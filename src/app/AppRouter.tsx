import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation, useNavigate, useParams, type Location } from 'react-router-dom';
import { AppShell } from '@/app/AppShell';
import { LoginModalHost } from '@/features/auth/LoginModalHost';
import ExploreScreen from '@/features/explore/ExploreScreen';
import CollectionView from '@/features/library/CollectionView';
import { COLLECTION_PARAM } from '@/features/library/collectionParam';
import LibraryScreen from '@/features/library/LibraryScreen';
import EditorScreen from '@/features/editor/EditorScreen';
import PracticeScreen from '@/features/practice/PracticeScreen';
import AuthorProfileScreen from '@/features/browse/AuthorProfileScreen';
import YouScreen from '@/features/browse/YouScreen';
import { useAuthStore } from '@/core/auth/authStore';
import { useAuthPrompt } from '@/core/auth/authPrompt';
import { withPreview } from '@/features/browse/previewRoute';
import { PageReadinessScope, PageTransition, TransitionLoading, usePageReady, usePageTransitionPhase, useScreenOpacity } from '@/ui/PageTransition';
import { usePlaybackValue } from '@/core/playback/PlaybackController';
import { usePractice } from '@/core/practice/PracticeSession';
import { useWakeLock } from '@/ui/useWakeLock';

function RootRoute() {
  const status = useAuthStore((state) => state.status);
  usePageReady(true);
  return <>
    <div className="browse-loading">Restoring your session…</div>
    {status !== 'loading' && <Navigate to={status === 'authed' ? '/library' : '/explore'} replace />}
  </>;
}

/** Library is private navigation, not a public screen with a sign-in placeholder. A direct URL
 *  opens the same modal as the Library nav action, but moves the underlying route to Explore so
 *  dismissing the modal never leaves an anonymous visitor inside Library. Successful sign-in
 *  resumes the exact requested Library URL, including collection/search/preview context. */
function LibraryRoute({ draftsOnly = false }: { draftsOnly?: boolean }) {
  const status = useAuthStore((state) => state.status);
  const openLogin = useAuthPrompt((state) => state.open);
  const location = useLocation();
  const navigate = useNavigate();
  const phase = usePageTransitionPhase();

  useLayoutEffect(() => {
    if (phase === 'exiting' || status !== 'anonymous' ||
      (location.pathname !== '/library' && !location.pathname.startsWith('/library/'))) return;
    const requestedLibrary = `${location.pathname}${location.search}`;
    const previewId = new URLSearchParams(location.search).get('preview');
    openLogin(() => navigate(requestedLibrary, { replace: true }));
    navigate(withPreview('/explore', previewId), { replace: true });
  }, [location.pathname, location.search, navigate, openLogin, phase, status]);

  const collectionId = new URLSearchParams(location.search).get(COLLECTION_PARAM);
  if (status === 'authed') {
    return collectionId && !draftsOnly
      ? <CollectionView key={collectionId} collectionId={collectionId} />
      : <LibraryScreen draftsOnly={draftsOnly} />;
  }
  // Fail closed: no Library-owned placeholder, copy, or data surface is mounted before auth.
  return null;
}

/** A draft is private. Keep an anonymous direct editor URL as the post-login destination,
 *  while showing the public Explore page beneath the shared sign-in modal. */
function EditorRoute() {
  const { scoreId } = useParams<{ scoreId: string }>();
  const status = useAuthStore((state) => state.status);
  const openLogin = useAuthPrompt((state) => state.open);
  const location = useLocation();
  const navigate = useNavigate();
  const phase = usePageTransitionPhase();

  useLayoutEffect(() => {
    if (phase === 'exiting' || scoreId || status !== 'anonymous') return;
    const requestedEditor = `${location.pathname}${location.search}`;
    openLogin(() => navigate(requestedEditor, { replace: true }));
    navigate('/explore', { replace: true });
  }, [location.pathname, location.search, navigate, openLogin, phase, status, scoreId]);

  return scoreId || status === 'authed' ? <EditorScreen /> : null;
}

/** Self-contained displacement source for the `.glass` primitive's real lensing (index.css) — a
 *  radial shape whose fill goes from neutral grey (128,128 = no displacement) at the center to a
 *  warped red/green edge, so `feDisplacementMap` only bends pixels near the glass's own border,
 *  like a lens, and leaves the center flat. No external PNG/data-URI: `feImage` references the
 *  local `#lensShape` by id. Mounted once here (not per-popover) since both route trees
 *  (browse under AppShell, the editor as a sibling) need it. */
function LiquidGlassDefs() {
  return (
    <svg width="0" height="0" style={{ position: 'absolute' }} aria-hidden="true">
      <defs>
        <radialGradient id="lensGradient" cx="50%" cy="50%" r="60%">
          <stop offset="55%" stopColor="rgb(128,128,128)" />
          <stop offset="82%" stopColor="rgb(40,210,90)" />
          <stop offset="100%" stopColor="rgb(230,60,130)" />
        </radialGradient>
        <rect id="lensShape" width="400" height="400" fill="url(#lensGradient)" />
        <filter id="liquidLens" x="-30%" y="-30%" width="160%" height="160%">
          <feImage href="#lensShape" x="0" y="0" width="100%" height="100%" result="map" />
          <feGaussianBlur in="map" stdDeviation="11" result="mapBlur" />
          <feDisplacementMap in="SourceGraphic" in2="mapBlur" scale="22" xChannelSelector="R" yChannelSelector="G" />
        </filter>
      </defs>
    </svg>
  );
}

function renderBrowseRoutes(location: Location) {
  return (
    <Routes location={location}>
      <Route path="/" element={<RootRoute />} />
      <Route path="/explore" element={<ExploreScreen />} />
      <Route path="/library" element={<LibraryRoute />} />
      <Route path="/library/drafts" element={<LibraryRoute draftsOnly />} />
      <Route path="/authors/:authorId" element={<AuthorProfileScreen />} />
      <Route path="/you" element={<YouScreen />} />
      <Route path="*" element={<RootRoute />} />
    </Routes>
  );
}

/** The score store and playback binding belong to one editor. Cover its painted
 * surface before changing the route it reads, then unveil the replacement. */
function WorkspaceRoutes({ location }: { location: Location }) {
  const phase = usePageTransitionPhase();
  const [held, setHeld] = useState(location);
  const [handoff, setHandoff] = useState(false);
  const [coverOpaque, setCoverOpaque] = useState(false);
  const [readyPath, setReadyPath] = useState<string | null>(null);
  const cover = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const different = held.pathname !== location.pathname;
  const routed = different && phase !== 'entering' ? held : location;
  const ready = readyPath === routed.pathname;
  const waiting = different || (handoff && !ready);
  const covered = (phase === 'settled' && waiting) || (phase === 'exiting' && handoff);
  const blocked = phase !== 'settled' || waiting || handoff;
  const report = useCallback((painted: boolean) => {
    setReadyPath(previous => painted ? routed.pathname : previous === routed.pathname ? null : previous);
  }, [routed.pathname]);

  usePageReady(ready && !different);
  useLayoutEffect(() => {
    if (phase === 'entering' && different) setHeld(location);
  }, [phase, different, location]);
  useLayoutEffect(() => { if (content.current) content.current.inert = blocked; }, [blocked]);
  useLayoutEffect(() => {
    if (!covered) setCoverOpaque(false);
    else if (coverOpaque && different && phase === 'settled') {
      setHandoff(true);
      setHeld(location);
    }
  }, [coverOpaque, covered, different, location, phase]);
  useScreenOpacity(cover, covered ? 1 : 0, () => {
    if (covered) setCoverOpaque(true);
    else if (handoff && ready) setHandoff(false);
  }, false, covered);

  return (
    <div className="workspace-transition">
      <PageReadinessScope phase={phase === 'settled' && (waiting || handoff) ? 'entering' : phase} onReady={report}>
        <div className="workspace-route-content" ref={content}>
          <Routes location={routed}>
            <Route path="/scores/:scoreId" element={<EditorRoute />} />
            <Route path="/scores/:scoreId/practice" element={<PracticeScreen />} />
            <Route path="/edit/:draftId" element={<EditorRoute />} />
          </Routes>
        </div>
      </PageReadinessScope>
      <div ref={cover} className="workspace-transition-cover" data-covering={covered || handoff} aria-hidden="true" />
      <TransitionLoading waiting={phase === 'settled' && waiting} label="Opening score…" />
    </div>
  );
}

/** The workspace keeps one route layer for both drafts and saved scores. Browse
 * owns a second transition inside its persistent shell. */
function RoutedApp() {
  const location = useLocation();
  // The waterfall is a view of the editor and plays through the same playback; a practice session
  // can run with no sound at all, so it is asked for on its own.
  const playing = usePlaybackValue((state) => state.playing);
  const practising = usePractice().phase !== 'idle';
  useWakeLock(playing || practising);
  // Browse views animate inside AppShell so its navigation remains persistent. Crossing the
  // browse/editor boundary replaces the whole application surface with the same default
  // lifecycle. Auth stays outside this layer and owns its separate welcome/reveal sequence.
  const routeFamily = /^\/(?:edit|scores)\/[^/]+(?:\/practice)?\/?$/i.test(location.pathname) ? 'editor' : 'browse';
  const collection = location.pathname === '/library' ? new URLSearchParams(location.search).get(COLLECTION_PARAM) : null;
  const requestKey = collection ? `${location.pathname}:${collection}` : location.pathname;

  return (
    <>
      <LiquidGlassDefs />
      <PageTransition
        transitionKey={routeFamily}
        requestKey={requestKey}
        className="route-transition-root"
        // the workspace is deeper than browse: opening a score goes forward, leaving it goes back
        direction={(from, to) => (from === to ? 0 : to === 'editor' ? 1 : -1)}
      >
        {routeFamily === 'editor' ? <WorkspaceRoutes location={location} /> : (
          <Routes location={location}>
            <Route path="*" element={<AppShell renderOutlet={renderBrowseRoutes} />} />
          </Routes>
        )}
      </PageTransition>
      {/* Mounted outside <Routes> so the login modal survives across route trees (browse shell and
          the sibling editor) — any surface can prompt sign-in without owning the modal. */}
      <LoginModalHost />
    </>
  );
}

export default function AppRouter() {
  return (
    <BrowserRouter>
      <RoutedApp />
    </BrowserRouter>
  );
}
