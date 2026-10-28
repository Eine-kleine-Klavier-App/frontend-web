import { useEditor, subscribeEditorEdits, type EditorEditEvent } from '@/app/store';
import type { ScoreDocument, Item, NoteRef } from '@/core/model/score';
import { playback } from '@/core/playback/PlaybackController';
import { withGraces } from '@/core/model/query';

type State = ReturnType<typeof useEditor.getState>;
export interface PreviewTarget { carrierId: string; noteIds?: string[] }
const items = (document: ScoreDocument): Item[] => document.measures.flatMap(m => m.voices.flatMap(v => withGraces(v.items)));
const notes = (document: ScoreDocument) => items(document).flatMap(item => item.notes.map(note => ({ item, note })));
const changed = (a: NoteRef, b: NoteRef): boolean => a.staffStep !== b.staffStep || a.accidental !== b.accidental || a.staffId !== b.staffId || a.midiNote !== b.midiNote;

/** A single note or a whole carrier is an individual pick; ranges and structures are silent. */
export function selectionPreview(state: Pick<State, 'document' | 'selectedIds' | 'carrierSelectedIds' | 'selectedMeasureIds' | 'selectedStructureIds'>): PreviewTarget | null {
  if (state.selectedMeasureIds.length || state.selectedStructureIds.length || !state.selectedIds.length) return null;
  const selected = new Set(state.selectedIds);
  const picked = notes(state.document).filter(({ note }) => selected.has(note.noteId));
  if (picked.length !== selected.size || new Set(picked.map(({ item }) => item.id)).size !== 1) return null;
  const item = picked[0].item;
  if (state.carrierSelectedIds.length && (state.carrierSelectedIds.length !== 1 || state.carrierSelectedIds[0] !== item.id)) return null;
  if (picked.length === item.notes.length) return { carrierId: item.id };
  return picked.length === 1 ? { carrierId: item.id, noteIds: [picked[0].note.noteId] } : null;
}

/** Explicit pitch edits audition their source chord even when ties propagate into other carriers. */
export function editPreview(event: EditorEditEvent): PreviewTarget | null {
  if (!event.after) return null;
  const before = new Map(notes(event.before).map(entry => [entry.note.noteId, entry]));
  const after = notes(event.after);
  const command = event.command;
  if (command.type === 'insertNote' || command.type === 'addGraceNote' || command.type === 'addGraceCarrierNote' || (command.type === 'createTuplet' && command.note)) {
    const created = after.find(({ note }) => !before.has(note.noteId));
    return created ? { carrierId: created.item.id } : null;
  }
  const ids = command.type === 'shiftStaffSteps' ? command.noteIds
    : command.type === 'changePitch' || command.type === 'setAccidental' || command.type === 'moveNoteToStaff' ? [command.noteId] : null;
  const affected = after.filter(({ note }) => {
    const old = before.get(note.noteId);
    return old && (!ids || ids.includes(note.noteId)) && changed(old.note, note);
  });
  const carriers = new Set(affected.map(({ item }) => item.id));
  return carriers.size === 1 ? { carrierId: affected[0].item.id } : null;
}

export function bindEditorAudition(editor = useEditor, transport = playback, editEvents = subscribeEditorEdits): () => void {
  let selectionGeneration = 0;
  const started = new WeakMap<object, number>();
  const preview = (target: PreviewTarget | null) => {
    const state = editor.getState();
    if (!target || state.loading || state.locked) { transport.cancelPreview(); return; }
    void transport.previewCarrier(target.carrierId, state.scoreId, target.noteIds);
  };
  const unsubscribe = editor.subscribe((state, previous) => {
    if (state.document !== previous.document) {
      const snapshot = state.document.musicRevision;
      if (snapshot !== previous.document.musicRevision) transport.documentChanged(snapshot);
      return;
    }
    if (state.selectedIds !== previous.selectedIds || state.carrierSelectedIds !== previous.carrierSelectedIds || state.selectedStructureIds !== previous.selectedStructureIds || state.selectedMeasureIds !== previous.selectedMeasureIds) {
      selectionGeneration++;
      if (!state.auditionSuppressed) preview(selectionPreview(state));
    } else if (state.locked !== previous.locked && state.locked) {
      selectionGeneration++;
      transport.cancelPreview();
    }
  });
  const unsubscribeEdits = editEvents(event => {
    if (['editPresentation', 'setStems', 'setBeamOverride'].includes(event.command.type)) return;
    if (event.phase === 'start') {
      started.set(event.command, selectionGeneration);
      transport.unlock();
    } else if (event.draftId === editor.getState().scoreId && started.get(event.command) === selectionGeneration) {
      preview(editPreview(event));
    }
  });
  return () => { unsubscribe(); unsubscribeEdits(); transport.cancelPreview(); };
}
