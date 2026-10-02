import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { libraryGateway } from '@/core/gateway/defaultLibraryGateway';
import type { DraftSummary, ScoreSummary } from '@/core/gateway/LibraryGateway';
import { PieceCard } from '@/features/browse/PieceCard';
import { ScoreCover } from '@/features/browse/ScoreCover';
import { Dropdown } from '@/ui/Dropdown';
import { ArrowLeftIcon, PlusIcon } from '@/ui/icons';
import { Button } from '@/ui/Button';
import { FadeSwap } from '@/ui/FadeSwap';
import { useAuthStore } from '@/core/auth/authStore';
import { requireAuth } from '@/core/auth/authPrompt';
import { BROWSE_QUERY_KEYS, invalidateBrowseQueries, useBrowseQuery } from '@/core/gateway/browseQueryCache';
import { DelayedLoading } from '@/ui/DelayedLoading';
import { errorMessage } from '@/core/errorMessage';

type SortKey = 'recent' | 'title' | 'composer';
const SORTS: { value: SortKey; label: string }[] = [
  { value: 'recent', label: 'Recently updated' },
  { value: 'title', label: 'Title' },
  { value: 'composer', label: 'Composer' },
];

function relativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const min = Math.round(ms / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.round(hr / 24)}d ago`;
}

function DraftWorkCard({ draft }: { draft: DraftSummary }) {
  const navigate = useNavigate();
  return (
    <button type="button" className="work-card" data-draft-id={draft.id}
      onClick={() => navigate(`/edit/${encodeURIComponent(draft.id)}`)}>
      <div className="work-card-thumb"><ScoreCover score={draft} /></div>
      <div className="work-card-main">
        <span className="work-card-title" title={draft.title}>{draft.title}</span>
        <span className="work-card-when">{relativeTime(draft.updatedAt)}</span>
      </div>
    </button>
  );
}

export default function LibraryScreen({ draftsOnly = false }: { draftsOnly?: boolean }) {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [sort, setSort] = useState<SortKey>('recent');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<DraftSummary | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const deleteLock = useRef(false);
  const deleted = useRef(false);
  const deleteOpener = useRef<HTMLButtonElement | null>(null);
  const deleteDialog = useRef<HTMLDialogElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useLayoutEffect(() => {
    const element = deleteDialog.current;
    if (!deleteTarget || !element) return;
    const opener = deleteOpener.current;
    element.showModal();
    return () => {
      element.close();
      if (deleted.current) heading.current?.focus({ preventScroll: true });
      else if (opener instanceof HTMLElement && opener.isConnected) opener.focus({ preventScroll: true });
    };
  }, [deleteTarget]);
  const authed = useAuthStore((s) => s.status === 'authed');
  const { data: drafts, status: draftsStatus, error: draftsError } = useBrowseQuery(
    'private', BROWSE_QUERY_KEYS.myDrafts, () => libraryGateway.listMyDrafts(), authed,
  );
  const refreshDraftsOnEntry = useRef(draftsStatus === 'success');
  useEffect(() => {
    if (!refreshDraftsOnEntry.current) return;
    refreshDraftsOnEntry.current = false;
    invalidateBrowseQueries('private', BROWSE_QUERY_KEYS.myDrafts);
  }, []);
  const { data: scores, status: scoresStatus, error: scoresError } = useBrowseQuery(
    'private', BROWSE_QUERY_KEYS.myScores, () => libraryGateway.listMyScores(), authed && !draftsOnly,
  );
  const previewId = searchParams.get('preview');
  const query = searchParams.get('q')?.trim().toLocaleLowerCase() ?? '';
  const recentDrafts = useMemo(() => [...(drafts ?? [])].sort((a, b) =>
    b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id)), [drafts]);
  const visibleDrafts = useMemo(() => {
    const list = recentDrafts.filter(draft => !query || draft.title.toLocaleLowerCase().includes(query));
    return draftsOnly && sort === 'title' ? [...list].sort((a, b) =>
      a.title.localeCompare(b.title) || a.id.localeCompare(b.id)) : list;
  }, [recentDrafts, query, draftsOnly, sort]);
  const visibleScores = useMemo(() => {
    const list = (scores ?? []).filter((score) =>
      !query || score.title.toLocaleLowerCase().includes(query) ||
      (score.composer?.toLocaleLowerCase().includes(query) ?? false));
    return [...list].sort((a, b) => {
      if (sort === 'title') return a.title.localeCompare(b.title);
      if (sort === 'composer') return (a.composer ?? '').localeCompare(b.composer ?? '');
      return b.updatedAt.localeCompare(a.updatedAt);
    });
  }, [scores, query, sort]);

  const openScore = (score: ScoreSummary) => {
    const next = new URLSearchParams(searchParams);
    next.set('preview', score.id);
    setSearchParams(next);
  };
  const newScore = () => requireAuth(async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const { draftId } = await libraryGateway.createDraft();
      invalidateBrowseQueries('private', BROWSE_QUERY_KEYS.myDrafts);
      navigate(`/edit/${draftId}`);
    } catch (cause) {
      setError(errorMessage(cause, 'Failed to create a draft.'));
    } finally {
      setBusy(false);
    }
  });

  const requestDelete = (draft: DraftSummary, trigger: HTMLButtonElement) => {
    deleteOpener.current = trigger;
    deleted.current = false;
    setDeleteError(null);
    setDeleteTarget(draft);
  };
  const deleteDraft = async () => {
    if (!deleteTarget || deleteLock.current) return;
    deleteLock.current = true; setDeleting(true); setDeleteError(null);
    try {
      await libraryGateway.deleteDraft(deleteTarget.id);
      invalidateBrowseQueries('private', BROWSE_QUERY_KEYS.myDrafts);
      if (mounted.current) { deleted.current = true; setDeleteTarget(null); }
    } catch (cause) {
      if (mounted.current) setDeleteError(errorMessage(cause, 'Could not delete draft.'));
    } finally {
      deleteLock.current = false;
      if (mounted.current) setDeleting(false);
    }
  };

  if (!authed) return null;
  return (
    <>
    <div className="library-screen">
      <header className="library-header">
        <div className="library-heading">
          {draftsOnly && <Link className="back-link" to="/library"><ArrowLeftIcon />Back to Library</Link>}
          <h1 ref={heading} tabIndex={-1}>{draftsOnly ? 'Drafts' : 'Library'}</h1>
        </div>
        <Button variant="primary" icon={<PlusIcon />} disabled={busy} onClick={() => void newScore()}>New score</Button>
      </header>
      {error && <div className="library-error" role="alert">{error}</div>}
      {draftsStatus === 'error' && <div className="library-error" role="alert">{errorMessage(draftsError, 'Could not load drafts.')}</div>}
      {scoresStatus === 'error' && <div className="library-error" role="alert">{errorMessage(scoresError, 'Could not load scores.')}</div>}

      {draftsOnly ? (
        <section className="library-section" aria-label="All drafts">
          <div className="library-section-header">
            {drafts && <span className="library-count">{visibleDrafts.length} drafts</span>}
            <div className="library-sort">
              <span className="library-sort-label">Sort</span>
              <Dropdown value={sort} options={SORTS.filter(option => option.value !== 'composer')}
                onChange={setSort} label="Sort drafts" />
            </div>
          </div>
          <FadeSwap stateKey={!drafts ? draftsStatus : visibleDrafts.length ? 'content' : 'empty'}>
            {!drafts ? draftsStatus === 'error' ? null : <DelayedLoading>Loading…</DelayedLoading>
              : visibleDrafts.length === 0 ? (
                <div className="library-empty">{query ? 'No drafts match your search.' : 'No drafts yet.'}</div>
              ) : (
                <div className="draft-grid">
                  {visibleDrafts.map(draft => (
                    <div className="draft-entry" key={draft.id}>
                      <DraftWorkCard draft={draft} />
                      <Button variant="ghost" className="draft-delete-action" aria-label={`Delete ${draft.title}`}
                        onClick={event => requestDelete(draft, event.currentTarget)}>Delete</Button>
                    </div>
                  ))}
                </div>
              )}
          </FadeSwap>
        </section>
      ) : (
        <section className="library-section" aria-label="Continue editing">
          <div className="library-section-header">
            <h2>Continue editing</h2>
            <Link className="library-drafts-link" to="/library/drafts">See all</Link>
          </div>
          <FadeSwap stateKey={!drafts ? draftsStatus : visibleDrafts.length ? 'content' : 'empty'}>
          {!drafts ? draftsStatus === 'error' ? null : <DelayedLoading>Loading…</DelayedLoading>
            : visibleDrafts.length > 0 ? (
              <div className="jump-track">
                {visibleDrafts.slice(0, 6).map(draft => <DraftWorkCard key={draft.id} draft={draft} />)}
              </div>
            ) : <div className="library-empty">{query ? 'No drafts match your search.' : 'No drafts yet.'}</div>}
          </FadeSwap>
        </section>
      )}

      {!draftsOnly && <section className="library-section">
        <div className="library-section-header">
          <h2>Your scores</h2>
          <div className="library-section-tools">
            {scores && <span className="library-count">{visibleScores.length} scores</span>}
            <div className="library-sort">
              <span className="library-sort-label">Sort</span>
              <Dropdown value={sort} options={SORTS} onChange={setSort} label="Sort scores" />
            </div>
          </div>
        </div>
        <FadeSwap stateKey={!scores ? scoresStatus : visibleScores.length ? 'content' : 'empty'}>
          {!scores ? <DelayedLoading>Loading…</DelayedLoading> : visibleScores.length === 0 ? (
            <div className="library-empty">{query ? 'No scores match your search.' : 'Nothing here yet.'}</div>
          ) : (
            <div className="piece-grid">
              {visibleScores.map((score) => (
                <PieceCard key={score.id} score={score} onOpen={openScore} active={score.id === previewId} />
              ))}
            </div>
          )}
        </FadeSwap>
      </section>}
    </div>
    {deleteTarget && createPortal(
      <dialog ref={deleteDialog} className="save-score-dialog draft-delete-dialog" aria-labelledby="delete-draft-title"
        onCancel={event => { event.preventDefault(); if (!deleteLock.current) setDeleteTarget(null); }}>
        <h2 id="delete-draft-title">Delete draft?</h2>
        <p>Delete “{deleteTarget.title}”? Only this working copy will be removed. Saved scores are kept.</p>
        {deleteError && <p className="save-score-error" role="alert">{deleteError}</p>}
        <div className="save-score-actions">
          <Button autoFocus disabled={deleting} onClick={() => setDeleteTarget(null)}>Cancel</Button>
          <Button className="draft-delete-action" disabled={deleting} onClick={() => void deleteDraft()}>
            {deleting ? 'Deleting…' : 'Delete'}
          </Button>
        </div>
      </dialog>, document.body)}
    </>
  );
}
