import { useEffect, useLayoutEffect, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Link, NavLink, useLocation, useNavigate, useOutlet, useSearchParams } from 'react-router-dom';
import { BrandMark, CompassIcon, FolderIcon, LibraryIcon } from '@/ui/icons';
import { libraryGateway } from '@/core/gateway/defaultLibraryGateway';
import { collectionParamToId, collectionIdToSearchParams } from '@/features/library/collectionParam';
import { CURRENT_AUTHOR_ID } from '@/core/gateway/authorId';
import { PreviewPanel } from '@/features/browse/PreviewPanel';
import { NowPlayingBar } from '@/features/browse/NowPlayingBar';
import { AccountNav } from '@/features/auth/AccountNav';
import { useAuthStore } from '@/core/auth/authStore';
import { ScopedSearch } from '@/features/browse/ScopedSearch';
import { springGentle, springSmooth } from '@/styles/motion';
import { withPreview } from '@/features/browse/previewRoute';
import { useAuthPrompt } from '@/core/auth/authPrompt';
import { previewPlayer } from '@/core/audio/PreviewPlayer';
import { useAuthSceneTransitionActive } from '@/features/auth/authSceneTransition';
import { BROWSE_QUERY_KEYS, useBrowseQuery } from '@/core/gateway/browseQueryCache';

function collectionHref(id: string | null | undefined, previewId: string | null): string {
  const qs = new URLSearchParams(collectionIdToSearchParams(id)).toString();
  return withPreview(qs ? `/library?${qs}` : '/library', previewId);
}

const NAV_ITEMS = [
  { to: '/explore', label: 'Explore', Icon: CompassIcon },
  { to: '/library', label: 'Library', Icon: LibraryIcon },
];

/** The nav chrome around Explore/Library. NOT the flat top-bar-with-two-tabs this used to be —
 *  that read as "orphaned" because two destinations don't earn a whole nav bar. A persistent
 *  sidebar earns its keep once it holds real content: the collections tree, file-manager-style
 *  (ui-ux-pro-max's own "File Manager & Transfer" product-type match: "N/A — file tree
 *  focused" is exactly this shape). Narrow screens still fall back to the bottom tab bar (no
 *  room for a tree there — Library's own page renders an inline collection tile grid instead,
 *  see LibraryScreen.tsx's `.library-section-collections-mobile`). The Editor is a SIBLING
 *  route, not nested here — keeps its own chrome untouched. */
export function AppShell() {
  const location = useLocation();
  const navigate = useNavigate();
  const outlet = useOutlet();
  const [searchParams, setSearchParams] = useSearchParams();
  const [previewPanelMoving, setPreviewPanelMoving] = useState(false);
  const [nowPlayingMoving, setNowPlayingMoving] = useState(false);
  const authSceneTransitionActive = useAuthSceneTransitionActive();
  const isLibrary = location.pathname.startsWith('/library');
  // Collections are personal — neither their nav tree nor any Library surface mounts before the
  // route-level auth gate has admitted a signed-in user.
  const authStatus = useAuthStore((s) => s.status);
  const openLogin = useAuthPrompt((s) => s.open);
  const authed = authStatus === 'authed';
  const { data: collections } = useBrowseQuery(
    'private',
    BROWSE_QUERY_KEYS.myCollections,
    () => libraryGateway.listMyCollections(),
    authed,
  );
  const libraryBlocked = isLibrary && !authed;
  const openCollectionId = collectionParamToId(searchParams.get('collection'));

  // The one score-context surface, driven by `?preview=<scoreId>` (a URL param, not a store —
  // shareable and stable across back/forward). CSS presents the same panel as a reflowing column
  // on wide screens and a right-side drawer below that, so card clicks never fork into a second
  // detail-page interaction model.
  const previewId = searchParams.get('preview');
  const panelOpen = !!previewId;
  // A finished preview belongs to the piece that just finished, not to the next piece selected.
  // Clear that retained Replay state before paint when context changes; active background audio
  // intentionally survives because `clearReplayForSelection` ignores the playing phase.
  useLayoutEffect(() => {
    if (previewId) previewPlayer.clearReplayForSelection(previewId);
  }, [previewId]);
  const collapsePanel = () => {
    const next = new URLSearchParams(searchParams);
    next.delete('preview');
    setSearchParams(next, { replace: true });
  };
  const closePanelAndPlayer = () => {
    previewPlayer.dismiss();
    collapsePanel();
  };
  // Keeps the last-open piece's content mounted while the panel slides away — masked, not
  // squeezed/removed (the real macOS sidebar-collapse lesson, DESIGN.md §3.5): the panel closing
  // is a MOTION of the same content leaving, not a content teardown mid-flight.
  const [lastPreviewId, setLastPreviewId] = useState<string | null>(null);
  useEffect(() => {
    if (previewId) setLastPreviewId(previewId);
  }, [previewId]);

  // Main tabs change the catalog underneath the selected score, not the score context itself.
  // Carry ONLY `preview`: `q` and `collection` are local state of their current destination and
  // must not leak across Explore/Library.
  const tabHref = (pathname: string) => withPreview(pathname, previewId);

  // Search lives in ONE fixed place — this shell top bar — on every browse screen, not moved
  // around per screen. It stays contextual via the scope label + the `?q` URL param the screens
  // read; only the scope changes per surface, not the position. Author profiles use this same
  // topbar too — no screen inserts a second search field inside its content.
  const isExplore = location.pathname.startsWith('/explore');
  const isAuthorProfile = location.pathname.startsWith('/authors/');
  const isYourScores = authed && location.pathname === `/authors/${CURRENT_AUTHOR_ID}`;
  const openCollection = collections?.find((collection) => collection.id === openCollectionId);
  const librarySearchScope =
    openCollectionId === undefined ? 'your library' : openCollectionId === null ? 'Unsorted' : (openCollection?.name ?? 'this collection');
  const searchScope = libraryBlocked
    ? null
    : isExplore
      ? 'all pieces'
      : isLibrary
        ? librarySearchScope
        : isYourScores
          ? 'your scores'
          : isAuthorProfile
            ? 'this author’s scores'
            : null;
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
      <nav className="app-nav" aria-label="Main">
        <div className="app-nav-brand">
          <BrandMark />
          <span className="app-nav-wordmark">Eine kleine Klavierapp</span>
        </div>
        <div className="app-nav-tabs">
          {NAV_ITEMS.map(({ to, label, Icon }) => (
            <NavLink
              key={to}
              to={tabHref(to)}
              className={({ isActive }) =>
                'app-nav-item' + (isActive && !(to === '/library' && !authed) ? ' active' : '')
              }
              onClick={(event) => {
                if (to !== '/library' || authed) return;
                event.preventDefault();
                if (authStatus === 'anonymous') openLogin(() => navigate(tabHref('/library')));
              }}
            >
              <Icon />
              <span>{label}</span>
            </NavLink>
          ))}
        </div>

        {/* Travels a real distance (its own height) downward from under the tabs — a real slide,
            not a fade with a small positional nudge — matching `PreviewPanel`'s own slide below. */}
        <AnimatePresence initial={false}>
          {isLibrary && authed && (
            <motion.div
              key="collections-tree"
              className="app-nav-tree"
              initial={{ opacity: 0, y: -32 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -32 }}
              transition={springSmooth}
            >
              <span className="app-nav-tree-heading">Collections</span>
              <Link
                to={collectionHref(undefined, previewId)}
                className={'app-nav-tree-item' + (openCollectionId === undefined ? ' active' : '')}
              >
                All scores
              </Link>
              {collections?.map((c) => (
                <Link
                  key={c.id}
                  to={collectionHref(c.id, previewId)}
                  className={'app-nav-tree-item' + (openCollectionId === c.id ? ' active' : '')}
                >
                  <FolderIcon />
                  {c.name}
                </Link>
              ))}
              <Link
                to={collectionHref(null, previewId)}
                className={'app-nav-tree-item' + (openCollectionId === null ? ' active' : '')}
              >
                <FolderIcon />
                Unsorted
              </Link>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Account: sign-in prompt for anonymous visitors, else the personal "You" area (progress
            dashboard; catalog is one click on at `/authors/:id`) + sign out. */}
        <AccountNav />
      </nav>
      <main className="app-shell-content">
        {searchScope && (
          <div className="shell-topbar">
            <ScopedSearch value={q} onChange={setQ} scope={searchScope} />
          </div>
        )}
        <div className="shell-outlet">
          {/* screen-to-screen transition: keyed by pathname only, so opening the preview panel or
              typing in search (query-param changes) never re-animates the page — only an actual
              route change does. `mode="sync"` (the default), not "wait": old and new overlap
              during the crossfade rather than the old fully exiting before the new mounts, which
              would leave a blank frame between screens (DESIGN.md §3.5 principle 5 forbids this).
              `.shell-page` is absolutely positioned (see CSS) so the overlap doesn't double the
              layout height. */}
          <AnimatePresence initial={false}>
            <motion.div
              key={location.pathname}
              className="shell-page"
              initial={authSceneTransitionActive ? false : { opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={authSceneTransitionActive ? undefined : { opacity: 0, y: -6 }}
              transition={springGentle}
            >
              {outlet}
            </motion.div>
          </AnimatePresence>
        </div>
        <NowPlayingBar hidden={panelOpen} onMotionChange={setNowPlayingMoving} />
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
        scoreId={lastPreviewId}
        open={panelOpen}
        onCollapse={collapsePanel}
        onClose={closePanelAndPlayer}
        onMotionChange={setPreviewPanelMoving}
      />
    </div>
  );
}
