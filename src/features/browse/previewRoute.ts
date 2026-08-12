/** Carries the selected score across browse-shell routes without leaking route-local state such
 *  as search or collection filters. The preview closes only when its own Close action removes
 *  the param; ordinary navigation changes the context underneath it. */
export function withPreview(path: string, previewId: string | null): string {
  if (!previewId) return path;
  const queryAt = path.indexOf('?');
  const pathname = queryAt === -1 ? path : path.slice(0, queryAt);
  const params = new URLSearchParams(queryAt === -1 ? '' : path.slice(queryAt + 1));
  params.set('preview', previewId);
  return `${pathname}?${params.toString()}`;
}
