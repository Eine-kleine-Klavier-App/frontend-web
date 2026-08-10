import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Link, NavLink, useLocation, useOutlet, useSearchParams } from 'react-router-dom';
import { BrandMark, ExploreIcon, FolderIcon, LibraryIcon } from '@/features/editor/icons';
import { libraryGateway } from '@/core/gateway/defaultLibraryGateway';
import type { Collection } from '@/core/gateway/LibraryGateway';
import { collectionParamToId, collectionIdToSearchParams } from '@/features/library/collectionParam';
import { CURRENT_AUTHOR_ID } from '@/core/gateway/authorId';
import { PreviewPanel } from '@/features/browse/PreviewPanel';
import { ScopedSearch } from '@/features/browse/ScopedSearch';
import { useIsWide } from '@/features/browse/useIsWide';
import { springGentle, springSmooth } from '@/styles/motion';

function collectionHref(id: string | null | undefined): string {
  const qs = new URLSearchParams(collectionIdToSearchParams(id)).toString();
  return qs ? `/library?${qs}` : '/library';
}

const NAV_ITEMS = [
  { to: '/explore', label: 'Explore', Icon: ExploreIcon },
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
  const outlet = useOutlet();
  const [searchParams, setSearchParams] = useSearchParams();
  const [collections, setCollections] = useState<Collection[] | null>(null);
  const isLibrary = location.pathname.startsWith('/library');
  const openCollectionId = collectionParamToId(searchParams.get('collection'));

  // Desktop-only right preview panel, driven by `?preview=<scoreId>` (a URL param, not a store —
  // shareable, survives back/forward, and the browse screens set it on card click; below the
  // breakpoint they navigate to /scores/:id instead). It's a real grid column, so the content
  // reflows narrower when it opens and never gets overlapped (docs/browse-redesign.md, round 3).
  const wide = useIsWide();
  const previewId = searchParams.get('preview');
  const panelOpen = wide && !!previewId;
  const closePanel = () => {
    const next = new URLSearchParams(searchParams);
    next.delete('preview');
    setSearchParams(next, { replace: true });
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
  // read; only the scope changes per surface, not the position. Other authors' profiles are NOT
  // in this list — they keep their own inline `ScopedSearch`, a different surface with a
  // different job (a public read-only introduction, not a personal catalog).
  const isExplore = location.pathname.startsWith('/explore');
  const isYourScores = location.pathname === `/authors/${CURRENT_AUTHOR_ID}`;
  const searchScope = isExplore ? 'all pieces' : isLibrary ? 'your library' : isYourScores ? 'your scores' : null;
  const q = searchParams.get('q') ?? '';
  const setQ = (v: string) => {
    const next = new URLSearchParams(searchParams);
    if (v) next.set('q', v);
    else next.delete('q');
    setSearchParams(next, { replace: true });
  };

  useEffect(() => {
    let cancelled = false;
    void libraryGateway.listMyCollections().then((r) => !cancelled && setCollections(r));
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className={'app-shell' + (panelOpen ? ' has-panel' : '')}>
      <nav className="app-nav" aria-label="Main">
        <div className="app-nav-brand">
          <BrandMark />
          <span className="app-nav-wordmark">Eine kleine Klavierapp</span>
        </div>
        <div className="app-nav-tabs">
          {NAV_ITEMS.map(({ to, label, Icon }) => (
            <NavLink key={to} to={to} className={({ isActive }) => 'app-nav-item' + (isActive ? ' active' : '')}>
              <Icon />
              <span>{label}</span>
            </NavLink>
          ))}
        </div>

        {/* Travels a real distance (its own height) downward from under the tabs — a real slide,
            not a fade with a small positional nudge — matching `PreviewPanel`'s own slide below. */}
        <AnimatePresence initial={false}>
          {isLibrary && (
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
                to={collectionHref(undefined)}
                className={'app-nav-tree-item' + (openCollectionId === undefined ? ' active' : '')}
              >
                All scores
              </Link>
              {collections?.map((c) => (
                <Link
                  key={c.id}
                  to={collectionHref(c.id)}
                  className={'app-nav-tree-item' + (openCollectionId === c.id ? ' active' : '')}
                >
                  <FolderIcon />
                  {c.name}
                </Link>
              ))}
              <Link
                to={collectionHref(null)}
                className={'app-nav-tree-item' + (openCollectionId === null ? ' active' : '')}
              >
                <FolderIcon />
                Unsorted
              </Link>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Lands on the progress dashboard, not the score catalog — the catalog is one click away
            from there, at `/authors/:id`. */}
        <NavLink to="/you" className={({ isActive }) => 'app-nav-item app-nav-account' + (isActive ? ' active' : '')}>
          <span className="app-nav-avatar" aria-hidden="true">Y</span>
          <span>You</span>
        </NavLink>
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
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              transition={springGentle}
            >
              {outlet}
            </motion.div>
          </AnimatePresence>
        </div>
      </main>
      {/* The panel is the ONLY space-reserving element here — no separate gap div. It's a real
          flex sibling of `<main>` whose own `width` IS the reservation, mirroring `LeftPanel`'s
          mechanism (editor) for the right edge; `PreviewPanel.tsx` owns the motion itself, so this
          shell just renders it with an `open` intent, same as `<LeftPanel />` needs no wrapper in
          the editor. Mounted unconditionally from this shell's very first render
          (`scoreId={lastPreviewId}`, starting `null`) rather than gated on a piece being selected
          — see `PreviewPanel.tsx`'s own doc comment for why that gate matters. No
          `AnimatePresence` mount/unmount — the panel's own internal motion handles open and
          close, nothing left for this shell to orchestrate. */}
      <PreviewPanel scoreId={lastPreviewId} open={panelOpen} onClose={closePanel} />
    </div>
  );
}
