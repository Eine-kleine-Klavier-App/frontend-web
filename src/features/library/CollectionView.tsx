import { useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { usePageReady } from '@/ui/PageTransition';
import { createPortal } from 'react-dom';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { libraryGateway } from '@/core/gateway/defaultLibraryGateway';
import type { CollectionSummary, ScoreSummary } from '@/core/gateway/LibraryGateway';
import { BROWSE_QUERY_KEYS, collectionScoresQueryKey, updateBrowseQuery, useBrowseQuery } from '@/core/gateway/browseQueryCache';
import { errorMessage } from '@/core/errorMessage';
import { PieceCard } from '@/features/browse/PieceCard';
import { Button } from '@/ui/Button';
import { DelayedLoading } from '@/ui/DelayedLoading';
import { FadeSwap } from '@/ui/FadeSwap';
import { ArrowLeftIcon, CloseIcon, EditIcon, TrashIcon } from '@/ui/icons';
import { byName } from './collectionParam';

/** One collection's scores. Removing a score only takes it out of the collection. */
export default function CollectionView({ collectionId }: { collectionId: string }) {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { data: collections, status: collectionsStatus, error: collectionsError } = useBrowseQuery(
    'private', BROWSE_QUERY_KEYS.myCollections, () => libraryGateway.listMyCollections(),
  );
  const collection = collections?.find((candidate) => candidate.id === collectionId) ?? null;
  const scoresKey = collectionScoresQueryKey(collectionId);
  const { data: scores, status: scoresStatus, error: scoresError } = useBrowseQuery(
    'private', scoresKey, () => libraryGateway.listCollectionScores(collectionId), collection !== null,
  );
  usePageReady(collectionsStatus === 'error' ||
    (collections !== null && (!collection || scores !== null || scoresStatus === 'error')));
  const previewId = searchParams.get('preview');
  const query = searchParams.get('q')?.trim().toLocaleLowerCase() ?? '';
  const visibleScores = useMemo(() => (scores ?? []).filter((score) =>
    !query || score.title.toLocaleLowerCase().includes(query) ||
    (score.composer?.toLocaleLowerCase().includes(query) ?? false)), [scores, query]);

  const [error, setError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [draftName, setDraftName] = useState('');
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const deleteDialog = useRef<HTMLDialogElement>(null);
  const deleteOpener = useRef<HTMLButtonElement | null>(null);
  const renameButton = useRef<HTMLButtonElement>(null);
  const mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const wasRenaming = useRef(false);
  useEffect(() => {
    if (!renaming && wasRenaming.current) renameButton.current?.focus({ preventScroll: true });
    wasRenaming.current = renaming;
  }, [renaming]);
  useLayoutEffect(() => {
    const element = deleteDialog.current;
    if (!confirmingDelete || !element) return;
    const opener = deleteOpener.current;
    element.showModal();
    return () => {
      element.close();
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, [confirmingDelete]);

  const openScore = (score: ScoreSummary) => {
    const next = new URLSearchParams(searchParams);
    next.set('preview', score.id);
    setSearchParams(next);
  };
  const removeScore = async (score: ScoreSummary) => {
    setError(null);
    try {
      await libraryGateway.removeScoreFromCollection(collectionId, score.id);
      updateBrowseQuery<ScoreSummary[]>('private', scoresKey, (list) => list.filter((entry) => entry.id !== score.id));
      updateBrowseQuery<CollectionSummary[]>('private', BROWSE_QUERY_KEYS.myCollections, (list) =>
        list.map((entry) => (entry.id === collectionId ? { ...entry, scoreCount: entry.scoreCount - 1 } : entry)));
    } catch (cause) {
      setError(errorMessage(cause, 'Could not remove the score.'));
    }
  };
  const rename = async (event: FormEvent) => {
    event.preventDefault();
    const trimmed = draftName.trim();
    if (!trimmed || !collection) return;
    setError(null);
    try {
      if (trimmed !== collection.name) {
        await libraryGateway.renameCollection(collectionId, trimmed);
        updateBrowseQuery<CollectionSummary[]>('private', BROWSE_QUERY_KEYS.myCollections, (list) =>
          list.map((entry) => (entry.id === collectionId ? { ...entry, name: trimmed } : entry)).sort(byName));
      }
      setRenaming(false);
    } catch (cause) {
      setError(errorMessage(cause, 'Could not rename the collection.'));
    }
  };
  const deleteCollection = async () => {
    setDeleting(true);
    setError(null);
    try {
      await libraryGateway.deleteCollection(collectionId);
      updateBrowseQuery<CollectionSummary[]>('private', BROWSE_QUERY_KEYS.myCollections, (list) =>
        list.filter((entry) => entry.id !== collectionId));
      navigate('/library');
    } catch (cause) {
      if (mounted.current) { setConfirmingDelete(false); setError(errorMessage(cause, 'Could not delete the collection.')); }
    } finally {
      if (mounted.current) setDeleting(false);
    }
  };

  if (!collection) {
    return (
      <div className="library-screen">
        <div className="library-heading"><Link className="back-link" to="/library"><ArrowLeftIcon />Back to Library</Link></div>
        {collectionsStatus === 'error' ? (
          <div className="library-error" role="alert">{errorMessage(collectionsError, 'Could not load collections.')}</div>
        ) : collections ? (
          <div className="library-empty">This collection does not exist.</div>
        ) : <DelayedLoading>Loading…</DelayedLoading>}
      </div>
    );
  }

  return (
    <>
    <div className="library-screen">
      <header className="library-header">
        <div className="library-heading">
          {renaming ? (
            <form className="collection-rename" onSubmit={(event) => void rename(event)}>
              <input autoFocus className="collection-rename-input" aria-label="Collection name" maxLength={100}
                value={draftName} onChange={(event) => setDraftName(event.target.value)} />
              <Button variant="primary" type="submit" disabled={!draftName.trim()}>Save</Button>
              <Button onClick={() => setRenaming(false)}>Cancel</Button>
            </form>
          ) : (
            <h1>{collection.name}</h1>
          )}
          <span className="library-count">Private · {collection.scoreCount} {collection.scoreCount === 1 ? 'score' : 'scores'}</span>
        </div>
        {!renaming && (
          <div className="collection-actions">
            <button ref={renameButton} type="button" className="icon-btn" aria-label="Rename collection" title="Rename collection"
              onClick={() => { setDraftName(collection.name); setRenaming(true); }}><EditIcon /></button>
            <button type="button" className="icon-btn" aria-label="Delete collection" title="Delete collection"
              onClick={(event) => { deleteOpener.current = event.currentTarget; setConfirmingDelete(true); }}><TrashIcon /></button>
          </div>
        )}
      </header>
      {error && <div className="library-error" role="alert">{error}</div>}
      {scoresStatus === 'error' && <div className="library-error" role="alert">{errorMessage(scoresError, 'Could not load scores.')}</div>}
      <FadeSwap stateKey={!scores ? scoresStatus : visibleScores.length ? 'content' : 'empty'}>
        {!scores ? scoresStatus === 'error' ? null : <DelayedLoading>Loading…</DelayedLoading> : visibleScores.length === 0 ? (
          <div className="library-empty">
            {query ? 'No scores match your search.' : 'Open a score and press the folder icon in its panel to put it here.'}
          </div>
        ) : (
          <div className="piece-grid">
            {visibleScores.map((score) => (
              <div className="collection-entry" key={score.id}>
                <PieceCard score={score} onOpen={openScore} active={score.id === previewId} />
                <button type="button" className="icon-btn collection-entry-remove" aria-label={`Remove ${score.title} from this collection`}
                  title="Remove from collection" onClick={() => void removeScore(score)}><CloseIcon /></button>
              </div>
            ))}
          </div>
        )}
      </FadeSwap>
    </div>
    {confirmingDelete && createPortal(
      <dialog ref={deleteDialog} className="save-score-dialog draft-delete-dialog" aria-labelledby="delete-collection-title"
        onCancel={(event) => { event.preventDefault(); if (!deleting) setConfirmingDelete(false); }}>
        <h2 id="delete-collection-title">Delete collection?</h2>
        <p>Delete “{collection.name}”? The collection is removed. The scores themselves are not deleted.</p>
        <div className="save-score-actions">
          <Button autoFocus disabled={deleting} onClick={() => setConfirmingDelete(false)}>Cancel</Button>
          <Button className="draft-delete-action" disabled={deleting} onClick={() => void deleteCollection()}>
            {deleting ? 'Deleting…' : 'Delete'}
          </Button>
        </div>
      </dialog>, document.body)}
    </>
  );
}
