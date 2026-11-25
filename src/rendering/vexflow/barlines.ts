// The one drawing of a barline, whatever it is: a plain line between measures, the closing line of a piece, the sign that begins a repeat
// and the sign that ends one. A barline is made of the same parts everywhere (a thin line, a thick bar, two dots on each staff); its kind
// says which parts it has and on which side of the line they stand. The staves draw no barlines of their own.
import { REPEAT_BAR_HALF, REPEAT_DOT_OFFSET, REPEAT_DOT_RADIUS, REPEAT_THIN_OFFSET, STAFF_SPACE } from './engravingScale';

export type BarlineKind = 'single' | 'final' | 'repeatBegin' | 'repeatEnd';

const SVG_NS = 'http://www.w3.org/2000/svg';

interface BarlineParts {
  /** where the thin line stands relative to the barline, in the direction of the sign (+1 to the right, -1 to the left); null: on the barline itself */
  thin: 1 | -1 | null;
  thick: boolean;
  /** which side the dots stand on; null: none */
  dots: 1 | -1 | null;
}

const PARTS: Record<BarlineKind, BarlineParts> = {
  single: { thin: null, thick: false, dots: null },
  final: { thin: -1, thick: true, dots: null },
  repeatBegin: { thin: 1, thick: true, dots: 1 },
  repeatEnd: { thin: -1, thick: true, dots: -1 },
};

export interface BarlineDrawing {
  parent: Element;
  kind: BarlineKind;
  /** the x of the barline */
  x: number;
  /** the top line of the highest staff and the bottom line of the lowest: the bars run through every staff and the gap between them */
  top: number;
  bottom: number;
  /** the bottom line of each staff, for its dots */
  staffBottoms: readonly number[];
  ink: string;
}

export function drawBarline({ parent, kind, x, top, bottom, staffBottoms, ink }: BarlineDrawing): void {
  const parts: BarlineParts = PARTS[kind];
  const add = (tag: string, attributes: Record<string, string | number>): void => {
    const node: Element = document.createElementNS(SVG_NS, tag);
    for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, String(value));
    parent.appendChild(node);
  };
  if (parts.thick) add('rect', { x: x - REPEAT_BAR_HALF, y: top, width: 2 * REPEAT_BAR_HALF, height: bottom - top, fill: ink });
  const thinX: number = x + (parts.thin ?? 0) * REPEAT_THIN_OFFSET;
  add('line', { x1: thinX, x2: thinX, y1: top, y2: bottom, stroke: ink, 'stroke-width': 1 });
  if (parts.dots === null) return;
  const dotX: number = x + parts.dots * REPEAT_DOT_OFFSET;
  for (const staffBottom of staffBottoms) {
    for (const lift of [1.5, 2.5]) add('circle', { cx: dotX, cy: staffBottom - lift * STAFF_SPACE, r: REPEAT_DOT_RADIUS, fill: ink });
  }
}
