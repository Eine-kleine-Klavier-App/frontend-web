import type { ScoreView } from '@/core/model/fromView';
import type { MeasureSoundsWire, MeasureSyncWire, TimingWire, WireStrike } from '@/core/gateway/measureSync';
import { parsePlaybackMap } from './HttpPlaybackGateway';
import type { PlaybackGateway, PlaybackMap, PreviewCarrier } from './PlaybackGateway';

/** How long a click sounds its notes. */
const STRIKE_MS = 650;

/**
 * The sound of the open draft, measure by measure, as the responses of the server bring it: the
 * chord a click plays and the playback map are put together from the measures in memory, with no
 * request of their own. The map is built again only when the sound changed.
 */
export class DraftSounds implements PlaybackGateway {
  private draftId: string | null = null;
  private measures = new Map<string, MeasureSoundsWire>();
  private order: string[] = [];
  private carrierNotes = new Map<string, string[]>();
  private timing: TimingWire | null = null;
  private error: string | null = null;
  private version = 0;
  private strikes: { version: number; byNote: Map<string, WireStrike> } | null = null;
  private built: { version: number; map: PlaybackMap } | null = null;
  private waiting: (() => void)[] = [];

  /** Takes in the sound of a response; `view` is the document view it belongs to. */
  apply(draftId: string, sync: MeasureSyncWire, view: ScoreView): void {
    if (draftId !== this.draftId || sync.from_version === null) {
      this.draftId = draftId;
      this.measures.clear();
      this.timing = null;
    }
    const changed = sync.sounds.length > 0 || sync.timing !== null || sync.removed.length > 0 || sync.sound_error !== this.error;
    for (const measureId of sync.removed) this.measures.delete(measureId);
    for (const sounds of sync.sounds) this.measures.set(sounds.measure_id, sounds);
    if (sync.timing) this.timing = sync.timing;
    this.error = sync.sound_error;
    this.order = view.measures.map((measure) => measure.id);
    this.carrierNotes = new Map(view.carriers.flatMap((carrier) => (carrier.kind === 'chord' ? [[carrier.id, carrier.note_ids] as const] : [])));
    if (changed) this.version += 1;
    for (const resolve of this.waiting.splice(0)) resolve();
  }

  async map(draftId: string, signal: AbortSignal): Promise<PlaybackMap> {
    await this.loaded(draftId, signal);
    const timing = this.playable();
    if (this.built?.version === this.version) return this.built.map;
    const sorted = <T extends { start_ms: number }>(rows: T[]) => [...rows].sort((a, b) => a.start_ms - b.start_ms);
    const raw = {
      version: this.version,
      extent_ms: timing.extent_ms,
      notes: sorted(this.order.flatMap((measureId) => this.measures.get(measureId)?.notes ?? [])),
      pedals: timing.pedals,
      anchors: sorted(this.order.flatMap((measureId) => this.measures.get(measureId)?.anchors ?? [])),
      segments: timing.segments,
    };
    const map = parsePlaybackMap(raw, raw.version, raw.extent_ms);
    this.built = { version: this.version, map };
    return map;
  }

  async previewCarrier(draftId: string, carrierId: string, signal: AbortSignal): Promise<PreviewCarrier> {
    await this.loaded(draftId, signal);
    this.playable();
    if (this.strikes?.version !== this.version) {
      const byNote = new Map<string, WireStrike>();
      for (const sounds of this.measures.values()) for (const strike of sounds.strikes) byNote.set(strike.note_id, strike);
      this.strikes = { version: this.version, byNote };
    }
    const byNote = this.strikes.byNote;
    const notes = (this.carrierNotes.get(carrierId) ?? []).flatMap((noteId) => {
      const strike = byNote.get(noteId);
      return strike ? [{ sourceId: strike.note_id, pitch: strike.pitch, velocity: strike.velocity, durationMs: STRIKE_MS }] : [];
    });
    if (!notes.length) throw new Error('The chord is never played.');
    return { version: this.version, carrierId, notes };
  }

  /** The timing of the sound, or the reason the score cannot be played. */
  private playable(): TimingWire {
    if (this.error) throw new Error(this.error);
    if (!this.timing) throw new Error('The sound of the score has not come yet.');
    return this.timing;
  }

  /** Waits for the first sound of `draftId` when a click or Play comes before it. */
  private loaded(draftId: string, signal: AbortSignal): Promise<void> {
    if (this.draftId === draftId && this.timing !== null) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const done = () => (this.draftId === draftId ? resolve() : this.waiting.push(done));
      signal.addEventListener('abort', () => reject(new DOMException('Sound request aborted.', 'AbortError')), { once: true });
      this.waiting.push(done);
    });
  }
}

/** The sound of the draft open in the editor. */
export const draftSounds = new DraftSounds();
