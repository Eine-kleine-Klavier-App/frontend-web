import type { EditorGateway } from './EditorGateway';
import type { ScoreDocument } from '@/core/model/score';
import type { Command } from '@/core/commands/command';
import { fromView, type ScoreView } from '@/core/model/fromView';
import { API_BASE } from './apiBase';
import { CURRENT_AUTHOR_ID } from './authorId';

const AUTHOR_HEADER = 'X-Author-Id';

/** Talks to the backend draft/edit endpoints (`/drafts/{draft_id}`, `/drafts/{draft_id}/edit/...`)
 *  and maps the render view into the client model. Every response wraps the view under a
 *  `document` key (`GetDraftResponse` / `ScoreEditedResponse`, both `{ document: ScoreView }`) —
 *  see PianoAppBackend's `adapters/inbound/http/score/{draft,edit}/router.py`. */
export class HttpGateway implements EditorGateway {
  private draftUrl(draftId: string): string {
    return `${API_BASE}/drafts/${encodeURIComponent(draftId)}`;
  }

  private editUrl(draftId: string): string {
    return `${this.draftUrl(draftId)}/edit`;
  }

  load(draftId: string): Promise<ScoreDocument> {
    return this.asDocument(draftId, fetch(this.draftUrl(draftId), { headers: this.headers() }));
  }

  apply(draftId: string, command: Command): Promise<ScoreDocument> {
    const base = this.editUrl(draftId);
    switch (command.type) {
      case 'insertNote':
        return this.asDocument(
          draftId,
          fetch(`${base}/notes`, {
            method: 'POST',
            headers: this.headers({ 'content-type': 'application/json' }),
            body: JSON.stringify({
              voice_id: command.voiceId,
              staff_id: command.staffId,
              measure_id: command.measureId,
              position: command.position,
              written_value: command.writtenValue,
              staff_step: command.staffStep,
              accidental: command.accidental ?? 'none',
              fingering: 0,
            }),
          }),
        );
      case 'deleteBatch':
        // mixed multi-select: whole carriers + individual notes, ONE gesture / one undo entry.
        // Flat `entity_ids` — the backend resolves + classifies each id (note vs carrier) itself.
        return this.asDocument(
          draftId,
          fetch(`${base}/batch-delete`, {
            method: 'POST',
            headers: this.headers({ 'content-type': 'application/json' }),
            body: JSON.stringify({ entity_ids: command.entityIds }),
          }),
        );
    }
  }

  undo(draftId: string): Promise<ScoreDocument> {
    return this.asDocument(
      draftId,
      fetch(`${this.editUrl(draftId)}/undo`, { method: 'POST', headers: this.headers() }),
    );
  }

  redo(draftId: string): Promise<ScoreDocument> {
    return this.asDocument(
      draftId,
      fetch(`${this.editUrl(draftId)}/redo`, { method: 'POST', headers: this.headers() }),
    );
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    return { [AUTHOR_HEADER]: CURRENT_AUTHOR_ID, ...extra };
  }

  private async asDocument(draftId: string, pending: Promise<Response>): Promise<ScoreDocument> {
    const res = await pending;
    if (!res.ok) {
      const body: unknown = await res.json().catch(() => null);
      const detail =
        body && typeof body === 'object' && 'detail' in body ? String((body as { detail: unknown }).detail) : null;
      throw new Error(detail ?? `Request failed (${res.status})`);
    }
    const body = (await res.json()) as { document: ScoreView };
    return fromView(body.document, draftId);
  }
}
