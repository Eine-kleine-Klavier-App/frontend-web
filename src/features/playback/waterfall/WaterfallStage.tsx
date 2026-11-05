import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { useEditor } from '@/app/store';
import { resolveVoiceColor } from '@/core/model/voiceColors';
import { playback, usePlaybackValue } from '@/core/playback/PlaybackController';
import { WaterfallScene } from './rollScene';
import { waterfallBars, waterfallNotes } from './waterfallNotes';
import { voiceRamp, type VoiceRamp } from './waterfallPalette';
import { readCssToken } from '@/ui/cssToken';

const MS_PER_SECOND = 1000;
/** A paused scene is still drawn this often, so a drawing buffer the browser drops is never left blank. */
const HEARTBEAT_MS = 500;

export type WaterfallSky = 'black' | 'grey';
/** The choices of the sky, as the controls list them. */
export const WATERFALL_SKIES: { value: WaterfallSky; label: string }[] = [
  { value: 'black', label: 'Black' },
  { value: 'grey', label: 'Grey' },
];

let warmer: () => void = () => {};
/** Draws the stage once, at the time it will be shown at, BEFORE the view changes: the first draw of a hidden stage is the heaviest frame of the switch, and an animation that starts before it is frozen for its length and then jumps ahead. */
export function warmWaterfallStage(): void {
  warmer();
}

/** The waterfall: the piece as notes falling onto a keyboard, in the colours of their voices, over the playback clock. It fills its parent; the controls live in the editor's bar. */
export function WaterfallStage({
  sky,
  active,
  stripColor,
  tilt,
  viewportRef,
  octaveLines,
  measureLines,
}: {
  sky: WaterfallSky;
  active: boolean;
  stripColor: string;
  tilt: number;
  viewportRef: RefObject<HTMLDivElement>;
  octaveLines: boolean;
  measureLines: boolean;
}) {
  const document = useEditor((s) => s.document);
  const voiceColors = useEditor((s) => s.voiceColors);
  const map = usePlaybackValue((state) => state.map);
  const mapLoading = usePlaybackValue((state) => state.mapLoading);
  const [unavailable, setUnavailable] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sceneRef = useRef<WaterfallScene | null>(null);
  const dirty = useRef(true);
  const activeRef = useRef(active);
  activeRef.current = active;

  const notes = useMemo(() => (map ? waterfallNotes(map, document) : []), [map, document]);
  const bars = useMemo(() => (map ? waterfallBars(map, document) : []), [map, document]);
  const ramps = useMemo(() => {
    const result: VoiceRamp[] = [];
    for (const voice of document.voices) result[voice.index] = voiceRamp(resolveVoiceColor(voice.id, voice.index, voiceColors));
    return result;
  }, [document.voices, voiceColors]);

  useEffect(() => {
    if (!active) return;
    void playback.prepareMap();
  }, [active]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let scene: WaterfallScene;
    try {
      scene = new WaterfallScene(canvas);
    } catch {
      setUnavailable(true);
      return;
    }
    sceneRef.current = scene;
    // a resize clears the canvas, so the new size is drawn in the same frame, before it is shown
    const observer = new ResizeObserver(() => {
      scene.resize(viewportRef.current?.clientHeight);
      scene.render(playback.getTimeMs() / MS_PER_SECOND);
      dirty.current = true;
    });
    observer.observe(canvas);
    if (viewportRef.current) observer.observe(viewportRef.current);
    const lose = (event: Event) => {
      event.preventDefault();
      setUnavailable(true);
    };
    canvas.addEventListener('webglcontextlost', lose);
    const snapshot = () => {
      if (activeRef.current) scene.render(playback.getTimeMs() / MS_PER_SECOND);
    };
    canvas.addEventListener('snapshot', snapshot);
    let frame = 0;
    let drawn = -1;
    let drawnAt = 0;
    warmer = () => {
      const timeMs = playback.getTimeMs();
      dirty.current = false;
      drawn = timeMs;
      drawnAt = performance.now();
      scene.render(timeMs / MS_PER_SECOND);
    };
    const tick = (now: number) => {
      frame = requestAnimationFrame(tick);
      if (!activeRef.current) return;
      const { playing } = playback.getState();
      const timeMs = playback.getTimeMs();
      if (!playing && !dirty.current && timeMs === drawn && now - drawnAt < HEARTBEAT_MS) return;
      dirty.current = false;
      drawn = timeMs;
      drawnAt = now;
      scene.render(timeMs / MS_PER_SECOND);
    };
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      warmer = () => {};
      observer.disconnect();
      canvas.removeEventListener('webglcontextlost', lose);
      canvas.removeEventListener('snapshot', snapshot);
      scene.dispose();
      sceneRef.current = null;
    };
  }, [viewportRef]);

  useEffect(() => {
    sceneRef.current?.setPiece(notes, bars, map?.pedals.map((p) => ({ down: p.downMs / MS_PER_SECOND, up: p.upMs / MS_PER_SECOND })) ?? []);
    dirty.current = true;
  }, [notes, bars, map]);

  useEffect(() => {
    sceneRef.current?.setRamps(ramps);
    dirty.current = true;
  }, [ramps]);

  useEffect(() => {
    sceneRef.current?.setBackground(readCssToken(globalThis.document.documentElement, sky === 'black' ? '--waterfall-sky-black' : '--waterfall-sky-grey'));
    dirty.current = true;
  }, [sky]);

  useEffect(() => {
    sceneRef.current?.setGuides(octaveLines, measureLines);
    dirty.current = true;
  }, [octaveLines, measureLines]);

  useEffect(() => {
    sceneRef.current?.setTilt(tilt);
    dirty.current = true;
  }, [tilt]);

  useEffect(() => {
    sceneRef.current?.setStripLight(stripColor);
    dirty.current = true;
  }, [stripColor]);

  return (
    <>
      <canvas ref={canvasRef} className="waterfall-canvas" role="img" aria-label="Notes falling onto a piano keyboard, each in the colour of its voice" />
      {unavailable && <p className="waterfall-message" role="alert">The waterfall needs WebGL 2, which is not available here.</p>}
      {!unavailable && mapLoading && <p className="waterfall-message" role="status">Loading the playback map…</p>}
    </>
  );
}
