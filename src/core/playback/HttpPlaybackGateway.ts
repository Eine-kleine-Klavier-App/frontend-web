import { authorizedFetch, optionalAuthFetch } from '@/core/auth/authorizedFetch';
import { API_BASE } from '@/core/gateway/apiBase';
import type { PlaybackMap, PreviewCarrier, SavedScorePlaybackGateway } from './PlaybackGateway';

interface RawPreviewNote { source_id: string; pitch: number; velocity: number; duration_ms: number }
interface RawPlaybackNote {
  source_id: string;
  pitch: number;
  start_ms: number;
  key_release_ms: number;
  end_ms: number;
  velocity: number;
}
interface RawPlaybackSegment {
  start: unknown;
  end: unknown;
  start_ms: number;
  end_ms: number;
  moments: { position: unknown; time_ms: number }[];
}

export class HttpPlaybackGateway implements SavedScorePlaybackGateway {
  async mapScore(scoreId: string, signal: AbortSignal): Promise<PlaybackMap> {
    return this.readMap(`/scores/${encodeURIComponent(scoreId)}/playback/map`, signal, true);
  }

  previewCarrierScore(scoreId: string, carrierId: string, signal: AbortSignal): Promise<PreviewCarrier> {
    return this.readPreviewCarrier(`/scores/${encodeURIComponent(scoreId)}/playback/preview/carriers/${encodeURIComponent(carrierId)}`, signal, true);
  }

  private async readPreviewCarrier(path: string, signal: AbortSignal, saved = false): Promise<PreviewCarrier> {
    const value = await this.read(path, signal, saved);
    if (
      !value ||
      typeof value !== 'object' ||
      !('version' in value) ||
      !Number.isSafeInteger(value.version) ||
      (value.version as number) < 0 ||
      !('carrier_id' in value) ||
      typeof value.carrier_id !== 'string' ||
      !('notes' in value) ||
      !Array.isArray(value.notes)
    ) {
      throw new Error('Invalid preview carrier.');
    }
    const notes = (value.notes as RawPreviewNote[]).map((note) => {
      if (typeof note.source_id !== 'string' || !isMidiNote(note.pitch, note.velocity) || !Number.isFinite(note.duration_ms) || note.duration_ms <= 0) {
        throw new Error('Invalid preview note.');
      }
      return { sourceId: note.source_id, pitch: note.pitch, velocity: note.velocity, durationMs: note.duration_ms };
    });
    return { version: value.version as number, carrierId: value.carrier_id, notes };
  }

  private async readMap(path: string, signal: AbortSignal, saved = false): Promise<PlaybackMap> {
    const value = await this.read(path, signal, saved);
    if (!value || typeof value !== 'object' || !('version' in value) || !('extent_ms' in value)) throw new Error('Invalid playback map.');
    return parsePlaybackMap(value, value.version, value.extent_ms);
  }

  private async read(path: string, signal: AbortSignal, saved = false): Promise<unknown> {
    const response = await (saved ? optionalAuthFetch : authorizedFetch)(`${API_BASE}${path}`, { signal });
    if (!response.ok) {
      const payload: unknown = await response.json().catch(() => null);
      const detail = payload && typeof payload === 'object' && 'detail' in payload ? payload.detail : null;
      throw new Error(typeof detail === 'string' ? detail : `Playback map failed (${response.status}).`);
    }
    return response.json();
  }
}

const TOLERANCE_MS = 1e-6;

/** a MIDI pitch (0–127) sounded at a MIDI velocity (1–127) */
function isMidiNote(pitch: number, velocity: number): boolean {
  return Number.isInteger(pitch) && pitch >= 0 && pitch <= 127 && Number.isInteger(velocity) && velocity >= 1 && velocity <= 127;
}

function beatsOf(value: unknown): number {
  const fraction = value as { numerator?: unknown; denominator?: unknown } | null;
  if (
    !fraction ||
    !Number.isSafeInteger(fraction.numerator) ||
    !Number.isSafeInteger(fraction.denominator) ||
    (fraction.numerator as number) < 0 ||
    (fraction.denominator as number) <= 0
  ) {
    throw new Error('Invalid playback position.');
  }
  return ((fraction.numerator as number) / (fraction.denominator as number)) * 4;
}

export function parsePlaybackMap(value: unknown, version: unknown, extentMs: unknown): PlaybackMap {
  if (
    !value ||
    typeof value !== 'object' ||
    !('version' in value) ||
    !('extent_ms' in value) ||
    !('notes' in value) ||
    !('anchors' in value) ||
    !('segments' in value) ||
    !('pedals' in value) ||
    !Number.isSafeInteger(version) ||
    (version as number) < 0 ||
    !Number.isFinite(extentMs) ||
    (extentMs as number) < 0 ||
    value.version !== version ||
    value.extent_ms !== extentMs ||
    !Array.isArray(value.notes) ||
    !Array.isArray(value.anchors) ||
    !Array.isArray(value.segments) ||
    !Array.isArray(value.pedals)
  ) {
    throw new Error('Invalid playback map.');
  }
  const extent = extentMs as number;
  const inside = (start: number, end: number) => Number.isFinite(start) && Number.isFinite(end) && start >= 0 && end > start && end <= extent + TOLERANCE_MS;
  const map: PlaybackMap = {
    version: version as number,
    extentMs: extent,
    notes: value.notes.map((note: RawPlaybackNote) => {
      if (
        typeof note.source_id !== 'string' ||
        !isMidiNote(note.pitch, note.velocity) ||
        !inside(note.start_ms, note.end_ms) ||
        !Number.isFinite(note.key_release_ms) ||
        note.key_release_ms < note.start_ms ||
        note.key_release_ms > note.end_ms
      ) {
        throw new Error('Invalid playback note.');
      }
      return { sourceId: note.source_id, pitch: note.pitch, startMs: note.start_ms, keyReleaseMs: note.key_release_ms, endMs: note.end_ms, velocity: note.velocity };
    }),
    pedals: value.pedals.map((pedal: { down_ms: number; up_ms: number }) => {
      if (!inside(pedal.down_ms, pedal.up_ms)) throw new Error('Invalid playback pedal.');
      return { downMs: pedal.down_ms, upMs: pedal.up_ms };
    }),
    anchors: value.anchors.map((anchor: { carrier_id: string; start_ms: number; end_ms: number }) => {
      if (typeof anchor.carrier_id !== 'string' || !inside(anchor.start_ms, anchor.end_ms)) throw new Error('Invalid playback anchor.');
      return { carrierId: anchor.carrier_id, startMs: anchor.start_ms, endMs: anchor.end_ms };
    }),
    segments: value.segments.map((segment: RawPlaybackSegment) => {
      if (!Array.isArray(segment.moments) || !segment.moments.length || !Number.isFinite(segment.start_ms) || !Number.isFinite(segment.end_ms)) {
        throw new Error('Invalid playback segment.');
      }
      let previousTime = -Infinity;
      let previousBeats = -Infinity;
      const moments = segment.moments.map((moment) => {
        const beats = beatsOf(moment.position);
        if (!Number.isFinite(moment.time_ms) || moment.time_ms < 0 || moment.time_ms <= previousTime || beats <= previousBeats) throw new Error('Invalid playback timeline.');
        previousTime = moment.time_ms;
        previousBeats = beats;
        return { beats, timeMs: moment.time_ms };
      });
      if (Math.abs(moments[0].timeMs - segment.start_ms) > TOLERANCE_MS || Math.abs(moments.at(-1)!.timeMs - segment.end_ms) > TOLERANCE_MS) {
        throw new Error('Invalid playback segment.');
      }
      return { startBeats: beatsOf(segment.start), endBeats: beatsOf(segment.end), startMs: segment.start_ms, endMs: segment.end_ms, moments };
    }),
  };
  let expected = 0;
  for (const segment of map.segments) {
    if (Math.abs(segment.startMs - expected) > TOLERANCE_MS) throw new Error('Incomplete playback timeline.');
    expected = segment.endMs;
  }
  if (map.segments.length && Math.abs(expected - extent) > TOLERANCE_MS) throw new Error('Incomplete playback timeline.');
  return map;
}
