import { useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { libraryGateway } from '@/core/gateway/defaultLibraryGateway';
import { CURRENT_AUTHOR_ID } from '@/core/gateway/authorId';
import type { ScoreSummary } from '@/core/gateway/LibraryGateway';
import { PieceCard } from '@/features/browse/PieceCard';
import { ScoreCover, type Coverable } from '@/features/browse/ScoreCover';
import { Dropdown } from '@/features/browse/Dropdown';
import { ArrowLeftIcon, FolderIcon, PlusIcon } from '@/ui/icons';
import { Button } from '@/ui/Button';
import { FadeSwap } from '@/ui/FadeSwap';
import { springGentle } from '@/styles/motion';
import { collectionParamToId, collectionIdToSearchParams } from './collectionParam';
import { useAuthStore } from '@/core/auth/authStore';
import { requireAuth } from '@/core/auth/authPrompt';
import { BROWSE_QUERY_KEYS, invalidateBrowseQueries, useBrowseQuery } from '@/core/gateway/browseQueryCache';
import { DelayedLoading } from '@/ui/DelayedLoading';

function scoreCount(n: number): string {
  return `${n} ${n === 1 ? 'score' : 'scores'}`;
}

function relativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const min = Math.round(ms / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  return `${day}d ago`;
}

type SortKey = 'recent' | 'title' | 'composer' | 'fit';
const SORTS: { value: SortKey; label: string }[] = [
  { value: 'recent', label: 'Recently updated' },
  { value: 'title', label: 'Title' },
  { value: 'composer', label: 'Composer' },
  { value: 'fit', label: 'Best fit' },
];

/** One "Jump back in" item — a draft you were editing or a piece you were practicing, unified so
 *  the row reflects the user's actual recent relationship with material, not just files. */
interface JumpItem {
  key: string;
  cover: Coverable;
  title: string;
  /** Short activity type, shown as a coloured chip: Editing / Edited / Listened / Practiced. */
  kindLabel: string;
  kindClass: string;
  when: string;
  time: number;
  progress?: number;
  onOpen: () => void;
}

export default function LibraryScreen() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [sort, setSort] = useState<SortKey>('recent');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const authStatus = useAuthStore((s) => s.status);
  const authed = authStatus === 'authed';
  const { data: drafts } = useBrowseQuery(
    'private',
    BROWSE_QUERY_KEYS.myDrafts,
    () => libraryGateway.listMyDrafts(),
    authed,
  );
  const { data: practice } = useBrowseQuery(
    'private',
    BROWSE_QUERY_KEYS.recentPractice,
    () => libraryGateway.listRecentPractice(),
    authed,
  );
  const { data: listens } = useBrowseQuery(
    'private',
    BROWSE_QUERY_KEYS.recentListens,
    () => libraryGateway.listRecentListens(),
    authed,
  );
  const { data: scores } = useBrowseQuery(
    'private',
    BROWSE_QUERY_KEYS.myScores,
    () => libraryGateway.listMyScores(),
    authed,
  );
  const { data: collections } = useBrowseQuery(
    'private',
    BROWSE_QUERY_KEYS.myCollections,
    () => libraryGateway.listMyCollections(),
    authed,
  );

  const previewId = searchParams.get('preview');
  const query = searchParams.get('q') ?? '';
  const openCollectionId = collectionParamToId(searchParams.get('collection'));
  const setOpenCollectionId = (id: string | null | undefined) => {
    const next = new URLSearchParams(searchParams);
    const coll = new URLSearchParams(collectionIdToSearchParams(id));
    next.delete('collection');
    const c = coll.get('collection');
    if (c !== null) next.set('collection', c);
    setSearchParams(next);
  };

  const openDraft = (draftId: string) => navigate(`/edit/${draftId}`);
  // A saved piece opens in the shell's one contextual panel at every viewport width.
  const openScore = (s: ScoreSummary) => {
    const next = new URLSearchParams(searchParams);
    next.set('preview', s.id);
    setSearchParams(next);
  };

  // Creating a draft is a write → sign-in required. requireAuth runs it straight away if already
  // signed in, otherwise opens the login modal and resumes here after a successful sign-in.
  const newScore = () =>
    requireAuth(async () => {
      if (busy) return;
      setBusy(true);
      setError(null);
      try {
        const { draftId } = await libraryGateway.createDraft();
        invalidateBrowseQueries('private', BROWSE_QUERY_KEYS.myDrafts);
        navigate(`/edit/${draftId}`);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to create a draft.');
      } finally {
        setBusy(false);
      }
    });

  const scoreTitleById = useMemo(() => new Map((scores ?? []).map((s) => [s.id, s.title])), [scores]);

  // "Jump back in" = ALL your recent activity: edits (drafts + changed scores), listens, and
  // practices — one row, each card tagged by kind, newest first.
  const EDIT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
  const jumpItems = useMemo<JumpItem[]>(() => {
    const items: JumpItem[] = [];
    for (const d of drafts ?? []) {
      items.push({
        key: `draft-${d.id}`,
        cover: { id: d.id, title: d.title, composer: null, coverImageUrl: d.coverImageUrl, previewDocument: d.previewDocument },
        title: d.title,
        kindLabel: 'Editing',
        kindClass: 'kind-edit',
        when: relativeTime(d.updatedAt),
        time: new Date(d.updatedAt).getTime(),
        onOpen: () => openDraft(d.id),
      });
    }
    for (const s of scores ?? []) {
      const t = new Date(s.updatedAt).getTime();
      if (s.authorId !== CURRENT_AUTHOR_ID || Date.now() - t > EDIT_WINDOW_MS) continue;
      items.push({
        key: `score-${s.id}`,
        cover: s,
        title: s.title,
        kindLabel: 'Edited',
        kindClass: 'kind-edit',
        when: relativeTime(s.updatedAt),
        time: t,
        onOpen: () => openScore(s),
      });
    }
    for (const p of practice ?? []) {
      items.push({
        key: `practice-${p.id}`,
        cover: p,
        title: p.title,
        kindLabel: 'Practiced',
        kindClass: 'kind-practice',
        when: relativeTime(p.lastPracticedAt),
        time: new Date(p.lastPracticedAt).getTime(),
        progress: p.progress,
        onOpen: () => openScore(p),
      });
    }
    for (const l of listens ?? []) {
      items.push({
        key: `listen-${l.id}`,
        cover: l,
        title: l.title,
        kindLabel: 'Listened',
        kindClass: 'kind-listen',
        when: relativeTime(l.listenedAt),
        time: new Date(l.listenedAt).getTime(),
        onOpen: () => openScore(l),
      });
    }
    return items.sort((a, b) => b.time - a.time);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drafts, scores, practice, listens, scoreTitleById]);

  const collectedIds = useMemo(() => new Set((collections ?? []).flatMap((c) => c.scoreIds)), [collections]);
  const openCollection = collections?.find((c) => c.id === openCollectionId) ?? null;
  const collectionSelected = openCollectionId !== undefined;
  const collectionLabel = openCollectionId === null ? 'Unsorted' : (openCollection?.name ?? 'Collection');
  const unsortedCount = scores ? scores.filter((s) => !collectedIds.has(s.id)).length : 0;

  const visibleScores = useMemo(() => {
    if (!scores || (typeof openCollectionId === 'string' && !collections)) return null;
    let list = scores;
    if (openCollectionId === null) list = list.filter((s) => !collectedIds.has(s.id));
    else if (openCollectionId !== undefined) {
      const ids = new Set(openCollection?.scoreIds ?? []);
      list = list.filter((s) => ids.has(s.id));
    }
    const q = query.trim().toLowerCase();
    if (q) list = list.filter((s) => s.title.toLowerCase().includes(q) || (s.composer?.toLowerCase().includes(q) ?? false));
    const sorted = [...list];
    sorted.sort((a, b) => {
      if (sort === 'title') return a.title.localeCompare(b.title);
      if (sort === 'composer') return (a.composer ?? '~').localeCompare(b.composer ?? '~');
      if (sort === 'fit') return b.difficultyFit - a.difficultyFit;
      return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
    });
    return sorted;
  }, [scores, collections, openCollectionId, openCollection, collectedIds, query, sort]);

  const emptyMessage = query.trim()
    ? `No scores match “${query.trim()}” in ${collectionSelected ? collectionLabel : 'your library'}.`
    : openCollectionId === null
      ? 'No unsorted scores.'
      : collectionSelected
        ? `${collectionLabel} is empty.`
        : 'Nothing here yet.';

  // AppRouter is the primary route gate; keep the screen itself fail-closed too so it can never
  // expose personal chrome if it is mounted from another route/test harness in the future.
  if (authStatus !== 'authed') return null;

  return (
    <div className="library-screen">
      <header className="library-header">
        <h1>Library</h1>
        <Button variant="primary" icon={<PlusIcon />} disabled={busy} onClick={() => void newScore()}>
          New score
        </Button>
      </header>

      {error && <div className="library-error">{error}</div>}

      <AnimatePresence initial={false}>
        {!collectionSelected && jumpItems.length > 0 && (
          <motion.div
            key="jump-back-in"
            className="library-section-presence"
            initial={{ opacity: 0, height: 0, y: -8 }}
            animate={{ opacity: 1, height: 'auto', y: 0 }}
            exit={{ opacity: 0, height: 0, y: -8 }}
            transition={springGentle}
          >
            <section className="library-section" aria-label="Jump back in">
              <div className="library-section-header">
                <h2>Jump back in</h2>
              </div>
              <div className="jump-track">
                {jumpItems.slice(0, 6).map((item) => (
                  <div
                    key={item.key}
                    role="button"
                    tabIndex={0}
                    className="work-card"
                    onClick={item.onOpen}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        item.onOpen();
                      }
                    }}
                  >
                    <div className="work-card-thumb">
                      <ScoreCover score={item.cover} playable={false} />
                    </div>
                    <div className="work-card-main">
                      <span className={'pill work-card-kind ' + item.kindClass}>{item.kindLabel}</span>
                      <span className="work-card-title">{item.title}</span>
                      {item.progress !== undefined && (
                        <span className="work-card-progress" aria-label={`${Math.round(item.progress * 100)}% practiced`}>
                          <span className="work-card-progress-fill" style={{ width: `${Math.round(item.progress * 100)}%` }} />
                        </span>
                      )}
                      <span className="work-card-when">{item.when}</span>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          </motion.div>
        )}
      </AnimatePresence>

      {/* narrow only — the sidebar tree (AppShell) is the desktop equivalent */}
      {!collectionSelected && (
        <section className="library-section library-section-collections-mobile">
          <div className="library-section-header">
            <h2>Collections</h2>
            {collections && <span className="library-count">{collections.length}</span>}
          </div>
          {collections && (
            <div className="collection-grid">
              {collections.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  className="collection-tile"
                  onClick={() => setOpenCollectionId(c.id)}
                >
                  <FolderIcon />
                  <span className="collection-tile-name">{c.name}</span>
                  <span className="collection-tile-count">{scoreCount(c.scoreIds.length)}</span>
                </button>
              ))}
              {unsortedCount > 0 && (
                <button type="button" className="collection-tile" onClick={() => setOpenCollectionId(null)}>
                  <FolderIcon />
                  <span className="collection-tile-name">Unsorted</span>
                  <span className="collection-tile-count">{scoreCount(unsortedCount)}</span>
                </button>
              )}
            </div>
          )}
        </section>
      )}

      <section className="library-section">
        <div className="library-section-header">
          {openCollectionId !== undefined ? (
            <button type="button" className="back-link" onClick={() => setOpenCollectionId(undefined)}>
              <ArrowLeftIcon />
              {collectionLabel}
            </button>
          ) : (
            <h2>Your scores</h2>
          )}
          <div className="library-section-tools">
            {visibleScores && <span className="library-count">{visibleScores.length} saved</span>}
            <div className="library-sort">
              <span className="library-sort-label">Sort</span>
              <Dropdown value={sort} options={SORTS} onChange={setSort} label="Sort scores" />
            </div>
          </div>
        </div>
        {/* keyed by collection too — not just loading/empty/content — so switching collections
            crossfades the grid instead of silently re-rendering it with zero transition:
            `visibleScores` never becomes null between two non-empty collections, so a state-only
            key alone never retriggers `FadeSwap`. */}
        <FadeSwap
          stateKey={
            !visibleScores ? 'loading' : `${openCollectionId}:` + (visibleScores.length === 0 ? 'empty' : 'content')
          }
        >
          {!visibleScores ? (
            <DelayedLoading>Loading…</DelayedLoading>
          ) : visibleScores.length === 0 ? (
            <div className="library-empty">{emptyMessage}</div>
          ) : (
            <div className="piece-grid">
              {visibleScores.map((score) => (
                <PieceCard key={score.id} score={score} onOpen={openScore} active={score.id === previewId} />
              ))}
            </div>
          )}
        </FadeSwap>
      </section>
    </div>
  );
}
