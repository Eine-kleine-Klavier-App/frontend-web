import { measureBeats } from '@/core/model/contexts';
import type { ScoreDocument } from '@/core/model/score';
import { timeInSegment } from '@/core/playback/PlaybackController';
import type { PlaybackMap } from '@/core/playback/PlaybackGateway';

const MS_PER_SECOND = 1000;
/** The server sends a note's loudness as a MIDI velocity. */
const MIDI_VELOCITY_MAX = 127;

/** A note as the waterfall plays it: times in seconds, loudness 0..1, the voice by its index in the score. */
export interface WaterfallNote {
  pitch: number;
  voice: number;
  start: number;
  duration: number;
  sustainDuration: number;
  velocity: number;
}

/** The notes that sound in the playback, each with the voice it belongs to; a note the score no longer knows falls to the first voice. */
export function waterfallNotes(map: PlaybackMap, document: ScoreDocument): WaterfallNote[] {
  const voiceByNote = new Map<string, number>();
  const indexByVoice = new Map(document.voices.map((voice) => [voice.id, voice.index]));
  for (const measure of document.measures) {
    for (const voice of measure.voices) {
      for (const item of voice.items) {
        for (const note of item.notes) voiceByNote.set(note.noteId, indexByVoice.get(voice.id) ?? 0);
      }
    }
  }
  return map.notes.map((note) => ({
    pitch: note.pitch,
    voice: voiceByNote.get(note.sourceId) ?? 0,
    start: note.startMs / MS_PER_SECOND,
    duration: (note.keyReleaseMs - note.startMs) / MS_PER_SECOND,
    sustainDuration: (note.endMs - note.startMs) / MS_PER_SECOND,
    velocity: note.velocity / MIDI_VELOCITY_MAX,
  }));
}

/** The start of every measure as it is played, in seconds: a repeated measure is marked once for each pass. */
export function waterfallBars(map: PlaybackMap, document: ScoreDocument): number[] {
  const starts: number[] = [];
  let startBeat = 0;
  for (const measure of document.measures) {
    starts.push(startBeat);
    startBeat += measureBeats(measure.timeSignature);
  }
  const bars: number[] = [];
  for (const segment of map.segments) {
    for (const beat of starts) {
      if (beat >= segment.startBeats && beat < segment.endBeats) bars.push(timeInSegment(segment, beat) / MS_PER_SECOND);
    }
  }
  return bars.sort((first, second) => first - second);
}
