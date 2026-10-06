import { useEffect, useRef, useState, type FormEvent } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { libraryGateway } from '@/core/gateway/defaultLibraryGateway';
import type { CollectionSummary } from '@/core/gateway/LibraryGateway';
import { BROWSE_QUERY_KEYS, collectionScoresQueryKey, invalidateBrowseQueries, updateBrowseQuery, useBrowseQuery } from '@/core/gateway/browseQueryCache';
import { errorMessage } from '@/core/errorMessage';
import { byName } from '@/features/library/collectionParam';
import { glassSettleMotion } from '@/styles/motion';
import { CheckIcon, FolderIcon, FolderPlusIcon, PlusIcon } from '@/ui/icons';
import { PanelToolbarControl } from '@/ui/PanelToolbar';
import { useDismiss } from '@/ui/useDismiss';

/** Puts the open score into, or takes it out of, the user's collections. Only the score shown in
 *  the panel is affected. */
export function CollectionPicker({ scoreId }: { scoreId: string }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const reduce = useReducedMotion();
  const { surface } = glassSettleMotion(reduce, -6);
  const { data: collections, status, error: loadError } = useBrowseQuery(
    'private', BROWSE_QUERY_KEYS.myCollections, () => libraryGateway.listMyCollections(), open,
  );
  const [held, setHeld] = useState<ReadonlySet<string> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('');
  const busy = useRef(false);

  const close = () => {
    setOpen(false);
    setNaming(false);
    setName('');
  };
  useDismiss(open, [rootRef], close, 'mousedown');
  useEffect(close, [scoreId]);
  useEffect(() => {
    if (!open) return;
    let current = true;
    setHeld(null);
    setError(null);
    libraryGateway.listScoreCollectionIds(scoreId)
      .then((ids) => { if (current) setHeld(new Set(ids)); })
      .catch((cause) => { if (current) setError(errorMessage(cause, 'Could not load your collections.')); });
    return () => { current = false; };
  }, [open, scoreId]);
  useEffect(() => {
    if (open && held) listRef.current?.querySelector<HTMLElement>('button:not(:disabled)')?.focus({ preventScroll: true });
  }, [open, held === null]);

  const changeCount = (collectionId: string, delta: number) =>
    updateBrowseQuery<CollectionSummary[]>('private', BROWSE_QUERY_KEYS.myCollections, (list) =>
      list.map((entry) => (entry.id === collectionId ? { ...entry, scoreCount: entry.scoreCount + delta } : entry)));
  const toggle = async (collection: CollectionSummary) => {
    if (busy.current || !held) return;
    busy.current = true;
    setError(null);
    const holds = held.has(collection.id);
    try {
      if (holds) await libraryGateway.removeScoreFromCollection(collection.id, scoreId);
      else await libraryGateway.addScoreToCollection(collection.id, scoreId);
      const next = new Set(held);
      if (holds) next.delete(collection.id);
      else next.add(collection.id);
      setHeld(next);
      changeCount(collection.id, holds ? -1 : 1);
      invalidateBrowseQueries('private', collectionScoresQueryKey(collection.id));
    } catch (cause) {
      setError(errorMessage(cause, 'Could not update the collection.'));
    } finally {
      busy.current = false;
    }
  };
  const create = async (event: FormEvent) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || busy.current || !held) return;
    busy.current = true;
    setError(null);
    try {
      const created = await libraryGateway.createCollection(trimmed);
      updateBrowseQuery<CollectionSummary[]>('private', BROWSE_QUERY_KEYS.myCollections, (list) => [...list, created].sort(byName));
      await libraryGateway.addScoreToCollection(created.id, scoreId);
      setHeld(new Set(held).add(created.id));
      changeCount(created.id, 1);
      setNaming(false);
      setName('');
    } catch (cause) {
      setError(errorMessage(cause, 'Could not create the collection.'));
    } finally {
      busy.current = false;
    }
  };

  return (
    <div
      className="collection-picker"
      ref={rootRef}
    >
      <PanelToolbarControl ref={triggerRef} aria-label="Add to collection" title="Add to collection" aria-haspopup="dialog" aria-expanded={open}
        onClick={() => (open ? close() : setOpen(true))}>
        <FolderPlusIcon />
      </PanelToolbarControl>
      <AnimatePresence>
        {open && (
          <motion.div className="dropdown-menu collection-menu" role="dialog" aria-label="Add to collection" {...surface}>
            <span className="collection-menu-label">Add to collection</span>
            {status === 'error' && <p className="collection-menu-note" role="alert">{errorMessage(loadError, 'Could not load your collections.')}</p>}
            <ul className="dropdown-menu-list" ref={listRef}>
              {collections?.map((collection) => {
                const holds = held?.has(collection.id) ?? false;
                return (
                  <li key={collection.id}>
                    <button type="button" aria-pressed={holds} disabled={!held} title={collection.name}
                      className={'dropdown-option collection-option' + (holds ? ' selected' : '')}
                      onClick={() => void toggle(collection)}>
                      <span className={'collection-check' + (holds ? ' on' : '')}>{holds && <CheckIcon />}</span>
                      <FolderIcon />
                      <span className="collection-option-name">{collection.name}</span>
                    </button>
                  </li>
                );
              })}
              {collections?.length === 0 && <li className="collection-menu-note">You have no collections yet.</li>}
              <li>
                {naming ? (
                  <form className="collection-option collection-option-new" onSubmit={(event) => void create(event)}>
                    <PlusIcon />
                    <input autoFocus className="collection-option-input" aria-label="Collection name" placeholder="Collection name" maxLength={100}
                      value={name} onChange={(event) => setName(event.target.value)} />
                  </form>
                ) : (
                  <button type="button" className="dropdown-option collection-option" disabled={!held} onClick={() => setNaming(true)}>
                    <PlusIcon />
                    <span className="collection-option-name">New collection…</span>
                  </button>
                )}
              </li>
            </ul>
            {error && <p className="collection-menu-note" role="alert">{error}</p>}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
