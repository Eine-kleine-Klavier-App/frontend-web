import type { EditorGateway } from './EditorGateway';
import type { ContextCoverage, ScoreDocument } from '@/core/model/score';
import type { Command } from '@/core/commands/command';
import { fromView } from '@/core/model/fromView';
import { draftSounds } from '@/core/playback/draftSounds';
import { DraftSync, type MeasureSyncWire } from './measureSync';
import { API_BASE } from './apiBase';
import { authorizedFetch } from '@/core/auth/authorizedFetch';

/** Talks to the backend draft/edit endpoints (`/drafts/{draft_id}`, `/drafts/{draft_id}/edit/...`)
 *  and maps the render view into the client model. The draft read and every edit answer
 *  `{ sync }`: the measures that changed and their sound (`GetDraftResponse` /
 *  `ScoreEditedResponse`, PianoAppBackend's `adapters/inbound/http/score/sync.py`); `DraftSync`
 *  puts the whole view together again.
 *
 *  Every call goes through `authorizedFetch` — the backend guards these routes with a Bearer
 *  access token (`Depends(current_user)`); an anonymous/expired request surfaces as an
 *  `AuthRequiredError` the editor catches to prompt sign-in. */
/** The server has no working copy under this id (it was discarded, or the server restarted). */
export class DraftNotFoundError extends Error {
  constructor() {
    super('This working copy could not be found.');
    this.name = 'DraftNotFoundError';
  }
}

export class HttpGateway implements EditorGateway {
  /** the view of each draft this client holds, measure by measure */
  private syncs = new Map<string, DraftSync>();

  private draftUrl(draftId: string): string {
    return `${API_BASE}/drafts/${encodeURIComponent(draftId)}`;
  }

  private editUrl(draftId: string): string {
    return `${this.draftUrl(draftId)}/edit`;
  }

  async load(draftId: string): Promise<ScoreDocument> {
    const res = await authorizedFetch(this.draftUrl(draftId));
    if (res.status === 404) throw new DraftNotFoundError();
    return this.asDocument(draftId, Promise.resolve(res));
  }

  apply(draftId: string, command: Command): Promise<ScoreDocument> {
    const base = this.editUrl(draftId);
    switch (command.type) {
      case 'insertNote':
        return this.asDocument(
          draftId,
          authorizedFetch(`${base}/notes`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              voice_id: command.voiceId,
              staff_id: command.staffId,
              measure_id: command.measureId,
              position: command.position,
              written_value: command.writtenValue,
              staff_step: command.staffStep,
              accidental: command.accidental ?? null,
              fingering: command.fingering ?? 0,
              ...(command.beamShare === undefined ? {} : { beam_share: command.beamShare }),
            }),
          }),
        );
      case 'deleteBatch':
        // mixed multi-select: whole carriers + individual notes, ONE gesture / one undo entry.
        // Flat `entity_ids` — the backend resolves + classifies each id (note vs carrier) itself.
        return this.asDocument(
          draftId,
          authorizedFetch(`${base}/batch-delete`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ entity_ids: command.entityIds }),
          }),
        );
      case 'editPresentation':
        return this.asDocument(draftId, authorizedFetch(`${base}/presentation`, {
          method: 'PUT', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ changes: command.changes }),
        }));
      case 'setBeamOverride':
        return this.apply(draftId, { type: 'editPresentation', changes: [{ kind: 'endpoints',
          target: { entity_id: command.beamId, reference: 'body' },
          offsets: command.override ? { left: command.override.leftFactor, right: command.override.rightFactor } : null }] });
      case 'setStems':
        return this.apply(draftId, { type: 'editPresentation', changes: command.carrierIds.flatMap(id => [
          { kind: 'direction' as const, target: { entity_id: id, reference: 'stem_tip' as const }, direction: command.override ? command.override.direction === 1 ? 'up' as const : 'down' as const : null },
          { kind: 'vertical' as const, target: { entity_id: id, reference: 'stem_tip' as const }, offset: command.override && command.override.lengthFactor !== 1 ? command.override.lengthFactor : null },
        ]) });
      case 'insertRest':
        return this.asDocument(
          draftId,
          authorizedFetch(`${base}/rests`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              voice_id: command.voiceId,
              staff_id: command.staffId,
              measure_id: command.measureId,
              position: command.position,
              written_value: command.writtenValue,
            }),
          }),
        );
      case 'createTuplet':
        return this.asDocument(
          draftId,
          authorizedFetch(`${base}/tuplets`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              voice_id: command.voiceId,
              staff_id: command.staffId,
              measure_id: command.measureId,
              position: command.position,
              written_size: command.writtenSize,
              occupied_size: command.occupiedSize,
              written_value: command.writtenValue,
              note: command.note && {
                staff_step: command.note.staffStep,
                accidental: command.note.accidental ?? null,
                fingering: command.note.fingering ?? 0,
              },
            }),
          }),
        );
      case 'glissandoNotes':
        return this.asDocument(
          draftId,
          authorizedFetch(`${base}/glissandos`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ start_note_id: command.startNoteId, end_note_id: command.endNoteId, glissando_type: command.glissandoType }),
          }),
        );
      case 'tieNotes':
        return this.asDocument(
          draftId,
          authorizedFetch(`${base}/ties`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ start_note_id: command.startNoteId, end_note_id: command.endNoteId }),
          }),
        );
      case 'createBeam':
        return this.asDocument(
          draftId,
          authorizedFetch(`${base}/beams`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ carrier_ids: command.carrierIds }),
          }),
        );
      case 'splitBeam':
        return this.asDocument(
          draftId,
          authorizedFetch(`${base}/beams/split`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ beam_id: command.beamId, before_carrier_id: command.beforeCarrierId }),
          }),
        );
      case 'setFingering':
        return this.asDocument(
          draftId,
          authorizedFetch(`${base}/fingerings`, {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ note_id: command.noteId, fingering: command.fingering }),
          }),
        );
      case 'setArticulation':
        return this.asDocument(
          draftId,
          authorizedFetch(`${base}/articulations`, {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ carrier_id: command.carrierId, articulations: command.articulations }),
          }),
        );
      case 'setCarrierMarks':
        return this.asDocument(
          draftId,
          authorizedFetch(`${base}/carrier-marks`, {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              items: command.items.map((item) => ({ carrier_id: item.carrierId, articulations: item.articulations, ornament: item.ornament })),
            }),
          }),
        );
      case 'changeDuration':
        return this.asDocument(
          draftId,
          authorizedFetch(`${base}/durations`, {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ carrier_id: command.carrierId, written_value: command.writtenValue }),
          }),
        );
      case 'insertMeasure':
        return this.asDocument(
          draftId,
          authorizedFetch(`${base}/measures`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ before_measure_id: command.beforeMeasureId }),
          }),
        );
      case 'changeTimeSignature':
        return this.asDocument(
          draftId,
          authorizedFetch(`${base}/time-signatures`, {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              measure_ids: command.measureIds,
              time_signature: { value: { value: command.beatValue, dots: command.dots ?? 0 }, count: command.beats },
            }),
          }),
        );
      case 'setClef':
        return this.send(draftId, 'PUT', 'clefs', {
          staff_id: command.staffId,
          measure_id: command.measureId,
          position: command.position,
          clef: command.clef,
          octave_transposition: command.octaveTransposition,
          mode: command.mode,
        });
      case 'deleteClef':
        return this.send(draftId, 'POST', 'clef-deletions', {
          clef_id: command.clefId,
          measure_ids: command.measureIds,
          mode: command.mode,
        });
      case 'setKeySignature':
        return this.send(draftId, 'PUT', 'key-signatures', {
          staff_id: command.staffId,
          measure_id: command.measureId,
          position: command.position,
          alterations: command.alterations,
        });
      case 'setDynamic':
        return this.send(draftId, 'PUT', 'dynamics', {
          measure_id: command.measureId,
          position: command.position,
          voice_ids: command.voiceIds,
          dynamic: command.dynamic,
        });
      case 'addContextVoice':
        return this.send(draftId, 'POST', 'context-voices', { context_id: command.contextId, voice_id: command.voiceId });
      case 'removeContextVoice':
        return this.send(draftId, 'POST', 'context-voice-removals', { context_id: command.contextId, voice_id: command.voiceId });
      case 'createHairpin':
        return this.send(draftId, 'POST', 'hairpins', {
          start_measure_id: command.start.measureId,
          start_position: command.start.position,
          end_measure_id: command.end.measureId,
          end_position: command.end.position,
          voice_ids: command.voiceIds,
          target: command.target,
        });
      case 'setHairpinTarget':
        return this.send(draftId, 'PUT', 'hairpin-targets', { hairpin_id: command.hairpinId, target: command.target });
      case 'createRefrain':
        return this.send(draftId, 'POST', 'refrains', {
          start_measure_id: command.start.measureId,
          start_position: command.start.position,
          ...(command.end ? { end_measure_id: command.end.measureId, end_position: command.end.position } : {}),
          times: command.times,
        });
      case 'setRefrainTimes':
        return this.send(draftId, 'PUT', 'refrain-times', { refrain_id: command.refrainId, times: command.times });
      case 'addRefrainEnding':
        return this.send(draftId, 'POST', 'refrain-endings', {
          refrain_id: command.refrainId,
          ...(command.end ? { end_measure_id: command.end.measureId, end_position: command.end.position } : {}),
        });
      case 'moveRefrainStart':
        return this.send(draftId, 'PUT', 'refrain-starts', {
          refrain_id: command.refrainId,
          measure_id: command.start.measureId,
          position: command.start.position,
        });
      case 'moveRefrainEnd':
        return this.send(draftId, 'PUT', 'refrain-ends', {
          refrain_id: command.refrainId,
          ...(command.end ? { measure_id: command.end.measureId, position: command.end.position } : {}),
        });
      case 'createVolta':
        return this.send(draftId, 'POST', 'voltas', {
          start_measure_id: command.start.measureId,
          start_position: command.start.position,
          body_end_measure_id: command.bodyEnd.measureId,
          body_end_position: command.bodyEnd.position,
          fragments: command.fragments.map((fragment) => ({
            ...(fragment.end ? { end_measure_id: fragment.end.measureId, end_position: fragment.end.position } : {}),
            passes: fragment.passes,
          })),
        });
      case 'moveVoltaBoundary':
        return this.send(draftId, 'PUT', 'volta-boundaries', {
          volta_id: command.voltaId,
          boundary: command.boundary,
          ...(command.to ? { measure_id: command.to.measureId, position: command.to.position } : {}),
        });
      case 'moveVoltaStart':
        return this.send(draftId, 'PUT', 'volta-starts', {
          volta_id: command.voltaId,
          measure_id: command.start.measureId,
          position: command.start.position,
        });
      case 'setVoltaFragmentPasses':
        return this.send(draftId, 'PUT', 'volta-fragment-passes', {
          volta_id: command.voltaId,
          fragment: command.fragment,
          passes: command.passes,
        });
      case 'setVoltaTimes':
        return this.send(draftId, 'PUT', 'volta-times', { volta_id: command.voltaId, times: command.times });
      case 'appendVoltaFragment':
        return this.send(draftId, 'POST', 'volta-fragments', {
          volta_id: command.voltaId,
          ...(command.end ? { measure_id: command.end.measureId, position: command.end.position } : {}),
        });
      case 'splitVoltaFragment':
        return this.send(draftId, 'POST', 'volta-fragment-splits', {
          volta_id: command.voltaId,
          measure_id: command.at.measureId,
          position: command.at.position,
        });
      case 'openContextEnd':
        return this.send(draftId, 'PUT', 'context-open-ends', { context_id: command.contextId, mode: command.mode });
      case 'createSlur':
        return this.send(draftId, 'POST', 'slurs', {
          start_measure_id: command.start.measureId,
          start_position: command.start.position,
          end_measure_id: command.end.measureId,
          end_position: command.end.position,
          voice_ids: command.voiceIds,
        });
      case 'createSustainHold':
        return this.send(draftId, 'POST', 'sustain-holds', {
          start_measure_id: command.start.measureId,
          start_position: command.start.position,
          end_measure_id: command.end.measureId,
          end_position: command.end.position,
        });
      case 'createOctaveTransposition':
        return this.send(draftId, 'POST', 'octave-transpositions', {
          staff_id: command.staffId,
          start_measure_id: command.start.measureId,
          start_position: command.start.position,
          end_measure_id: command.end.measureId,
          end_position: command.end.position,
          octaves: command.octaves,
          mode: command.mode,
        });
      case 'deleteOctaveTransposition':
        return this.send(draftId, 'POST', 'octave-transposition-deletions', {
          octave_id: command.octaveId,
          mode: command.mode,
        });
      case 'setTempo':
        return this.send(draftId, 'PUT', 'tempos', {
          measure_id: command.measureId,
          position: command.position,
          beat: command.beat,
          bpm: command.bpm,
          show_label: command.showLabel ?? command.label != null,
          ...(command.label == null ? {} : { label: command.label }),
        });
      case 'createTempoTransition':
        return this.send(draftId, 'POST', 'tempo-transitions', {
          start_measure_id: command.start.measureId,
          start_position: command.start.position,
          end_measure_id: command.end.measureId,
          end_position: command.end.position,
          target_bpm: command.targetBpm,
        });
      case 'setTempoTransitionTarget':
        return this.send(draftId, 'PUT', 'tempo-transition-targets', {
          transition_id: command.transitionId,
          target_bpm: command.targetBpm,
        });
      case 'moveContextStart':
        return this.send(draftId, 'PUT', 'context-starts', {
          context_id: command.contextId,
          measure_id: command.measureId,
          position: command.position,
          mode: command.mode,
          ...(command.presentation?.length ? { presentation: command.presentation } : {}),
        });
      case 'moveContextEnd':
        return this.send(draftId, 'PUT', 'context-ends', {
          context_id: command.contextId,
          measure_id: command.measureId,
          position: command.position,
          mode: command.mode,
          ...(command.presentation?.length ? { presentation: command.presentation } : {}),
        });
      case 'shiftStaffSteps':
        return this.send(draftId, 'POST', 'pitches/shift', { note_ids: command.noteIds, delta: command.delta });
      case 'addGraceNote':
        return this.send(draftId, 'POST', 'grace-notes', {
          host_carrier_id: command.hostCarrierId,
          placement: command.placement,
          grace_type: command.graceKind,
          written_value: command.writtenValue,
          staff_id: command.staffId,
          staff_step: command.staffStep,
          accidental: command.accidental ?? null,
          fingering: command.fingering ?? 0,
          after_carrier_id: command.afterCarrierId ?? null,
        });
      case 'changeGraceType':
        return this.send(draftId, 'POST', 'grace-type-changes', { note_id: command.noteId, grace_type: command.graceKind });
      case 'changeGraceValue':
        return this.send(draftId, 'POST', 'grace-value-changes', { carrier_id: command.carrierId, written_value: command.writtenValue });
      case 'addGraceCarrierNote':
        return this.send(draftId, 'POST', 'grace-carrier-notes', {
          carrier_id: command.carrierId,
          staff_id: command.staffId,
          staff_step: command.staffStep,
          accidental: command.accidental ?? null,
          fingering: command.fingering ?? 0,
        });
      case 'changePitch':
        return this.send(draftId, 'PUT', 'pitches', { note_id: command.noteId, staff_step: command.staffStep });
      case 'setAccidental':
        return this.send(draftId, 'PUT', 'accidentals', { note_id: command.noteId, accidental: command.accidental });
      case 'moveNoteToStaff':
        return this.send(draftId, 'PUT', 'note-staffs', {
          note_id: command.noteId,
          staff_id: command.staffId,
          mode: command.mode,
        });
    }
  }

  /** one JSON request to an `/edit/<path>` route, answered with the resulting document */
  private send(draftId: string, method: 'POST' | 'PUT', path: string, body: unknown): Promise<ScoreDocument> {
    return this.asDocument(
      draftId,
      authorizedFetch(`${this.editUrl(draftId)}/${path}`, {
        method,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    );
  }

  undo(draftId: string): Promise<ScoreDocument> {
    return this.asDocument(draftId, authorizedFetch(`${this.editUrl(draftId)}/undo`, { method: 'POST' }));
  }

  redo(draftId: string): Promise<ScoreDocument> {
    return this.asDocument(draftId, authorizedFetch(`${this.editUrl(draftId)}/redo`, { method: 'POST' }));
  }

  async contextCoverage(draftId: string, contextId: string): Promise<ContextCoverage> {
    const res = await authorizedFetch(`${this.draftUrl(draftId)}/contexts/${encodeURIComponent(contextId)}/coverage`);
    if (!res.ok) {
      const body: unknown = await res.json().catch(() => null);
      const detail =
        body && typeof body === 'object' && 'detail' in body ? String((body as { detail: unknown }).detail) : null;
      throw new Error(detail ?? `Request failed (${res.status})`);
    }
    const body = (await res.json()) as { carrier_ids: string[]; note_ids: string[] };
    return { carrierIds: body.carrier_ids, noteIds: body.note_ids };
  }

  private async asDocument(draftId: string, pending: Promise<Response>): Promise<ScoreDocument> {
    const res = await pending;
    if (!res.ok) {
      const body: unknown = await res.json().catch(() => null);
      const detail =
        body && typeof body === 'object' && 'detail' in body ? String((body as { detail: unknown }).detail) : null;
      throw new Error(detail ?? `Request failed (${res.status})`);
    }
    let sync: MeasureSyncWire = ((await res.json()) as { sync: MeasureSyncWire }).sync;
    const held = this.syncs.get(draftId) ?? new DraftSync();
    let view = held.apply(sync);
    if (!view) {
      // the response does not follow the version this client holds (another tab saved in between):
      // the score is taken whole
      const whole = await authorizedFetch(this.draftUrl(draftId));
      if (!whole.ok) throw new Error(`Request failed (${whole.status})`);
      sync = ((await whole.json()) as { sync: MeasureSyncWire }).sync;
      view = held.apply(sync);
      if (!view) throw new Error('The score could not be loaded by measure.');
    }
    this.syncs.set(draftId, held);
    draftSounds.apply(draftId, sync, view);
    return fromView(view, draftId);
  }
}
