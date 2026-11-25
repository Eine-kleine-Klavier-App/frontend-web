import { endOfSpan, measureBeats, toBeats } from './contexts';
import { endBoundary, type MarkEnv, type MarkPoint, type MarkSpec } from './markTools';
import type { ScoreContext, ScoreDocument } from './score';

// The stretch of the score a mark will act on, shown while it is being placed: from the first click (or the pointer, for a mark that is
// one click) to where it ends. A clef, a key signature and an octave line act on one staff; everything else is shown over the whole
// height of the bars it covers (a voice may sound on both staves).

export interface RangePoint {
  measureId: string;
  /** quarter-note beats from the start of the measure; a stop at 0 is the barline before the measure */
  beats: number;
}

export interface RangeSpan {
  /** the staves it acts on; `null`: every staff */
  staffIds: string[] | null;
  from: RangePoint;
  to: RangePoint;
}

export interface InsertRange {
  main: RangeSpan;
  /** a volta's first ending, shown lighter */
  ending?: RangeSpan;
}

export function insertRange(doc: ScoreDocument, spec: MarkSpec, placed: MarkPoint[], pointer: MarkPoint, env: Pick<MarkEnv, 'measureAfter'> & { voiceId: string }): InsertRange | null {
  const index = new Map(doc.measures.map((measure, at) => [measure.id, at]));
  const first: MarkPoint | null = placed[0] ?? null;
  const order = (point: RangePoint) => (index.get(point.measureId) ?? 0) * 1e4 + point.beats;
  const last = doc.measures[doc.measures.length - 1];
  const endOfScore: RangePoint = { measureId: last?.id ?? '', beats: last ? measureBeats(last.timeSignature) : 0 };
  const atStartOf = (measureId: string | null): RangePoint => (measureId === null ? endOfScore : { measureId, beats: 0 });
  const [a, b] = first && order(first) > order(pointer) ? [pointer, first] : [first ?? pointer, pointer];
  /** to the next mark of its kind that `same` accepts after the pointer, or to the end of the score */
  const untilNext = (kind: string, same: (context: ScoreDocument['contexts'][number]) => boolean): RangePoint => {
    const next = doc.contexts
      .filter((context) => context.kind === kind && same(context) && order({ measureId: context.measureId, beats: toBeats(context.position) }) > order(pointer))
      .sort((x, z) => order({ measureId: x.measureId, beats: toBeats(x.position) }) - order({ measureId: z.measureId, beats: toBeats(z.position) }))[0];
    return next ? { measureId: next.measureId, beats: toBeats(next.position) } : endOfScore;
  };
  switch (spec.kind) {
    case 'refrain': {
      // bars: from the start of the first bar to the barline the last click is at or before; with no first click, the bar under the pointer
      const stop = first ? endBoundary(b, env) : env.measureAfter(pointer.measureId);
      return { main: { staffIds: null, from: { measureId: a.measureId, beats: 0 }, to: atStartOf(stop) } };
    }
    case 'volta': {
      // three stages: the body from the first click to the second, then where the first ending ends. Until the body is closed the pointer
      // closes it, and the next bar is shown lighter as the ending to come; once closed, the ending runs from the body's end to the pointer
      if (placed.length >= 2) {
        const bodyEnd = endBoundary(placed[1], env);
        const main: RangeSpan = { staffIds: null, from: { measureId: placed[0].measureId, beats: 0 }, to: atStartOf(bodyEnd) };
        if (bodyEnd === null) return { main };
        const endingEnd = endBoundary(pointer, env);
        if (endingEnd !== null && (index.get(endingEnd) ?? 0) <= (index.get(bodyEnd) ?? 0)) return { main };
        return { main, ending: { staffIds: null, from: atStartOf(bodyEnd), to: atStartOf(endingEnd) } };
      }
      const stop = first ? endBoundary(b, env) : env.measureAfter(pointer.measureId);
      const main: RangeSpan = { staffIds: null, from: { measureId: a.measureId, beats: 0 }, to: atStartOf(stop) };
      if (stop !== null) return { main, ending: { staffIds: null, from: atStartOf(stop), to: atStartOf(env.measureAfter(stop)) } };
      return { main };
    }
    case 'hairpin':
    case 'slur':
    case 'sustain':
    case 'transition':
      return first ? { main: { staffIds: null, from: a, to: b } } : null;
    case 'octave':
      return first ? { main: { staffIds: [first.staffId], from: a, to: b } } : null;
    case 'dynamic': {
      const voices = spec.voiceIds?.length ? spec.voiceIds : [env.voiceId];
      return { main: { staffIds: null, from: pointer, to: untilNext('dynamic', (context) => context.kind === 'dynamic' && voices.includes(context.voiceId)) } };
    }
    case 'tempoWord':
    case 'tempoBpm':
      return { main: { staffIds: null, from: pointer, to: untilNext('tempo', () => true) } };
    case 'clef':
    case 'key': {
      const kind = spec.kind === 'clef' ? 'clef' : 'keySignature';
      return { main: { staffIds: [pointer.staffId], from: pointer, to: untilNext(kind, (context) => 'staffId' in context && context.staffId === pointer.staffId) } };
    }
  }
}

/** the stretch of a span while one of its edges is dragged, with that edge at `landing` (where it would settle; none yet: where it is) */
export function draggedSpanRange(doc: ScoreDocument, context: Extract<ScoreContext, { endMeasureId: string | null }>, edge: 'start' | 'end', landing: RangePoint | undefined): InsertRange {
  const start: RangePoint = { measureId: context.measureId, beats: toBeats(context.position) };
  const end = endOfSpan(doc, context);
  const stop: RangePoint = { measureId: end.measureId, beats: toBeats(end.position) };
  return { main: { staffIds: context.kind === 'octave' ? [context.staffId] : null, from: edge === 'start' ? landing ?? start : start, to: edge === 'end' ? landing ?? stop : stop } };
}
