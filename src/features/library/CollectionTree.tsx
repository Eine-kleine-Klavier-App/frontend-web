import { useEffect, useRef, useState, type FormEvent } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { libraryGateway } from '@/core/gateway/defaultLibraryGateway';
import type { CollectionSummary } from '@/core/gateway/LibraryGateway';
import { BROWSE_QUERY_KEYS, updateBrowseQuery, useBrowseQuery } from '@/core/gateway/browseQueryCache';
import { errorMessage } from '@/core/errorMessage';
import { withPreview } from '@/features/browse/previewRoute';
import { springSmooth } from '@/styles/motion';
import { FolderIcon, PlusIcon } from '@/ui/icons';
import { COLLECTION_PARAM, byName, collectionHref } from './collectionParam';

/** The user's collections, under the rail's tabs while Library is the active section. */
export function CollectionTree({ visible, previewId }: { visible: boolean; previewId: string | null }) {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const openId = searchParams.get(COLLECTION_PARAM);
  const { data: collections } = useBrowseQuery('private', BROWSE_QUERY_KEYS.myCollections, () => libraryGateway.listMyCollections(), visible);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const creating = useRef(false);
  const addButton = useRef<HTMLButtonElement>(null);

  const stopNaming = () => {
    setNaming(false);
    setName('');
    setError(null);
  };
  const create = async (event: FormEvent) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || creating.current) return;
    creating.current = true;
    setError(null);
    try {
      const created = await libraryGateway.createCollection(trimmed);
      updateBrowseQuery<CollectionSummary[]>('private', BROWSE_QUERY_KEYS.myCollections, (list) => [...list, created].sort(byName));
      stopNaming();
      navigate(collectionHref(created.id, previewId));
    } catch (cause) {
      setError(errorMessage(cause, 'Could not create the collection.'));
    } finally {
      creating.current = false;
    }
  };

  return (
    <AnimatePresence initial={false}>
      {visible && (
        <motion.div
          key="collections-tree"
          className="app-nav-tree"
          role="group"
          aria-label="Collections"
          initial={{ opacity: 0, y: -32 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -32 }}
          transition={springSmooth}
        >
          <span className="app-nav-tree-heading">Collections</span>
          <Link
            to={withPreview('/library', previewId)}
            className={'app-nav-tree-item' + (openId === null ? ' active' : '')}
            aria-current={openId === null ? 'page' : undefined}
          >
            All scores
          </Link>
          {collections?.map((collection) => {
            const active = collection.id === openId;
            return (
              <Link
                key={collection.id}
                className={'app-nav-tree-item' + (active ? ' active' : '')}
                to={collectionHref(collection.id, previewId)}
                title={collection.name}
                aria-current={active ? 'page' : undefined}
              >
                <FolderIcon />
                <span className="app-nav-tree-name">{collection.name}</span>
              </Link>
            );
          })}
          {naming ? (
            <form className="app-nav-tree-item app-nav-tree-new" onSubmit={(event) => void create(event)}>
              <FolderIcon />
              <input
                autoFocus
                className="app-nav-tree-input"
                aria-label="Collection name"
                placeholder="Collection name"
                maxLength={100}
                value={name}
                onChange={(event) => setName(event.target.value)}
                onBlur={() => { if (!creating.current) stopNaming(); }}
              />
            </form>
          ) : (
            <button ref={addButton} type="button" className="app-nav-tree-item app-nav-tree-add" onClick={() => setNaming(true)}>
              <PlusIcon />
              <span>New collection</span>
            </button>
          )}
          {error && <p className="app-nav-tree-error" role="alert">{error}</p>}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
