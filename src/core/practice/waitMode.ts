import type { PlaybackMap } from '@/core/playback/PlaybackGateway';

/** Notes that start within this many milliseconds of each other are one chord: the map gives the notes of a chord the same start, an arpeggio spreads them by much more. */
const SAME_START_MS = 0.5;

/** The default chord window: the notes of one point must be pressed within this long of each other. */
export const DEFAULT_CHORD_WINDOW_MS = 200;

/** A place where the timeline stops and waits: every pitch that begins to sound at this time. */
export interface PracticePoint {
  index: number;
  startMs: number;
  /** Distinct MIDI pitches, ascending. */
  pitches: number[];
}

/** The points of a playback map, in time order. A tied continuation is no new attack in the map and a rest has no note, so neither is a point. */
export function practicePoints(map: PlaybackMap): PracticePoint[] {
  const notes = [...map.notes].sort((a, b) => a.startMs - b.startMs);
  const points: PracticePoint[] = [];
  for (const note of notes) {
    const last = points.at(-1);
    if (last && note.startMs - last.startMs <= SAME_START_MS) {
      if (!last.pitches.includes(note.pitch)) last.pitches.push(note.pitch);
    } else {
      points.push({ index: points.length, startMs: note.startMs, pitches: [note.pitch] });
    }
  }
  for (const point of points) point.pitches.sort((a, b) => a - b);
  return points;
}

export interface PressResult {
  /** The press belongs to the point that is waited for. */
  accepted: boolean;
  /** This press finished the point. */
  completed: boolean;
}

/**
 * Wait mode's judge: order only, never timing. A point is complete when every one of its pitches has
 * been pressed within the chord window; a press of any other pitch (an extra note, a note of a later
 * point, a key still held) is ignored. Only a new note-on counts, so a held key never completes the
 * next point.
 */
export class WaitMatcher {
  private index = 0;
  /** The pitches of the awaited point pressed so far, with the time of the press. */
  private pressed = new Map<number, number>();

  constructor(private readonly points: readonly PracticePoint[], private windowMs: number = DEFAULT_CHORD_WINDOW_MS) {}

  /** The number of points finished in this lap. */
  get completed(): number {
    return this.index;
  }

  get total(): number {
    return this.points.length;
  }

  get done(): boolean {
    return this.index >= this.points.length;
  }

  /** The point being waited for, or null when the lap is finished. */
  get current(): PracticePoint | null {
    return this.points[this.index] ?? null;
  }

  setWindow(windowMs: number): void {
    this.windowMs = windowMs;
  }

  /** Back to the first point of a new lap. */
  reset(): void {
    this.index = 0;
    this.pressed.clear();
  }

  /** Put the awaited point at `index`: the points before it count as finished. */
  moveTo(index: number): void {
    this.index = Math.max(0, Math.min(index, this.points.length));
    this.pressed.clear();
  }

  /** A note-on at `atMs` (milliseconds on any one clock, only differences matter). */
  press(pitch: number, atMs: number): PressResult {
    const point = this.current;
    if (!point || !point.pitches.includes(pitch)) return { accepted: false, completed: false };
    for (const [held, at] of this.pressed) if (atMs - at > this.windowMs) this.pressed.delete(held);
    this.pressed.set(pitch, atMs);
    if (!point.pitches.every((needed) => this.pressed.has(needed))) return { accepted: true, completed: false };
    this.pressed.clear();
    this.index++;
    return { accepted: true, completed: true };
  }
}
