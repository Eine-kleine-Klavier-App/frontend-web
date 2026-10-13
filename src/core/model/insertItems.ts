import type { Accidental, ArticulationMark, DurationValue, RhythmicSize } from './score';
import { ARTICULATION_LABEL, ARTICULATION_MARKS, validMarks } from './articulation';

// Everything the editor can INSERT, as one model. A tool id (what the hotbar slots, favourites and
// the active tool hold) parses to an `InsertSpec`; every insert path — the hotbar, the library, the
// constructor — goes through it, so they can never drift apart.
//
// Ids: the historic ones stay exactly as they were ('w' 'h' 'q' '8' '16' notes, 'rest' = quarter
// rest, 'triplet' = eighth triplet), so hotkeys, labels and stored slots keep working. New ones:
// '32' (a 32nd note), 'rest:<value>' (a rest of another value), and the constructor's items:
//   'note:<value>:<dots>:<marks>:<accidental>'          a note composite: marks joined by '+' or 'none';
//                                                       accidental '#' 'b' 'n' or ''
//   'tuplet:<n>:<m>:<value>:<first>'                    n notes of <value> in the time of m; the first
//                                                       element a note or a rest ('triplet' = 3:2 eighths)
//   'ts:<n>:<m>'                                        a time signature, set on the measure clicked
//   'grace:<value>:<slash|plain>'                       a grace note of the value, slashed or plain

export type InsertKind = 'note' | 'rest' | 'tuplet' | 'timesig' | 'grace';

export interface InsertSpec {
  kind: InsertKind;
  value: DurationValue;
  dots: number;
  /** the marks of the carrier it makes, at most one of each category; empty = none */
  articulations: ArticulationMark[];
  accidental: Accidental;
  fingering?: number;
  /** tuplets: n in the time of m, and whether the first element is a note or a rest */
  tuplet?: { n: number; m: number; first: 'note' | 'rest'; written?: RhythmicSize; occupied?: RhythmicSize };
  /** time signatures: beats / beat value */
  timeSignature?: { beats: number; beatValue: number; dots?: number };
  /** grace notes: slashed (acciaccatura) or plain (appoggiatura) */
  grace?: { slash: boolean };
}

export const NOTE_VALUES: DurationValue[] = ['w', 'h', 'q', '8', '16', '32'];
/** the values a grace note is written in */
export const GRACE_VALUES: DurationValue[] = ['8', '16', '32'];
const ACCIDENTALS: Accidental[] = ['#', 'b', 'n'];

/** the written value's denominator (whole = 1, quarter = 4 …) — what the backend's written value takes */
export const VALUE_DENOMINATOR: Record<DurationValue, number> = { w: 1, h: 2, q: 4, '8': 8, '16': 16, '32': 32 };

const VALUE_NAME: Record<DurationValue, string> = {
  w: 'Whole',
  h: 'Half',
  q: 'Quarter',
  '8': 'Eighth',
  '16': 'Sixteenth',
  '32': 'Thirty-second',
};
const ACCIDENTAL_NAME: Record<string, string> = { '#': 'sharp', b: 'flat', n: 'natural' };

const plain = (kind: InsertKind, value: DurationValue): InsertSpec => ({ kind, value, dots: 0, articulations: [], accidental: null });
const TRIPLET: InsertSpec = { ...plain('tuplet', '8'), tuplet: { n: 3, m: 2, first: 'note' } };
const isInt = (v: string, lo: number, hi: number) => /^\d+$/.test(v) && Number(v) >= lo && Number(v) <= hi;

/** The spec a tool id stands for, or null for the select tool / an unknown id. */
export function parseTool(tool: string): InsertSpec | null {
  if (tool.startsWith('insert:')) {
    try {
      const spec = JSON.parse(decodeURIComponent(tool.slice(7)));
      // a stored id from before the marks were a set carries one `articulation`
      if (spec && typeof spec === 'object' && !('articulations' in spec)) {
        const { articulation, ...rest } = spec as { articulation?: string };
        Object.assign(rest, { articulations: articulation && articulation !== 'none' ? [articulation] : [] });
        return validInsertSpec(rest) ? rest : null;
      }
      return validInsertSpec(spec) ? spec : null;
    } catch { return null; }
  }
  if ((NOTE_VALUES as string[]).includes(tool)) return plain('note', tool as DurationValue);
  if (tool === 'rest') return plain('rest', 'q');
  if (tool === 'triplet') return TRIPLET;
  const parts = tool.split(':');
  if (parts[0] === 'rest' && parts.length === 2 && (NOTE_VALUES as string[]).includes(parts[1])) {
    return plain('rest', parts[1] as DurationValue);
  }
  if (parts[0] === 'tuplet' && parts.length === 5) {
    const [, n, m, value, first] = parts;
    if (!isInt(n, 1, Number.MAX_SAFE_INTEGER) || !isInt(m, 1, Number.MAX_SAFE_INTEGER)) return null;
    if (!(NOTE_VALUES as string[]).includes(value) || (first !== 'note' && first !== 'rest')) return null;
    return { ...plain('tuplet', value as DurationValue), tuplet: { n: Number(n), m: Number(m), first } };
  }
  if (parts[0] === 'grace' && parts.length === 3) {
    const [, value, kind] = parts;
    if (!(GRACE_VALUES as string[]).includes(value) || (kind !== 'slash' && kind !== 'plain')) return null;
    return { ...plain('grace', value as DurationValue), grace: { slash: kind === 'slash' } };
  }
  if (parts[0] === 'ts' && parts.length === 3) {
    const [, n, m] = parts;
    if (!isInt(n, 1, Number.MAX_SAFE_INTEGER) || !['1', '2', '4', '8', '16', '32'].includes(m)) return null;
    return { ...plain('timesig', 'q'), timeSignature: { beats: Number(n), beatValue: Number(m) } };
  }
  if (parts[0] === 'note' && parts.length === 5) {
    const [, value, dots, marks, accidental] = parts;
    if (!(NOTE_VALUES as string[]).includes(value)) return null;
    const d = Number(dots);
    if (!Number.isInteger(d) || d < 0 || VALUE_DENOMINATOR[value as DurationValue] * 2 ** d > 32) return null;
    const articulations = marks === 'none' ? [] : marks.split('+');
    if (!validMarks(articulations)) return null;
    if (accidental && !(ACCIDENTALS as string[]).includes(accidental)) return null;
    return { kind: 'note', value: value as DurationValue, dots: d, articulations, accidental: (accidental || null) as Accidental };
  }
  return null;
}

/** The canonical id of a spec — a plain one keeps its historic id. */
export function toolId(spec: InsertSpec): string {
  if (spec.fingering || spec.tuplet?.written || spec.tuplet?.occupied || (spec.kind === 'rest' && spec.dots) || spec.timeSignature?.dots || spec.dots > 2) {
    return `insert:${encodeURIComponent(JSON.stringify(spec))}`;
  }
  const isPlain = spec.dots === 0 && !spec.articulations.length && !spec.accidental;
  if (spec.kind === 'tuplet' && spec.tuplet) {
    const { n, m, first } = spec.tuplet;
    if (n === 3 && m === 2 && first === 'note' && spec.value === '8') return 'triplet';
    return `tuplet:${n}:${m}:${spec.value}:${first}`;
  }
  if (spec.kind === 'timesig' && spec.timeSignature) return `ts:${spec.timeSignature.beats}:${spec.timeSignature.beatValue}`;
  if (spec.kind === 'grace' && spec.grace) return `grace:${spec.value}:${spec.grace.slash ? 'slash' : 'plain'}`;
  if (spec.kind === 'rest') return spec.value === 'q' ? 'rest' : `rest:${spec.value}`;
  if (isPlain) return spec.value;
  return `note:${spec.value}:${spec.dots}:${spec.articulations.length ? ARTICULATION_MARKS.filter((m) => spec.articulations.includes(m)).join('+') : 'none'}:${spec.accidental ?? ''}`;
}

/** A tool's human name ("Quarter note", "Dotted quarter note, accent, sharp", "Eighth rest"). */
export function toolLabel(tool: string): string {
  if (tool === 'select') return 'Select';
  if (tool === 'tie') return 'Tie';
  const spec = parseTool(tool);
  if (!spec) return tool;
  if (spec.kind === 'tuplet' && spec.tuplet) {
    const { n, m, first } = spec.tuplet;
    if (tool === 'triplet') return 'Eighth-note triplet';
    const unit = VALUE_NAME[spec.value].toLowerCase();
    return `Tuplet ${n}:${m}, ${unit}s${first === 'rest' ? ', starting on a rest' : ''}`;
  }
  if (spec.kind === 'timesig' && spec.timeSignature) return `Time signature ${spec.timeSignature.beats}/${spec.timeSignature.beatValue}`;
  if (spec.kind === 'grace' && spec.grace) return `${VALUE_NAME[spec.value]} grace note, ${spec.grace.slash ? 'slashed' : 'plain'}`;
  const dotted = spec.dots === 2 ? 'Double-dotted ' : spec.dots === 1 ? 'Dotted ' : '';
  const value = dotted ? VALUE_NAME[spec.value].toLowerCase() : VALUE_NAME[spec.value];
  const base = `${dotted}${value} ${spec.kind === 'rest' ? 'rest' : 'note'}`;
  const extras = [...spec.articulations.map((m) => ARTICULATION_LABEL[m].toLowerCase()), spec.accidental ? ACCIDENTAL_NAME[spec.accidental] : ''].filter(Boolean);
  return extras.length ? `${base}, ${extras.join(', ')}` : base;
}

/** The click grid an insert snaps its start to, in quarter beats: the base value's own length. */
export function gridBeats(spec: InsertSpec): number {
  // a tuplet snaps to the length it occupies (3:2 eighths = one quarter beat)
  if (spec.kind === 'tuplet' && spec.tuplet) {
    const occupied = spec.tuplet.occupied;
    return occupied ? occupied.count * 4 / occupied.value.value * (2 - 2 ** -occupied.value.dots) : (spec.tuplet.m * 4) / VALUE_DENOMINATOR[spec.value];
  }
  return 4 / VALUE_DENOMINATOR[spec.value];
}

/** Null asks the backend to infer the stored sign; 'n' is an explicit natural. */
export function backendAccidental(accidental: Accidental): 'sharp' | 'flat' | 'natural' | null {
  if (accidental === null) return null;
  return accidental === '#' ? 'sharp' : accidental === 'b' ? 'flat' : 'natural';
}

function validInsertSpec(s: unknown): s is InsertSpec {
  if (!s || typeof s !== 'object') return false;
  const v = s as InsertSpec;
  const integer = (n: number, min: number) => Number.isSafeInteger(n) && n >= min;
  const rhythm = (x: { value: number; dots: number }) => x && [1,2,4,8,16,32].includes(x.value) && integer(x.dots, 0) && x.value * 2 ** x.dots <= 32;
  const size = (x: RhythmicSize) => x && integer(x.count, 1) && rhythm(x.value);
  return ['note', 'rest', 'tuplet', 'timesig'].includes(v.kind) && NOTE_VALUES.includes(v.value)
    && rhythm({ value: VALUE_DENOMINATOR[v.value], dots: v.dots }) && Array.isArray(v.articulations) && validMarks(v.articulations)
    && (v.accidental === null || ACCIDENTALS.includes(v.accidental))
    && (v.fingering === undefined || (integer(v.fingering, 0) && v.fingering <= 5))
    && (v.kind !== 'tuplet' || !!v.tuplet && integer(v.tuplet.n, 1) && integer(v.tuplet.m, 1)
      && ['note', 'rest'].includes(v.tuplet.first) && (!v.tuplet.written || size(v.tuplet.written)) && (!v.tuplet.occupied || size(v.tuplet.occupied)))
    && (v.kind !== 'timesig' || !!v.timeSignature && integer(v.timeSignature.beats, 1)
      && rhythm({ value: v.timeSignature.beatValue, dots: v.timeSignature.dots ?? 0 }));
}
