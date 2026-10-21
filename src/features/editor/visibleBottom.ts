/** The lowest on-screen y of the sheet's scroll area that no floating chrome covers. Below 1024px
 *  the tool tray and the inspector sheet float over the bottom of the sheet; each marks itself with
 *  `data-occludes-canvas`, and a hidden one (`data-open="false"`) doesn't count. On wide screens
 *  nothing floats over the sheet, so this is simply the area's bottom. */
export function visibleBottom(area: HTMLElement): number {
  const areaRect = area.getBoundingClientRect();
  let bottom = areaRect.bottom;
  window.document.querySelectorAll<HTMLElement>('[data-occludes-canvas]').forEach((el) => {
    if (el.dataset.open === 'false') return;
    const r = el.getBoundingClientRect();
    const overlapsX = r.right > areaRect.left && r.left < areaRect.right;
    const inLowerHalf = r.top > areaRect.top + areaRect.height / 2;
    if (overlapsX && inLowerHalf) bottom = Math.min(bottom, r.top);
  });
  return bottom;
}
