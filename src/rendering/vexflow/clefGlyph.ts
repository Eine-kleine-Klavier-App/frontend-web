// A single real SMuFL glyph (from VexFlow's Bravura), rendered once to SVG markup for the score
// COVER colophon (docs/browse-redesign.md). Using the actual engraving font — not a hand-drawn
// SVG — is what DESIGN.md mandates for music glyphs in the UI; it also keeps the cover mark in the
// same visual family as the engraved score.
import { Glyph, Renderer } from 'vexflow';

export interface GlyphMarkup {
  /** `<path>` outerHTML, translated so the glyph's bounding box starts at (0,0). */
  markup: string;
  /** viewBox string sized exactly to the glyph, so it scales cleanly into any square. */
  viewBox: string;
}

const cache = new Map<string, GlyphMarkup>();

let scratchHost: HTMLDivElement | null = null;
function getScratchHost(): HTMLDivElement {
  if (scratchHost) return scratchHost;
  scratchHost = document.createElement('div');
  scratchHost.style.position = 'absolute';
  scratchHost.style.top = '0';
  scratchHost.style.left = '-9999px';
  scratchHost.style.visibility = 'hidden';
  scratchHost.style.pointerEvents = 'none';
  document.body.appendChild(scratchHost);
  return scratchHost;
}

/** SVG for a SMuFL glyph by VexFlow code (e.g. 'gClef', 'gClefFlat'…), cached. Returns null if
 *  the glyph can't be rendered (defensive — the caller falls back to a plain cover). */
export function getGlyphMarkup(code: string, pointSize = 120): GlyphMarkup | null {
  const key = `${code}:${pointSize}`;
  const cached = cache.get(key);
  if (cached) return cached;
  try {
    const host = getScratchHost();
    host.innerHTML = '';
    const renderer = new Renderer(host, Renderer.Backends.SVG);
    renderer.resize(pointSize * 3, pointSize * 3);
    const ctx = renderer.getContext();
    const glyph = new Glyph(code, pointSize);
    glyph.setContext(ctx);
    glyph.render(ctx, pointSize, pointSize * 2);
    const svg = host.querySelector('svg');
    const path = svg?.querySelector<SVGPathElement>('path');
    if (!path) return null;
    const bb = path.getBBox();
    if (!bb.width || !bb.height) return null;
    // translate the path so its bbox origin is (0,0); viewBox then hugs the glyph exactly.
    const g = `<g transform="translate(${(-bb.x).toFixed(2)} ${(-bb.y).toFixed(2)})">${path.outerHTML}</g>`;
    const result: GlyphMarkup = { markup: g, viewBox: `0 0 ${bb.width.toFixed(2)} ${bb.height.toFixed(2)}` };
    cache.set(key, result);
    return result;
  } catch {
    return null;
  }
}
