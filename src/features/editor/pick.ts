// Which element the pointer is on. Hover, click and press all ask this one question, and the answer is the nearest drawing: every element
// that has the pointer in its hit area (its ink, or the room kept around it to make a thin or small thing easy to grab) is given the
// distance from the pointer to its ink, and only the nearest are kept. A pointer on a rest's ink is at 0 from the rest, however close a
// stem's hit column or a note's padding comes; a pointer beside a stem on bare paper is nearest to the stem. Several inks under the pointer
// are a real overlap, and the choice between them is the user's. Several at the same distance from the pointer, none of them with the
// pointer on its ink (a point midway between two noteheads), are not: nothing is picked.

/** distances closer than this (layout units) are the same distance */
const SAME_DISTANCE = 0.5;

export interface Candidate<T> {
  target: T;
  /** the distance from the pointer to the target's ink: 0 on the ink */
  distance: number;
}

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface Point {
  x: number;
  y: number;
}

/** the distance from a point to a box: 0 inside it */
export function distanceToBox(box: Box, point: Point): number {
  const dx: number = Math.max(box.x - point.x, 0, point.x - (box.x + box.width));
  const dy: number = Math.max(box.y - point.y, 0, point.y - (box.y + box.height));
  return Math.hypot(dx, dy);
}

/** the distance from a point to an upright line from `top` to `bottom` at `x` */
export function distanceToUprightLine(x: number, top: number, bottom: number, point: Point): number {
  return Math.hypot(point.x - x, Math.max(top - point.y, 0, point.y - bottom));
}

/** the candidates nearest to the pointer, in the order given: those within `SAME_DISTANCE` of the smallest distance; of several that are
 *  equally near but none on the pointer, none */
export function nearest<T>(candidates: readonly Candidate<T>[]): T[] {
  if (!candidates.length) return [];
  const smallest: number = Math.min(...candidates.map((candidate) => candidate.distance));
  const tied: Candidate<T>[] = candidates.filter((candidate) => candidate.distance - smallest <= SAME_DISTANCE);
  if (smallest > SAME_DISTANCE && tied.length > 1) return [];
  return tied.map((candidate) => candidate.target);
}
