import type { Presentation, PresentationChange, PresentationTarget } from './presentation';

export interface Point { x: number; y: number }
/** The slur's Bézier control polygon: the chord ends (p0, p3) and the two control points (c1, c2). */
export interface SlurFrame { p0: Point; p3: Point; c1: Point; c2: Point }
export type SlurHandle = 'top' | 'topLeft' | 'topRight' | 'edgeLeft' | 'edgeMiddle' | 'edgeRight';
export const SLUR_HANDLES: readonly SlurHandle[] = ['top', 'topLeft', 'topRight', 'edgeLeft', 'edgeMiddle', 'edgeRight'];

/** What a handle does, for drawing it: the top corners also change the span (a sideways pull), the top middle moves the whole slur, the rest only reshape it. */
export const SLUR_HANDLE_ROLES: Record<SlurHandle, 'span' | 'move' | 'shape'> = {
  top: 'move', topLeft: 'span', topRight: 'span', edgeLeft: 'shape', edgeMiddle: 'shape', edgeRight: 'shape',
};

/** Every offset is a fraction of the slur's frame (see `frameSize`): vertical of its arch height, sideways of its width; vertical is positive down, horizontal positive right. */
export interface SlurOffsets {
  bodyVertical: number; bodyLeft: number; bodyRight: number;
  edgeVertical: number; edgeLeft: number; edgeRight: number;
  horizontal: number; horizontalLeft: number; horizontalRight: number;
}
export const noSlurOffsets: SlurOffsets = {
  bodyVertical: 0, bodyLeft: 0, bodyRight: 0, edgeVertical: 0, edgeLeft: 0, edgeRight: 0,
  horizontal: 0, horizontalLeft: 0, horizontalRight: 0,
};

const body = (id: string): PresentationTarget => ({ entity_id: id, reference: 'body' });
const lowerEdge = (id: string): PresentationTarget => ({ entity_id: id, reference: 'lower_edge' });
const matches = (value: PresentationTarget, target: PresentationTarget): boolean =>
  value.entity_id === target.entity_id && value.reference === target.reference;

export function slurOffsets(presentation: Presentation, id: string): SlurOffsets {
  const bodyTarget: PresentationTarget = body(id);
  const edgeTarget: PresentationTarget = lowerEdge(id);
  const bodyEnds = presentation.endpoints.find(value => matches(value, bodyTarget));
  const edgeEnds = presentation.endpoints.find(value => matches(value, edgeTarget));
  const horizontalEnds = presentation.horizontal_endpoints.find(value => matches(value, edgeTarget));
  return {
    bodyVertical: presentation.vertical.find(value => matches(value, bodyTarget))?.offset ?? 0,
    bodyLeft: bodyEnds?.left ?? 0,
    bodyRight: bodyEnds?.right ?? 0,
    edgeVertical: presentation.vertical.find(value => matches(value, edgeTarget))?.offset ?? 0,
    edgeLeft: edgeEnds?.left ?? 0,
    edgeRight: edgeEnds?.right ?? 0,
    horizontal: presentation.horizontal.find(value => matches(value, edgeTarget))?.offset ?? 0,
    horizontalLeft: horizontalEnds?.left ?? 0,
    horizontalRight: horizontalEnds?.right ?? 0,
  };
}

/** The frame a slur's handles are measured in: its width, and the height of its arch above the chord. */
export function frameSize(base: SlurFrame): { w: number; h: number } {
  return { w: Math.abs(base.p3.x - base.p0.x), h: Math.abs(base.c1.y - base.p0.y) };
}

/** The arch a slur of this chord width has of itself: what its stored height multiplies. It depends on nothing but the width and the staff space. */
export function automaticArch(width: number, sp: number): number {
  return Math.min(4 * sp, Math.max(1.4 * sp, width * 0.16));
}

/** The frame after the offsets: the whole-slur lift moves all four points, the rest moves its own. */
export function framed(base: SlurFrame, offsets: SlurOffsets): SlurFrame {
  const { w, h } = frameSize(base);
  const lift: number = offsets.bodyVertical * h;
  return {
    p0: { x: base.p0.x, y: base.p0.y + lift + offsets.bodyLeft * h },
    p3: { x: base.p3.x, y: base.p3.y + lift + offsets.bodyRight * h },
    c1: {
      x: base.c1.x + (offsets.horizontal + offsets.horizontalLeft) * w,
      y: base.c1.y + lift + (offsets.edgeVertical + offsets.edgeLeft) * h,
    },
    c2: {
      x: base.c2.x + (offsets.horizontal + offsets.horizontalRight) * w,
      y: base.c2.y + lift + (offsets.edgeVertical + offsets.edgeRight) * h,
    },
  };
}

export function handlePoints(frame: SlurFrame): Record<SlurHandle, Point> {
  return {
    top: { x: (frame.p0.x + frame.p3.x) / 2, y: (frame.p0.y + frame.p3.y) / 2 },
    topLeft: frame.p0,
    topRight: frame.p3,
    edgeLeft: frame.c1,
    edgeMiddle: { x: (frame.c1.x + frame.c2.x) / 2, y: (frame.c1.y + frame.c2.y) / 2 },
    edgeRight: frame.c2,
  };
}

/** Which side of the chord the control edge lies on by default: 1 below it, -1 above it. */
const sideOf = (base: SlurFrame): 1 | -1 =>
  (base.c1.y + base.c2.y) / 2 < (base.p0.y + base.p3.y) / 2 ? -1 : 1;

/** The frame stays a trapezoid-like shape: controls inside the chord's x-range, left before right,
 *  and the control edge never crosses the chord edge. */
function isValid(frame: SlurFrame, side: 1 | -1): boolean {
  if (frame.c1.x < frame.p0.x - TOLERANCE || frame.c2.x > frame.p3.x + TOLERANCE || frame.c1.x > frame.c2.x + TOLERANCE) return false;
  for (const control of [frame.c1, frame.c2])
    if (side * (control.y - chordYAt(frame, control.x)) < -TOLERANCE) return false;
  return true;
}

/** Rounding slack, in layout units, so a point resting exactly on a wall is still inside. */
const TOLERANCE = 1e-6;

const chordYAt = (frame: SlurFrame, x: number): number => {
  const width: number = frame.p3.x - frame.p0.x;
  return width > 0 ? frame.p0.y + (frame.p3.y - frame.p0.y) * (x - frame.p0.x) / width : frame.p0.y;
};

/** The offsets pressed back into the valid shape. The offsets are fractions of the frame, but a slur whose
 *  frame has changed (its end moved, the notes spread) can still leave the shape it was stored in: the lower
 *  corners outside the chord, swapped, or across it. Drawing and dragging start from this, never from the
 *  stored values. */
export function fitted(base: SlurFrame, offsets: SlurOffsets): SlurOffsets {
  const side: 1 | -1 = sideOf(base);
  const { w, h } = frameSize(base);
  const frame: SlurFrame = framed(base, offsets);
  const left: number = Math.min(Math.max(frame.c1.x, frame.p0.x), frame.p3.x);
  const right: number = Math.min(Math.max(frame.c2.x, left), frame.p3.x);
  const placed: SlurFrame = { ...frame, c1: { x: left, y: frame.c1.y }, c2: { x: right, y: frame.c2.y } };
  const leftY: number = side === 1 ? Math.max(placed.c1.y, chordYAt(placed, left)) : Math.min(placed.c1.y, chordYAt(placed, left));
  const rightY: number = side === 1 ? Math.max(placed.c2.y, chordYAt(placed, right)) : Math.min(placed.c2.y, chordYAt(placed, right));
  return {
    ...offsets,
    horizontalLeft: offsets.horizontalLeft + (w > 0 ? (left - frame.c1.x) / w : 0),
    horizontalRight: offsets.horizontalRight + (w > 0 ? (right - frame.c2.x) / w : 0),
    edgeLeft: offsets.edgeLeft + (h > 0 ? (leftY - frame.c1.y) / h : 0),
    edgeRight: offsets.edgeRight + (h > 0 ? (rightY - frame.c2.y) / h : 0),
  };
}

function moved(offsets: SlurOffsets, handle: SlurHandle, dx: number, dy: number): SlurOffsets {
  switch (handle) {
    case 'top': return { ...offsets, bodyVertical: offsets.bodyVertical + dy };
    case 'topLeft': return { ...offsets, bodyLeft: offsets.bodyLeft + dy };
    case 'topRight': return { ...offsets, bodyRight: offsets.bodyRight + dy };
    case 'edgeLeft': return { ...offsets, edgeLeft: offsets.edgeLeft + dy, horizontalLeft: offsets.horizontalLeft + dx };
    case 'edgeMiddle': return { ...offsets, edgeVertical: offsets.edgeVertical + dy, horizontal: offsets.horizontal + dx };
    case 'edgeRight': return { ...offsets, edgeRight: offsets.edgeRight + dy, horizontalRight: offsets.horizontalRight + dx };
  }
}

const BISECTIONS = 24;

/** Drags one handle by `delta` px from `from`. Each axis goes as far as the frame stays valid, so the
 *  handle slides along a wall instead of sticking to it. */
export function dragSlur(handle: SlurHandle, from: SlurOffsets, base: SlurFrame, delta: Point): SlurOffsets {
  const side: 1 | -1 = sideOf(base);
  const { w, h } = frameSize(base);
  let current: SlurOffsets = from;
  for (const [dx, dy] of [[w > 0 ? delta.x / w : 0, 0], [0, h > 0 ? delta.y / h : 0]] as const) {
    const target: SlurOffsets = moved(current, handle, dx, dy);
    if (isValid(framed(base, target), side)) { current = target; continue; }
    let low = 0;
    let high = 1;
    for (let step = 0; step < BISECTIONS; step++) {
      const middle: number = (low + high) / 2;
      if (isValid(framed(base, moved(current, handle, dx * middle, dy * middle)), side)) low = middle;
      else high = middle;
    }
    current = moved(current, handle, dx * low, dy * low);
  }
  return current;
}

const orNull = (value: number): number | null => (value === 0 ? null : value);

/** The presentation changes that take the slur from `before` to `after`; a group returning to zero is cleared. */
export function slurChanges(id: string, before: SlurOffsets, after: SlurOffsets): PresentationChange[] {
  const changes: PresentationChange[] = [];
  if (before.bodyVertical !== after.bodyVertical)
    changes.push({ kind: 'vertical', target: body(id), offset: orNull(after.bodyVertical) });
  if (before.bodyLeft !== after.bodyLeft || before.bodyRight !== after.bodyRight)
    changes.push({ kind: 'endpoints', target: body(id), offsets: after.bodyLeft === 0 && after.bodyRight === 0 ? null : { left: after.bodyLeft, right: after.bodyRight } });
  if (before.edgeVertical !== after.edgeVertical)
    changes.push({ kind: 'vertical', target: lowerEdge(id), offset: orNull(after.edgeVertical) });
  if (before.edgeLeft !== after.edgeLeft || before.edgeRight !== after.edgeRight)
    changes.push({ kind: 'endpoints', target: lowerEdge(id), offsets: after.edgeLeft === 0 && after.edgeRight === 0 ? null : { left: after.edgeLeft, right: after.edgeRight } });
  if (before.horizontal !== after.horizontal)
    changes.push({ kind: 'horizontal', target: lowerEdge(id), offset: orNull(after.horizontal) });
  if (before.horizontalLeft !== after.horizontalLeft || before.horizontalRight !== after.horizontalRight)
    changes.push({ kind: 'horizontal_endpoints', target: lowerEdge(id), offsets: after.horizontalLeft === 0 && after.horizontalRight === 0 ? null : { left: after.horizontalLeft, right: after.horizontalRight } });
  return changes;
}
