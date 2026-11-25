import type { PlaybackMap } from '@/core/playback/PlaybackGateway';
import { timeInSegment } from './ScoreNavigation';

/** One bar as it is played: a bar in a repeated part has one entry for each time it sounds. */
export interface RouteBar {
  /** The bar's place in the score, from zero. */
  measure: number;
  /** Where the bar stands in the score and how long it is, in quarter beats. */
  startBeats: number;
  lengthBeats: number;
  startMs: number;
  endMs: number;
  /** Which time this bar sounds, from 1, and how many times it sounds in all. */
  pass: number;
  passes: number;
}

/** The bars in the order they are played. */
export interface Route {
  bars: RouteBar[];
  totalMs: number;
}

/** A length of music below this (in quarter beats) is a shared barline, not a bar that is played. */
const EMPTY_BEATS = 1e-9;
/** Going back past this share of a bar goes to its start, before it goes to the bar before. */
const RESTART_SHARE = 0.4;

/**
 * The route the playback takes through the score. The map gives the stretches that are played in
 * one go (a repeated part has one for each pass); this cuts them at the barlines, so the strip, the
 * bar number and the steps all read the same list. `measureBeats` is the length of every bar of the
 * score in quarter beats, as the map counts them.
 */
export function buildRoute(map: PlaybackMap, measureBeats: readonly number[]): Route {
  const starts: number[] = [];
  let beat = 0;
  for (const length of measureBeats) {
    starts.push(beat);
    beat += length;
  }
  const bars: RouteBar[] = [];
  const times = measureBeats.map(() => 0);
  for (const segment of map.segments) {
    for (let measure = 0; measure < measureBeats.length && starts[measure] < segment.endBeats; measure++) {
      const from = Math.max(starts[measure], segment.startBeats);
      const to = Math.min(starts[measure] + measureBeats[measure], segment.endBeats);
      if (to - from <= EMPTY_BEATS) continue;
      times[measure]++;
      bars.push({ measure, startBeats: starts[measure], lengthBeats: measureBeats[measure], startMs: timeInSegment(segment, from), endMs: timeInSegment(segment, to), pass: times[measure], passes: 0 });
    }
  }
  for (const bar of bars) bar.passes = times[bar.measure];
  return { bars, totalMs: bars.length ? bars[bars.length - 1].endMs : 0 };
}

/** The index of the played bar sounding at `ms`: the first for a time before the start, the last for one past the end. */
export function indexAtMs(route: Route, ms: number): number {
  let low = 0;
  let high = route.bars.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (route.bars[middle].startMs <= ms) low = middle;
    else high = middle - 1;
  }
  return Math.max(0, low);
}

/** Where `ms` stands in the route as one number: the index of the played bar plus the share of it that has sounded. */
export function positionAtMs(route: Route, ms: number): number {
  if (!route.bars.length) return 0;
  const index = indexAtMs(route, ms);
  const bar = route.bars[index];
  const length = bar.endMs - bar.startMs;
  return index + (length > 0 ? Math.max(0, Math.min(1, (ms - bar.startMs) / length)) : 0);
}

/** The time of a place in the route, the inverse of `positionAtMs`. */
export function msAtPosition(route: Route, position: number): number {
  if (!route.bars.length) return 0;
  const index = Math.max(0, Math.min(route.bars.length - 1, Math.floor(position)));
  const bar = route.bars[index];
  return bar.startMs + Math.max(0, Math.min(1, position - index)) * (bar.endMs - bar.startMs);
}

/**
 * Where a place of the score stands in the route: the played bar that holds it plus how far into the bar it is. A bar that sounds
 * more than once is taken in the given `pass`, or in its last when it sounds fewer times. A place before the score is the start of
 * the route and one after it is the end.
 */
export function positionAtBeat(route: Route, beats: number, pass: number): number {
  let found = -1;
  route.bars.forEach((bar, index) => {
    if (beats < bar.startBeats || beats >= bar.startBeats + bar.lengthBeats) return;
    if (found < 0 || bar.pass <= pass) found = index;
  });
  if (found < 0) return beats <= 0 ? 0 : route.bars.length;
  const bar = route.bars[found];
  return found + Math.max(0, Math.min(1, (beats - bar.startBeats) / bar.lengthBeats));
}

/** The time a step of one bar goes to: the start of the next bar, or, back, the start of this bar when it has sounded for more than two fifths of it, else of the one before. */
export function stepMs(route: Route, ms: number, direction: 1 | -1): number {
  const position = positionAtMs(route, ms);
  const index = Math.floor(position);
  if (direction > 0) return msAtPosition(route, Math.min(route.bars.length, index + 1));
  return msAtPosition(route, position - index > RESTART_SHARE ? index : Math.max(0, index - 1));
}

/** The left edge of a window of `count` bars over `total` that shows `position`: `start` while the position is inside it, else the next portion, which begins at the bar the position is in (forward) or ends at it (back); it stops at the ends of the piece. */
export function pageStart(position: number, count: number, total: number, start: number): number {
  if (position >= start && position < start + count) return start;
  const edge = position < start ? Math.ceil(position) - count : Math.floor(position);
  return Math.max(0, Math.min(total - count, edge));
}

/** A time as minutes and seconds. */
export function formatClock(ms: number): string {
  const seconds = Math.floor(Math.max(0, ms) / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}
