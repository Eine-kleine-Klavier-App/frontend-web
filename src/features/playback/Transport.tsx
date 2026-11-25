import { useEffect, useLayoutEffect, useRef } from 'react';
import { motion, useReducedMotion, type MotionValue } from 'motion/react';
import { PauseIcon, PlayIcon, SkipBackIcon, SkipForwardIcon, StopIcon } from '@/ui/icons';
import { useEditor } from '@/app/store';
import { navigation } from '@/core/navigation/ScoreNavigation';
import { formatClock, msAtPosition, stepMs } from '@/core/navigation/route';
import { onAnimationFrame } from '@/core/playback/MediaClock';
import { readCssLength } from '@/ui/cssLength';
import { playhead, usePlayheadDriver } from './playhead';
import { useRoute } from './useRoute';

/** How the position is moved by hand: the sound is held while it moves and goes on from where it is left. */
export interface TransportScrub {
  begin(): void;
  to(ms: number): void;
  end(ms: number): void;
}

/** Held, a step button turns into a scrub that speeds up. */
const HOLD_MS = 350;
const SCRUB_SPEEDS = [1, 2, 4, 8, 16, 32, 64] as const;
const SCRUB_STEP_MS = 800;

const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));

/**
 * The transport island: ⏮ ▶ ⏭ ■, the time, and a thin strip of the whole piece.
 * The strip and the time are drawn on the animation frame from the playhead, so they move with the music and never step.
 * Play is the one accent fill on the page. It is the one control for every screen that moves the line.
 * `shift` carries it along while the column's edge moves (the panel opening).
 */
export function Transport({ shift, loading, playing, paused, disabled, stopDisabled, onPlay, onPause, onStop, onSeekMs, scrub }: {
  shift?: MotionValue<number>;
  loading: boolean;
  playing: boolean;
  paused: boolean;
  /** Play and the strips cannot be used. */
  disabled: boolean;
  stopDisabled: boolean;
  onPlay: () => void;
  onPause: () => void;
  /** Stop, and also the cancel of a loading play. */
  onStop: () => void;
  /** Go to a time of the route and stay there (a step, a key). */
  onSeekMs: (ms: number) => void;
  scrub: TransportScrub;
}) {
  const documentLoading = useEditor((s) => s.loading);
  const reduce = useReducedMotion();
  const route = useRoute();
  const rootRef = useRef<HTMLDivElement>(null);
  const plateRef = useRef<HTMLDivElement>(null);
  const topRef = useRef<HTMLDivElement>(null);
  const miniRef = useRef<HTMLDivElement>(null);
  const timeRef = useRef<HTMLSpanElement>(null);
  const scrubbing = useRef<{ stop: () => void; speed: number } | null>(null);
  const placed = useRef(0);
  const bars = route.bars;
  const total = bars.length;
  const live = useRef({ route });
  live.current = { route };
  const locked = disabled || documentLoading;

  usePlayheadDriver(route, !!reduce, scrubbing);

  useLayoutEffect(() => {
    const root = rootRef.current;
    const plate = plateRef.current;
    const top = topRef.current;
    const time = timeRef.current;
    const mini = miniRef.current;
    if (!root || !plate || !top || !time || !mini) return;
    const measure = () => {
      const slot = root.getBoundingClientRect();
      const width = Math.min(readCssLength(root, '--island-w'), slot.width);
      plate.style.width = `${width}px`;
      plate.style.setProperty('--island-left', `${(slot.width - width) / 2}px`);
      const button = readCssLength(root, '--island-btn');
      const gap = readCssLength(root, '--island-gap');
      const pad = readCssLength(root, '--island-pad');
      const pitch = button + gap;
      // the parts of the top row stand in steps of a button and its gap
      const stand = (name: string, step: number) => {
        top.querySelector<HTMLElement>(`[data-at="${name}"]`)?.style.setProperty('--x', String(pad + step * pitch));
      };
      stand('prev', 0);
      stand('play', 1);
      stand('next', 2);
      stand('stop', 3);
      stand('time', 4);
      // the time keeps the width of its widest form in this piece (4:56 / 4:56), so the strip beside it does not move as it counts
      const written = time.textContent;
      time.style.minWidth = '0';
      time.textContent = `${formatClock(live.current.route.totalMs)} / ${formatClock(live.current.route.totalMs)}`;
      time.style.minWidth = `${time.offsetWidth}px`;
      time.textContent = written;
      // the small strip fills what is left between the time and the plate's edge, with room for half the thumb at either end
      const half = readCssLength(root, '--island-thumb') / 2;
      const miniLeft = pad + 4 * pitch + time.offsetWidth + gap + half;
      mini.style.left = `${miniLeft}px`;
      mini.style.width = `${Math.max(0, width - pad - half - miniLeft)}px`;
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [route.totalMs]);

  useEffect(() => playhead.subscribe((frame) => {
    const { route: r, shown } = frame;
    const count = r.bars.length;
    const ratio = count ? shown / count : 0;
    const mini = miniRef.current;
    const fill = mini?.querySelector<HTMLElement>('[data-fill]');
    const thumb = mini?.querySelector<HTMLElement>('[data-thumb]');
    if (fill) fill.style.transform = `scaleX(${ratio})`;
    if (thumb) thumb.style.left = `${ratio * 100}%`;
    const timeText = timeRef.current;
    if (timeText) timeText.textContent = `${formatClock(msAtPosition(r, shown))} / ${formatClock(r.totalMs)}`;
    const index = Math.min(Math.floor(shown), Math.max(0, count - 1));
    const bar = r.bars[index];
    mini?.setAttribute('aria-valuenow', String(index));
    mini?.setAttribute('aria-valuetext', bar ? `Bar ${bar.measure + 1}${bar.passes > 1 ? `, pass ${bar.pass} of ${bar.passes}` : ''}` : 'No position');
  }), []);

  const startScrub = (direction: 1 | -1) => {
    if (locked || !total) return;
    scrub.begin();
    const started = navigation.getTimeMs();
    let ms = started;
    let before = 0;
    let began = 0;
    const handle = { speed: SCRUB_SPEEDS[0] as number, stop: () => {} };
    const off = onAnimationFrame((now) => {
      if (!began) began = before = now;
      handle.speed = SCRUB_SPEEDS[Math.min(SCRUB_SPEEDS.length - 1, Math.floor((now - began) / SCRUB_STEP_MS))];
      ms = Math.max(0, Math.min(live.current.route.totalMs, ms + direction * (now - before) * handle.speed));
      before = now;
      scrub.to(ms);
    });
    handle.stop = () => {
      off();
      scrubbing.current = null;
      scrub.end(ms);
    };
    scrubbing.current = handle;
  };
  const endScrub = () => scrubbing.current?.stop();
  const step = (direction: 1 | -1) => {
    if (!locked && total) onSeekMs(stepMs(route, navigation.getTimeMs(), direction));
  };
  // A step button: a tap goes one bar, a hold turns into a scrub.
  const holdTimer = useRef(0);
  const stepButton = (direction: 1 | -1) => ({
    onPointerDown: () => { holdTimer.current = window.setTimeout(() => { holdTimer.current = 0; startScrub(direction); }, HOLD_MS); },
    onPointerUp: () => {
      if (holdTimer.current) { window.clearTimeout(holdTimer.current); holdTimer.current = 0; step(direction); } else endScrub();
    },
    onPointerLeave: () => {
      if (holdTimer.current) { window.clearTimeout(holdTimer.current); holdTimer.current = 0; } else endScrub();
    },
    onClick: (event: React.MouseEvent) => { if (event.detail === 0) step(direction); },
  });

  // The small strip: pressing it goes to the place under the finger, dragging follows it, and the sound goes on from where it is left.
  const placeAt = (event: React.PointerEvent<HTMLElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    placed.current = msAtPosition(route, clamp((event.clientX - box.left) / box.width, 0, 1) * total);
    scrub.to(placed.current);
  };
  const strip = {
    onPointerDown: (event: React.PointerEvent<HTMLElement>) => {
      if (locked || !total) return;
      event.currentTarget.setPointerCapture(event.pointerId);
      scrub.begin();
      placeAt(event);
    },
    onPointerMove: (event: React.PointerEvent<HTMLElement>) => { if (event.currentTarget.hasPointerCapture(event.pointerId)) placeAt(event); },
    onPointerUp: () => scrub.end(placed.current),
    onPointerCancel: () => scrub.end(placed.current),
    onKeyDown: (event: React.KeyboardEvent) => {
      if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
      event.preventDefault();
      step(event.key === 'ArrowRight' ? 1 : -1);
    },
    role: 'slider',
    tabIndex: locked ? -1 : 0,
    'aria-label': 'Position in the piece',
    'aria-valuemin': 0,
    'aria-valuemax': total,
    'aria-disabled': locked,
  } as const;

  return (
    <motion.div ref={rootRef} className="island-slot" style={{ x: shift }} role="group" aria-label="Playback" aria-busy={loading}>
      <div ref={plateRef} className="island">
        <div ref={topRef} className="island-top">
          <button type="button" className="island-btn island-at" data-at="prev" aria-label="Previous bar, hold to rewind" title="Previous bar (hold to rewind)" disabled={locked} {...stepButton(-1)}><SkipBackIcon /></button>
          <button
            type="button"
            className="island-btn island-play island-at"
            data-at="play"
            aria-label={loading ? 'Cancel loading audio' : playing ? 'Pause playback' : paused ? 'Resume playback' : 'Play from the line'}
            title={loading ? 'Loading audio…' : playing ? 'Pause playback' : 'Play from the line'}
            disabled={locked}
            onClick={() => { if (loading) onStop(); else if (playing) onPause(); else onPlay(); }}
          >
            {playing ? <PauseIcon /> : <PlayIcon />}
          </button>
          <button type="button" className="island-btn island-at" data-at="next" aria-label="Next bar, hold to fast-forward" title="Next bar (hold to fast-forward)" disabled={locked} {...stepButton(1)}><SkipForwardIcon /></button>
          <button type="button" className="island-btn island-at" data-at="stop" aria-label="Stop playback" title="Stop" disabled={stopDisabled} onClick={onStop}><StopIcon /></button>
          <span ref={timeRef} className="island-time island-at" data-at="time" />
          <div ref={miniRef} className="island-strip island-mini" {...strip}>
            <span className="island-fill" data-fill />
            <span className="island-thumb" data-thumb />
          </div>
        </div>
      </div>
    </motion.div>
  );
}
