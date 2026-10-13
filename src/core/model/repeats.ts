import type { Fraction, ScoreDocument, VoltaContext } from './score';

/** "1." · "1.–2." · "1., 3." — how the passes of an ending are written over its bracket. */
export function passesLabel(passes: number[]): string {
  const sorted = [...new Set(passes)].sort((a, z) => a - z);
  const runs: number[][] = [];
  for (const pass of sorted) {
    const last = runs[runs.length - 1];
    if (last && pass === last[last.length - 1] + 1) last.push(pass);
    else runs.push([pass]);
  }
  return runs.map((run) => (run.length > 1 ? `${run[0]}.–${run[run.length - 1]}.` : `${run[0]}.`)).join(', ');
}

/** A place of the score: a measure and a position in it. */
export interface Place {
  measureId: string;
  position: Fraction;
}

/** One part of a volta, in order: its body, then each stored ending. */
export interface VoltaPart {
  start: Place;
  /** `null`: the part lasts until the end of the score */
  end: Place | null;
  /** the passes an ending is played in; none for the body, which every pass plays */
  passes: number[] | null;
}

const placeOf = (measureId: string | null, position: Fraction | null): Place | null =>
  measureId === null || position === null ? null : { measureId, position };

export function voltaParts(volta: VoltaContext): VoltaPart[] {
  const bodyEnd: Place = { measureId: volta.bodyEndMeasureId, position: volta.bodyEndPosition };
  const parts: VoltaPart[] = [{ start: { measureId: volta.measureId, position: volta.position }, end: bodyEnd, passes: null }];
  let start = bodyEnd;
  for (const fragment of volta.fragments) {
    const end = placeOf(fragment.endMeasureId, fragment.endPosition);
    parts.push({ start, end, passes: fragment.passes });
    if (end) start = end;
  }
  return parts;
}

/** The last ending of a volta: played only in the last pass, over the bar right after the last stored ending and open on the right,
 *  because the music leaves the repeat there. It is not stored, so it is worked out here; none when the last stored ending lasts to the
 *  end of the score, with no bar after it. */
export interface DerivedEnding {
  start: Place;
  /** the start of the measure after, `null` when that bar is the last */
  end: Place | null;
  passes: number[];
}

export function derivedEnding(doc: ScoreDocument, volta: VoltaContext): DerivedEnding | null {
  const last = volta.fragments[volta.fragments.length - 1];
  const start = last ? placeOf(last.endMeasureId, last.endPosition) : null;
  if (!start) return null;
  const index = doc.measures.findIndex((measure) => measure.id === start.measureId);
  if (index < 0) return null;
  const next = doc.measures[index + 1];
  return {
    start,
    end: next ? { measureId: next.id, position: { numerator: 0, denominator: 1 } } : null,
    passes: [volta.passCount],
  };
}

/** Which barlines carry the repeat signs of refrains and voltas, as the measure whose left barline is `|:` and the measure whose right
 *  barline is `:|`. A refrain and a volta begin where they start; the music jumps back at the end of a refrain and of every stored
 *  ending, and an end that lasts to the end of the score is the right barline of the last measure. The editor puts boundaries on measure
 *  lines only, so one inside a measure is not drawn. */
export function repeatBarlines(doc: ScoreDocument): { beginMeasureIds: Set<string>; endMeasureIds: Set<string> } {
  const beginMeasureIds = new Set<string>();
  const endMeasureIds = new Set<string>();
  const begin = (measureId: string, position: Fraction): void => {
    if (position.numerator === 0) beginMeasureIds.add(measureId);
  };
  const end = (measureId: string | null, position: Fraction | null): void => {
    if (measureId === null || position === null) {
      const last = doc.measures[doc.measures.length - 1];
      if (last) endMeasureIds.add(last.id);
      return;
    }
    if (position.numerator !== 0) return;
    const before = doc.measures.findIndex((measure) => measure.id === measureId) - 1;
    if (before >= 0) endMeasureIds.add(doc.measures[before].id);
  };
  for (const context of doc.contexts) {
    if (context.kind === 'refrain') {
      begin(context.measureId, context.position);
      end(context.endMeasureId, context.endPosition);
    } else if (context.kind === 'volta') {
      begin(context.measureId, context.position);
      for (const fragment of context.fragments) end(fragment.endMeasureId, fragment.endPosition);
    }
  }
  return { beginMeasureIds, endMeasureIds };
}

/** What is written over the closing sign of a refrain played more than twice; played twice it needs no word. */
export const refrainLabel = (times: number): string => (times > 2 ? `Play ${times} times` : '');
