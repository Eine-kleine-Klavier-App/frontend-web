import type { CollectionSummary } from '@/core/gateway/LibraryGateway';
import { withPreview } from '@/features/browse/previewRoute';

/** The open collection lives in the URL, so the rail's tree and the Library page read one source
 *  and a collection can be linked to. */
export const COLLECTION_PARAM = 'collection';

export function collectionHref(collectionId: string, previewId: string | null): string {
  return withPreview(`/library?${COLLECTION_PARAM}=${encodeURIComponent(collectionId)}`, previewId);
}

/** The order the backend lists collections in. */
export function byName(a: CollectionSummary, b: CollectionSummary): number {
  return a.name.toLowerCase().localeCompare(b.name.toLowerCase()) || a.id.localeCompare(b.id);
}
