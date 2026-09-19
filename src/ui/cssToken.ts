/** A CSS custom property's value as written in the stylesheet, read in `el`'s context — for code
 *  that paints outside CSS (a canvas, an inline style set from script) so its values keep one
 *  source. Lengths that must be resolved to pixels use `readCssLength` instead. */
export function readCssToken(el: Element, token: string): string {
  return getComputedStyle(el).getPropertyValue(token).trim();
}
