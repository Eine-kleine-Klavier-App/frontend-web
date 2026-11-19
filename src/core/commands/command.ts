import type { PresentationChange } from '@/core/model/presentation';
import type { ArticulationMark, OrnamentMark, ClefName, Dynamic, Fraction, PitchMode, StemPlacement, TempoWord } from '@/core/model/score';

// The intent of an edit — the boundary to the backend mutation engine. The gateway
// ships each command to `/drafts/{draftId}/edit/...` and returns the resulting document.

/** position within a measure, in whole-note units (whole = 1/1). */
type Position = Fraction;
/** rhythmic value: `value` is the note denominator (1,2,4,8,16,32). */
type WrittenValue = { value: number; dots: number };

export type Command =
  | { type: 'editPresentation'; changes: PresentationChange[] }
  | { type: 'setBeamOverride'; beamId: string; override: { leftFactor: number; rightFactor: number } | null }
  | {
      type: 'insertNote';
      measureId: string;
      staffId: string;
      voiceId: string;
      position: Position;
      writtenValue: WrittenValue;
      /** clef-independent staff geometry: 0 = the staff's bottom line, +1 per step up. */
      staffStep: number;
      accidental?: string | null;
      fingering?: number;
      /** the part of a measure a beam holds before the next note begins another, as a fraction (0: no automatic beams); dispatch fills it from the editor's setting */
      beamShare?: { numerator: number; denominator: number };
    }
  /** mixed multi-select delete — whole carriers AND individual notes-out-of-chords — all removed
   *  in ONE backend gesture (one transaction, one undo entry). This is what makes a single Delete
   *  over any selection a single undo step, instead of one gesture for the carriers plus one per
   *  leftover note. `entityIds` is a FLAT list of ids of any deletable kind — the backend resolves
   *  each id to its entity (note / note-carrier / rest-carrier) and classifies it (see the backend
   *  `DeleteBatchCommand.entity_ids` / `compile_delete_batch`), so the client sends a carrier id to
   *  drop a whole chord and individual note ids to drop notes out of a chord, in one array. */
  | { type: 'deleteBatch'; entityIds: string[] }
  /** set (or, with `override: null`, reset to automatic) the stems of several carriers at once —
   *  one backend gesture, one undo entry. */
  | { type: 'setStems'; carrierIds: string[]; override: StemPlacement | null }
  | { type: 'insertRest'; measureId: string; staffId: string; voiceId: string; position: Position; writtenValue: WrittenValue }
  /** a tuplet created with its first element — a note, or a rest when `note` is null. Sizes are
   *  in the model's own terms: an eighth triplet is written 3 eighths, occupied 2 eighths. */
  | {
      type: 'createTuplet';
      measureId: string;
      staffId: string;
      voiceId: string;
      position: Position;
      writtenSize: { value: WrittenValue; count: number };
      occupiedSize: { value: WrittenValue; count: number };
      writtenValue: WrittenValue;
      note: { staffStep: number; accidental?: string | null; fingering?: number } | null;
    }
  | { type: 'tieNotes'; startNoteId: string; endNoteId: string }
  | { type: 'glissandoNotes'; startNoteId: string; endNoteId: string; glissandoType: 'straight' | 'wavy' }
  /** carriers in time order — the backend refuses any other order. */
  | { type: 'createBeam'; carrierIds: string[] }
  | { type: 'splitBeam'; beamId: string; beforeCarrierId: string }
  | { type: 'setFingering'; noteId: string; fingering: number }
  | { type: 'setArticulation'; carrierId: string; articulations: ArticulationMark[] }
  /** the marks of several carriers in ONE gesture (one undo); a mark left out is not touched */
  | { type: 'setCarrierMarks'; items: { carrierId: string; articulations?: ArticulationMark[]; ornament?: OrnamentMark }[] }
  | { type: 'changeDuration'; carrierId: string; writtenValue: WrittenValue }
  /** `beforeMeasureId: null` appends after the last measure. */
  | { type: 'insertMeasure'; beforeMeasureId: string | null }
  /** contiguous measures only — the backend refuses a gap. */
  | { type: 'changeTimeSignature'; measureIds: string[]; beats: number; beatValue: number; dots?: number }
  /** a clef on one staff from a position on; `mode` says whether the notes it reaches keep their
   *  sound or their place on the lines */
  | { type: 'setClef'; staffId: string; measureId: string; position: Position; clef: ClefName; octaveTransposition: number; mode: PitchMode }
  | { type: 'deleteClef'; clefId: string; measureIds: string[]; mode: PitchMode }
  /** one alteration per diatonic step, C to B */
  | { type: 'setKeySignature'; staffId: string; measureId: string; position: Position; alterations: string[] }
  /** a dynamic, hairpin or slur applies to one more voice, or stops applying to one of its voices */
  | { type: 'addContextVoice'; contextId: string; voiceId: string }
  | { type: 'removeContextVoice'; contextId: string; voiceId: string }
  | { type: 'setDynamic'; measureId: string; position: Position; voiceIds: string[]; dynamic: Dynamic }
  | {
      type: 'createHairpin';
      start: { measureId: string; position: Position };
      end: { measureId: string; position: Position };
      voiceIds: string[];
      /** the level it ends on — whether it opens or closes follows from the level it starts at */
      target: Dynamic;
    }
  | { type: 'setHairpinTarget'; hairpinId: string; target: Dynamic }
  /** a stretch of the score played in `passes`; with no `end` it lasts until the end of the score */
  /** a stretch of the score played `times` times; with no `end` it lasts until the end of the score */
  | { type: 'createRefrain'; start: { measureId: string; position: Position }; end: { measureId: string; position: Position } | null; times: number }
  | { type: 'setRefrainTimes'; refrainId: string; times: number }
  /** a repeat becomes a volta: its stretch is the body and its first ending ends at `end` (`null`: the end of the score) */
  | { type: 'addRefrainEnding'; refrainId: string; end: { measureId: string; position: Position } | null }
  | { type: 'moveRefrainStart'; refrainId: string; start: { measureId: string; position: Position } }
  | { type: 'moveRefrainEnd'; refrainId: string; end: { measureId: string; position: Position } | null }
  /** the endings of a repeat: a body from `start` to `bodyEnd` and the fragments after it, each in its own passes (the last of them may
   *  last until the end of the score, `end: null`); the passes together are every pass from the first, each in one fragment */
  | {
      type: 'createVolta';
      start: { measureId: string; position: Position };
      bodyEnd: { measureId: string; position: Position };
      fragments: { end: { measureId: string; position: Position } | null; passes: number[] }[];
    }
  /** drag a boundary of a volta: 0 is where the body ends, `i` where fragment `i` ends; a fragment the dragged boundary covers whole is absorbed */
  | { type: 'moveVoltaBoundary'; voltaId: string; boundary: number; to: { measureId: string; position: Position } | null }
  | { type: 'moveVoltaStart'; voltaId: string; start: { measureId: string; position: Position } }
  /** the passes of a fragment counted from zero; the first fragment is played in the passes the others leave */
  | { type: 'setVoltaFragmentPasses'; voltaId: string; fragment: number; passes: number[] }
  /** how many times a volta is played; the first ending takes the passes the others leave */
  | { type: 'setVoltaTimes'; voltaId: string; times: number }
  | { type: 'appendVoltaFragment'; voltaId: string; end: { measureId: string; position: Position } | null }
  | { type: 'splitVoltaFragment'; voltaId: string; at: { measureId: string; position: Position } }
  /** a span (octave line: its notes by `mode`) lasts until the end of the score */
  | { type: 'openContextEnd'; contextId: string; mode: PitchMode }
  | {
      type: 'createSlur';
      start: { measureId: string; position: Position };
      end: { measureId: string; position: Position };
      voiceIds: string[];
    }
  /** a damper pedal over a stretch of the score: one pedal, so no staff and no voices */
  | { type: 'createSustainHold'; start: { measureId: string; position: Position }; end: { measureId: string; position: Position } }
  | {
      type: 'createOctaveTransposition';
      staffId: string;
      start: { measureId: string; position: Position };
      end: { measureId: string; position: Position };
      octaves: number;
      mode: PitchMode;
    }
  | { type: 'deleteOctaveTransposition'; octaveId: string; mode: PitchMode }
  /** a tempo gives a number, a word, or both */
  | { type: 'setTempo'; measureId: string; position: Position; beat: WrittenValue | null; bpm: number | null; showLabel?: boolean; label?: TempoWord | null }
  | {
      type: 'createTempoTransition';
      start: { measureId: string; position: Position };
      end: { measureId: string; position: Position };
      targetBpm: number;
    }
  | { type: 'setTempoTransitionTarget'; transitionId: string; targetBpm: number }
  /** move where a context starts / ends — any span, or a point context's one position; `presentation` changes ride in the same request and are one gesture with it */
  | { type: 'moveContextStart'; contextId: string; measureId: string; position: Position; mode: PitchMode; presentation?: PresentationChange[] }
  | { type: 'moveContextEnd'; contextId: string; measureId: string; position: Position; mode: PitchMode; presentation?: PresentationChange[] }
  /** a grace note before or after a carrier, after the grace carrier `afterCarrierId` of that side (first when null);
   *  `graceKind` is the kind of a group it makes, an existing group keeps its own */
  | {
      type: 'addGraceNote';
      hostCarrierId: string;
      placement: 'before' | 'after';
      graceKind: 'appoggiatura' | 'acciaccatura';
      writtenValue: WrittenValue;
      staffId: string;
      staffStep: number;
      accidental?: string | null;
      fingering?: number;
      afterCarrierId?: string | null;
    }
  /** the kind of the group a grace note belongs to: slashed or plain; its time then changes */
  | { type: 'changeGraceType'; noteId: string; graceKind: 'appoggiatura' | 'acciaccatura' }
  /** a grace carrier written as another value */
  | { type: 'changeGraceValue'; carrierId: string; writtenValue: WrittenValue }
  /** one more note in a grace carrier, which then holds a chord */
  | { type: 'addGraceCarrierNote'; carrierId: string; staffId: string; staffStep: number; accidental?: string | null; fingering?: number }
  /** put a note on another step of its staff */
  | { type: 'changePitch'; noteId: string; staffStep: number }
  | { type: 'shiftStaffSteps'; noteIds: string[]; delta: -1 | 1 }
  | { type: 'setAccidental'; noteId: string; accidental: 'flat' | 'natural' | 'sharp' }
  | { type: 'moveNoteToStaff'; noteId: string; staffId: string; mode: PitchMode };
