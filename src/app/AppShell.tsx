import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { useWakeLock } from '@/ui/useWakeLock';
import { animate, useReducedMotion } from 'motion/react';
import { useLocation, useSearchParams, type Location } from 'react-router-dom';
import { BrandMark } from '@/ui/icons';
import { PreviewPanel } from '@/features/browse/PreviewPanel';
import { NowPlayingBar } from '@/features/browse/NowPlayingBar';
import { createSavedScorePlayback } from '@/core/playback/SavedScorePlayback';
import { useAuthStore } from '@/core/auth/authStore';
import { ScopedSearch } from '@/features/browse/ScopedSearch';
import { SEARCH_PROMPT_ERASE_MS, SEARCH_PROMPT_TYPE_MS } from '@/styles/motion';
import { PageTransition, usePageTransitionPhase } from '@/ui/PageTransition';
import { RailNav } from '@/app/RailNav';
import { COLLECTION_PARAM } from '@/features/library/collectionParam';
import { useAuthSceneTransitionActive } from '@/features/auth/authSceneTransition';

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

function graphemes(value: string): string[] {
  return Array.from(graphemeSegmenter.segment(value), ({ segment }) => segment);
}

function commonPrefixLength(a: readonly string[], b: readonly string[]): number {
  const limit = Math.min(a.length, b.length);
  let i = 0;
  while (i < limit && a[i] === b[i]) i++;
  return i;
}

/** Persistent above the route outlet, so a reversal edits from the characters actually visible. */
function useTypedSearchPrompt(scope: string | null): { visiblePrompt: string; typing: boolean } {
  const prompt = scope ? `Search ${scope}` : '';
  const reduce = useReducedMotion();
  const [visiblePrompt, setVisiblePrompt] = useState(prompt);
  const [typing, setTyping] = useState(false);
  const visiblePromptRef = useRef(prompt);
  const targetPromptRef = useRef(prompt);

  useEffect(() => {
    if (reduce) {
      targetPromptRef.current = prompt;
      visiblePromptRef.current = prompt;
      setVisiblePrompt(prompt);
      setTyping(false);
      return;
    }
    if (targetPromptRef.current === prompt) return;
    targetPromptRef.current = prompt;

    const source = visiblePromptRef.current;
    const sourceGraphemes = graphemes(source);
    const targetGraphemes = graphemes(prompt);
    const common = commonPrefixLength(sourceGraphemes, targetGraphemes);
    const eraseCount = sourceGraphemes.length - common;
    const typeCount = targetGraphemes.length - common;
    const eraseDuration = eraseCount * SEARCH_PROMPT_ERASE_MS;
    const totalDuration = eraseDuration + typeCount * SEARCH_PROMPT_TYPE_MS;
    if (totalDuration === 0) return;

    setTyping(true);
    let lastText = source;
    const controls = animate(0, totalDuration, {
      duration: totalDuration / 1000,
      ease: 'linear',
      onUpdate: (elapsed) => {
        let next: string;
        if (elapsed < eraseDuration) {
          const erased = Math.min(eraseCount, Math.floor(elapsed / SEARCH_PROMPT_ERASE_MS));
          next = sourceGraphemes.slice(0, sourceGraphemes.length - erased).join('');
        } else {
          const typed = Math.min(typeCount, Math.floor((elapsed - eraseDuration) / SEARCH_PROMPT_TYPE_MS));
          next = targetGraphemes.slice(0, common + typed).join('');
        }
        if (next === lastText) return;
        lastText = next;
        visiblePromptRef.current = next;
        setVisiblePrompt(next);
      },
      onComplete: () => {
        visiblePromptRef.current = prompt;
        setVisiblePrompt(prompt);
        setTyping(false);
      },
    });

    return () => controls.stop();
  }, [prompt, reduce]);

  return { visiblePrompt, typing };
}

/** Shared browse navigation, search and score preview. The editor remains a sibling route. */
/** Where a browse path stands in the navigation, left to right, deeper pages after them: a screen goes forward to a higher rank and back to a lower one. */
const NAV_ORDER = ['/explore', '/library', '/you'];
function navRank(key: string): number {
  const at = NAV_ORDER.findIndex((path) => key === path || key.startsWith(path + '/') || key.startsWith(path + ':'));
  return at < 0 ? NAV_ORDER.length : at;
}

export function AppShell({ renderOutlet }: { renderOutlet: (location: Location) => ReactNode }) {
  const location = useLocation();
  const phase = usePageTransitionPhase();
  const [searchParams, setSearchParams] = useSearchParams();
  const [previewPanelMoving, setPreviewPanelMoving] = useState(false);
  const [nowPlayingMoving, setNowPlayingMoving] = useState(false);
  const [transport] = useState(createSavedScorePlayback);
  useEffect(() => {
    void transport.prepare().catch(() => {});
    return () => transport.dispose();
  }, [transport]);
  useLayoutEffect(() => { if (phase === 'exiting') transport.stop(); }, [phase, transport]);
  useWakeLock(useSyncExternalStore(transport.subscribe, () => transport.getState().phase === 'playing'));
  const authSceneTransitionActive = useAuthSceneTransitionActive();
  const isLibrary = location.pathname.startsWith('/library');
  const isDrafts = location.pathname === '/library/drafts';
  const collectionKey = location.pathname === '/library' ? searchParams.get(COLLECTION_PARAM) : null;
  const authStatus = useAuthStore((s) => s.status);
  const authed = authStatus === 'authed';
  const userId = useAuthStore((s) => s.userId);
  const playbackIdentity = useRef(userId);
  useLayoutEffect(() => {
    if (playbackIdentity.current !== userId) { playbackIdentity.current = userId; transport.stop(); }
  }, [transport, userId]);
  const libraryBlocked = isLibrary && !authed;

  // The one score-context surface, driven by `?preview=<scoreId>` (a URL param, not a store —
  // shareable and stable across back/forward). CSS presents the same panel as a reflowing column
  // on wide screens and a right-side drawer below that, so card clicks never fork into a second
  // detail-page interaction model.
  const previewId = searchParams.get('preview');
  const panelOpen = !!previewId;
  useLayoutEffect(() => { if (previewId) transport.clearReplayForSelection(previewId); }, [transport, previewId]);
  const collapsePanel = () => {
    const next = new URLSearchParams(searchParams);
    next.delete('preview');
    setSearchParams(next, { replace: true });
  };
  const closePanelAndPlayer = () => {
    transport.stop();
    collapsePanel();
  };
  // Keeps the last-open piece's content mounted while the panel slides away — masked, not
  // squeezed/removed (the real macOS sidebar-collapse lesson, DESIGN.md §3.5): the panel closing
  // is a MOTION of the same content leaving, not a content teardown mid-flight.
  const [lastPreviewId, setLastPreviewId] = useState<string | null>(null);
  useEffect(() => {
    if (previewId) setLastPreviewId(previewId);
  }, [previewId]);

  // Search lives in ONE fixed place — this shell top bar — on every browse screen, not moved
  // around per screen. It stays contextual via the scope label + the `?q` URL param the screens
  // read; only the scope changes per surface, not the position. Author profiles use this same
  // topbar too — no screen inserts a second search field inside its content.
  const isExplore = location.pathname.startsWith('/explore');
  const isAuthorProfile = location.pathname.startsWith('/authors/');
  const isYourScores = authed && userId !== null && location.pathname === `/authors/${userId}`;
  const searchScope = libraryBlocked
    ? null
    : isExplore
      ? 'all pieces'
      : isLibrary
        ? isDrafts ? 'drafts' : searchParams.get(COLLECTION_PARAM) ? 'this collection' : 'your library'
        : isYourScores
          ? 'your scores'
          : isAuthorProfile
            ? 'this author’s scores'
            : null;
  // Presentation state lives above keyed scenes: rapid route reversals edit from the prompt that
  // is truly visible mid-word instead of remounting a fresh typewriter at a guessed endpoint.
  const typedSearchPrompt = useTypedSearchPrompt(searchScope);
  const q = searchParams.get('q') ?? '';
  const setQ = (v: string) => {
    const next = new URLSearchParams(searchParams);
    if (v) next.set('q', v);
    else next.delete('q');
    setSearchParams(next, { replace: true });
  };

  return (
    <div
      className={
        'app-shell' +
        (panelOpen ? ' has-panel' : '') +
        (previewPanelMoving || nowPlayingMoving ? ' panels-moving' : '')
      }
    >
      <nav className="app-nav rail" aria-label="Main">
        <div className="app-nav-brand">
          <BrandMark />
          <span className="app-nav-wordmark">Eine kleine Klavierapp</span>
        </div>
        <RailNav />
      </nav>
      <main className="app-shell-content">
        <div className="shell-topbar" data-search-hidden={!searchScope}>
          <ScopedSearch
            value={q}
            onChange={setQ}
            scope={searchScope ?? ''}
            visiblePrompt={typedSearchPrompt.visiblePrompt}
            typing={typedSearchPrompt.typing}
          />
        </div>
        <PageTransition
          transitionKey={collectionKey ? `${location.pathname}:${collectionKey}` : location.pathname}
          className="shell-outlet"
          disabled={authSceneTransitionActive}
          direction={(from, to) => Math.sign(navRank(to) - navRank(from)) as -1 | 0 | 1}
        >
          {renderOutlet(location)}
        </PageTransition>
        <NowPlayingBar transport={transport} hidden={panelOpen} onMotionChange={setNowPlayingMoving} />
      </main>
      {/* The panel is a real flex sibling of `<main>` on wide screens, where its own `width` is the
          reservation; CSS turns that same element into an overlay drawer below 1080px. There is
          no second detail component or motion wrapper. `PreviewPanel.tsx` owns the motion itself,
          so this shell only renders it with an `open` intent. Mounted unconditionally from this
          shell's very first render
          (`scoreId={lastPreviewId}`, starting `null`) rather than gated on a piece being selected
          — see `PreviewPanel.tsx`'s own doc comment for why that gate matters. No
          `AnimatePresence` mount/unmount — the panel's own internal motion handles open and
          close, nothing left for this shell to orchestrate. */}
      <PreviewPanel
        transport={transport}
        scoreId={lastPreviewId}
        open={panelOpen}
        onCollapse={collapsePanel}
        onClose={closePanelAndPlayer}
        onMotionChange={setPreviewPanelMoving}
      />
    </div>
  );
}
