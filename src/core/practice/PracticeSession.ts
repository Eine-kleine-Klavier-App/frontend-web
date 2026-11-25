import { useSyncExternalStore } from 'react';
import { navigation as sharedNavigation, timeAtBeat, type ScoreNavigation } from '@/core/navigation/ScoreNavigation';
import { frameTimeMs, onAnimationFrame } from '@/core/playback/MediaClock';
import { playback as sharedPlayback, type PlaybackController } from '@/core/playback/PlaybackController';
import { midiInput as sharedMidi, type MidiInput, type MidiNoteEvent } from '@/core/midi/MidiInput';
import { PracticeClock } from './PracticeClock';
import { DEFAULT_CHORD_WINDOW_MS, practicePoints, WaitMatcher, type PracticePoint } from './waitMode';

/**
 * running: the line runs and waits for the keyboard. lost: the keyboard is not there, the line holds.
 * counting: the keyboard is back, a count-in runs before the line goes on. listening: the playback
 * plays and the practice waits, holding its place.
 */
export type PracticePhase = 'idle' | 'running' | 'lost' | 'counting' | 'listening';

export interface PracticeState {
  phase: PracticePhase;
  /** 3, 2, 1 while counting in, otherwise null. */
  countIn: number | null;
  /** Points finished in this lap, and all points of the score. */
  completed: number;
  total: number;
  /** Laps finished since the practice began. */
  lap: number;
  /** The time that notes of one chord must be pressed within, in milliseconds. */
  windowMs: number;
  /** Keys held down on the keyboard now, MIDI pitches. */
  pressed: number[];
  /** The keys of the point that is waited for, MIDI pitches; none between laps and while nothing is waited for. */
  expected: number[];
  /** Why the practice cannot start (a score with no notes), or null. */
  problem: string | null;
}

export interface PracticeDeps {
  navigation: ScoreNavigation;
  midi: MidiInput;
  playback: Pick<PlaybackController, 'play' | 'stop' | 'getState' | 'subscribe'>;
  /** The time of the animation frame being drawn. */
  frame: () => number;
  onFrame: (listener: (frameTime: number) => void) => () => void;
  setTimeout: (callback: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
  now: () => number;
  /** How long one number of the count-in lasts. */
  countStepMs: number;
}

const COUNT_FROM = 3;
const STATE_WRITE_MS = 50;

function initial(windowMs: number): PracticeState {
  return { phase: 'idle', countIn: null, completed: 0, total: 0, lap: 0, windowMs, pressed: [], expected: [], problem: null };
}

/**
 * Wait mode over the one position of the score. It is a driver of the navigation: while it runs the
 * line runs at the pace of the playback and stops at the next point until the keyboard plays it; the
 * waterfall, the score cursor and the keys read the same position as ever. Playback and practice take
 * turns: «listen» holds the practice and lets the playback play, and when the playback stops the line
 * is put back where it was held.
 */
export class PracticeSession {
  private state: PracticeState = initial(DEFAULT_CHORD_WINDOW_MS);
  private listeners = new Set<(state: PracticeState) => void>();
  private clock = new PracticeClock();
  private matcher = new WaitMatcher([], DEFAULT_CHORD_WINDOW_MS);
  private points: PracticePoint[] = [];
  private teardown: (() => void)[] = [];
  private interrupted = false;
  private lastWrite = -Infinity;
  private countHandle: unknown = null;
  private resumeMs = 0;
  private playbackSeen = false;

  constructor(private readonly deps: PracticeDeps) {}

  private readonly source = () => this.clock.at(this.deps.frame());

  getState(): PracticeState {
    return this.state;
  }

  subscribe(listener: (state: PracticeState) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Begin on the playback map the navigation holds. */
  start(): void {
    if (this.state.phase !== 'idle') return;
    const { navigation, midi } = this.deps;
    const map = navigation.getState().map;
    if (!map) return;
    this.points = practicePoints(map);
    if (!this.points.length) {
      this.set({ problem: 'This score has no notes to play.' });
      return;
    }
    this.matcher = new WaitMatcher(this.points, this.state.windowMs);
    this.interrupted = false;
    this.clock.reset(0);
    this.clock.setLimit(this.points[0].startMs);
    navigation.attach(this.source);
    navigation.update({ cursorShown: true });
    navigation.setTime(0);
    this.teardown = [
      midi.onNote((event) => this.note(event)),
      midi.subscribe(() => this.device()),
      this.deps.playback.subscribe(() => this.playbackChanged()),
      this.deps.onFrame((frameTime) => this.frameTick(frameTime)),
    ];
    this.set({ phase: 'lost', countIn: null, completed: 0, total: this.points.length, lap: 0, problem: null, pressed: [], expected: this.points[0].pitches });
    this.device();
  }

  /** Leave the practice; the line stays where it stood. */
  stop(): void {
    if (this.state.phase === 'idle') return;
    this.cancelCount();
    for (const off of this.teardown) off();
    this.teardown = [];
    if (this.state.phase === 'listening') this.deps.playback.stop();
    this.deps.navigation.setTime(this.clock.positionMs);
    this.deps.navigation.detach(this.source);
    this.deps.navigation.update({ cursorShown: false });
    this.clock.setRunning(false);
    this.set({ phase: 'idle', countIn: null, problem: null, pressed: [], expected: [] });
  }

  setWindow(windowMs: number): void {
    if (!Number.isFinite(windowMs) || windowMs <= 0) return;
    this.matcher.setWindow(windowMs);
    this.set({ windowMs });
  }

  /** Put the line at `beats`: the points before it count as played, and the keyboard is waited for at the first one from there. While the playback plays, the position is the playback's. */
  seek(beats: number): void {
    const { phase } = this.state;
    const map = this.deps.navigation.getState().map;
    if (phase === 'idle' || phase === 'listening' || !map) return;
    const wanted = timeAtBeat(map, beats);
    const found = this.points.findIndex((point) => point.startMs >= wanted);
    const index = found < 0 ? this.points.length - 1 : found;
    const timeMs = found < 0 ? this.points[index].startMs : wanted;
    this.matcher.moveTo(index);
    this.clock.reset(timeMs);
    this.clock.setLimit(this.points[index].startMs);
    this.deps.navigation.setTime(timeMs);
    this.set({ completed: index, expected: this.points[index].pitches });
  }

  /** Hand the line to the playback: it plays from where the practice stands, and the practice goes on from there when it stops. */
  listen(): void {
    if (this.state.phase === 'idle' || this.state.phase === 'listening') return;
    this.cancelCount();
    this.resumeMs = this.clock.positionMs;
    this.clock.setRunning(false);
    this.deps.navigation.setTime(this.resumeMs);
    this.deps.navigation.detach(this.source);
    this.playbackSeen = false;
    this.set({ phase: 'listening', countIn: null });
    void this.deps.playback.play();
  }

  /** Stop the playback that «listen» started. */
  stopListening(): void {
    if (this.state.phase === 'listening') this.deps.playback.stop();
  }

  private playbackChanged(): void {
    if (this.state.phase !== 'listening') return;
    const { playing, loading, paused } = this.deps.playback.getState();
    if (playing || loading || paused) {
      this.playbackSeen = true;
      return;
    }
    if (!this.playbackSeen) return;
    // The playback stopped: the line goes back to where the practice held it.
    const { navigation } = this.deps;
    navigation.setTime(this.resumeMs);
    this.clock.reset(this.resumeMs);
    navigation.attach(this.source);
    this.set({ phase: 'lost' });
    this.device();
  }

  /** The keyboard came or went: the phase follows it. */
  private device(): void {
    const connected = this.deps.midi.getState().status === 'connected';
    const { phase } = this.state;
    if (phase === 'listening' || phase === 'idle') return;
    if (!connected) {
      if (phase === 'running' || phase === 'counting') this.interrupted = true;
      this.cancelCount();
      this.clock.setRunning(false);
      if (phase !== 'lost') this.set({ phase: 'lost', countIn: null });
      return;
    }
    if (phase === 'lost') {
      if (this.interrupted) this.countIn(COUNT_FROM);
      else this.run();
    }
  }

  private run(): void {
    this.interrupted = false;
    this.clock.setRunning(true);
    this.set({ phase: 'running', countIn: null });
  }

  private countIn(number: number): void {
    this.clock.setRunning(false);
    this.set({ phase: 'counting', countIn: number });
    this.countHandle = this.deps.setTimeout(() => {
      this.countHandle = null;
      if (this.state.phase !== 'counting') return;
      if (number > 1) this.countIn(number - 1);
      else this.run();
    }, this.deps.countStepMs);
  }

  private cancelCount(): void {
    if (this.countHandle !== null) this.deps.clearTimeout(this.countHandle);
    this.countHandle = null;
  }

  private note(event: MidiNoteEvent): void {
    const held = new Set(this.state.pressed);
    if (event.kind === 'on') held.add(event.pitch);
    else held.delete(event.pitch);
    const pressed = [...held].sort((a, b) => a - b);
    if (event.kind !== 'on' || this.state.phase !== 'running') {
      this.set({ pressed });
      return;
    }
    const result = this.matcher.press(event.pitch, event.at);
    if (!result.completed) {
      this.set({ pressed });
      return;
    }
    if (this.matcher.done) {
      // The last point of the loop is played: the line goes back to the start and the next lap begins.
      this.matcher.reset();
      this.clock.reset(0);
      this.clock.setLimit(this.points[0].startMs);
      this.deps.navigation.setTime(0);
      this.set({ pressed, completed: 0, lap: this.state.lap + 1, expected: this.points[0].pitches });
      return;
    }
    this.clock.setLimit(this.points[this.matcher.completed].startMs);
    this.set({ pressed, completed: this.matcher.completed, expected: this.points[this.matcher.completed].pitches });
  }

  /** The navigation's own record of the position follows the line a few times a second; readers on the frame ask the source. */
  private frameTick(frameTime: number): void {
    const { phase } = this.state;
    if (phase === 'idle' || phase === 'listening') return;
    const position = this.clock.at(frameTime);
    const now = this.deps.now();
    if (now - this.lastWrite >= STATE_WRITE_MS) {
      this.lastWrite = now;
      this.deps.navigation.setTime(position);
    }
  }

  private set(patch: Partial<PracticeState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener(this.state);
  }
}

export const practice = new PracticeSession({
  navigation: sharedNavigation,
  midi: sharedMidi,
  playback: sharedPlayback,
  frame: frameTimeMs,
  onFrame: onAnimationFrame,
  setTimeout: (callback, ms) => window.setTimeout(callback, ms),
  clearTimeout: (handle) => window.clearTimeout(handle as number),
  now: () => performance.now(),
  countStepMs: 1000,
});

export function usePractice(): PracticeState {
  return useSyncExternalStore(
    (cb) => practice.subscribe(() => cb()),
    () => practice.getState(),
  );
}
