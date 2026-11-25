import type { ScoreLayout, TimeMapEntry } from '@/rendering/ScoreRenderer';

/** Where the cursor stands on the engraving at `beat`: its x and the vertical extent of the system it is in. */
export function stripCursorAt(timeMap: readonly TimeMapEntry[], beat: number): { x: number; y0: number; y1: number } | null {
  if (!timeMap.length) return null;
  const first = timeMap[0];
  if (beat <= first.timeBeats) return { x: first.x, y0: first.y0, y1: first.y1 };
  for (let i = 0; i < timeMap.length - 1; i++) {
    const a = timeMap[i];
    const b = timeMap[i + 1];
    // A pair that spans two systems is the jump to the next one: the cursor does not sweep across it.
    if (a.y0 !== b.y0 || beat < a.timeBeats || beat >= b.timeBeats) continue;
    const t = (beat - a.timeBeats) / (b.timeBeats - a.timeBeats || 1);
    return { x: a.x + t * (b.x - a.x), y0: a.y0, y1: a.y1 };
  }
  const last = timeMap[timeMap.length - 1];
  return { x: last.x, y0: last.y0, y1: last.y1 };
}

/** The place of the score under an x of the engraving in the system that starts at `y0`, the inverse of `stripCursorAt`: before the system it is its first place, after it its last. */
export function beatAtStripX(timeMap: readonly TimeMapEntry[], y0: number, x: number): number | null {
  const row: TimeMapEntry[] = timeMap.filter((entry) => entry.y0 === y0);
  if (!row.length) return null;
  if (x <= row[0].x) return row[0].timeBeats;
  for (let i = 0; i < row.length - 1; i++) {
    const a: TimeMapEntry = row[i];
    const b: TimeMapEntry = row[i + 1];
    if (x < b.x) return a.timeBeats + ((x - a.x) / (b.x - a.x || 1)) * (b.timeBeats - a.timeBeats);
  }
  return row[row.length - 1].timeBeats;
}

export interface SystemBand {
  top: number;
  bottom: number;
}

/**
 * The vertical extent of everything drawn in each system, by its first staff's top (`y0`): the staves
 * and also the notes with ledger lines and the marks that stand beyond them. `ink` is what is really drawn
 * in each system group (dynamics and other marks the boxes do not list). A system
 * owns what lies between the middle of the gap above it and the middle of the gap below it.
 */
export function systemBands(
  layout: Pick<ScoreLayout, 'timeMap' | 'noteBoxes' | 'modifierBoxes' | 'measures'>,
  ink: readonly { y: number; h: number }[],
): Map<number, SystemBand> {
  const systems = new Map<number, { y0: number; y1: number }>();
  for (const entry of layout.timeMap) if (!systems.has(entry.y0)) systems.set(entry.y0, { y0: entry.y0, y1: entry.y1 });
  const ordered = [...systems.values()].sort((a, b) => a.y0 - b.y0);
  const bands = new Map<number, SystemBand>();
  const boxes: { y: number; h: number }[] = [...layout.noteBoxes, ...layout.modifierBoxes, ...layout.measures, ...ink];
  ordered.forEach((system, index) => {
    const low = index > 0 ? (ordered[index - 1].y1 + system.y0) / 2 : -Infinity;
    const high = index < ordered.length - 1 ? (system.y1 + ordered[index + 1].y0) / 2 : Infinity;
    let top = system.y0;
    let bottom = system.y1;
    for (const box of boxes) {
      const middle = box.y + box.h / 2;
      if (middle <= low || middle >= high) continue;
      top = Math.min(top, box.y);
      bottom = Math.max(bottom, box.y + box.h);
    }
    bands.set(system.y0, { top, bottom });
  });
  return bands;
}
