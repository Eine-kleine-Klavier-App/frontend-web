import { useEffect, useRef, type MutableRefObject } from 'react';
import { animate } from 'motion/react';
import { navigation } from '@/core/navigation/ScoreNavigation';
import { pageStart, positionAtMs, type Route } from '@/core/navigation/route';
import { onAnimationFrame } from '@/core/playback/MediaClock';
import { playback } from '@/core/playback/PlaybackController';
import { CARRY_MS, EASE_IN_OUT, springSmooth } from '@/styles/motion';

/** The bars the timeline's ribbon shows at once; a shorter piece shows all of its bars, and its cells then take the whole strip. */
export const RIBBON_BARS = 12;
/** A step of the position larger than this many bars in one frame is a jump, to be glided to; a smaller one is the music running. */
const JUMP_BARS = 0.2;

const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));

/** The window of bars the ribbon shows, and what holds it. */
export interface PlayheadWindow {
  /** The first bar of the window; a fraction while it slides to the next portion. */
  start: number;
  /** The share of the window the position stood at when the segment was taken by hand. */
  rel: number;
  /** What is held by hand: the segment (it carries the window with the position) or the ribbon (the window stays). */
  drag: 'segment' | 'ribbon' | null;
}

/** What a drawing of the position reads on every frame. */
export interface PlayheadFrame {
  route: Route;
  /** The position drawn, in bars of the route: it glides to a jump and follows the music otherwise. */
  shown: number;
  start: number;
  span: number;
  /** The speed of a scrub by a held step button, 0 when none. */
  speed: number;
}

/** The one place the position is worked out for every drawing of it (the island's small strip and time, the timeline's lines): they subscribe and paint, they do not work it out again. */
class Playhead {
  readonly window: PlayheadWindow = { start: 0, rel: 0, drag: null };
  private readonly listeners = new Set<(frame: PlayheadFrame) => void>();

  subscribe(listener: (frame: PlayheadFrame) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  emit(frame: PlayheadFrame): void {
    for (const listener of this.listeners) listener(frame);
  }
}

export const playhead = new Playhead();

/**
 * Runs the frame loop of the playhead: the position shown (it glides to a jump), the window of the ribbon (it holds while the position is inside it and slides to the next portion
 * when the position leaves; a segment held by hand carries it along), and tells the subscribers. Mounted once, by the island, which every screen has.
 */
export function usePlayheadDriver(route: Route, still: boolean, scrubbing: MutableRefObject<{ speed: number } | null>): void {
  const live = useRef({ route, still });
  live.current = { route, still };
  useEffect(() => {
    let shown = 0;
    let lastTarget = 0;
    let first = true;
    let glide: { stop: () => void } | null = null;
    let page: { stop: () => void } | null = null;
    const frame: PlayheadFrame = { route, shown: 0, start: 0, span: 1, speed: 0 };
    const stop = onAnimationFrame(() => {
      const { route: r, still: calm } = live.current;
      const w = playhead.window;
      const count = r.bars.length;
      const size = Math.max(1, Math.min(RIBBON_BARS, count));
      const firstFrame = first;
      const ms = playback.getState().seekMs ?? navigation.getTimeMs();
      const target = positionAtMs(r, ms);
      const speed = scrubbing.current?.speed ?? 0;
      const delta = Math.abs(target - lastTarget);
      const held = firstFrame || calm || speed > 0 || w.drag !== null || navigation.getState().held;
      // The picture is on the position while it runs or is held by hand; a jump is glided to, and a glide in flight is left to finish.
      if (held || (delta > 0 && delta < JUMP_BARS)) {
        glide?.stop();
        glide = null;
        shown = target;
      } else if (delta >= JUMP_BARS) {
        glide?.stop();
        glide = animate(shown, target, { ...springSmooth, onUpdate: (value) => { shown = value; }, onComplete: () => { glide = null; } });
      } else if (!glide) {
        shown = target;
      }
      lastTarget = target;
      first = false;

      if (w.drag !== null) {
        page?.stop();
        page = null;
      }
      if (count && w.drag === 'segment') {
        w.start = clamp(target - w.rel * size, 0, count - size);
      } else if (count && w.drag === null) {
        const wanted = pageStart(target, size, count, w.start);
        if (firstFrame || calm) {
          page?.stop();
          page = null;
          w.start = wanted;
        } else if (!page && Math.abs(wanted - w.start) > 1e-6) {
          page = animate(w.start, wanted, { duration: CARRY_MS / 1000, ease: EASE_IN_OUT, onUpdate: (value) => { w.start = value; }, onComplete: () => { page = null; } });
        }
      }
      if (!page) w.start = clamp(w.start, 0, Math.max(0, count - size));

      frame.route = r;
      frame.shown = shown;
      frame.start = w.start;
      frame.span = size;
      frame.speed = speed;
      playhead.emit(frame);
    });
    return () => {
      stop();
      glide?.stop();
      page?.stop();
    };
  }, []);
}
