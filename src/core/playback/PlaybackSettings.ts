import type { PlaybackMap } from './PlaybackGateway';

export interface PlaybackSettings { speed: number; transpose: number }
export interface PitchRange { min: number; max: number }
export const DEFAULT_PLAYBACK_SETTINGS: Readonly<PlaybackSettings> = { speed: 1, transpose: 0 };

export function validatePlaybackSettings(settings: PlaybackSettings): void {
  if (!Number.isFinite(settings.speed) || settings.speed < 0.5 || settings.speed > 2) throw new RangeError('Speed must be between 0.5× and 2×.');
  if (!Number.isInteger(settings.transpose) || Math.abs(settings.transpose) > 12) throw new RangeError('Transpose must be a whole number from −12 to +12 semitones.');
}

/** Reject the whole change before replacing an audible recording or any settings. */
export function validateTransposition(map: PlaybackMap, transpose: number, range: PitchRange): void {
  if (map.notes.some((note) => note.pitch + transpose < range.min || note.pitch + transpose > range.max)) {
    throw new RangeError('Cannot transpose: at least one note would be outside the keyboard range (A0–C8).');
  }
}

/** Listening transforms resolved server timing/pitches; source notation and musical places stay intact. */
export function withPlaybackSettings(map: PlaybackMap, settings: PlaybackSettings): PlaybackMap {
  validatePlaybackSettings(settings);
  if (settings.speed === 1 && settings.transpose === 0) return map;
  const time = (ms: number) => ms / settings.speed;
  return { ...map, extentMs: time(map.extentMs),
    notes: map.notes.map((note) => ({ ...note, pitch: note.pitch + settings.transpose,
      startMs: time(note.startMs), keyReleaseMs: time(note.keyReleaseMs), endMs: time(note.endMs) })),
    pedals: map.pedals.map((pedal) => ({ downMs: time(pedal.downMs), upMs: time(pedal.upMs) })),
    anchors: map.anchors.map((anchor) => ({ ...anchor, startMs: time(anchor.startMs), endMs: time(anchor.endMs) })),
    segments: map.segments.map((segment) => ({ ...segment, startMs: time(segment.startMs), endMs: time(segment.endMs),
      moments: segment.moments.map((moment) => ({ ...moment, timeMs: time(moment.timeMs) })) })),
  };
}
