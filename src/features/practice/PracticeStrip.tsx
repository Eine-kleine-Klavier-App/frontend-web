import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { animate, useMotionValue, useReducedMotion, type AnimationPlaybackControls } from 'motion/react';
import { useEditor } from '@/app/store';
import { navigation } from '@/core/navigation/ScoreNavigation';
import { formatClock, indexAtMs, msAtPosition, positionAtBeat } from '@/core/navigation/route';
import { onAnimationFrame } from '@/core/playback/MediaClock';
import type { ScoreLayout } from '@/rendering/ScoreRenderer';
import { Renderer } from 'vexflow';
import { ContextIndex } from '@/core/model/contexts';
import { barAtBeat } from '@/core/model/query';
import { readCssToken } from '@/ui/cssToken';
import { CARRY_MS, EASE_IN_OUT } from '@/styles/motion';
import { VexflowRenderer } from '@/rendering/vexflow/VexflowRenderer';
import { ScoreErrorBoundary } from '@/features/editor/ScoreErrorBoundary';
import { createPlaybackLayers, type PlaybackLayers } from '@/features/editor/PlaybackLayers';
import type { TransportScrub } from '@/features/playback/Transport';
import { useRoute } from '@/features/playback/useRoute';
import { WHEEL_IDLE_MS, WHEEL_LINE_PX } from '@/features/playback/waterfall/rollScrub';
import { beatAtStripX, stripCursorAt, systemBands } from './stripCursor';
import { drawHead, headBlockWidth, headKey, headStateAt } from './stripHead';

/** The scale of the strip is bounded so that the notes stay readable in a low zone and do not swell in a high one. */
const MIN_SCALE = 0.35;
const MAX_SCALE = 1.7;
/** The strip is one system however long the piece is (the renderer is asked for it); this width is only the key of its drawing. */
const STRIP_UNITS = 900;
/** The share of the height the system takes (with everything beyond its staves), and of the width where the cursor stands:
 *  near the left edge by default, so the room is for what is coming, with a little of what was just played behind it. */
const FILL = 0.9;
/** A step of the line this far, either way (a share of the visible width), is a jump, not the line running. */
const JUMP_SHARE = 0.25;
/** A drag along the strip shorter than this share of its width is a touch, not a scroll. */
const DEAD_ZONE_OF_WIDTH = 0.015;
/** The id a hold by the wheel has in place of a pointer's. */
const WHEEL = -1;

/** Where the strip is drawn and where its cursor stands, for the animation frame. */
interface Pose {
  tx: number;
  ty: number;
  scale: number;
  markX: number;
  markTop: number;
  markH: number;
}

/**
 * The notes of the score as a strip: the system the cursor is in, large, with the cursor at a fixed
 * place and the notes moving under it. It is the page's own engraving, taken with long systems, so
 * the whole score is drawn once and only moved on each frame.
 */
export function PracticeStrip({ width, height, lineAt, pinHead, scrub }: {
  width: number;
  height: number;
  lineAt: number;
  pinHead: boolean;
  /** What moves the position by hand; the strip is dragged with it like the page's line. */
  scrub: TransportScrub;
}) {
  const document = useEditor((s) => s.document);
  const voiceColors = useEditor((s) => s.voiceColors);
  const stemOverrides = useEditor((s) => s.stemOverrides);
  const [layout, setLayout] = useState<ScoreLayout | null>(null);
  const sheetRef = useRef<HTMLDivElement>(null);
  const cursorRef = useRef<HTMLDivElement>(null);
  const washRef = useRef<HTMLDivElement>(null);
  const headRef = useRef<HTMLDivElement>(null);
  const ghostRef = useRef<HTMLDivElement>(null);
  const ghostClipRef = useRef<HTMLDivElement>(null);
  const ghostArtRef = useRef<HTMLDivElement>(null);
  const headArtRef = useRef<HTMLDivElement>(null);
  const captionRef = useRef<HTMLDivElement>(null);
  const reduce = useReducedMotion();
  // 0 to 1 while the strip carries itself to where the line jumped to
  const blend = useMotionValue(1);
  // where the sheet is drawn and which system the line is in, as the animation frame last put them: a drag starts from there
  const poseRef = useRef<{ scale: number; y0: number } | null>(null);

  const [ink, setInk] = useState<{ y: number; h: number }[]>([]);
  // The head of the system (clef, key, time) is pinned at the left once the sheet has moved: the widest one sets where the line stands.
  const contexts = useMemo(() => new ContextIndex(document), [document]);
  const headLeft = layout?.staffZones[0]?.left ?? 0;
  const widestHead = useMemo(() => {
    if (!layout) return 0;
    const context = new Renderer(globalThis.document.createElement('div'), Renderer.Backends.SVG).getContext();
    const seen = new Set<string>();
    let widest = 0;
    for (let index = 0; index < document.measures.length; index++) {
      const state = headStateAt(document, contexts, index);
      if (!state || seen.has(headKey(state))) continue;
      seen.add(headKey(state));
      widest = Math.max(widest, headBlockWidth(state, headLeft, context));
    }
    return widest;
  }, [layout, document, contexts, headLeft]);
  const bands = useMemo(() => (layout ? systemBands(layout, ink) : null), [layout, ink]);
  const onLayout = useCallback((next: ScoreLayout) => {
    setLayout(next);
    navigation.setTotalBeats(next.totalBeats);
  }, []);
  const onEngraveError = useCallback((message: string) => useEditor.setState({ error: `The score could not be drawn: ${message}` }), []);

  // Dragging the strip, or the wheel over it: the notes go with the hand and the line stays where it stands, so the place of the score that reaches the line is the position;
  // the sound is held until the strip is let go. The pass the line is in stays the same, as with the line on the page.
  const route = useRoute();
  interface Hold {
    /** the pointer that holds it, or `WHEEL` */
    id: number;
    x: number;
    /** where the line stood on the engraving when it was taken, and the scale and the system it was drawn in */
    lineX: number;
    scale: number;
    y0: number;
    pass: number;
    ms: number;
    held: boolean;
  }
  const drag = useRef<Hold | null>(null);
  const wheel = useRef({ shift: 0, idle: 0 });
  const [caption, setCaption] = useState<string | null>(null);
  const release = () => {
    const held = drag.current;
    if (!held) return;
    drag.current = null;
    setCaption(null);
    if (held.held) scrub.end(held.ms);
  };
  const releaseRef = useRef(release);
  releaseRef.current = release;
  // leaving with the strip held lets it go
  useEffect(() => () => releaseRef.current(), []);
  /** Takes the strip where it stands; it is not held yet, a touch is not a scroll. */
  const take = (id: number, x: number): Hold | null => {
    if (drag.current || !layout || !poseRef.current || !route.bars.length) return null;
    const at = stripCursorAt(layout.timeMap, navigation.getTimeBeats());
    if (!at) return null;
    const ms = navigation.getTimeMs();
    drag.current = { id, x, lineX: at.x, scale: poseRef.current.scale, y0: poseRef.current.y0, pass: route.bars[indexAtMs(route, ms)]?.pass ?? 1, ms, held: false };
    return drag.current;
  };
  /** The notes have been carried `shift` pixels sideways from where the strip was taken: to the right is back in the music. */
  const carry = (hold: Hold, shift: number) => {
    if (!layout) return;
    const beats = beatAtStripX(layout.timeMap, hold.y0, hold.lineX - shift / hold.scale);
    if (beats === null) return;
    const position = positionAtBeat(route, beats, hold.pass);
    hold.ms = msAtPosition(route, position);
    scrub.to(hold.ms);
    const bar = route.bars[Math.min(Math.floor(position), route.bars.length - 1)];
    setCaption(`Bar ${bar.measure + 1}${bar.passes > 1 ? ` · pass ${bar.pass}/${bar.passes}` : ''} · ${formatClock(hold.ms)}`);
  };
  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    // a hand that takes the strip ends the wheel's gesture, which would otherwise hold it until the wheel has been still (a trackpad's momentum keeps it long)
    if (drag.current?.id === WHEEL) {
      window.clearTimeout(wheel.current.idle);
      wheel.current.shift = 0;
      release();
    }
    if (take(event.pointerId, event.clientX)) event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const hold = drag.current;
    if (!hold || event.pointerId !== hold.id) return;
    if (!hold.held) {
      if (Math.abs(event.clientX - hold.x) < DEAD_ZONE_OF_WIDTH * width) return;
      // what lay inside the dead zone is not carried
      hold.held = true;
      hold.x = event.clientX;
      scrub.begin();
      return;
    }
    carry(hold, event.clientX - hold.x);
  };
  // The wheel and the trackpad carry the notes the way a drag does; down or to the right is on in the music, as in reading. A wheel gesture ends when the wheel has been still.
  const onWheel = (event: WheelEvent) => {
    if (event.ctrlKey || (drag.current && drag.current.id !== WHEEL)) return;
    event.preventDefault();
    const unit: number = event.deltaMode === 1 ? WHEEL_LINE_PX : event.deltaMode === 2 ? width : 1;
    const delta: number = (Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY) * unit;
    window.clearTimeout(wheel.current.idle);
    wheel.current.idle = window.setTimeout(() => {
      wheel.current.shift = 0;
      releaseRef.current();
    }, WHEEL_IDLE_MS);
    wheel.current.shift -= delta;
    let hold = drag.current;
    if (!hold) {
      // what came in while it was still a touch is carried when it turns into a scroll
      if (Math.abs(wheel.current.shift) < DEAD_ZONE_OF_WIDTH * width) return;
      hold = take(WHEEL, 0);
      if (!hold) return;
      hold.held = true;
      scrub.begin();
    }
    carry(hold, wheel.current.shift);
  };
  const wheelRef = useRef(onWheel);
  wheelRef.current = onWheel;
  const areaRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const area = areaRef.current;
    if (!area) return;
    const listener = (event: WheelEvent) => wheelRef.current(event);
    // not passive: the strip is scrolled, the page under it is not
    area.addEventListener('wheel', listener, { passive: false });
    return () => {
      area.removeEventListener('wheel', listener);
      window.clearTimeout(wheel.current.idle);
    };
  }, []);

  // What is drawn in each system is measured once the engraving stands: the dynamics and marks under the staves are in no box of the layout.
  useLayoutEffect(() => {
    const sheet = sheetRef.current;
    if (!sheet || !layout) return;
    const next: { y: number; h: number }[] = [];
    // the engraving once more, still: the grey copy of what the route plays next is cut out of it
    const art = ghostArtRef.current;
    const drawing = sheet.querySelector('svg');
    if (art) {
      art.replaceChildren();
      if (drawing) {
        const copy = drawing.cloneNode(true) as SVGElement;
        art.appendChild(copy);
      }
    }
    sheet.querySelectorAll<SVGGElement>('g.vf-system').forEach((group) => {
      const box = group.getBBox();
      if (box.height > 0) next.push({ y: box.y, h: box.height });
    });
    setInk(next);
  }, [layout]);

  // Every frame: where the cursor is, the system it is in, and the sheet moved so the cursor stays put. When the line jumps (a repeat,
  // the next system, a new lap, the position slider) the strip does not teleport: it is carried there on the shared ease-in-out.
  useEffect(() => {
    if (!layout || !bands || width <= 0 || height <= 0) return;
    let washed = -1;
    let headDrawn = '';
    let lastSegment: number | null = null;
    let ghostFor: number | null = null;
    let headBlock = 0;
    let layers: PlaybackLayers | null = null;
    const ink = readCssToken(sheetRef.current ?? globalThis.document.documentElement, '--color-ink');
    let last: Pose | null = null;
    let from: Pose | null = null;
    let shown: Pose | null = null;
    let flight: AnimationPlaybackControls | undefined;
    blend.set(1);
    const stop = onAnimationFrame(() => {
      const sheet = sheetRef.current;
      const mark = cursorRef.current;
      const wash = washRef.current;
      if (!sheet || !mark || !wash) return;
      const beat = navigation.getTimeBeats();
      const at = stripCursorAt(layout.timeMap, beat);
      if (!at) return;
      const band = bands.get(at.y0) ?? { top: at.y0, bottom: at.y1 };
      const scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, FILL * height / Math.max(1, band.bottom - band.top)));
      const reach = Math.max(0, layout.width * scale - width);
      const anchor = (pinHead ? widestHead * scale : 0) + lineAt * width;
      const target: Pose = {
        tx: Math.max(-reach, Math.min(0, anchor - at.x * scale)),
        ty: (height - (band.bottom - band.top) * scale) / 2 - band.top * scale,
        scale,
        markX: at.x,
        markTop: at.y0,
        markH: at.y1 - at.y0,
      };
      // Where the route is: a step from one stretch of the plan to one that does not begin where it ended (a repeat, a volta, a new lap) is a jump
      // of the line, in either direction; so is any other sudden move (a new system, the slider). A jump the grey copy has announced is invisible:
      // the real music now stands where the copy was, so there is nothing to carry.
      const map = navigation.getState().map;
      const segments = map?.segments ?? [];
      const ms = navigation.getTimeMs();
      let segment = segments.findIndex((part) => ms >= part.startMs && ms < part.endMs);
      if (segment < 0) segment = Math.max(0, segments.length - 1);
      const routeJump = lastSegment !== null && segment !== lastSegment && segments.length > 0 &&
        (segment !== lastSegment + 1 || Math.abs(segments[segment].startBeats - segments[lastSegment].endBeats) > 1e-6);
      const announced = routeJump && ghostFor === segment;
      lastSegment = segment;
      const held = navigation.getState().held;
      // a hand that holds the strip is followed at once, not glided to
      if (held) {
        flight?.stop();
        blend.set(1);
      } else if (last && !announced && (routeJump || target.markTop !== last.markTop || Math.abs(target.markX - last.markX) > JUMP_SHARE * width / scale || target.markX < last.markX - 1)) {
        from = shown ?? last;
        flight?.stop();
        if (reduce) blend.set(1);
        else {
          blend.set(0);
          flight = animate(blend, 1, { duration: CARRY_MS / 1000, ease: EASE_IN_OUT });
        }
      } else if (announced) {
        flight?.stop();
        blend.set(1);
      }
      last = target;
      const t = Math.max(0, Math.min(1, blend.get()));
      const pose: Pose = from && t < 1 ? {
        tx: from.tx + (target.tx - from.tx) * t,
        ty: from.ty + (target.ty - from.ty) * t,
        scale: from.scale + (target.scale - from.scale) * t,
        markX: from.markX + (target.markX - from.markX) * t,
        markTop: from.markTop + (target.markTop - from.markTop) * t,
        markH: from.markH + (target.markH - from.markH) * t,
      } : target;
      shown = pose;
      poseRef.current = { scale: pose.scale, y0: at.y0 };
      // Everything is put on whole device pixels: a sheet carried by a fraction of a pixel is filtered anew on every frame, and the thin lines
      // (the bar lines, the line of the playback) shimmer. On whole pixels each of them is rasterised the same way on every frame.
      const ratio = globalThis.devicePixelRatio || 1;
      const snap = (value: number) => Math.round(value * ratio) / ratio;
      const tx = snap(pose.tx);
      const ty = snap(pose.ty);
      sheet.style.transform = `translate(${tx}px, ${ty}px) scale(${pose.scale})`;
      // the line of the playback is drawn over the sheet, in screen pixels, so that it is the same picture wherever the sheet is
      mark.style.left = `${snap(pose.tx + pose.markX * pose.scale)}px`;
      mark.style.top = `${snap(pose.ty + pose.markTop * pose.scale)}px`;
      mark.style.height = `${snap(pose.markH * pose.scale)}px`;
      // the caption is a plate of the page: it stands over the line's top and keeps its size
      const tip = captionRef.current;
      if (tip) {
        const box = mark.getBoundingClientRect();
        tip.style.left = `${box.left}px`;
        tip.style.top = `max(${box.top}px, calc(var(--editor-bar-h) + var(--space-8)))`;
        tip.style.visibility = 'visible';
      }
      // The copy of what comes next: where the route will not go on to the music that stands after this stretch, it goes to the stretch it jumps to, and a
      // grey copy of that, laid over what stands there, shows it ahead of the line. It begins where the line will be when it jumps.
      const ghost = ghostRef.current;
      const clip = ghostClipRef.current;
      const copy = ghostArtRef.current;
      if (ghost && clip && copy) {
        const part = segments[segment];
        const nextIndex = segments.length ? (segment + 1) % segments.length : 0;
        const next = segments[nextIndex];
        if (part && next && Math.abs(next.startBeats - part.endBeats) > 1e-6) {
          const gx = stripCursorAt(layout.timeMap, part.endBeats)?.x ?? 0;
          const gs = stripCursorAt(layout.timeMap, next.startBeats)?.x ?? 0;
          ghostFor = nextIndex;
          ghost.style.display = 'block';
          ghost.style.transform = `translate(${tx}px, ${ty}px) scale(${pose.scale})`;
          clip.style.left = `${gx}px`;
          clip.style.width = `${width / pose.scale + 400}px`;
          clip.style.height = `${layout.height}px`;
          copy.style.transform = `translateX(${-gs}px)`;
        } else {
          ghostFor = null;
          ghost.style.display = 'none';
        }
      }
      // the bar the line is in is washed pink; its box is set only when the bar changes
      const index = barAtBeat(document, beat).index;
      // the head the bar has: drawn again only when it differs from the one drawn, pinned once the engraving's own head has moved off
      const head = headRef.current;
      const art = headArtRef.current;
      if (head && art) {
        const state = headStateAt(document, contexts, index);
        const measureId = document.measures[index]?.id;
        const upper = layout.staffZones.find((zone) => zone.measureId === measureId && zone.staffId === document.staffOrder[0]);
        const lower = layout.staffZones.find((zone) => zone.measureId === measureId && zone.staffId === document.staffOrder[1]);
        if (state && upper && lower) {
          const wanted = `${headKey(state)}|${upper.bottomLineY}|${lower.bottomLineY}`;
          if (wanted !== headDrawn) {
            headDrawn = wanted;
            headBlock = drawHead(art, state, { left: headLeft, trebleBottom: upper.bottomLineY, bassBottom: lower.bottomLineY, height: layout.height, ink });
          }
          head.style.display = pinHead && pose.tx < -1 ? 'block' : 'none';
          head.style.width = `${headBlock * pose.scale}px`;
          art.style.transform = `translate(0px, ${ty}px) scale(${pose.scale})`;
        } else head.style.display = 'none';
      }
      if (index !== washed) {
        washed = index;
        const box = layout.measures[index];
        wash.style.display = box ? 'block' : 'none';
        if (box) {
          wash.style.left = `${box.x}px`;
          wash.style.top = `${box.y}px`;
          wash.style.width = `${box.w}px`;
          wash.style.height = `${box.h}px`;
        }
      }
      // The washed bar and the notes of the point that is waited for are drawn on layers of whole device pixels over the sheet (the sheet, the wash box
      // in it and the notes are placed by the browser, the layers read where they stand); the line is already a box on whole device pixels.
      const area = sheet.parentElement;
      if (area) {
        layers ??= createPlaybackLayers(area);
        layers.draw(null, wash.style.display === 'none' ? null : wash, navigation.getState().activeCarrierIds, sheet);
      }
    });
    return () => {
      stop();
      layers?.dispose();
      flight?.stop();
    };
  }, [layout, bands, width, height, lineAt, pinHead, document, contexts, headLeft, widestHead, blend, reduce]);

  return (
    <div
      ref={areaRef}
      className="practice-strip"
      aria-label="Notes"
      data-grabbing={caption !== null}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={release}
      onPointerCancel={release}
      onLostPointerCapture={release}
    >
      <div ref={sheetRef} className="practice-strip-sheet" style={{ width: layout?.width, height: layout?.height }}>
        <ScoreErrorBoundary document={document}>
          <VexflowRenderer
            document={document}
            selectedIds={[]}
            carrierSelectedIds={[]}
            pageContentWidth={STRIP_UNITS}
            continuous
            onLayout={onLayout}
            voiceColors={voiceColors}
            stemOverrides={stemOverrides}
            hoveredNoteIds={[]}
            onEngraveError={onEngraveError}
          />
        </ScoreErrorBoundary>
        <div ref={washRef} className="practice-strip-wash" />
      </div>
      <div ref={cursorRef} className="practice-strip-cursor" />
      {caption !== null && createPortal(<div ref={captionRef} className="line-caption" style={{ visibility: 'hidden' }}>{caption}</div>, globalThis.document.body)}
      <div ref={ghostRef} className="practice-strip-ghost" aria-hidden="true">
        <div ref={ghostClipRef} className="practice-strip-ghost-clip">
          <div ref={ghostArtRef} className="practice-strip-ghost-art" />
        </div>
      </div>
      <div ref={headRef} className="practice-strip-head" aria-hidden="true">
        <div ref={headArtRef} className="practice-strip-head-art" />
      </div>
    </div>
  );
}
