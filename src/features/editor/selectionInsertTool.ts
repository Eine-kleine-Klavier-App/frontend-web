import type { ScoreDocument } from '@/core/model/score';
import { toolId } from '@/core/model/insertItems';
import { markToolId } from '@/core/model/markTools';
import { ARTICULATION_CATEGORY } from '@/core/model/articulation';

interface Selection {
  selectedIds: readonly string[];
  selectedStructureIds: readonly string[];
  selectedMeasureIds: readonly string[];
}

/** Choose an existing insertion tool from a single selected object, without modifying music. */
export function selectionInsertTool(document: ScoreDocument, selection: Selection): string | null {
  if (selection.selectedMeasureIds.length) return null;
  if (selection.selectedStructureIds.length) {
    if (selection.selectedStructureIds.length !== 1 || selection.selectedIds.length) return null;
    const context = document.contexts.find(context => context.id === selection.selectedStructureIds[0]);
    if (!context) return null;
    switch (context.kind) {
      case 'clef': return markToolId({ kind: 'clef', clef: context.clef, octaveTransposition: context.octaveTransposition });
      case 'keySignature': return markToolId({ kind: 'key', fifths: 0, alterations: [...context.alterations] });
      case 'dynamic': return markToolId({ kind: 'dynamic', dynamic: context.dynamic });
      case 'tempo':
        return context.bpm !== null
          ? markToolId({ kind: 'tempoBpm', bpm: context.bpm, beat: context.beat ?? undefined, label: context.label, showLabel: context.showLabel })
          : context.label !== null ? markToolId({ kind: 'tempoWord', word: context.label, beat: context.beat ?? undefined, label: context.label, showLabel: context.showLabel }) : null;
      default: return null;
    }
  }
  if (selection.selectedIds.length !== 1) return null;
  const id = selection.selectedIds[0];
  for (const measure of document.measures) for (const voice of measure.voices) for (const item of voice.items) {
    if (item.kind === 'rest' && item.id === id) return toolId({ kind: 'rest', value: item.duration, dots: item.dots, articulations: [], accidental: null });
    const note = item.notes.find(note => note.noteId === id);
    if (note) return toolId({ kind: 'note', value: item.duration, dots: item.dots, articulations: item.articulations.filter((m) => ARTICULATION_CATEGORY[m] !== 'arpeggio'), accidental: note.accidental, fingering: note.fingering });
  }
  return null;
}
