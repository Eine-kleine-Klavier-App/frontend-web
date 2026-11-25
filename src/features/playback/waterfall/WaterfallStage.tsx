import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { useReducedMotion } from 'motion/react';
import { useEditor } from '@/app/store';
import { resolveVoiceColor } from '@/core/model/voiceColors';
import { playback, usePlaybackValue } from '@/core/playback/PlaybackController';
import { navigation, useNavigationValue } from '@/core/navigation/ScoreNavigation';
import { keyMarks } from '@/core/keys/KeyMarks';
import { WaterfallScene, type PedalInterval, type WaterfallLayout } from './rollScene';
import { attachRollScrub } from './rollScrub';
import type { TransportScrub } from '../Transport';
import WaterfallPrerenderWorker from './WaterfallPrerender.worker?worker';
import {
  prepareWaterfallWindow, waterfallWindowId,
  WaterfallWindowCache,
  type WaterfallWindowSource, type WaterfallWorkerRequest, type WaterfallWorkerResponse,
} from './waterfallFrameCache';
import { waterfallBars, waterfallNotes, type WaterfallNote } from './waterfallNotes';
import { voiceRamp, type VoiceRamp } from './waterfallPalette';
import { readCssToken } from '@/ui/cssToken';
import { DelayedLoading } from '@/ui/DelayedLoading';
import type { PlaybackMap } from '@/core/playback/PlaybackGateway';

const MS_PER_SECOND = 1000;
const WORKER_TIMEOUT_MS = 2500;

interface RenderSettings {
  notes: WaterfallNote[];
  bars: number[];
  pedals: PedalInterval[];
  ramps: VoiceRamp[];
  sky: WaterfallSky;
  octaveLines: boolean;
  measureLines: boolean;
  backgroundDust: boolean;
  stripColor: string;
  map: PlaybackMap | null;
}

interface FramePreparation {
  map: PlaybackMap;
  timeMs: number;
  signal: AbortSignal;
  cancel: () => void;
  resolve: () => void;
  promise: Promise<void>;
  timeout: number;
  ready: boolean;
}

export type WaterfallSky = 'black' | 'grey';
/** The choices of the sky, as the controls list them. */
export const WATERFALL_SKIES: { value: WaterfallSky; label: string }[] = [
  { value: 'black', label: 'Black' },
  { value: 'grey', label: 'Grey' },
];

function FrameLoadingDots() {
  const ref = useRef<HTMLSpanElement>(null);
  const reduce = useReducedMotion();

  useEffect(() => {
    if (reduce || !ref.current) return;
    const animations = Array.from(ref.current.children, (dot, index) => dot.animate(
      [{ opacity: 0.32 }, { opacity: 1 }, { opacity: 0.32 }],
      { duration: 900, delay: index * 140, iterations: Infinity, easing: 'ease-in-out' },
    ));
    return () => animations.forEach(animation => animation.cancel());
  }, [reduce]);

  return <span ref={ref} aria-hidden="true" style={{ display: 'flex', gap: 'var(--space-2)' }}>
    {[0, 1, 2].map(dot => <span
      key={dot}
      style={{
        display: 'block', width: 'var(--space-2)', aspectRatio: 1, borderRadius: '50%',
        background: 'currentColor', opacity: reduce ? 0.8 : 0.32,
      }}
    />)}
  </span>;
}

/** The waterfall: the piece as notes falling onto a keyboard, in the colours of their voices, over the playback clock. It fills its parent; the controls live in the editor's bar. */
export function WaterfallStage({
  sky,
  active,
  preparingView = false,
  onFirstFrame,
  stripColor,
  viewportRef,
  octaveLines,
  measureLines,
  backgroundDust,
  scrub,
}: {
  sky: WaterfallSky;
  active: boolean;
  preparingView?: boolean;
  onFirstFrame?: (ready: boolean) => void;
  stripColor: string;
  viewportRef: RefObject<HTMLDivElement>;
  octaveLines: boolean;
  measureLines: boolean;
  backgroundDust: boolean;
  /** What moves the position by hand; the roll is scrolled with it (the wheel, a trackpad, a drag along it). */
  scrub?: TransportScrub;
}) {
  const document = useEditor((s) => s.document);
  const sourceIdentity = useEditor((s) => s.source);
  const voiceColors = useEditor((s) => s.voiceColors);
  const map = useNavigationValue((state) => state.map);
  const mapLoading = usePlaybackValue((state) => state.mapLoading);
  const [unavailable, setUnavailable] = useState(false);
  const [mapFailure, setMapFailure] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const keyboardRef = useRef<HTMLCanvasElement>(null);
  const skyRef = useRef<HTMLCanvasElement>(null);
  const linesRef = useRef<HTMLCanvasElement>(null);
  const updateSettings = useRef<(settings: RenderSettings) => void>(() => {});
  const activeRef = useRef(active);
  activeRef.current = active;
  const scrubRef = useRef(scrub);
  scrubRef.current = scrub;
  const renderIntent = useRef(preparingView);
  renderIntent.current = preparingView;
  const reportFirstFrame = useRef(onFirstFrame);
  reportFirstFrame.current = onFirstFrame;
  const needsMap = active || preparingView;

  const notes = useMemo(() => (map ? waterfallNotes(map, document) : []), [map, document]);
  const bars = useMemo(() => (map ? waterfallBars(map, document) : []), [map, document]);
  const pedals = useMemo(() => map?.pedals.map(({ downMs, upMs }) => ({
    down: downMs / MS_PER_SECOND,
    up: upMs / MS_PER_SECOND,
  })) ?? [], [map]);
  const ramps = useMemo(() => {
    const result: VoiceRamp[] = [];
    for (const voice of document.voices) result[voice.index] = voiceRamp(resolveVoiceColor(voice.id, voice.index, voiceColors));
    return result;
  }, [document.voices, voiceColors]);

  useEffect(() => {
    setMapFailure(false);
    if (!needsMap || !sourceIdentity) return;
    let current = true;
    void playback.prepareMap().then(() => {
      if (current && !navigation.getState().map) setMapFailure(true);
    });
    return () => { current = false; };
  }, [needsMap, sourceIdentity, document]);

  useEffect(() => {
    if (!preparingView && !active) onFirstFrame?.(false);
    else if (unavailable || (!map && mapFailure)) onFirstFrame?.(true);
  }, [active, preparingView, unavailable, map, mapFailure, onFirstFrame]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const keyboard = keyboardRef.current;
    const sky = skyRef.current;
    const lines = linesRef.current;
    const surface = canvas?.parentElement;
    if (!canvas || !keyboard || !sky || !lines || !surface) return;
    let scene: WaterfallScene;
    try {
      scene = new WaterfallScene(canvas, undefined, keyboard, { sky, lines });
    } catch {
      setUnavailable(true);
      return;
    }

    const detachScrub = attachRollScrub(canvas, {
      scrub: () => scrubRef.current,
      pixelsPerSecond: () => scene.pixelsPerSecond,
      keysTop: () => scene.keysTop,
      totalMs: () => navigation.getState().map?.extentMs ?? 0,
    });
    const cache = new WaterfallWindowCache();
    let worker: Worker | undefined;
    let useWorker = typeof Worker !== 'undefined';
    let generation = 0;
    let configured = -1;
    let nextRequest = 0;
    let pending: { request: number; timeout: number; ids: readonly number[] } | undefined;
    let source: WaterfallWindowSource | undefined;
    let settings: RenderSettings | undefined;
    let layout: WaterfallLayout | undefined;
    let dirty = true;
    let paintRevision = 0;
    let contextAvailable = true;
    const lostContexts = new Set<EventTarget>();
    let presented: number | undefined;
    let preparation: FramePreparation | undefined;
    const bypassed = new WeakSet<AbortSignal>();
    let frame = 0;
    let readinessFrame = 0;
    let firstFrameReported = false;

    const playhead = () => Math.max(0, navigation.getTimeMs());

    const clearPreparation = () => {
      const target = preparation;
      if (!target) return;
      preparation = undefined;
      window.clearTimeout(target.timeout);
      target.signal.removeEventListener('abort', target.cancel);
      target.resolve();
      setPreparing(false);
    };

    const dropPending = () => {
      if (pending) window.clearTimeout(pending.timeout);
      pending = undefined;
    };

    const stopWorker = () => {
      dropPending();
      worker?.terminate();
      worker = undefined;
      configured = -1;
    };

    const invalidateWindows = (newSource = false) => {
      if (newSource) generation++;
      cache.clear();
      dropPending();
    };

    const measure = () => {
      const width = surface.clientWidth;
      const height = surface.clientHeight;
      const viewportHeight = viewportRef.current?.clientHeight || height;
      if (!(width > 0 && height > 0)) return;
      const pixelRatio = window.devicePixelRatio || 1;
      if (layout?.width === width && layout.height === height &&
          layout.viewportHeight === viewportHeight && layout.pixelRatio === pixelRatio) return;
      const previousLookAhead = scene.lookAheadSeconds;
      layout = { width, height, viewportHeight, pixelRatio };
      scene.resizeTo(layout);
      if (scene.lookAheadSeconds !== previousLookAhead) invalidateWindows();
      dirty = true;
      paintRevision++;
    };

    const draw = (timeMs: number) => {
      if (!contextAvailable || !layout || !settings?.ramps.length) return false;
      const seconds = timeMs / MS_PER_SECOND;
      const prepared = source && cache.get(waterfallWindowId(source, seconds));
      scene.setKeyMarks(keyMarks.get());
      scene.render(seconds, prepared);
      presented = timeMs;
      dirty = false;
      return true;
    };

    const canBuffer = () => activeRef.current && contextAvailable && !canvas.ownerDocument.hidden;
    const checkPreparation = () => {
      const target = preparation;
      if (!target || target.ready || settings?.map !== target.map || !source || !layout) return;
      const id = waterfallWindowId(source, target.timeMs / MS_PER_SECOND);
      if (!cache.get(id)) return;
      target.ready = true;
      window.clearTimeout(target.timeout);
      target.resolve();
    };

    const refill = (audioMs?: number) => {
      if (!canBuffer() || !source || !layout || (preparation && settings?.map !== preparation.map)) return;
      const id = waterfallWindowId(source, (preparation?.timeMs ?? audioMs ?? playhead()) / MS_PER_SECOND);
      cache.moveTo(id, source.bars.length - 1);
      checkPreparation();
      if (pending) return;
      const ids = cache.missing(id);
      if (!ids.length) return;
      const index = source;
      if (useWorker) {
        const disableWorker = () => {
          useWorker = false;
          stopWorker();
          refill();
        };
        try {
          if (!worker) {
            const running = new WaterfallPrerenderWorker();
            worker = running;
            running.onerror = (event) => {
              event.preventDefault();
              if (running === worker) disableWorker();
            };
            running.onmessageerror = () => {
              if (running === worker) disableWorker();
            };
            running.onmessage = ({ data }: MessageEvent<WaterfallWorkerResponse>) => {
              if (running !== worker || pending?.request !== data.request || data.generation !== generation) return;
              window.clearTimeout(pending.timeout);
              pending = undefined;
              cache.add(data.windows);
              refill();
            };
          }
          if (configured !== generation) {
            worker.postMessage({ type: 'configure', generation, source: index } satisfies WaterfallWorkerRequest);
            configured = generation;
          }
          const request = ++nextRequest;
          pending = { request, timeout: window.setTimeout(disableWorker, WORKER_TIMEOUT_MS), ids };
          worker.postMessage({ type: 'prepare', generation, request, ids, visibleAhead: scene.lookAheadSeconds } satisfies WaterfallWorkerRequest);
          return;
        } catch {
          useWorker = false;
          stopWorker();
        }
      }
      // The same small search works synchronously if creating a worker fails.
      cache.add(ids.map(windowId => prepareWaterfallWindow(index, windowId, scene.lookAheadSeconds)));
      checkPreparation();
    };

    const detachBuffer = playback.setFrameBuffer({
      active: canBuffer,
      prepare(map, timeMs, signal) {
        if (signal.aborted || bypassed.delete(signal) || !canBuffer()) return;
        if (!layout) measure();
        const existing = preparation;
        const sameTarget = existing?.signal === signal && existing.map === map && existing.timeMs === timeMs;
        if (!sameTarget) clearPreparation();
        if (sameTarget && !existing.ready) return existing.promise;
        if (settings?.map === map && source && layout) {
          const id = waterfallWindowId(source, timeMs / MS_PER_SECOND);
          cache.moveTo(id, source.bars.length - 1);
          if (cache.get(id)) return;
          if (pending && !pending.ids.includes(id)) dropPending();
        }
        clearPreparation();
        let resolve!: () => void;
        const promise = new Promise<void>(complete => { resolve = complete; });
        const cancel = () => {
          if (preparation?.signal === signal) clearPreparation();
        };
        const timeout = window.setTimeout(() => {
          if (preparation?.signal !== signal) return;
          if (settings?.map === map && source && layout) {
            stopWorker();
            useWorker = false;
            refill();
            if (preparation?.ready) return;
          }
          bypassed.add(signal);
          clearPreparation();
        }, WORKER_TIMEOUT_MS);
        preparation = { map, timeMs, signal, cancel, resolve, promise, timeout, ready: false };
        signal.addEventListener('abort', cancel, { once: true });
        setPreparing(true);
        refill();
        return promise;
      },
    });

    const onResize = () => {
      if (!activeRef.current && !renderIntent.current) return;
      measure();
      if (dirty) draw(preparation ? presented ?? playhead() : playhead());
    };
    const observer = new ResizeObserver(onResize);
    observer.observe(surface);
    if (viewportRef.current) observer.observe(viewportRef.current);
    window.addEventListener('resize', onResize);
    const onVisibility = () => {
      if (canvas.ownerDocument.hidden) {
        clearPreparation();
        stopWorker();
        cache.clear();
      } else {
        onResize();
        refill();
      }
    };
    canvas.ownerDocument.addEventListener('visibilitychange', onVisibility);
    const onContextLost = (event: Event) => {
      if (event.currentTarget) lostContexts.add(event.currentTarget);
      contextAvailable = false;
      setUnavailable(true);
      clearPreparation();
    };
    const onContextRestored = (event: Event) => {
      if (event.currentTarget) lostContexts.delete(event.currentTarget);
      if (lostContexts.size) return;
      contextAvailable = true;
      scene.invalidateRasters();
      layout = undefined;
      dirty = true;
      paintRevision++;
      setUnavailable(false);
    };
    canvas.addEventListener('contextlost', onContextLost);
    canvas.addEventListener('contextrestored', onContextRestored);
    keyboard.addEventListener('contextlost', onContextLost);
    keyboard.addEventListener('contextrestored', onContextRestored);
    sky.addEventListener('contextlost', onContextLost);
    sky.addEventListener('contextrestored', onContextRestored);
    lines.addEventListener('contextlost', onContextLost);
    lines.addEventListener('contextrestored', onContextRestored);

    updateSettings.current = (next) => {
      if (settings?.notes !== next.notes || settings.bars !== next.bars || settings.pedals !== next.pedals) {
        scene.setPiece(next.notes, next.bars, next.pedals);
        source = next.map ? scene.windowSource(next.map.extentMs / MS_PER_SECOND) : undefined;
        invalidateWindows(true);
      }
      if (settings?.ramps !== next.ramps) scene.setRamps(next.ramps);
      if (settings?.sky !== next.sky) {
        scene.setBackground(readCssToken(canvas, next.sky === 'black' ? '--waterfall-sky-black' : '--waterfall-sky-grey'));
      }
      if (settings?.octaveLines !== next.octaveLines || settings?.measureLines !== next.measureLines) {
        scene.setGuides(next.octaveLines, next.measureLines);
      }
      if (settings?.backgroundDust !== next.backgroundDust) scene.setBackgroundDust(next.backgroundDust);
      if (settings?.stripColor !== next.stripColor) scene.setStripLight(next.stripColor);
      settings = next;
      dirty = true;
      paintRevision++;
      refill();
    };

    const tick = () => {
      frame = requestAnimationFrame(tick);
      if (canvas.ownerDocument.hidden) return;
      if (!activeRef.current) {
        clearPreparation();
        if (worker) stopWorker();
        if (!renderIntent.current) {
          firstFrameReported = false;
          if (cache.get(0) || presented !== undefined) cache.clear();
          return;
        }
        if (!settings?.map || firstFrameReported || readinessFrame) return;
        measure();
        if (!draw(playhead())) return;
        const revision = paintRevision;
        readinessFrame = requestAnimationFrame(() => {
          readinessFrame = 0;
          if (!renderIntent.current || !contextAvailable || revision !== paintRevision) return;
          firstFrameReported = true;
          reportFirstFrame.current?.(true);
        });
        return;
      }
      if (!layout) measure();
      const { loading, seekBeats } = playback.getState();
      if (preparation?.ready && !loading && seekBeats === null) clearPreparation();
      if (preparation) {
        refill();
        return;
      }
      const audioMs = playhead();
      if (dirty || audioMs !== presented) draw(audioMs);
      // A stage that is on screen from the start (a screen that opens in the waterfall) reports its first frame here: it is never prepared out of view.
      if (!firstFrameReported && settings?.map && presented !== undefined) {
        firstFrameReported = true;
        reportFirstFrame.current?.(true);
      }
      refill(audioMs);
    };
    frame = requestAnimationFrame(tick);
    const unsubscribeKeyMarks = keyMarks.subscribe(() => { dirty = true; });

    return () => {
      unsubscribeKeyMarks();
      detachScrub();
      cancelAnimationFrame(frame);
      detachBuffer();
      cancelAnimationFrame(readinessFrame);
      updateSettings.current = () => {};
      observer.disconnect();
      window.removeEventListener('resize', onResize);
      canvas.ownerDocument.removeEventListener('visibilitychange', onVisibility);
      canvas.removeEventListener('contextlost', onContextLost);
      canvas.removeEventListener('contextrestored', onContextRestored);
      keyboard.removeEventListener('contextlost', onContextLost);
      keyboard.removeEventListener('contextrestored', onContextRestored);
      sky.removeEventListener('contextlost', onContextLost);
      sky.removeEventListener('contextrestored', onContextRestored);
      lines.removeEventListener('contextlost', onContextLost);
      lines.removeEventListener('contextrestored', onContextRestored);
      clearPreparation();
      stopWorker();
      cache.clear();
      scene.dispose();
    };
  }, [viewportRef]);

  useEffect(() => {
    updateSettings.current({
      notes, bars, pedals, ramps, sky, octaveLines, measureLines, backgroundDust, stripColor, map,
    });
  }, [notes, bars, pedals, ramps, sky, octaveLines, measureLines, backgroundDust, stripColor, map]);

  return (
    <>
      <canvas ref={canvasRef} className="waterfall-canvas" role="img" aria-label="Notes falling onto a piano keyboard, each in the colour of its voice" />
      <canvas ref={keyboardRef} className="waterfall-keyboard-canvas" aria-hidden="true"
        style={{ position: 'absolute', left: 0, bottom: 0, display: 'block', width: '100%', pointerEvents: 'none' }} />
      <canvas ref={skyRef} className="waterfall-sky" aria-hidden="true" />
      <canvas ref={linesRef} className="waterfall-lines" aria-hidden="true" />
      {unavailable && <p className="waterfall-message" role="alert">The waterfall could not start its drawing surface.</p>}
      {!unavailable && mapFailure && !map && <p className="waterfall-message" role="alert">The playback map could not be loaded.</p>}
      {!unavailable && mapLoading && !preparing && <p className="waterfall-message" role="status">Loading the playback map…</p>}
      {active && preparing && <DelayedLoading className="waterfall-message">
        <span role="status" style={{
          display: 'grid', justifyItems: 'center', gap: 'var(--space-2)', color: '#fff',
          padding: 'var(--space-3) var(--space-4)', background: 'rgba(2, 2, 9, .76)',
          borderRadius: 'var(--radius-md)',
        }}>
          <FrameLoadingDots />
          Preparing frames…
        </span>
      </DelayedLoading>}
    </>
  );
}
