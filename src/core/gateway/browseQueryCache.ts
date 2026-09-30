import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';

export type BrowseQueryScope = 'public' | 'private';

export const BROWSE_QUERY_KEYS = {
  publicScores: 'scores:public',
  myDrafts: 'drafts:mine',
  myScores: 'scores:mine',
  myCollections: 'collections:mine',
} as const;

export const collectionScoresQueryKey = (collectionId: string) => `collection:${collectionId}:scores`;

export const authorScoresQueryKey = (authorId: string) => `author:${authorId}:scores`;

type QueryStatus = 'idle' | 'pending' | 'success' | 'error';

interface QuerySnapshot<T> {
  status: QueryStatus;
  data: T | null;
  error: unknown;
  /** The entry still holds `data`, but it was invalidated and a fresh read is due. */
  stale: boolean;
}

interface StoredQuery<T> extends QuerySnapshot<T> {
  promise: Promise<T> | null;
}

const EMPTY_SNAPSHOT: QuerySnapshot<never> = { status: 'idle', data: null, error: null, stale: false };
const queries = new Map<string, StoredQuery<unknown>>();
const listeners = new Map<string, Set<() => void>>();

function scopedKey(scope: BrowseQueryScope, key: string): string {
  return `${scope}:${key}`;
}

function emit(key: string): void {
  listeners.get(key)?.forEach((listener) => listener());
}

function snapshot<T>(key: string): QuerySnapshot<T> {
  return (queries.get(key) as StoredQuery<T> | undefined) ?? EMPTY_SNAPSHOT;
}

function ensureQuery<T>(key: string, load: () => Promise<T>): void {
  const current = queries.get(key) as StoredQuery<T> | undefined;
  if (current?.status === 'pending' || (current?.status === 'success' && !current.stale)) return;

  const promise = load();
  queries.set(key, current?.status === 'success'
    ? { ...current, stale: false, promise }
    : { status: 'pending', data: null, error: null, stale: false, promise });
  emit(key);

  void promise.then(
    (data) => {
      const latest = queries.get(key) as StoredQuery<T> | undefined;
      if (latest?.promise !== promise) return;
      queries.set(key, { status: 'success', data, error: null, stale: false, promise: null });
      emit(key);
    },
    (error: unknown) => {
      const latest = queries.get(key) as StoredQuery<T> | undefined;
      if (latest?.promise !== promise) return;
      queries.set(key, { status: 'error', data: null, error, stale: false, promise: null });
      emit(key);
    },
  );
}

/** Read-through cache for browse data. Successful reads survive route unmounts, and concurrent
 * consumers share one promise. `private` entries are cleared by the auth store at every session
 * boundary, so cached personal data is never reused after sign-out or by a different account. */
export function useBrowseQuery<T>(
  scope: BrowseQueryScope,
  key: string,
  load: () => Promise<T>,
  enabled = true,
): QuerySnapshot<T> {
  const keyWithScope = scopedKey(scope, key);
  const loadRef = useRef(load);
  const attemptedKeyRef = useRef<string | null>(null);
  loadRef.current = load;

  const subscribe = useCallback(
    (listener: () => void) => {
      let queryListeners = listeners.get(keyWithScope);
      if (!queryListeners) {
        queryListeners = new Set();
        listeners.set(keyWithScope, queryListeners);
      }
      queryListeners.add(listener);
      return () => {
        queryListeners.delete(listener);
        if (queryListeners.size === 0) listeners.delete(keyWithScope);
      };
    },
    [keyWithScope],
  );
  const getSnapshot = useCallback(
    () => (enabled ? snapshot<T>(keyWithScope) : (EMPTY_SNAPSHOT as QuerySnapshot<T>)),
    [enabled, keyWithScope],
  );
  const current = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  useEffect(() => {
    if (!enabled) return;
    const mayRetryAfterRemount = current.status === 'error' && attemptedKeyRef.current !== keyWithScope;
    if (current.status !== 'idle' && !current.stale && !mayRetryAfterRemount) return;
    attemptedKeyRef.current = keyWithScope;
    ensureQuery(keyWithScope, () => loadRef.current());
  }, [current.status, current.stale, enabled, keyWithScope]);

  return current;
}

/** Marks entries out of date. A loaded entry keeps showing its data until the next read replaces
 * it, so views never collapse into a loading state while fresh data is on its way; an entry that
 * has no data yet is dropped and loads from scratch. A read already in flight is discarded, since
 * it may predate the change that caused the invalidation. */
export function invalidateBrowseQueries(scope: BrowseQueryScope, ...keys: string[]): void {
  for (const key of keys) {
    const keyWithScope = scopedKey(scope, key);
    const current = queries.get(keyWithScope);
    if (current?.status === 'success') queries.set(keyWithScope, { ...current, stale: true, promise: null });
    else queries.delete(keyWithScope);
    emit(keyWithScope);
  }
}

/** Patches a loaded entry in place, so views showing it keep their data instead of blanking while
 * a refetch runs. An entry that is not loaded is left alone: its next load reads fresh data. */
export function updateBrowseQuery<T>(scope: BrowseQueryScope, key: string, update: (data: T) => T): void {
  const keyWithScope = scopedKey(scope, key);
  const current = queries.get(keyWithScope) as StoredQuery<T> | undefined;
  if (current?.status !== 'success' || current.data === null) return;
  queries.set(keyWithScope, { ...current, data: update(current.data) });
  emit(keyWithScope);
}

export function clearPrivateBrowseQueries(): void {
  for (const key of [...queries.keys()]) {
    if (!key.startsWith('private:')) continue;
    queries.delete(key);
    emit(key);
  }
}
