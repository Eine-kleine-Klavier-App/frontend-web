import { useSyncExternalStore } from 'react';
import type { PlaybackMap, PlaybackSegment } from '@/core/playback/PlaybackGateway';

export interface NavigationState {
  map: PlaybackMap | null;
  timeMs: number;
  timeBeats: number;
  totalBeats: number;
  activeCarrierIds: string[];
  /** A driver holds the position, so the cursor is shown even where nothing plays and the position is the start. */
  cursorShown: boolean;
  /** A hand holds the position (a strip or the line dragged, a scrub held): whoever draws it follows it at once instead of gliding to it. */
  held: boolean;
}
export type NavigationListener = (state: NavigationState) => void;

/** The position a driver reports on this animation frame, in milliseconds; null when it is not moving the position. */
export type PositionSource = () => number | null;

/**
 * Where the score is read from: the plan of the playback and the position in it. Whoever moves the
 * position (the sound player, a practice mode) attaches the source it reads the position from, so the
 * waterfall, the score cursor and the sliders read the same time and none of them knows who drives it.
 */
export class ScoreNavigation {
  private state: NavigationState = { map: null, timeMs: 0, timeBeats: 0, totalBeats: 0, activeCarrierIds: [], cursorShown: false, held: false };
  private listeners = new Set<NavigationListener>();
  /** Drivers that may move the position, the one attached last on top. */
  private sources: PositionSource[] = [];

  getState(): NavigationState {
    return this.state;
  }

  subscribe(listener: NavigationListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  update(patch: Partial<NavigationState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener(this.state);
  }

  /** The position at `timeMs`: its place in the score and the carriers sounding there. */
  setTime(timeMs: number): void {
    const { map, timeBeats, activeCarrierIds } = this.state;
    if (!map) {
      this.update({ timeMs, timeBeats, activeCarrierIds });
      return;
    }
    const active = map.anchors.filter((anchor) => anchor.startMs <= timeMs && timeMs < anchor.endMs).map((anchor) => anchor.carrierId);
    const same = active.length === activeCarrierIds.length && active.every((id, index) => id === activeCarrierIds[index]);
    this.update({ timeMs, timeBeats: beatAtTime(map, Math.min(timeMs, map.extentMs)), activeCarrierIds: same ? activeCarrierIds : active });
  }

  setTotalBeats(total: number): void {
    if (Number.isFinite(total) && total >= 0) this.update({ totalBeats: total, timeBeats: Math.min(total, this.state.timeBeats) });
  }

  /** A source attached later is asked first; one that has no position (null) leaves the question to the one below it. */
  attach(source: PositionSource): void {
    this.detach(source);
    this.sources.push(source);
  }

  /** The position stays where it was held; the source below the detached one is asked again. */
  detach(source: PositionSource): void {
    const at = this.sources.indexOf(source);
    if (at >= 0) this.sources.splice(at, 1);
  }

  /** The position of whoever drives now, read on the animation frame; the state's time is written only on transport events and a few times a second. */
  getTimeMs(): number {
    for (let index = this.sources.length - 1; index >= 0; index--) {
      const position = this.sources[index]();
      if (position !== null) return position;
    }
    return this.state.timeMs;
  }

  getTimeBeats(): number {
    const { map, timeBeats } = this.state;
    return map ? beatAtTime(map, Math.min(this.getTimeMs(), map.extentMs)) : timeBeats;
  }
}

export const navigation = new ScoreNavigation();

/** One value of the state, read so that the component renders only when that value changes. `select` must return something comparable with `===`. */
export function useNavigationValue<T>(select: (state: NavigationState) => T): T {
  return useSyncExternalStore(
    (cb) => navigation.subscribe(() => cb()),
    () => select(navigation.getState()),
  );
}

/** The time at a place of one segment, read between its moments. */
export function timeInSegment(segment: PlaybackSegment, beats: number): number {
  const points = segment.moments;
  if (beats <= points[0].beats) return points[0].timeMs;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    if (beats <= b.beats) return a.timeMs + ((beats - a.beats) / (b.beats - a.beats)) * (b.timeMs - a.timeMs);
  }
  return points.at(-1)!.timeMs;
}

/** The time the playback first reaches a place of the score (a repeated part is reached again
 *  later, its first pass counts). A place that is never played gives the time of the next one
 *  played. */
export function timeAtBeat(map: PlaybackMap, beats: number): number {
  for (const segment of map.segments) {
    if (beats < segment.startBeats) return segment.startMs;
    if (beats <= segment.endBeats) return timeInSegment(segment, beats);
  }
  return map.extentMs;
}

/** The place of the score the playback is at when the time is `ms`: in the segment, so a repeated
 *  part gives its own pass. */
export function beatAtTime(map: PlaybackMap, ms: number): number {
  const segment = map.segments.find((candidate) => ms < candidate.endMs) ?? map.segments.at(-1);
  if (!segment) return 0;
  const points = segment.moments;
  if (ms <= points[0].timeMs) return points[0].beats;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    if (ms <= b.timeMs) return a.beats + ((ms - a.timeMs) / (b.timeMs - a.timeMs)) * (b.beats - a.beats);
  }
  return points.at(-1)!.beats;
}
