/** A CSS length token resolved to pixels in `el`'s context. `getPropertyValue('--x')` only returns
 *  the token's text (e.g. `calc(var(--u) * 8)`), so a hidden probe sized by the token measures it.
 *  Lets layout code read its constants from the stylesheet — one source — instead of duplicating
 *  pixel numbers in TS. */
export function readCssLength(el: Element, token: string): number {
  const probe = document.createElement('div');
  probe.style.cssText = `position:absolute;visibility:hidden;pointer-events:none;width:var(${token})`;
  el.appendChild(probe);
  const px = probe.getBoundingClientRect().width;
  probe.remove();
  return px;
}
