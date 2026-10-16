/** A hidden element to draw VexFlow into off screen and measure what it drew. `visibility:hidden`
 *  (not `display:none`) keeps the SVG laid out for `getBBox()`; it is pinned off-screen so it never
 *  takes room in the page's layout or adds to its scroll height. */
export function createScratchHost(): HTMLDivElement {
  const host = document.createElement('div');
  host.style.position = 'absolute';
  host.style.top = '0';
  host.style.left = '-9999px';
  host.style.visibility = 'hidden';
  host.style.pointerEvents = 'none';
  document.body.appendChild(host);
  return host;
}
