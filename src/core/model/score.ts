import type { StemPlacement, Presentation, PlacementCapabilities } from './presentation';
export type { StemPlacement } from './presentation';
// Client-side render/edit model. This is the transient document the editor owns
// (branch or draft). Shaped to mirror the BACKEND's domain truth directly: voice and
// staff are independent axes (see PianoAppBackend CLAUDE.md / the `staff-voice-independent-axes`
// design note) — a measure holds VOICES, and staff is a per-note attribute, never a level
// of the document hierarchy. The backend sends a flat, normalized entity dump (not this
// shape) — fromView.ts resolves it into `measures -> voices -> items` with staff on each
// note. Only the VexFlow renderer (which must place glyphs on physical staves) derives a
// per-staff view, locally, at draw time.

export interface RhythmicValue { value: number; dots: number }
export interface RhythmicSize { value: RhythmicValue; count: number }
export interface TempoValue { beat: RhythmicValue; bpm: number }

export type Clef = 'treble' | 'bass';
export type StaffId = string;

export type DurationValue = 'w' | 'h' | 'q' | '8' | '16' | '32';
export type Accidental = '#' | 'b' | 'n' | '##' | 'bb' | null;
/** A mark of articulation as the backend holds it. A carrier has a list of them: at most one of
 *  length (staccato, staccatissimo, tenuto, fermata), one of loudness (accent, marcato) and one of
 *  arpeggio (up, down; a chord of one voice rolled from the lower staff up, or the reverse). */
export type ArticulationMark = 'staccato' | 'staccatissimo' | 'tenuto' | 'accent' | 'marcato' | 'fermata' | 'arpeggio_up' | 'arpeggio_down';

/** An ornament as the backend holds it: a carrier has none or one. */
/** The tremolo of one note is the ornament too: the number is the strokes on the stem. */
export type OrnamentMark = 'none' | 'trill' | 'upper_mordent' | 'lower_mordent' | 'turn' | 'inverted_turn' | 'tremolo_1' | 'tremolo_2' | 'tremolo_3';

/** One note of a chord (or the chord's only note) — carries its OWN staff, so a chord (one
 *  `Item`) can natively span more than one staff (a cross-staff chord: e.g. voice 1 holding a
 *  note on the treble staff and one on the bass staff at the same beat, in one carrier). */
export interface NoteRef {
  noteId: string;
  staffId: StaffId;
  staffStep: number;
  accidental: Accidental;
  /** 0 = no fingering, 1 (thumb) .. 5 (little finger). */
  fingering: number;
  midiNote?: number | null;
}

/** A group of grace notes is slashed (acciaccatura, short) or plain (appoggiatura, as written). */
export type GraceKind = 'appoggiatura' | 'acciaccatura';

/** One carrier of a grace group: written like a carrier of a note, but it takes no time of its own —
 *  the group borrows it from the carrier it stands before or after. */
export interface GraceCarrier {
  id: string;
  duration: DurationValue;
  dots: number;
  notes: NoteRef[];
  articulations: ArticulationMark[];
}

/** The grace notes before or after a carrier, in the order they are played. Lives and dies with that carrier. */
export interface GraceGroup {
  id: string;
  kind: GraceKind;
  carriers: GraceCarrier[];
}

/** A rhythmic item on one voice's timeline — a chord/single-note carrier, or a rest. */
export interface Item {
  /** The carrier id — the chord/rest as a WHOLE (delete-carrier, stem handle, group-select all
   *  key off this). Individual-note selection uses `notes[].noteId` instead. */
  id: string;
  kind: 'note' | 'rest';
  duration: DurationValue;
  dots: number;
  /** Where the item starts in its measure, in quarter-note beats — the backend's own anchor, so a
   *  tuplet member sits at its real time, not at the sum of the written durations before it. */
  position: number;
  positionFraction?: Fraction;
  writtenSize?: RhythmicSize;
  occupiedSize?: RhythmicSize;
  /** One entry per note in the chord — possibly on DIFFERENT staffs. Empty for a rest. */
  notes: NoteRef[];
  /** Rests only — a rest lives on exactly one staff (no per-note list); where on it the rest
   *  is drawn is the renderer's call. */
  staffId?: StaffId;
  /** The carrier's marks of articulation; always empty for a rest. */
  articulations: ArticulationMark[];
  /** The carrier's ornament; absent is none, and always none for a rest. */
  ornament?: OrnamentMark;
  /** The grace notes standing before this item, and the ones standing after it. */
  graceBefore?: GraceGroup | null;
  graceAfter?: GraceGroup | null;
  /** Set on a grace carrier seen as an item (see `withGraces` in query.ts): the carrier it stands beside, and on which side. */
  grace?: { hostId: string; side: 'before' | 'after'; kind: GraceKind };
}

export interface VoiceMeasure {
  id: string;
  items: Item[];
}

export interface Measure {
  id: string;
  timeSignature: { beats: number; beatValue: number; dots?: number };
  voices: VoiceMeasure[];
}

/** A global voice (spans staffs). Voice color is keyed by `index`. */
export interface VoiceRef {
  id: string;
  index: number;
}

/** A tie between two notes — they may sit in different measures or systems. */
export interface Tie {
  id: string;
  startNoteId: string;
  endNoteId: string;
}
export type GlissandoType = 'straight' | 'wavy';
/** A glissando from one note to the next: a line between them, straight or wavy. */
export interface Glissando {
  id: string;
  startNoteId: string;
  endNoteId: string;
  glissandoType: GlissandoType;
}

/** What a context is applied to, as the backend answers: the carriers (notes' and rests') and the
 *  notes. A staff-scoped context covers only its own notes of a chord that spans two staffs. */
export interface ContextCoverage {
  carrierIds: string[];
  noteIds: string[];
}

/** A beam over carriers, in time order — it may cross a barline. */
/** the stem length at each end of a beam, as a factor of its automatic length (1 = automatic) */
export interface BeamOverride { leftFactor: number; rightFactor: number }

export interface Beam {
  override?: BeamOverride | null;
  id: string;
  carrierIds: string[];
}

/** A tuplet: `numNotes` written notes in the time of `notesOccupied`, both counted in the
 *  tuplet's written note value (an eighth triplet is 3 in 2). `carrierIds` are its leaves in
 *  time order, nested tuplets included. */
export interface Tuplet {
  id: string;
  writtenSize?: RhythmicSize;
  occupiedSize?: RhythmicSize;
  numNotes: number;
  notesOccupied: number;
  carrierIds: string[];
}

/** a position inside a measure, in whole-note units (the backend's own fraction) */
export interface Fraction {
  numerator: number;
  denominator: number;
}

export type Dynamic = 'ppp' | 'pp' | 'p' | 'mp' | 'mf' | 'f' | 'ff' | 'fff';
export type TempoWord = 'grave' | 'largo' | 'adagio' | 'andante' | 'moderato' | 'allegro' | 'presto';
export type KeyAlteration = 'flat' | 'natural' | 'sharp';
export type ClefName = 'treble' | 'bass';
/** what an edit does to the notes under a clef or octave line (backend `PitchEditMode`) */
export type PitchMode = 'preserve_pitch' | 'preserve_step';

/** Everything the backend keeps beside the notes, "contexts": each starts at a measure position and
 *  the span kinds also end at one. A clef or key signature belongs to a staff, a dynamic, hairpin
 *  and slur to voices, a tempo to the whole score. */
interface ContextBase {
  id: string;
  measureId: string;
  position: Fraction;
}
interface SpanBase extends ContextBase {
  /** `null` (both): the span lasts until the end of the score */
  endMeasureId: string | null;
  endPosition: Fraction | null;
}
export interface ClefContext extends ContextBase {
  kind: 'clef';
  staffId: StaffId;
  clef: ClefName;
  octaveTransposition: number;
}
export interface KeySignatureContext extends ContextBase {
  kind: 'keySignature';
  staffId: StaffId;
  /** one per diatonic step, C to B */
  alterations: KeyAlteration[];
}
export interface DynamicContext extends ContextBase {
  kind: 'dynamic';
  voiceIds: string[];
  dynamic: Dynamic;
}
export interface TempoContext extends ContextBase {
  kind: 'tempo';
  beat: { value: number; dots: number } | null;
  bpm: number | null;
  label: TempoWord | null;
  showLabel: boolean;
}
export interface HairpinContext extends SpanBase {
  kind: 'hairpin';
  voiceIds: string[];
  type: 'crescendo' | 'diminuendo';
  steps?: number;
  levels: { voiceId: string; from: Dynamic; to: Dynamic }[];
}
export interface SlurContext extends SpanBase {
  kind: 'slur';
  voiceIds: string[];
}
export interface OctaveContext extends SpanBase {
  kind: 'octave';
  staffId: StaffId;
  /** +1 = 8va, -1 = 8vb, ±2 = 15ma / 15mb */
  octaves: number;
}
export interface TempoTransitionContext extends SpanBase {
  kind: 'tempoTransition';
  ratio?: Fraction;
  startTempo?: TempoValue | null;
  endTempo?: TempoValue | null;
  startBpm: number | null;
  endBpm: number | null;
}
export interface SustainContext extends SpanBase { kind: 'sustain' }
/** A stretch of the score played `times` times: `|: 1 2 :|` played three times. With no end it lasts until the end of the score. */
export interface RefrainContext extends SpanBase {
  kind: 'refrain';
  times: number;
}
/** One ending of a volta: where it ends (`null`: the end of the score) and the passes it is played in. It starts where the one before ends. */
export interface VoltaFragment {
  endMeasureId: string | null;
  endPosition: Fraction | null;
  passes: number[];
}
/** The endings of a repeat, one element for all its fragments. It starts where its body starts, the part played in every pass; the
 *  fragments follow the body. The last ending is not here: it is the last of `passCount` passes and is drawn after the last fragment. */
export interface VoltaContext extends ContextBase {
  kind: 'volta';
  bodyEndMeasureId: string;
  bodyEndPosition: Fraction;
  passCount: number;
  fragments: VoltaFragment[];
}
export type ScoreContext =
  | SustainContext
  | RefrainContext
  | VoltaContext
  | ClefContext
  | KeySignatureContext
  | DynamicContext
  | TempoContext
  | HairpinContext
  | SlurContext
  | OctaveContext
  | TempoTransitionContext;

export interface InsertionSpace {
  id: string;
  voiceId: string;
  parentId: string | null;
  start: Fraction;
  scale: Fraction;
  extent: Fraction;
}

export interface ScoreDocument {
  musicRevision: string;
  presentation: Presentation;
  presentationCapabilities: PlacementCapabilities[];
  insertionSpaces?: InsertionSpace[];
  id: string;
  title: string;
  /** Top-to-bottom staff order, e.g. ['rh', 'lh']. Staves exist as a rendering/insertion
   *  surface (`staffOrder`, click geometry) — they are not a level of the document tree. */
  staffOrder: StaffId[];
  /** Global voices in document order (backend truth), for panels + voice selection. */
  voices: VoiceRef[];
  measures: Measure[];
  /** Stem overrides keyed by note carrier id; a carrier without one is drawn automatically. */
  stemOverrides: Record<string, StemPlacement>;
  ties: Tie[];
  glissandos: Glissando[];
  beams: Beam[];
  /** Outer tuplets before the tuplets nested in them. */
  tuplets: Tuplet[];
  /** clefs, key signatures, dynamics, tempos, hairpins, slurs, octave lines, tempo transitions */
  contexts: ScoreContext[];
}
