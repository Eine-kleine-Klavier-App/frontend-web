export interface InkBox { x: number; y: number; width: number; height: number }
export interface Placement {
  measureId: string;
  staffId: string;
  beat?: number;
  kind: 'rhythm' | 'inline' | 'attached' | 'context' | 'staff' | 'rest' | 'header' | 'bridge';
  /** a mark that lasts from one time to another (a hairpin, an octave line, a pedal) */
  timed?: boolean;
}
export interface Ink extends Placement { element: SVGGraphicsElement; box: InkBox; spacingBox?: InkBox }

/** SVG bounds in score coordinates, including the element's own transform. */
export function inkBox(element: SVGGraphicsElement): InkBox {
  // A cross-staff stem is registered as its own bridge, not as the upper note's vertical reach.
  if (element.querySelector('.vf-cross-staff-stem')) {
    const children = [...element.children].filter((child): child is SVGGraphicsElement =>
      child instanceof SVGGraphicsElement && !child.classList.contains('vf-cross-staff-stem')).map(inkBox);
    if (children.length) {
      const x = Math.min(...children.map((box) => box.x)), y = Math.min(...children.map((box) => box.y));
      return { x, y, width: Math.max(...children.map((box) => box.x + box.width)) - x,
        height: Math.max(...children.map((box) => box.y + box.height)) - y };
    }
  }
  const box = element.getBBox();
  const svg = element.ownerSVGElement;
  const root = svg?.getCTM();
  const local = element.getCTM();
  if (!root || !local) return box;
  const matrix = root.inverse().multiply(local);
  const corners = [[box.x, box.y], [box.x + box.width, box.y],
    [box.x, box.y + box.height], [box.x + box.width, box.y + box.height]]
    .map(([x, y]) => new DOMPoint(x, y).matrixTransform(matrix));
  const x = Math.min(...corners.map((p) => p.x)), y = Math.min(...corners.map((p) => p.y));
  return { x, y, width: Math.max(...corners.map((p) => p.x)) - x,
    height: Math.max(...corners.map((p) => p.y)) - y };
}
export function intersects(a: InkBox, b: InkBox, gap = 0, gapX = gap): boolean {
  return a.x < b.x + b.width + gapX && a.x + a.width + gapX > b.x &&
    a.y < b.y + b.height + gap && a.y + a.height + gap > b.y;
}

/** Monotone interval constraints: measured deficiencies can only enlarge the next engraving pass. */
export function growMinimum(map: Map<string, number>, key: string, value: number): boolean {
  if (value <= (map.get(key) ?? 0) + 0.25) return false;
  map.set(key, value);
  return true;
}

export class CollisionLayout {
  readonly items: Ink[] = [];
  constructor(readonly gap: number) {}
  add(element: Element | undefined | null, placement: Placement, spacingBox?: InkBox, span?: { x0: number; x1: number }): Ink | null {
    if (!(element instanceof SVGGraphicsElement)) return null;
    const box = span ? { ...inkBox(element), x: span.x0, width: span.x1 - span.x0 } : inkBox(element);
    if (!box.width && !box.height) return null;
    const item = { ...placement, element, box, spacingBox };
    this.items.push(item);
    element.setAttribute('data-layout-staff', placement.staffId);
    element.setAttribute('data-layout-measure', placement.measureId);
    element.setAttribute('data-layout-kind', placement.kind);
    if (placement.beat !== undefined) element.setAttribute('data-layout-beat', String(placement.beat));
    return item;
  }
  /** Point marks pass beside bridges; time-anchored spans can keep their place across them. */
  outsideOffset(box: InkBox, staffId: string, side: -1 | 1, allowBridgeOverlap = false, timed = false): { dx: number; dy: number } {
    let moved = { ...box };
    const obstacles = this.items.filter((it) => (it.staffId === staffId || it.kind === 'bridge') &&
      !(allowBridgeOverlap && it.kind === 'bridge'))
      .map((it) => ({ ...it, box: it.spacingBox ?? it.box }));
    for (let step = 0; step <= obstacles.length; step++) {
      // two timed marks that meet (one ends where the next starts) share a line: only a real overlap in time moves one of them
      const hits = obstacles.filter((it) => intersects(moved, it.box, this.gap, timed && it.timed ? 0 : this.gap));
      if (!hits.length) break;
      const bridges = hits.filter((it) => it.kind === 'bridge');
      if (bridges.length) {
        moved.x = Math.max(...bridges.map((it) => it.box.x + it.box.width + this.gap));
      } else {
        moved.y = side < 0
          ? Math.min(...hits.map((it) => it.box.y - this.gap - moved.height))
          : Math.max(...hits.map((it) => it.box.y + it.box.height + this.gap));
      }
    }
    return { dx: moved.x - box.x, dy: moved.y - box.y };
  }
  /** Floating marks move outside occupied ink; note anchors and their attachments stay together.
   *  With `span`, the mark is laid out as if it covered only that x-range (a span whose edge is being dragged
   *  keeps the place it has at rest). */
  placeOutside(element: SVGGraphicsElement, placement: Placement, side: -1 | 1, span?: { x0: number; x1: number }, allowBridgeOverlap = false): void {
    const { dx, dy } = this.outsideOffset(span ? { ...inkBox(element), x: span.x0, width: span.x1 - span.x0 } : inkBox(element), placement.staffId, side, allowBridgeOverlap, placement.timed);
    if (dx || dy) {
      const wrapper = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      wrapper.setAttribute('transform', `translate(${dx} ${dy})`);
      wrapper.append(...element.childNodes);
      element.appendChild(wrapper);
      for (const edge of ['start', 'end']) for (const [axis, shift] of [['x', dx], ['y', dy]] as const) {
        const attr = `data-context-${edge}-${axis}`;
        if (element.hasAttribute(attr)) element.setAttribute(attr, String(Number(element.getAttribute(attr)) + shift));
      }
    }
    this.add(element, placement, undefined, span);
  }
  /** A cubic slur's endpoints stay fixed; only its arch grows to clear intervening engraving. Only the
   *  engraving of `measureIds` (the slur's own system) is in its way: the same staff in another system is
   *  far below or above it, and clearing that would lift the arch a page away. `maxLift` bounds the arch
   *  whatever it finds, so a layout can never run away. */
  curveLift(x0: number, y0: number, x1: number, y1: number, initial: number, staffId: string, measureIds: ReadonlySet<string>, maxLift: number): number {
    let lift = initial;
    const side = initial < 0 ? -1 : 1;
    const obstacles = this.items.filter((it) => it.staffId === staffId && it.kind !== 'staff' && measureIds.has(it.measureId) &&
      !(it.box.x <= x0 && it.box.x + it.box.width >= x0) &&
      !(it.box.x <= x1 && it.box.x + it.box.width >= x1));
    const steps = Math.max(2, Math.ceil(Math.abs(x1 - x0) / this.gap));
    for (let i = 1; i < steps; i++) {
      const t = i / steps, u = 1 - t;
      const x = u ** 3 * x0 + 3 * u * u * t * (x0 + (x1 - x0) / 4) +
        3 * u * t * t * (x0 + (x1 - x0) * 3 / 4) + t ** 3 * x1;
      const base = (u ** 3 + 3 * u * u * t) * y0 + (3 * u * t * t + t ** 3) * y1;
      for (const it of obstacles) {
        if (x < it.box.x - this.gap || x > it.box.x + it.box.width + this.gap) continue;
        const edge = side < 0 ? it.box.y - this.gap * 2 : it.box.y + it.box.height + this.gap * 2;
        const required = (edge - base) / (3 * u * t);
        lift = side < 0 ? Math.min(lift, required) : Math.max(lift, required);
      }
    }
    return Math.max(-maxLift, Math.min(maxLift, lift));
  }
  /** Empty-measure rests have no onset anchor: choose the widest unoccupied interval. */
  restX(left: number, right: number, y: number, height: number, width: number, staffId: string, measureId: string): number | null {
    const occupied = this.items.filter((it) => it.staffId === staffId && it.measureId === measureId && it.kind !== 'staff' && it.kind !== 'rest' &&
      it.box.y < y + height + this.gap && it.box.y + it.box.height + this.gap > y)
      .map((it) => [Math.max(left, it.box.x - this.gap), Math.min(right, it.box.x + it.box.width + this.gap)])
      .filter(([a, b]) => b > a).sort((a, b) => a[0] - b[0]);
    const free: [number, number][] = [];
    let cursor = left;
    for (const [a, b] of occupied) { if (a > cursor) free.push([cursor, a]); cursor = Math.max(cursor, b); }
    if (cursor < right) free.push([cursor, right]);
    free.sort((a, b) => (b[1] - b[0]) - (a[1] - a[0]));
    const best = free.find(([a, b]) => b - a >= width + this.gap * 2);
    return best ? (best[0] + best[1]) / 2 : null;
  }
}
