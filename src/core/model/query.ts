import { measureBeats } from './contexts';
import type { ContextCoverage, GraceGroup, Item, NoteRef, ScoreDocument } from './score';

/** An item's own individually-selectable ids — its chord's several note ids, or (a rest) its
 *  own carrier id as a single-element fallback. Every group-select helper below (`selectedIds`
 *  is always individual-note-id-granularity, see Overlay.tsx) flattens through this so a chord
 *  inside a selected voice/staff/measure highlights ALL its notes, not nothing. */
function itemNoteIds(item: Item): string[] {
  return item.notes.length ? item.notes.map((n) => n.noteId) : [item.id];
}

/** The items of a voice in one measure with each item's grace carriers beside it, in the order they are
 *  played, the grace carriers as items of their own (marked by `grace`). A grace note is selected, edited
 *  and deleted by its own ids like the notes of any carrier, so every lookup by id goes through this. */
export function withGraces(items: Item[]): Item[] {
  return items.flatMap((item) => {
    const asItems = (group: GraceGroup | null | undefined, side: 'before' | 'after'): Item[] =>
      group ? group.carriers.map((carrier) => ({
        id: carrier.id,
        kind: 'note',
        duration: carrier.duration,
        dots: carrier.dots,
        position: item.position,
        notes: carrier.notes,
        articulations: carrier.articulations,
        grace: { hostId: item.id, side, kind: group.kind },
      })) : [];
    return [...asItems(item.graceBefore, 'before'), item, ...asItems(item.graceAfter, 'after')];
  });
}

export interface NoteLocation {
  measureId: string;
  staffId: string;
  voiceId: string;
}

/** Which measure/staff/voice a note lives in. Accepts EITHER an individual note id (resolves to
 *  that note's own staff — unambiguous) OR a carrier id (a cross-staff chord makes this
 *  ambiguous: falls back to its FIRST note's staff — callers that need an exact staff should
 *  pass the individual note id instead, e.g. a `NoteBox.id`, not its `carrierId`). */
export function locate(doc: ScoreDocument, id: string): NoteLocation | null {
  for (const m of doc.measures) {
    for (const v of m.voices) {
      for (const item of withGraces(v.items)) {
        if (item.kind === 'rest') {
          if (item.id === id && item.staffId) return { measureId: m.id, staffId: item.staffId, voiceId: v.id };
          continue;
        }
        const n = item.notes.find((x) => x.noteId === id);
        if (n) return { measureId: m.id, staffId: n.staffId, voiceId: v.id };
        if (item.id === id && item.notes[0]) {
          return { measureId: m.id, staffId: item.notes[0].staffId, voiceId: v.id };
        }
      }
    }
  }
  return null;
}

/** All individually-selectable note ids belonging to one carrier (a chord's several keys,
 *  possibly across DIFFERENT staves, or a single note's own one id) — used to expand a fast
 *  double-click on one notehead into "select the whole chord," including any cross-staff
 *  partner notes. Falls back to the carrier id itself (a rest, or a lookup miss). */
export function chordNoteIds(doc: ScoreDocument, carrierId: string): string[] {
  for (const m of doc.measures) {
    for (const v of m.voices) {
      const item = withGraces(v.items).find((x) => x.id === carrierId);
      if (item) return itemNoteIds(item);
    }
  }
  return [carrierId];
}

/** The carrier a given id belongs to — accepts EITHER a carrier id (returned as-is) or an
 *  individual note id (resolved to its owning carrier). Used wherever an operation is only
 *  defined at carrier granularity (e.g. delete) but `selectedIds` may hold individual note ids. */
export function carrierIdOf(doc: ScoreDocument, id: string): string {
  for (const m of doc.measures) {
    for (const v of m.voices) {
      for (const item of withGraces(v.items)) {
        if (item.id === id || item.notes.some((n) => n.noteId === id)) return item.id;
      }
    }
  }
  return id;
}

/** The full item (chord/rest) a carrier id belongs to — for callers that need its `notes` list
 *  itself, not just derived id sets (e.g. within-chord note-to-note navigation). */
export function itemOf(doc: ScoreDocument, carrierId: string): Item | null {
  for (const m of doc.measures) {
    for (const v of m.voices) {
      const item = withGraces(v.items).find((x) => x.id === carrierId);
      if (item) return item;
    }
  }
  return null;
}

/** A chord's own note ids, ordered bottom-to-top PHYSICALLY (screen position), not by pitch —
 *  pitch/spelling isn't implemented (`staff_step` carried as-is, see backend CLAUDE.md), so this
 *  is the only "low to high" the client can compute. `staffStep` (0 = that staff's bottom line,
 *  increasing = higher) is only comparable WITHIN one staff — a cross-staff chord's two halves
 *  live in different physical coordinate systems, so staves are ordered first (by `doc.staffOrder`,
 *  top-to-bottom; a note on a LOWER staff always sorts below one on a HIGHER staff, regardless of
 *  its own `staffStep`), and `staffStep` only breaks ties within the same staff. */
export function physicalNoteOrder(doc: ScoreDocument, item: Item): string[] {
  return [...item.notes]
    .sort((a, b) => {
      const ai = doc.staffOrder.indexOf(a.staffId);
      const bi = doc.staffOrder.indexOf(b.staffId);
      if (ai !== bi) return bi - ai; // higher staffOrder index = lower staff = sorts first (lowest)
      return a.staffStep - b.staffStep; // ascending staffStep = low to high within one staff
    })
    .map((n) => n.noteId);
}

/** Every individually-selectable note id of one voice within one measure, across ALL the
 *  staves that voice touches there (voice is the real axis — a cross-staff chord's partner
 *  notes belong to the same "whole voice in this measure" group even though they render on a
 *  different staff). */
export function voiceNoteIds(doc: ScoreDocument, measureId: string, voiceId: string): string[] {
  const v = doc.measures.find((m) => m.id === measureId)?.voices.find((x) => x.id === voiceId);
  return v ? withGraces(v.items).flatMap(itemNoteIds) : [];
}

/** Every individually-selectable note id landing on one staff within one measure, across all
 *  voices — a chord note only counts if ITS OWN staff matches (a cross-staff chord contributes
 *  only its notes on this staff, not its partner notes on the other staff). */
export function staffNoteIds(doc: ScoreDocument, measureId: string, staffId: string): string[] {
  const m = doc.measures.find((x) => x.id === measureId);
  if (!m) return [];
  const ids: string[] = [];
  for (const v of m.voices) {
    for (const item of withGraces(v.items)) {
      if (item.kind === 'rest') {
        if (item.staffId === staffId) ids.push(item.id);
        continue;
      }
      ids.push(...item.notes.filter((n) => n.staffId === staffId).map((n) => n.noteId));
    }
  }
  return ids;
}

/** Every individually-selectable note id of a global voice, across all staffs and measures.
 *  Voices are global (a voice spans staffs), so we match by voice id, not a per-staff index. */
export function voiceCarrierIds(doc: ScoreDocument, voiceId: string): string[] {
  const ids: string[] = [];
  for (const m of doc.measures) {
    const v = m.voices.find((x) => x.id === voiceId);
    if (v) ids.push(...withGraces(v.items).flatMap(itemNoteIds));
  }
  return ids;
}

/** One entry PER CARRIER (chord/rest, `item.id` — not exploded to individual note ids like
 *  `voiceCarrierIds`) of a global voice, in document order across measures. Metric operations such
 *  as beaming exclude grace carriers; selection navigation has its own order below. A measure the
 *  voice has nothing in contributes no id. */
export function orderedVoiceCarrierIds(doc: ScoreDocument, voiceId: string): string[] {
  const ids: string[] = [];
  for (const m of doc.measures) {
    const v = m.voices.find((x) => x.id === voiceId);
    if (v) ids.push(...v.items.map((item) => item.id));
  }
  return ids;
}

/** Selection walks every carrier in reading order, including both sides of a host's grace groups.
 *  Metric carrier order stays separate for operations such as beaming. */
export function orderedVoiceNavigationIds(doc: ScoreDocument, voiceId: string): string[] {
  return doc.measures.flatMap(measure => {
    const voice = measure.voices.find(candidate => candidate.id === voiceId);
    return voice ? withGraces(voice.items).map(item => item.id) : [];
  });
}

export function measureNoteIds(doc: ScoreDocument, measureId: string): string[] {
  const m = doc.measures.find((x) => x.id === measureId);
  return m ? m.voices.flatMap((v) => withGraces(v.items).flatMap(itemNoteIds)) : [];
}


export interface ContentSelection {
  noteIds: string[];
  carrierIds: string[];
  structureIds: string[];
}

/** Group picks colour the complete local glyph, including a selected half of a cross-staff chord.
 *  A relation belongs to the pick only when all of its members belong to it. */
export function contentSelection(doc: ScoreDocument, noteIds: string[], contextIds: string[] = []): ContentSelection {
  const picked = new Set(noteIds);
  const carrierIds = [...new Set(noteIds.map(id => carrierIdOf(doc, id)))];
  const whole = new Set(carrierIds.filter(id => chordNoteIds(doc, id).every(noteId => picked.has(noteId))));
  const relations = [...doc.beams, ...doc.tuplets].filter(relation =>
    relation.carrierIds.length > 0 && relation.carrierIds.every(id => whole.has(id))).map(relation => relation.id);
  const ties = [...doc.ties, ...doc.glissandos].filter(tie => picked.has(tie.startNoteId) && picked.has(tie.endNoteId)).map(tie => tie.id);
  return { noteIds: [...picked], carrierIds, structureIds: [...new Set([...relations, ...ties, ...contextIds])] };
}

export function measureContentSelection(doc: ScoreDocument, measureId: string, staffId?: string): ContentSelection {
  if (!doc.measures.some(measure => measure.id === measureId)) return { noteIds: [], carrierIds: [], structureIds: [] };
  const contextIds = doc.contexts.filter(context => context.measureId === measureId
    && 'staffId' in context && (!staffId || context.staffId === staffId)).map(context => context.id);
  return contentSelection(doc, staffId ? staffNoteIds(doc, measureId, staffId) : measureNoteIds(doc, measureId), contextIds);
}

/** What belongs to a relation: the notes of its members, and so everything those notes make whole
 *  (a beam or tuplet over exactly them, a tie between them). A beam and a tuplet name carriers, a
 *  tie its two notes. */
export function relationContentSelection(doc: ScoreDocument, relationId: string): ContentSelection {
  const tie = [...doc.ties, ...doc.glissandos].find(candidate => candidate.id === relationId);
  if (tie) return contentSelection(doc, [tie.startNoteId, tie.endNoteId]);
  const carrierIds = [...doc.beams, ...doc.tuplets].find(candidate => candidate.id === relationId)?.carrierIds;
  if (!carrierIds) return { noteIds: [], carrierIds: [], structureIds: [] };
  return contentSelection(doc, carrierIds.flatMap(id => chordNoteIds(doc, id)));
}

/** What a context is applied to, as the backend answers (it owns the rule): the covered notes and
 *  the covered rests, with the context itself. */
export function contextContentSelection(doc: ScoreDocument, contextId: string, coverage: ContextCoverage): ContentSelection {
  const restIds = coverage.carrierIds.filter(id => itemOf(doc, id)?.kind === 'rest');
  return contentSelection(doc, [...coverage.noteIds, ...restIds], [contextId]);
}

/** Empty-space staff gestures are bounded by its five lines, including the outer lines. */
export function staffContainsPoint(zone: { x0: number; x1: number; bottomLineY: number; stepPx: number }, x: number, y: number): boolean {
  return x >= zone.x0 && x <= zone.x1 && y >= zone.bottomLineY - 8 * zone.stepPx && y <= zone.bottomLineY;
}

export function splitBeamTarget(doc: ScoreDocument, carrierId: string): { beamId: string; beforeCarrierId: string } | null {
  const beam = doc.beams.find(candidate => candidate.carrierIds.indexOf(carrierId) > 0);
  return beam ? { beamId: beam.id, beforeCarrierId: carrierId } : null;
}

/** One carrier (chord/rest) touched by the current selection, with which of its notes are picked. */
export interface SelectedCarrier {
  item: Item;
  measureId: string;
  voiceId: string;
  /** the selected individual note refs of THIS carrier (empty for a rest). */
  notes: NoteRef[];
  /** true when every one of the carrier's notes is selected (or it's a rest, selected as a whole). */
  whole: boolean;
}

/** Structured view of `selectedIds` (which hold individual note ids, plus a rest's own carrier id)
 *  for the contextual properties panel: the distinct carriers touched, and per-carrier which notes.
 *  Ordered by document position (measure, then voice, then item) for a stable panel. */
export interface SelectionInfo {
  carriers: SelectedCarrier[];
  /** count of individually-selected notes across all chords. */
  noteCount: number;
  /** count of selected rests. */
  restCount: number;
}

export function describeSelection(doc: ScoreDocument, selectedIds: string[]): SelectionInfo {
  const ids = new Set(selectedIds);
  const carriers: SelectedCarrier[] = [];
  let noteCount = 0;
  let restCount = 0;
  for (const m of doc.measures) {
    for (const v of m.voices) {
      for (const item of withGraces(v.items)) {
        if (item.kind === 'rest') {
          if (ids.has(item.id)) {
            carriers.push({ item, measureId: m.id, voiceId: v.id, notes: [], whole: true });
            restCount += 1;
          }
          continue;
        }
        const picked = item.notes.filter((n) => ids.has(n.noteId));
        if (picked.length) {
          carriers.push({
            item,
            measureId: m.id,
            voiceId: v.id,
            notes: picked,
            whole: picked.length === item.notes.length,
          });
          noteCount += picked.length;
        }
      }
    }
  }
  return { carriers, noteCount, restCount };
}

/** Where `timeBeats` (quarter beats from the start) falls: the 0-based measure index and the 1-based
 *  beat in that measure's own beat unit (a 6/8 bar counts eighths). Bars accumulate exactly as the
 *  renderer's time map does (`beats * 4 / beatValue` quarter beats each), so the transport readout,
 *  the current-bar wash and the playback cursor always agree. */
export function barAtBeat(doc: ScoreDocument, timeBeats: number): { index: number; beat: number } {
  let start = 0;
  for (let i = 0; i < doc.measures.length; i++) {
    const { beats } = doc.measures[i].timeSignature;
    const length = measureBeats(doc.measures[i].timeSignature);
    if (timeBeats < start + length || i === doc.measures.length - 1) {
      const unit = length / beats;
      return { index: i, beat: Math.min(beats, Math.floor((timeBeats - start) / unit + 1e-6) + 1) };
    }
    start += length;
  }
  return { index: 0, beat: 1 };
}

/** Every selectable entity id in the document — each note of a chord, and each rest — with its
 *  kind. */
export function entityKinds(doc: ScoreDocument): Map<string, 'note' | 'rest'> {
  const kinds = new Map<string, 'note' | 'rest'>();
  for (const m of doc.measures)
    for (const v of m.voices)
      for (const item of withGraces(v.items)) {
        if (item.kind === 'rest') kinds.set(item.id, 'rest');
        else item.notes.forEach((n) => kinds.set(n.noteId, 'note'));
      }
  return kinds;
}
