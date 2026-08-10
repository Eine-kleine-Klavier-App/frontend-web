import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { libraryGateway } from '@/core/gateway/defaultLibraryGateway';
import { CURRENT_AUTHOR_ID } from '@/core/gateway/authorId';
import type {
  Collection,
  DraftSummary,
  ListenSummary,
  PracticeSummary,
  ScoreSummary,
} from '@/core/gateway/LibraryGateway';
import { PieceCard } from '@/features/browse/PieceCard';
import { ScoreCover, type Coverable } from '@/features/browse/ScoreCover';
import { Dropdown } from '@/features/browse/Dropdown';
import { useIsWide } from '@/features/browse/useIsWide';
import { FolderIcon } from '@/features/editor/icons';
import { Button } from '@/ui/Button';
import { FadeSwap } from '@/ui/FadeSwap';
import { collectionParamToId, collectionIdToSearchParams } from './collectionParam';

function PlusIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true">
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

function BackChevron() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M15 5 8 12l7 7" />
    </svg>
  );
}

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
  const wide = useIsWide();
  const [searchParams, setSearchParams] = useSearchParams();
  const [drafts, setDrafts] = useState<DraftSummary[] | null>(null);
  const [practice, setPractice] = useState<PracticeSummary[] | null>(null);
  const [listens, setListens] = useState<ListenSummary[] | null>(null);
  const [scores, setScores] = useState<ScoreSummary[] | null>(null);
  const [collections, setCollections] = useState<Collection[] | null>(null);
  const [sort, setSort] = useState<SortKey>('recent');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  useEffect(() => {
    let cancelled = false;
    void libraryGateway.listMyDrafts().then((r) => !cancelled && setDrafts(r));
    void libraryGateway.listRecentPractice().then((r) => !cancelled && setPractice(r));
    void libraryGateway.listRecentListens().then((r) => !cancelled && setListens(r));
    void libraryGateway.listMyScores().then((r) => !cancelled && setScores(r));
    void libraryGateway.listMyCollections().then((r) => !cancelled && setCollections(r));
    return () => {
      cancelled = true;
    };
  }, []);

  const openDraft = (draftId: string) => navigate(`/edit/${draftId}`);
  // A saved piece opens in the desktop preview panel (Practice/Play/Branch live there) or, on
  // narrow, the full detail route — same behaviour as Explore.
  const openScore = (s: ScoreSummary) => {
    if (wide) {
      const next = new URLSearchParams(searchParams);
      next.set('preview', s.id);
      setSearchParams(next);
    } else {
      navigate(`/scores/${s.id}`);
    }
  };

  const newScore = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const { draftId } = await libraryGateway.createDraft();
      navigate(`/edit/${draftId}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create a draft.');
    } finally {
      setBusy(false);
    }
  };

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
  }, [drafts, scores, practice, listens, scoreTitleById, wide]);

  const collectedIds = useMemo(() => new Set((collections ?? []).flatMap((c) => c.scoreIds)), [collections]);
  const openCollection = collections?.find((c) => c.id === openCollectionId) ?? null;
  const unsortedCount = scores ? scores.filter((s) => !collectedIds.has(s.id)).length : 0;

  const visibleScores = useMemo(() => {
    if (!scores) return null;
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
  }, [scores, openCollectionId, openCollection, collectedIds, query, sort]);

  return (
    <div className="library-screen">
      <header className="library-header">
        <h1>Library</h1>
        <Button variant="primary" icon={<PlusIcon />} disabled={busy} onClick={() => void newScore()}>
          New score
        </Button>
      </header>

      {error && <div className="library-error">{error}</div>}

      {jumpItems.length > 0 && (
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
      )}

      {/* narrow only — the sidebar tree (AppShell) is the desktop equivalent */}
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
                className={'collection-tile' + (openCollectionId === c.id ? ' active' : '')}
                onClick={() => setOpenCollectionId(openCollectionId === c.id ? undefined : c.id)}
              >
                <FolderIcon />
                <span className="collection-tile-name">{c.name}</span>
                <span className="collection-tile-count">{scoreCount(c.scoreIds.length)}</span>
              </button>
            ))}
            {unsortedCount > 0 && (
              <button
                type="button"
                className={'collection-tile' + (openCollectionId === null ? ' active' : '')}
                onClick={() => setOpenCollectionId(openCollectionId === null ? undefined : null)}
              >
                <FolderIcon />
                <span className="collection-tile-name">Unsorted</span>
                <span className="collection-tile-count">{scoreCount(unsortedCount)}</span>
              </button>
            )}
          </div>
        )}
      </section>

      <section className="library-section">
        <div className="library-section-header">
          {openCollectionId !== undefined ? (
            <button type="button" className="back-link" onClick={() => setOpenCollectionId(undefined)}>
              <BackChevron />
              {openCollectionId === null ? 'Unsorted' : (openCollection?.name ?? '')}
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
            <div className="browse-loading">Loading…</div>
          ) : visibleScores.length === 0 ? (
            <div className="library-empty">Nothing here yet.</div>
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
