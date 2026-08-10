import type { Accidental, DurationValue, ScoreDocument } from '@/core/model/score';
import { staffStepToKey } from '@/core/model/pitch';

const BEATS: Record<DurationValue, number> = { w: 4, h: 2, q: 1, '8': 0.5, '16': 0.25, '32': 0.125 };

function noteBeats(duration: DurationValue, dots: number): number {
  let b = BEATS[duration] ?? 1;
  if (dots) b *= 2 - Math.pow(0.5, dots);
  return b;
}

/** `staffStepToKey`'s "letter/octave" (e.g. "e/4") + an `Accidental` -> a Tone.js note name
 *  (e.g. "E#4"). Double accidentals collapse to single (`##`/`bb` -> `#`/`b`) — an approximation
 *  on top of an approximation: pitch itself is domain-unimplemented (staff_step + a client-side
 *  clef assumption, same heuristic the renderer already uses, see PianoAppBackend CLAUDE.md),
 *  so exact spelling was never available here to begin with. */
function toToneNote(key: string, accidental: Accidental): string {
  const [letter, octave] = key.split('/');
  const symbol = accidental === '#' || accidental === '##' ? '#' : accidental === 'b' || accidental === 'bb' ? 'b' : '';
  return `${letter.toUpperCase()}${symbol}${octave}`;
}

export interface PlaybackEvent {
  note: string;
  startBeat: number;
  durationBeats: number;
}

/** Walks every voice of every measure, in onset order, converting each note into a Tone.js-
 *  playable event. Rests advance the onset without emitting anything. Multiple voices (and a
 *  cross-staff chord's multiple notes) naturally overlap in `startBeat` — the player is
 *  polyphonic, so simultaneous events just sound together, no separate "merge" step needed. */
export function scoreToEvents(doc: ScoreDocument): PlaybackEvent[] {
  const events: PlaybackEvent[] = [];
  let measureOffsetBeats = 0;

  for (const measure of doc.measures) {
    const measureBeats = (measure.timeSignature.beats * 4) / measure.timeSignature.beatValue;

    for (const voice of measure.voices) {
      let onset = 0;
      for (const item of voice.items) {
        const durationBeats = noteBeats(item.duration, item.dots);
        if (item.kind === 'note') {
          for (const noteRef of item.notes) {
            const clef = doc.staffOrder.indexOf(noteRef.staffId) === 0 ? 'treble' : 'bass';
            const key = staffStepToKey(noteRef.staffStep, clef);
            events.push({
              note: toToneNote(key, noteRef.accidental),
              startBeat: measureOffsetBeats + onset,
              durationBeats,
            });
          }
        }
        onset += durationBeats;
      }
    }

    measureOffsetBeats += measureBeats;
  }

  return events;
}
