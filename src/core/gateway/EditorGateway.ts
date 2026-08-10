import type { ScoreDocument } from '@/core/model/score';
import type { Command } from '@/core/commands/command';

/**
 * The seam between the editor UI and the backend mutation engine.
 *
 * Stateful by design: the backend owns the working draft document and its
 * undo/redo journal, keyed by draft id. Every call returns the resulting
 * document (already mapped into the client render model); the UI renders it.
 * Swapping the impl (e.g. an offline mock) never touches the UI.
 */
export interface EditorGateway {
  load(draftId: string): Promise<ScoreDocument>;
  apply(draftId: string, command: Command): Promise<ScoreDocument>;
  undo(draftId: string): Promise<ScoreDocument>;
  redo(draftId: string): Promise<ScoreDocument>;
}
