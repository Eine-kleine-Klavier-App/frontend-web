// The selected collection lives in the URL (`?collection=`), not local component state —
// both the sidebar tree (AppShell) and the Library page itself need to read/drive the same
// selection, and a URL is the shared source of truth react-router already gives us for free
// (also makes the selection linkable/bookmarkable, a nice side effect of not inventing a store).
export const UNSORTED_PARAM = 'unsorted';

/** `undefined` = show everything (no filter), `null` = the Unsorted bucket, otherwise a real
 *  collection id. Absent query param decodes to `undefined`. */
export function collectionParamToId(param: string | null): string | null | undefined {
  if (param === null) return undefined;
  if (param === UNSORTED_PARAM) return null;
  return param;
}

export function collectionIdToSearchParams(id: string | null | undefined): Record<string, string> {
  if (id === undefined) return {};
  return { collection: id === null ? UNSORTED_PARAM : id };
}
