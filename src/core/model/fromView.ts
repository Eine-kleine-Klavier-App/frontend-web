// Maps the backend's flat entity dump (PianoAppBackend
// `application/use_cases/score/view.py` — `ScoreEditView.jsonify`) into the client model.
// The backend sends the raw document graph, normalized by id (staffs, measures, voices,
// rhythmic_containers, carriers, items, relations) rather than a pre-grouped render tree —
// this file does the measure/voice grouping and position ordering.

import { emptyPresentation, stemPlacements, type Presentation, type PlacementCapabilities } from './presentation';
import type {
  Accidental,
  ArticulationMark,
  OrnamentMark,
  ClefName,
  DurationValue,
  Dynamic,
  GraceGroup,
  Item,
  KeyAlteration,
  Measure,
  NoteRef,
  ScoreContext,
  ScoreDocument,
  TempoWord,
  Tuplet,
  VoiceMeasure,
} from '@/core/model/score';

interface ViewStaff {
  id: string;
}
interface ViewMeasure {
  id: string;
  time_signature: { count: number; value: number; dots: number };
}
interface ViewVoice {
  id: string;
  rhythmic_container_ids: string[];
}
interface ViewRhythmicSize {
  count: number;
  value: number;
  dots: number;
}
interface ViewFraction {
  numerator: number;
  denominator: number;
}
interface ViewGroupContainer {
  id: string;
  kind: 'group';
  written_size: ViewRhythmicSize;
  occupied_size: ViewRhythmicSize;
  child_ids: string[];
}
interface ViewLeafContainer {
  id: string;
  kind: 'leaf';
  written_size: ViewRhythmicSize;
  occupied_size: ViewRhythmicSize;
  measure_id: string;
  position: ViewFraction;
  carrier_id: string;
  grace_before?: ViewGraceGroup | null;
  grace_after?: ViewGraceGroup | null;
}
interface ViewGraceGroup {
  id: string;
  grace_type: 'appoggiatura' | 'acciaccatura';
  items: { id: string; rhythmic_value: { value: number; dots: number }; carrier_id: string }[];
}
type ViewRhythmicContainer = ViewGroupContainer | ViewLeafContainer;
interface ViewChordCarrier {
  id: string;
  kind: 'chord';
  articulations: ArticulationMark[];
  ornament?: OrnamentMark;
  note_ids: string[];
}
interface ViewRestCarrier {
  id: string;
  kind: 'rest';
  rest_id: string;
}
type ViewCarrier = ViewChordCarrier | ViewRestCarrier;
interface ViewNoteItem {
  id: string;
  kind: 'note';
  staff_id: string;
  staff_step: number;
  accidental: string;
  fingering: number;
  midi_note?: number | null;
}
interface ViewRestItem {
  id: string;
  kind: 'rest';
  staff_id: string;
}
type ViewMusicalItem = ViewNoteItem | ViewRestItem;
interface ViewTie {
  id: string;
  kind: 'tie';
  start_note_id: string;
  end_note_id: string;
}
interface ViewGlissando {
  id: string;
  kind: 'glissando';
  start_note_id: string;
  end_note_id: string;
  glissando_type: 'straight' | 'wavy';
}
interface ViewBeam {
  override?: { left_offset: number; right_offset: number } | null;
  id: string;
  kind: 'beam';
  carrier_ids: string[];
}
type ViewRelation = ViewTie | ViewGlissando | ViewBeam;

interface ViewContextBase {
  id: string;
  measure_id: string;
  position: ViewFraction;
}
type ViewContext = ViewContextBase &
  (
    | { kind: 'clef_change'; staff_id: string; clef: ClefName; octave_transposition: number }
    | { kind: 'key_signature_change'; staff_id: string; alterations: KeyAlteration[] }
    | { kind: 'dynamic_change'; voice_id: string; dynamic: Dynamic }
    | { kind: 'tempo_change'; beat: { value: number; dots: number } | null; bpm: number | null; label: TempoWord | null; show_label?: boolean }
    | {
        kind: 'hairpin';
        end_measure_id: string | null;
        end_position: ViewFraction | null;
        voice_id: string;
        steps?: number;
        hairpin_type: 'crescendo' | 'diminuendo';
        from: Dynamic;
        to: Dynamic;
      }
    | { kind: 'sustain_hold'; end_measure_id: string | null; end_position: ViewFraction | null }
    | { kind: 'refrain'; end_measure_id: string | null; end_position: ViewFraction | null; times: number }
    | {
        kind: 'volta';
        body_end_measure_id: string;
        body_end_position: ViewFraction;
        pass_count: number;
        fragments: { end_measure_id: string | null; end_position: ViewFraction | null; passes: number[] }[];
      }
    | { kind: 'slur'; end_measure_id: string | null; end_position: ViewFraction | null; voice_id: string }
    | { kind: 'octave_transposition'; end_measure_id: string | null; end_position: ViewFraction | null; staff_id: string; octaves: number }
    | {
        kind: 'tempo_transition';
        end_measure_id: string | null;
        end_position: ViewFraction | null;
        ratio?: ViewFraction;
        start_tempo: { beat: { value: number; dots: number }; bpm: number } | null;
        end_tempo: { beat: { value: number; dots: number }; bpm: number } | null;
      }
  );

export interface ScoreView {
  music_revision: string;
  presentation?: Presentation;
  presentation_capabilities?: PlacementCapabilities[];
  insertion_spaces?: { id: string; voice_id: string; parent_id: string | null; start: ViewFraction; scale: ViewFraction; extent: ViewFraction }[];
  staffs: ViewStaff[];
  measures: ViewMeasure[];
  voices: ViewVoice[];
  rhythmic_containers: ViewRhythmicContainer[];
  carriers: ViewCarrier[];
  items: ViewMusicalItem[];
  relations: ViewRelation[];
  /** absent from an older backend */
  contexts?: ViewContext[];
}

function toContext(c: ViewContext): ScoreContext {
  const at = { id: c.id, measureId: c.measure_id, position: c.position };
  switch (c.kind) {
    case 'clef_change':
      return { ...at, kind: 'clef', staffId: c.staff_id, clef: c.clef, octaveTransposition: c.octave_transposition };
    case 'key_signature_change':
      return { ...at, kind: 'keySignature', staffId: c.staff_id, alterations: c.alterations };
    case 'dynamic_change':
      return { ...at, kind: 'dynamic', voiceId: c.voice_id, dynamic: c.dynamic };
    case 'tempo_change':
      return { ...at, kind: 'tempo', beat: c.beat, bpm: c.bpm, label: c.label, showLabel: c.show_label ?? c.label !== null };
    case 'hairpin':
      return {
        ...at,
        kind: 'hairpin',
        endMeasureId: c.end_measure_id,
        endPosition: c.end_position,
        voiceId: c.voice_id,
        type: c.hairpin_type,
        steps: c.steps,
        from: c.from,
        to: c.to,
      };
    case 'sustain_hold':
      return { ...at, kind: 'sustain', endMeasureId: c.end_measure_id, endPosition: c.end_position };
    case 'refrain':
      return { ...at, kind: 'refrain', endMeasureId: c.end_measure_id, endPosition: c.end_position, times: c.times };
    case 'volta':
      return {
        ...at,
        kind: 'volta',
        bodyEndMeasureId: c.body_end_measure_id,
        bodyEndPosition: c.body_end_position,
        passCount: c.pass_count,
        fragments: c.fragments.map((f) => ({ endMeasureId: f.end_measure_id, endPosition: f.end_position, passes: f.passes })),
      };
    case 'slur':
      return { ...at, kind: 'slur', endMeasureId: c.end_measure_id, endPosition: c.end_position, voiceId: c.voice_id };
    case 'octave_transposition':
      return {
        ...at,
        kind: 'octave',
        endMeasureId: c.end_measure_id,
        endPosition: c.end_position,
        staffId: c.staff_id,
        octaves: c.octaves,
      };
    case 'tempo_transition':
      return {
        ...at,
        kind: 'tempoTransition',
        ratio: c.ratio,
        startTempo: c.start_tempo,
        endTempo: c.end_tempo,
        endMeasureId: c.end_measure_id,
        endPosition: c.end_position,
        startBpm: c.start_tempo?.bpm ?? null,
        endBpm: c.end_tempo?.bpm ?? null,
      };
  }
}

const DURATION: Record<number, DurationValue> = {
  1: 'w',
  2: 'h',
  4: 'q',
  8: '8',
  16: '16',
  32: '32',
};

function toAccidental(a: string): Accidental {
  if (a === 'sharp') return '#';
  if (a === 'flat') return 'b';
  if (a === 'natural') return 'n';
  return null;
}

function positionValue(p: ViewFraction): number {
  return p.numerator / p.denominator;
}

// a rhythmic size as a fraction of a whole note
function toSize(s: ViewRhythmicSize) {
  return { count: s.count, value: { value: s.value, dots: s.dots } };
}

function sizeValue(size: ViewRhythmicSize): number {
  return (size.count / size.value) * (2 - Math.pow(0.5, size.dots));
}

// the ratio counted in the written note value: 3 eighths in the time of 2 eighths -> 3 : 2
function toTuplet(group: ViewGroupContainer, carrierIds: string[]): Tuplet {
  const writtenNote = sizeValue({ ...group.written_size, count: 1 });
  let numNotes = group.written_size.count;
  let notesOccupied = sizeValue(group.occupied_size) / writtenNote;
  if (!Number.isInteger(notesOccupied)) {
    const gcd = (a: number, b: number): number => b ? gcd(b, a % b) : a;
    const writtenTicks = Math.round(sizeValue(group.written_size) * 1024);
    const occupiedTicks = Math.round(sizeValue(group.occupied_size) * 1024);
    const divisor = gcd(writtenTicks, occupiedTicks);
    numNotes = writtenTicks / divisor;
    notesOccupied = occupiedTicks / divisor;
  }
  return {
    id: group.id,
    writtenSize: toSize(group.written_size),
    occupiedSize: toSize(group.occupied_size),
    numNotes,
    notesOccupied,
    carrierIds,
  };
}

// measure_id + voice_id -> a stable, order-independent lookup key.
function bucketKey(measureId: string, voiceId: string): string {
  return `${measureId}\0${voiceId}`;
}

export function fromView(view: ScoreView, scoreId: string): ScoreDocument {
  const containerById = new Map(view.rhythmic_containers.map((c) => [c.id, c]));
  const carrierById = new Map(view.carriers.map((c) => [c.id, c]));
  const itemById = new Map(view.items.map((i) => [i.id, i]));

  // A voice only lists its TOP-LEVEL container ids -> descend groups to reach every leaf.
  const voiceOfLeaf = new Map<string, string>();
  const collectLeaves = (containerId: string, voiceId: string): void => {
    const container = containerById.get(containerId);
    if (!container) return;
    if (container.kind === 'group') {
      for (const childId of container.child_ids) collectLeaves(childId, voiceId);
    } else {
      voiceOfLeaf.set(container.id, voiceId);
    }
  };
  for (const voice of view.voices) {
    for (const containerId of voice.rhythmic_container_ids) collectLeaves(containerId, voice.id);
  }

  const leavesByBucket = new Map<string, ViewLeafContainer[]>();
  for (const container of view.rhythmic_containers) {
    if (container.kind !== 'leaf') continue;
    const voiceId = voiceOfLeaf.get(container.id);
    if (!voiceId) continue;
    const key = bucketKey(container.measure_id, voiceId);
    const bucket = leavesByBucket.get(key);
    if (bucket) bucket.push(container);
    else leavesByBucket.set(key, [container]);
  }

  function toNoteRef(noteId: string): NoteRef {
    const note = itemById.get(noteId);
    if (!note || note.kind !== 'note') throw new Error(`Missing note item ${noteId}`);
    return {
      noteId: note.id,
      staffId: note.staff_id,
      staffStep: note.staff_step,
      accidental: toAccidental(note.accidental),
      fingering: note.fingering,
      midiNote: note.midi_note ?? null,
    };
  }

  // a grace group's carriers; a grace rest is not made by the backend and is not drawn
  function toGraceGroup(group: ViewGraceGroup | null | undefined): GraceGroup | null {
    if (!group) return null;
    return {
      id: group.id,
      kind: group.grace_type,
      carriers: group.items.flatMap((item) => {
        const carrier = carrierById.get(item.carrier_id);
        if (!carrier || carrier.kind !== 'chord') return [];
        return [{
          id: carrier.id,
          duration: DURATION[item.rhythmic_value.value] ?? '32',
          dots: item.rhythmic_value.dots,
          notes: carrier.note_ids.map(toNoteRef),
          articulations: carrier.articulations,
        }];
      }),
    };
  }

  function toItem(leaf: ViewLeafContainer): Item {
    const carrier = carrierById.get(leaf.carrier_id);
    if (!carrier) throw new Error(`Missing carrier ${leaf.carrier_id}`);
    const base = {
      id: carrier.id,
      duration: DURATION[leaf.written_size.value] ?? 'q',
      dots: leaf.written_size.dots,
      writtenSize: toSize(leaf.written_size),
      occupiedSize: toSize(leaf.occupied_size),
      position: positionValue(leaf.position) * 4,
      positionFraction: leaf.position,
      graceBefore: toGraceGroup(leaf.grace_before),
      graceAfter: toGraceGroup(leaf.grace_after),
    };
    if (carrier.kind === 'chord') {
      return { ...base, kind: 'note', notes: carrier.note_ids.map(toNoteRef), articulations: carrier.articulations, ornament: carrier.ornament ?? 'none' };
    }
    const rest = itemById.get(carrier.rest_id);
    if (!rest) throw new Error(`Missing rest item ${carrier.rest_id}`);
    return { ...base, kind: 'rest', notes: [], staffId: rest.staff_id, articulations: [] };
  }

  function leafCarrierIds(containerId: string): string[] {
    const container = containerById.get(containerId);
    if (!container) return [];
    return container.kind === 'group' ? container.child_ids.flatMap(leafCarrierIds) : [container.carrier_id];
  }

  function toVoiceMeasure(voiceId: string, measureId: string): VoiceMeasure {
    const leaves = leavesByBucket.get(bucketKey(measureId, voiceId)) ?? [];
    const items = [...leaves].sort((a, b) => positionValue(a.position) - positionValue(b.position)).map(toItem);
    return { id: voiceId, items };
  }

  function toMeasure(m: ViewMeasure): Measure {
    return {
      id: m.id,
      timeSignature: { beats: m.time_signature.count, beatValue: m.time_signature.value, dots: m.time_signature.dots },
      voices: view.voices.map((v) => toVoiceMeasure(v.id, m.id)),
    };
  }

  return {
    id: scoreId,
    insertionSpaces: view.insertion_spaces?.map(space => ({ id: space.id, voiceId: space.voice_id, parentId: space.parent_id, start: space.start, scale: space.scale, extent: space.extent })),
    title: 'Untitled',
    staffOrder: view.staffs.map((s) => s.id),
    voices: view.voices.map((v, index) => ({ id: v.id, index })),
    measures: view.measures.map(toMeasure),
    musicRevision: view.music_revision,
    presentation: view.presentation ?? emptyPresentation(),
    presentationCapabilities: view.presentation_capabilities ?? [],
    stemOverrides: stemPlacements(view.presentation ?? emptyPresentation()),
    ties: view.relations.flatMap((r) =>
      r.kind === 'tie' ? [{ id: r.id, startNoteId: r.start_note_id, endNoteId: r.end_note_id }] : [],
    ),
    glissandos: view.relations.flatMap((r) =>
      r.kind === 'glissando' ? [{ id: r.id, startNoteId: r.start_note_id, endNoteId: r.end_note_id, glissandoType: r.glissando_type }] : [],
    ),
    beams: view.relations.flatMap((r) => (r.kind === 'beam' ? [{ id: r.id, carrierIds: r.carrier_ids, override: (() => { const value = view.presentation?.endpoints.find(p => p.entity_id === r.id); return value ? { leftFactor: value.left, rightFactor: value.right } : null; })() }] : [])),
    // the view lists every group before its children, so outer tuplets come first
    tuplets: view.rhythmic_containers.flatMap((c) => (c.kind === 'group' ? [toTuplet(c, leafCarrierIds(c.id))] : [])),
    contexts: (view.contexts ?? []).map(toContext),
  };
}
