import type { Command } from '@/core/commands/command';
import { alterationsOfFifths, fromBeats } from '@/core/model/contexts';
import type { ClefName, Dynamic, PitchMode, TempoWord, RhythmicValue, KeyAlteration } from '@/core/model/score';

// The tools that put a context on the score — a dynamic, a tempo, a clef, a key signature, a hairpin,
// a slur, an octave line, a ritardando / accelerando — as one model beside the insert items. A tool
// id is `mark:<kind>:<value>`; a POINT mark is placed by one click, a SPAN mark by two (its start,
// then its end).
//
//   mark:dyn:<level>      a dynamic for the current voice        mark:tempo:<word>   a tempo word
//   mark:bpm:<n>          a metronome tempo, quarter = n         mark:clef:<clef>    a clef on a staff
//   mark:key:<fifths>     a key signature on a staff (− = flats) mark:slur           a slur
//   mark:hairpin:<level>  a hairpin ending on a level            mark:oct:<n>        an octave line (±1, ±2)
//   mark:trans:<rit|accel>  a tempo transition      mark:repeat         a repeat over the bars from the first click to the second
//   mark:sustain          a sustain pedal over a stretch of the score   mark:volta  a repeat whose first ending is the bar after it

export type MarkSpec = ({
  voiceIds?: string[];
  beat?: RhythmicValue;
  bpm?: number | null;
  label?: TempoWord | null;
  showLabel?: boolean;
  alterations?: KeyAlteration[];
  octaveTransposition?: number;
  targetBpm?: number;
} & (
  | { kind: 'dynamic'; dynamic: Dynamic }
  | { kind: 'tempoWord'; word: TempoWord }
  | { kind: 'tempoBpm'; bpm: number }
  | { kind: 'clef'; clef: ClefName }
  | { kind: 'key'; fifths: number }
  | { kind: 'hairpin'; target: Dynamic }
  | { kind: 'slur' }
  | { kind: 'sustain' }
  | { kind: 'refrain' }
  | { kind: 'volta' }
  | { kind: 'octave'; octaves: number }
  | { kind: 'transition'; slower: boolean }));

const DYNAMICS = ['ppp', 'pp', 'p', 'mp', 'mf', 'f', 'ff', 'fff'];
const WORDS = ['grave', 'largo', 'adagio', 'andante', 'moderato', 'allegro', 'presto'];

export function parseMark(tool: string): MarkSpec | null {
  if (tool.startsWith('mark+:')) {
    try {
      const spec = JSON.parse(decodeURIComponent(tool.slice(6))) as MarkSpec;
      const base = { ...spec };
      delete base.voiceIds; delete base.beat; delete base.bpm; delete base.label; delete base.showLabel;
      if (spec.kind === 'tempoBpm') Object.assign(base, { bpm: spec.bpm });
      delete base.alterations; delete base.octaveTransposition; delete base.targetBpm;
      // Validate the discriminated part through the same canonical parser as simple tools.
      const parsed = parseMark(markToolId(base));
      if (!parsed) return null;
      if (spec.voiceIds && (!Array.isArray(spec.voiceIds) || !spec.voiceIds.every((id) => typeof id === 'string'))) return null;
      if (spec.beat && (![1,2,4,8,16,32].includes(spec.beat.value) || !Number.isInteger(spec.beat.dots) || spec.beat.dots < 0 || spec.beat.value * 2 ** spec.beat.dots > 32)) return null;
      if (spec.alterations && (spec.alterations.length !== 7 || !spec.alterations.every((a) => ['flat','natural','sharp'].includes(a)))) return null;
      if (spec.showLabel !== undefined && typeof spec.showLabel !== 'boolean') return null;
      if (spec.label != null && !WORDS.includes(spec.label)) return null;
      if (spec.bpm != null && (!Number.isSafeInteger(spec.bpm) || spec.bpm < 1)) return null;
      if (spec.targetBpm != null && (!Number.isSafeInteger(spec.targetBpm) || spec.targetBpm < 1)) return null;
      if (spec.octaveTransposition != null && !Number.isSafeInteger(spec.octaveTransposition)) return null;
      return spec;
    } catch { return null; }
  }
  const [head, kind, value] = tool.split(':');
  if (head !== 'mark') return null;
  if (kind === 'dyn' && DYNAMICS.includes(value)) return { kind: 'dynamic', dynamic: value as Dynamic };
  if (kind === 'tempo' && WORDS.includes(value)) return { kind: 'tempoWord', word: value as TempoWord };
  if (kind === 'bpm' && /^\d+$/.test(value) && Number(value) >= 1 && Number.isSafeInteger(Number(value))) return { kind: 'tempoBpm', bpm: Number(value) };
  if (kind === 'clef' && (value === 'treble' || value === 'bass')) return { kind: 'clef', clef: value };
  if (kind === 'key' && /^-?\d+$/.test(value) && Math.abs(Number(value)) <= 7) return { kind: 'key', fifths: Number(value) };
  if (kind === 'hairpin' && DYNAMICS.includes(value)) return { kind: 'hairpin', target: value as Dynamic };
  if (kind === 'slur' && value === undefined) return { kind: 'slur' };
  if (kind === 'sustain' && value === undefined) return { kind: 'sustain' };
  if (kind === 'repeat' && value === undefined) return { kind: 'refrain' };
  if (kind === 'volta' && value === undefined) return { kind: 'volta' };
  if (kind === 'oct' && /^-?\d+$/.test(value) && [-2, -1, 1, 2].includes(Number(value))) return { kind: 'octave', octaves: Number(value) };
  if (kind === 'trans' && (value === 'rit' || value === 'accel')) return { kind: 'transition', slower: value === 'rit' };
  return null;
}

export function markToolId(spec: MarkSpec): string {
  if (spec.voiceIds || spec.beat || spec.label !== undefined || spec.showLabel !== undefined || spec.alterations || spec.octaveTransposition !== undefined || spec.targetBpm !== undefined || (spec.kind !== 'tempoBpm' && spec.bpm !== undefined)) {
    return `mark+:${encodeURIComponent(JSON.stringify(spec))}`;
  }
  switch (spec.kind) {
    case 'dynamic': return `mark:dyn:${spec.dynamic}`;
    case 'tempoWord': return `mark:tempo:${spec.word}`;
    case 'tempoBpm': return `mark:bpm:${spec.bpm}`;
    case 'clef': return `mark:clef:${spec.clef}`;
    case 'key': return `mark:key:${spec.fifths}`;
    case 'hairpin': return `mark:hairpin:${spec.target}`;
    case 'slur': return 'mark:slur';
    case 'sustain': return 'mark:sustain';
    case 'refrain': return 'mark:repeat';
    case 'volta': return 'mark:volta';
    case 'octave': return `mark:oct:${spec.octaves}`;
    case 'transition': return `mark:trans:${spec.slower ? 'rit' : 'accel'}`;
  }
}

/** how many clicks a mark takes: a point mark one, a span two, a volta three (where it starts, where its body ends, where its first ending ends) */
export const markClicks = (spec: MarkSpec): number => (spec.kind === 'volta' ? 3 : isSpanMark(spec) ? 2 : 1);

/** a span mark takes two clicks */
export const isSpanMark = (spec: MarkSpec): boolean =>
  spec.kind === 'hairpin' || spec.kind === 'slur' || spec.kind === 'sustain' || spec.kind === 'octave' || spec.kind === 'transition' || spec.kind === 'refrain' || spec.kind === 'volta';

const OCTAVE_NAME: Record<string, string> = { '1': '8va', '2': '15ma', '-1': '8vb', '-2': '15mb' };

export function markLabel(spec: MarkSpec): string {
  switch (spec.kind) {
    case 'dynamic': return `Dynamic ${spec.dynamic}`;
    case 'tempoWord': return `Tempo ${spec.word}`;
    case 'tempoBpm': return `Tempo 1/${spec.beat?.value ?? 4}${"·".repeat(spec.beat?.dots ?? 0)} = ${spec.bpm}`;
    case 'clef': return `${spec.clef === 'treble' ? 'Treble' : 'Bass'} clef`;
    case 'key': return spec.alterations ? 'Custom key signature' : `Key signature, ${Math.abs(spec.fifths)} ${spec.fifths < 0 ? 'flats' : 'sharps'}`;
    case 'hairpin': return `Hairpin to ${spec.target}`;
    case 'slur': return 'Slur';
    case 'sustain': return 'Sustain pedal';
    case 'refrain': return 'Repeat';
    case 'volta': return 'Repeat with an ending';
    case 'octave': return `Octave line ${OCTAVE_NAME[String(spec.octaves)] ?? `${spec.octaves} octaves`}`;
    case 'transition': return spec.slower ? 'Ritardando' : 'Accelerando';
  }
}

/** a place on the score a click resolved to */
export interface MarkPoint {
  measureId: string;
  /** quarter-note beats from the measure start */
  beats: number;
  staffId: string;
  /** the pointer was in the right half of the measure: in a bar with nothing to snap to but its start (one whole rest), beat 0 is then the bar's whole, not its edge */
  late?: boolean;
}

export interface MarkEnv {
  voiceId: string;
  mode: PitchMode;
  /** the tempo in effect at the start, for a transition's target */
  bpmAtStart: number | null;
  /** the measure that follows this one, `null` after the last */
  measureAfter: (measureId: string) => string | null;
  /** the place of a measure in the score, from zero */
  measureIndex: (measureId: string) => number;
}

/** the command a one-click mark makes at a point */
export function pointCommand(spec: MarkSpec, at: MarkPoint, env: MarkEnv): Command | null {
  const position = fromBeats(at.beats);
  switch (spec.kind) {
    case 'dynamic':
      return { type: 'setDynamic', measureId: at.measureId, position, voiceIds: spec.voiceIds?.length ? spec.voiceIds : [env.voiceId], dynamic: spec.dynamic };
    case 'tempoWord':
      return { type: 'setTempo', measureId: at.measureId, position, beat: spec.beat ?? null, bpm: spec.bpm ?? null, label: spec.label === undefined ? spec.word : spec.label };
    case 'tempoBpm':
      return { type: 'setTempo', measureId: at.measureId, position, beat: spec.beat ?? { value: 4, dots: 0 }, bpm: spec.bpm, showLabel: spec.showLabel ?? spec.label != null };
    case 'clef':
      return { type: 'setClef', staffId: at.staffId, measureId: at.measureId, position, clef: spec.clef, octaveTransposition: spec.octaveTransposition ?? 0, mode: env.mode };
    case 'key':
      return { type: 'setKeySignature', staffId: at.staffId, measureId: at.measureId, position, alterations: spec.alterations ?? alterationsOfFifths(spec.fifths) };
    default:
      return null;
  }
}

const bar = (measureId: string) => ({ measureId, position: fromBeats(0) });

/** the barline a span of bars ends at when its last click is `b`: the start of that bar when the click is at its very start (the left half
 *  of the bar, at beat 0), else the start of the bar after it (`null`: the end of the score) */
export const endBoundary = (b: MarkPoint, env: Pick<MarkEnv, 'measureAfter'>): string | null => (b.beats === 0 && !b.late ? b.measureId : env.measureAfter(b.measureId));

/** the command a two-click mark makes from its start to its end (the caller orders them) */
export function spanCommand(spec: MarkSpec, a: MarkPoint, b: MarkPoint, env: MarkEnv, third: MarkPoint | null = null): Command | null {
  const start = { measureId: a.measureId, position: fromBeats(a.beats) };
  const end = { measureId: b.measureId, position: fromBeats(b.beats) };
  switch (spec.kind) {
    case 'hairpin':
      return { type: 'createHairpin', start, end, voiceIds: spec.voiceIds?.length ? spec.voiceIds : [env.voiceId], target: spec.target };
    case 'slur':
      return { type: 'createSlur', start, end, voiceIds: spec.voiceIds?.length ? spec.voiceIds : [env.voiceId] };
    case 'sustain':
      return { type: 'createSustainHold', start, end };
    // a repeat is made of bars: it starts where the first clicked bar starts and ends at the barline the second click is at or before: a click
    // at the very start of a bar is that barline (the bar itself is not in), anywhere else in a bar it is the end of that bar. A volta is a
    // repeat with a first ending
    case 'refrain': {
      const stop = endBoundary(b, env);
      return { type: 'createRefrain', start: bar(a.measureId), end: stop === null ? null : bar(stop), times: 2 };
    }
    case 'volta': {
      // the first ending follows the body edge to edge, so its third click gives only where it ends, and that is after the body; the last
      // ending is the bar after the first, made by the backend
      const bodyEnd = endBoundary(b, env);
      if (bodyEnd === null || third === null) return null;
      const endingEnd = endBoundary(third, env);
      if (endingEnd !== null && env.measureIndex(endingEnd) <= env.measureIndex(bodyEnd)) return null;
      return { type: 'createVolta', start: bar(a.measureId), bodyEnd: bar(bodyEnd), fragments: [{ end: endingEnd === null ? null : bar(endingEnd), passes: [1] }] };
    }
    case 'octave':
      return { type: 'createOctaveTransposition', staffId: a.staffId, start, end, octaves: spec.octaves, mode: env.mode };
    case 'transition': {
      const from = env.bpmAtStart ?? 100;
      return { type: 'createTempoTransition', start, end, targetBpm: spec.targetBpm ?? Math.max(1, Math.round(from * (spec.slower ? 0.7 : 1.3))) };
    }
    default:
      return null;
  }
}
