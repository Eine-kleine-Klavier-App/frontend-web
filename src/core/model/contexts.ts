// Where the backend's contexts (clefs, key signatures, dynamics, tempos …) stand in the score:
// positions across measures are compared as (measure index, beats from the measure start), and
// "what is in effect at a point" is answered here once, for the renderer, the tools and the panels.
import type {
  ClefContext,
  ClefName,
  Dynamic,
  Fraction,
  KeyAlteration,
  KeySignatureContext,
  ScoreContext,
  ScoreDocument,
  StaffId,
  TempoContext,
} from '@/core/model/score';

/** a position in whole-note units → quarter-note beats from the measure start */
export const toBeats = (f: Fraction): number => (f.numerator / f.denominator) * 4;

/** quarter-note beats → the backend's whole-note fraction, on a grid of 1/32 */
export function fromBeats(beats: number): Fraction {
  const thirtySeconds = Math.max(0, Math.round((beats / 4) * 32));
  const divisor = gcd(thirtySeconds, 32) || 1;
  return { numerator: thirtySeconds / divisor, denominator: 32 / divisor };
}

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

export function measureBeats(signature: { beats: number; beatValue: number; dots?: number }): number {
  return signature.beats * 4 / signature.beatValue * (2 - 2 ** -(signature.dots ?? 0));
}

/** Where a span ends. One with no end lasts until the end of the score, which is the end of the last measure. */
export function endOfSpan(doc: ScoreDocument, span: { endMeasureId: string | null; endPosition: Fraction | null }): { measureId: string; position: Fraction } {
  if (span.endMeasureId !== null && span.endPosition !== null) return { measureId: span.endMeasureId, position: span.endPosition };
  const last = doc.measures[doc.measures.length - 1];
  return { measureId: last?.id ?? '', position: fromBeats(last ? measureBeats(last.timeSignature) : 0) };
}

/** the clef a staff has where the document sets none: the first staff treble, every other bass */
export function defaultClef(staffOrder: readonly StaffId[], staffId: StaffId): ClefName {
  return staffOrder.indexOf(staffId) === 0 ? 'treble' : 'bass';
}

const EPS = 1e-6;

/** every context of one kind, in score order */
type Of<K extends ScoreContext['kind']> = Extract<ScoreContext, { kind: K }>;

export class ContextIndex {
  readonly measureIndex: Map<string, number>;
  private readonly sorted: ScoreContext[];

  constructor(private readonly doc: ScoreDocument) {
    this.measureIndex = new Map(doc.measures.map((m, i) => [m.id, i]));
    this.sorted = [...doc.contexts].sort(
      (a, b) =>
        (this.measureIndex.get(a.measureId) ?? 0) - (this.measureIndex.get(b.measureId) ?? 0) ||
        toBeats(a.position) - toBeats(b.position),
    );
  }

  /** score order of a (measure, beats) point: a number to compare, measures far apart by 1e4 */
  order(measureId: string, beats: number): number {
    return (this.measureIndex.get(measureId) ?? 0) * 1e4 + beats;
  }

  private lastAt<K extends ScoreContext['kind']>(
    kind: K,
    measureId: string,
    beats: number,
    match: (c: Of<K>) => boolean,
  ): Of<K> | undefined {
    const at = this.order(measureId, beats) + EPS;
    let found: Of<K> | undefined;
    for (const c of this.sorted) {
      if (c.kind !== kind) continue;
      if (this.order(c.measureId, toBeats(c.position)) > at) break;
      if (match(c as Of<K>)) found = c as Of<K>;
    }
    return found;
  }

  clefAt(staffId: StaffId, measureId: string, beats: number): ClefContext | undefined {
    return this.lastAt('clef', measureId, beats, (c) => c.staffId === staffId);
  }

  /** the clef in effect at a point, the staff's default clef before any is set */
  clefNameAt(staffId: StaffId, measureId: string, beats: number): ClefName {
    return this.clefAt(staffId, measureId, beats)?.clef ?? defaultClef(this.doc.staffOrder, staffId);
  }

  keyAt(staffId: StaffId, measureId: string, beats: number): KeySignatureContext | undefined {
    return this.lastAt('keySignature', measureId, beats, (c) => c.staffId === staffId);
  }

  tempoAt(measureId: string, beats: number): TempoContext | undefined {
    return this.lastAt('tempo', measureId, beats, () => true);
  }

  dynamicAt(voiceId: string, measureId: string, beats: number): Dynamic | undefined {
    return this.lastAt('dynamic', measureId, beats, (c) => c.voiceId === voiceId)?.dynamic;
  }

  /** contexts that sit exactly at the start of a measure */
  atMeasureStart<K extends ScoreContext['kind']>(kind: K, measureId: string): Of<K>[] {
    return this.sorted.filter((c): c is Of<K> => c.kind === kind && c.measureId === measureId && toBeats(c.position) < EPS);
  }

  /** the staff a voice sounds on at a point: the staff of its first item at or after it in that
   *  measure, else of its last item before it, else of any item of the voice, else the first staff */
  staffOfVoice(voiceId: string, measureId: string, beats: number): StaffId {
    const mi = this.measureIndex.get(measureId) ?? 0;
    const staffOf = (item: { kind: string; staffId?: StaffId; notes: { staffId: StaffId }[] }) =>
      item.kind === 'rest' ? item.staffId : item.notes[0]?.staffId;
    for (let i = mi; i < this.doc.measures.length; i += 1) {
      const voice = this.doc.measures[i].voices.find((v) => v.id === voiceId);
      if (!voice) continue;
      const item = voice.items.find((it) => i > mi || it.position >= beats - EPS);
      const staff = item && staffOf(item);
      if (staff) return staff;
    }
    for (let i = mi; i >= 0; i -= 1) {
      const voice = this.doc.measures[i].voices.find((v) => v.id === voiceId);
      const item = voice?.items[voice.items.length - 1];
      const staff = item && staffOf(item);
      if (staff) return staff;
    }
    return this.doc.staffOrder[0];
  }

  /** does the voice have any item at all */
  voiceSounds(voiceId: string): boolean {
    return this.doc.measures.some((m) => m.voices.some((v) => v.id === voiceId && v.items.length > 0));
  }
}

// ---- key signatures --------------------------------------------------------------------------

const SHARP_ORDER = [3, 0, 4, 1, 5, 2, 6]; // F C G D A E B, as indices into C D E F G A B
const FLAT_ORDER = [6, 2, 5, 1, 4, 0, 3]; // B E A D G C F
const SHARP_KEYS = ['C', 'G', 'D', 'A', 'E', 'B', 'F#', 'C#'];
const FLAT_KEYS = ['C', 'F', 'Bb', 'Eb', 'Ab', 'Db', 'Gb', 'Cb'];

/** the major key a set of seven alterations spells (`C` when it is not a standard key — nothing
 *  is drawn then) and how many sharps (+) or flats (−) it has */
export function keyOfAlterations(alterations: KeyAlteration[]): { name: string; fifths: number; standard?: boolean } {
  for (let n = 0; n <= 7; n += 1) {
    const sharp = alterations.every((a, i) => a === (SHARP_ORDER.slice(0, n).includes(i) ? 'sharp' : 'natural'));
    if (sharp) return { name: SHARP_KEYS[n], fifths: n };
    const flat = alterations.every((a, i) => a === (FLAT_ORDER.slice(0, n).includes(i) ? 'flat' : 'natural'));
    if (flat) return { name: FLAT_KEYS[n], fifths: -n };
  }
  return { name: 'C', fifths: 0, standard: false };
}

/** the seven alterations of a key with `fifths` sharps (+) or flats (−) */
export function alterationsOfFifths(fifths: number): KeyAlteration[] {
  const out: KeyAlteration[] = Array(7).fill('natural');
  const order = fifths >= 0 ? SHARP_ORDER : FLAT_ORDER;
  for (const i of order.slice(0, Math.abs(fifths))) out[i] = fifths >= 0 ? 'sharp' : 'flat';
  return out;
}

export const KEY_NAMES: { fifths: number; name: string }[] = Array.from({ length: 15 }, (_, i) => {
  const fifths = i - 7;
  return { fifths, name: fifths >= 0 ? SHARP_KEYS[fifths] : FLAT_KEYS[-fifths] };
});

// ---- clefs -----------------------------------------------------------------------------------

/** the diatonic letter (0 = C … 6 = B) a staff step lands on under a clef (step 0 = bottom line:
 *  treble E, bass G) */
export function letterOfStep(step: number, clef: ClefName): number {
  const bottom = clef === 'treble' ? 2 : 4;
  return (((bottom + step) % 7) + 7) % 7;
}

// ---- marks of several voices ------------------------------------------------------------------

/** What makes contexts one mark on the page: a dynamic or a hairpin for several voices is a context
 *  for each voice, and those of one kind, place and value (a hairpin: and reach) are one mark.
 *  `null` for any other context, which is a mark of its own. */
export function markKey(context: ScoreContext): string | null {
  const place = `${context.kind}|${context.measureId}|${toBeats(context.position)}`;
  if (context.kind === 'dynamic') return `${place}|${context.dynamic}`;
  if (context.kind === 'hairpin') {
    return `${place}|${context.endMeasureId}|${context.endPosition ? toBeats(context.endPosition) : ''}|${context.from}|${context.to}`;
  }
  return null;
}

/** the contexts drawn and edited together with `context`, itself among them */
export function markGroup<C extends ScoreContext>(doc: ScoreDocument, context: C): C[] {
  const key = markKey(context);
  return key === null ? [context] : doc.contexts.filter((other) => markKey(other) === key) as C[];
}
