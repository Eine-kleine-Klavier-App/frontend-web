import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { animate, motion, useMotionValue, useReducedMotion, useSpring } from 'motion/react';
import type { AnimationPlaybackControls } from 'motion/react';
import { useEditor } from '@/app/store';
import { VexflowRenderer } from '@/rendering/vexflow/VexflowRenderer';
import { Overlay } from './Overlay';
import type { ScoreLayout } from '@/rendering/ScoreRenderer';
import { StaffMarker } from './StaffMarker';
import type { BeamOverride } from '@/core/model/score';
import type { SlurOffsets } from '@/core/model/slurHandles';
import type { SpanPreview } from '@/rendering/ScoreRenderer';
import { playback } from '@/core/playback/PlaybackController';
import { SPRING_SMOOTH } from '@/styles/motion';
import { visibleBottom } from './visibleBottom';
import { readCssLength } from '@/ui/cssLength';
import { SCORE_MARGIN_X } from '@/rendering/vexflow/VexflowRenderer';

// Sheet geometry comes from the stylesheet's tokens (one source), resolved to pixels:
// `--sheet-gutter` (the canvas's side padding = browse's gutter), `--sheet-max` (a page, not a
// banner), `--paper-frame` (the paper's padding, both sides, plus slack) and `--title-band` (the
// engraved title block above the score — added to the paper's height, never part of the score's
// own coordinates, so the overlay and hit-testing are untouched).
interface SheetGeometry {
  gutter: number;
  max: number;
  frame: number;
  band: number;
}
function readSheetGeometry(el: Element): SheetGeometry {
  return {
    gutter: readCssLength(el, '--sheet-gutter'),
    max: readCssLength(el, '--sheet-max'),
    frame: readCssLength(el, '--paper-frame'),
    band: readCssLength(el, '--title-band'),
  };
}

/** Layout changes may generate hover events under a stationary pointer after keyboard navigation. */
export function createHoverFeedback(show: (ids: string[]) => void) {
  let keyboard = false;
  return {
    keyboardMove() { keyboard = true; show([]); },
    pointerMove() { keyboard = false; },
    hover(ids: string[]) { if (!keyboard) show(ids); },
  };
}

export function EditorView({ title }: { title?: string } = {}) {
  const tool = useEditor(s => s.tool);
  const reading = useEditor(s => s.source?.kind === 'saved');
  const document = useEditor((s) => s.document);
  const selectedIds = useEditor((s) => s.selectedIds);
  const carrierSelectedIds = useEditor((s) => s.carrierSelectedIds);
  const zoom = useEditor((s) => s.zoom);
  const voiceColors = useEditor((s) => s.voiceColors);
  const stemOverrides = useEditor((s) => s.stemOverrides);
  const [layout, setLayout] = useState<ScoreLayout | null>(null);
  const [beamPreview, setBeamPreview] = useState<{ id: string; override: BeamOverride; anchorId: string | null } | null>(null);
  const [slurPreview, setSlurPreview] = useState<{ id: string; offsets: SlurOffsets } | null>(null);
  const [placementPreview, setPlacementPreview] = useState<{ id: string; factor: number } | null>(null);
  const [spanPreview, setSpanPreview] = useState<SpanPreview | null>(null);
  const beamLayoutRef = useRef<ScoreLayout | null>(null);
  const beamAnchorRef = useRef<{ id: string; screenY: number; overflowAnchor: string; releaseLayout: ScoreLayout | null } | null>(null);
  const [hoveredNoteIds, setHoveredNoteIds] = useState<string[]>([]);
  const [hoverFeedback] = useState(() => createHoverFeedback(ids =>
    setHoveredNoteIds(previous => previous.length === ids.length && previous.every((id, index) => id === ids[index]) ? previous : ids)));
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) || target.isContentEditable)) return;
      if (!event.metaKey && !event.ctrlKey && !event.altKey && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) hoverFeedback.keyboardMove();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [hoverFeedback]);
  useEffect(() => { if (tool !== 'select') hoverFeedback.keyboardMove(); }, [tool, hoverFeedback]);
  const selectedStructureIds = useEditor((s) => s.selectedStructureIds);
  const selectedMeasureIds = useEditor((s) => s.selectedMeasureIds);
  // everything picked that is engraved as one object rather than as notes: beams, tuplets and clefs
  // by their own ids, and a picked measure's time signature
  const selectedObjectIds = [...selectedStructureIds, ...selectedMeasureIds.map((id) => `ts:${id}`)];
  // what the last insert created, flashed once in its voice colour (a fresh object per insert, so
  // the same ids inserted again still flash)
  const [flash, setFlash] = useState<{ ids: string[] } | null>(null);
  const onInserted = useCallback((ids: string[]) => setFlash({ ids }), []);

  const reduce = useReducedMotion();

  const canvasAreaRef = useRef<HTMLDivElement>(null);
  const scoreContentRef = useRef<HTMLDivElement>(null);

  const onLayout = useCallback((l: ScoreLayout) => {
    setLayout(l);
    playback.setTotalBeats(l.totalBeats);
  }, []);

  // Reflow-zoom: the rendered sheet width stays pinned to the desk's available width (capped at
  // SHEET_MAX_W) regardless of zoom, so the sheet never needs horizontal scroll — zoom only changes
  // how much content fits per system. Recomputed off the store's `zoom` (commits instantly, unlike
  // the animated `scale`), which does trigger a fresh layout per click; also watches
  // `.canvas-area`'s own size via `ResizeObserver` for window resizes.
  const [pageContentWidth, setPageContentWidth] = useState<number | undefined>(undefined);
  // the sheet's token geometry in pixels; re-read with every size change (a font-size change
  // reflows the canvas too, so the ResizeObserver below catches it)
  const geometryRef = useRef<SheetGeometry>({ gutter: 0, max: 0, frame: 0, band: 0 });
  // the page's width and the content width asked of the layout for it
  const pageWidthRef = useRef({ available: 0, requested: 0 });
  useLayoutEffect(() => {
    const area = canvasAreaRef.current;
    if (!area) return;
    const recompute = () => {
      const g = (geometryRef.current = readSheetGeometry(area));
      // Inverts EditorView's own `paperW` formula (`w*zoom + frame`) and VexflowRenderer's
      // `totalW = SCORE_MARGIN_X + pageContentWidth` against the actual available box:
      // the sheet is min(--sheet-max, column − 2 gutters).
      const available = Math.min(area.clientWidth - 2 * g.gutter, g.max);
      const target = (available - g.frame) / zoom - SCORE_MARGIN_X;
      pageWidthRef.current = { available, requested: Math.max(200, target) };
      syncSizes();
      setPageContentWidth(Math.max(200, target));
    };
    recompute();
    const ro = new ResizeObserver(recompute);
    ro.observe(area);
    return () => ro.disconnect();
  }, [zoom]);

  // --- ZOOM (unchanged, works): store `zoom` commits instantly; one spring chases it, and the
  // scale transform + container sizes are all read from that ONE value every frame so they can't
  // desync. A content edit leaves the spring at rest, so the size transforms recompute to the new
  // w/h instantly — edits never lag.
  const scale = useSpring(zoom, SPRING_SMOOTH);
  const onBeamPreview = useCallback((preview: { id: string; override: BeamOverride; anchorId: string | null } | null) => {
    if (preview?.anchorId && beamAnchorRef.current?.id !== preview.anchorId) {
      const area = canvasAreaRef.current;
      const content = scoreContentRef.current;
      const box = beamLayoutRef.current?.noteBoxes.find(note => note.id === preview.anchorId);
      if (area && content && box) {
        const screenY = content.getBoundingClientRect().top + (box.y + box.h / 2) * scale.get();
        beamAnchorRef.current = { id: preview.anchorId, screenY, overflowAnchor: area.style.overflowAnchor, releaseLayout: null };
        area.style.overflowAnchor = 'none';
      }
    }
    if (!preview && beamAnchorRef.current) beamAnchorRef.current.releaseLayout = beamLayoutRef.current;
    setBeamPreview(preview);
  }, [scale]);
  useEffect(() => {
    if (reduce) scale.jump(zoom);
    else scale.set(zoom);
  }, [zoom, reduce, scale]);

  // Zoom anchors on the VIEWPORT CENTER, not the scroll container's top-left (the default: a
  // scaled box growing/shrinking from `transformOrigin: top left` leaves `scrollLeft`/`scrollTop`
  // untouched, so the content pixel that was at the top-left corner stays put — everything visibly
  // drifts away from center as you zoom). Captured once per zoom trigger (the content-local point
  // currently under the viewport's center, read from the CURRENT scale before this change starts
  // animating), then re-applied on every `scale` tick for the rest of the spring's flight so the
  // anchor stays fixed on screen throughout the animation, not just once it settles.
  useEffect(() => {
    const area = canvasAreaRef.current;
    const content = scoreContentRef.current;
    if (!area || !content) return;

    const areaRect = area.getBoundingClientRect();
    const contentRect = content.getBoundingClientRect();
    const s = scale.get() || 1;
    const centerX = areaRect.left + areaRect.width / 2;
    const centerY = areaRect.top + areaRect.height / 2;
    const anchor = {
      x: (centerX - contentRect.left) / s,
      y: (centerY - contentRect.top) / s,
    };

    return scale.on('change', (curS) => {
      const a = canvasAreaRef.current;
      const c = scoreContentRef.current;
      if (!a || !c) return;
      const aRect = a.getBoundingClientRect();
      const cRect = c.getBoundingClientRect();
      const cx = aRect.left + aRect.width / 2;
      const cy = aRect.top + aRect.height / 2;
      const anchorScreenX = cRect.left + anchor.x * curS;
      const anchorScreenY = cRect.top + anchor.y * curS;
      a.scrollLeft += anchorScreenX - cx;
      a.scrollTop += anchorScreenY - cy;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoom]);

  // Keep the selection in view, smoothly — arrow-key carrier navigation (EditorScreen.tsx) can move the
  // selection past the edge of what's currently scrolled into view, and a click near the bottom
  // can land under the dock or the inspector sheet.
  // Same idea as the zoom-center fix above (animate `.canvas-area`'s scroll, don't jump it), same
  // spring preset as everything else chrome-weight (`SPRING_SMOOTH`, §3.5) — deliberately a ONE-
  // SHOT animation (current scroll -> a computed target), not a continuously-live value like
  // `scale`, since there's no per-frame-changing source driving it here.
  const selectionScrollAnimRef = useRef<AnimationPlaybackControls | null>(null);
  const prevSelectedIdsRef = useRef<string[]>([]);
  useEffect(() => {
    const prev = prevSelectedIdsRef.current;
    const changed = selectedIds.length !== prev.length || selectedIds.some((id, i) => id !== prev[i]);
    prevSelectedIdsRef.current = selectedIds;
    if (!changed || !selectedIds.length || !layout) return;

    const area = canvasAreaRef.current;
    const content = scoreContentRef.current;
    if (!area || !content) return;

    const boxes = layout.noteBoxes.filter((nb) => selectedIds.includes(nb.id));
    if (!boxes.length) return;
    const minX = Math.min(...boxes.map((b) => b.x));
    const maxX = Math.max(...boxes.map((b) => b.x + b.w));
    const minY = Math.min(...boxes.map((b) => b.y));
    const maxY = Math.max(...boxes.map((b) => b.y + b.h));

    const s = scale.get() || 1;
    const contentRect = content.getBoundingClientRect();
    const areaRect = area.getBoundingClientRect();
    const boxLeft = contentRect.left + minX * s;
    const boxRight = contentRect.left + maxX * s;
    const boxTop = contentRect.top + minY * s;
    const boxBottom = contentRect.top + maxY * s;
    const viewLeft = areaRect.left;
    const viewRight = areaRect.left + areaRect.width;
    const viewTop = areaRect.top;
    const viewBottom = visibleBottom(area);

    // already fully on screen — don't yank the view for a selection change that's already visible
    // (a plain click), only rescue one that navigated past the edge.
    if (boxLeft >= viewLeft && boxRight <= viewRight && boxTop >= viewTop && boxBottom <= viewBottom) return;

    const deltaX = (boxLeft + boxRight) / 2 - (viewLeft + viewRight) / 2;
    const deltaY = (boxTop + boxBottom) / 2 - (viewTop + viewBottom) / 2;
    const startL = area.scrollLeft;
    const startT = area.scrollTop;
    const targetL = startL + deltaX;
    const targetT = startT + deltaY;

    selectionScrollAnimRef.current?.stop();
    if (reduce) {
      area.scrollLeft = targetL;
      area.scrollTop = targetT;
      return;
    }
    selectionScrollAnimRef.current = animate(0, 1, {
      type: 'spring',
      ...SPRING_SMOOTH,
      onUpdate: (t) => {
        area.scrollLeft = startL + (targetL - startL) * t;
        area.scrollTop = startT + (targetT - startT) * t;
      },
    });
  }, [selectedIds, layout, reduce, scale]);

  const w = layout?.width ?? 0;
  const h = layout?.height ?? 0;
  // The paper's and the score box's sizes, written directly — never through a change event.
  // Derived motion values (`useTransform` over the layout size) subscribe in an effect AFTER this
  // component's layout effects, so a size set on the first commit was missed (WebKit kept the
  // paper at its bare 48px frame width, hidden). `syncSizes` runs on every layout/geometry
  // change and on every tick of the zoom spring; the visibility rides the same write as the
  // width, so the paper never shows before its size.
  const sizeRef = useRef({ w, h });
  sizeRef.current = { w, h };
  // the zoom being steered to: the paper's width follows THIS, not the spring in flight. A zoom step
  // re-flows the score to fit the width at once, so a paper sized by the flying value was wider than
  // the page (zooming out) or narrower (zooming in) for the length of the spring — a jump opposite to
  // the zoom's direction at every click
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const paperW = useMotionValue(0);
  const paperH = useMotionValue(0);
  const scaleW = useMotionValue(0);
  const scaleH = useMotionValue(0);
  const paperVisibility = useMotionValue<'visible' | 'hidden'>('hidden');
  const syncSizes = useCallback(() => {
    const z = scale.get();
    const { w: ww, h: hh } = sizeRef.current;
    const { frame, band } = geometryRef.current;
    scaleW.set(ww * z);
    scaleH.set(hh * z);
    // a layout engraved for another width than the one now asked for is stale (it arrives a frame or more after a zoom step): the paper keeps the width it has until the current layout comes
    // (the page's width if it has none yet)
    const { available, requested } = pageWidthRef.current;
    const current = layoutRef.current?.engravedFor === requested;
    if (current || !available) paperW.set(ww * zoomRef.current + frame);
    else if (paperW.get() === 0) paperW.set(available);
    paperH.set(hh * z + frame + band);
    paperVisibility.set(ww * z > 0 ? 'visible' : 'hidden');
  }, [scale, scaleW, scaleH, paperW, paperH, paperVisibility]);
  useLayoutEffect(syncSizes, [w, h, layout, syncSizes]);
  useLayoutEffect(() => {
    beamLayoutRef.current = layout;
    const anchor = beamAnchorRef.current;
    const area = canvasAreaRef.current;
    const content = scoreContentRef.current;
    const box = layout?.noteBoxes.find(note => note.id === anchor?.id);
    if (anchor && area && content && box) {
      const actualY = content.getBoundingClientRect().top + (box.y + box.h / 2) * scale.get();
      area.scrollTop += actualY - anchor.screenY;
    }
    if (!beamPreview && anchor && layout !== anchor.releaseLayout) {
      if (area) area.style.overflowAnchor = anchor.overflowAnchor;
      beamAnchorRef.current = null;
    }
  }, [layout, beamPreview, scale]);
  useEffect(() => scale.on('change', syncSizes), [scale, syncSizes]);

  useEffect(() => {
    return () => {
      selectionScrollAnimRef.current?.stop();
    };
  }, []);

  return (
    <div
      className="canvas-area"
      ref={canvasAreaRef}
      onPointerMoveCapture={() => hoverFeedback.pointerMove()}
      data-scrolled="false"
      // the soft top fade exists only once the sheet has scrolled (index.css); flipped on the DOM
      // directly so scrolling never re-renders the score
      onScroll={(e) => {
        const el = e.currentTarget;
        const scrolled = el.scrollTop > 2 ? 'true' : 'false';
        if (el.dataset.scrolled !== scrolled) el.dataset.scrolled = scrolled;
        // the sheet moved under a still pointer: whatever was hovered is no longer under it. Without
        // this, the hover tint stayed on a note that had scrolled away (no pointermove fires on
        // scroll) — a pale "white" note that looked like a broken selection.
        setHoveredNoteIds((ids) => (ids.length ? [] : ids));
      }}
    >
      {/* invisible until the first layout exists: before it the paper's width is just its frame,
          which painted as a thin full-height strip that then jumped to full width */}
      <motion.div className="paper" data-ready={layout && w > 0 ? 'true' : 'false'} style={{ width: paperW, height: paperH, visibility: paperVisibility }}>
        <div className="sheet-title" aria-hidden="true">
          <h1>{title || document.title || 'Untitled'}</h1>
        </div>
        <motion.div className="score-scale" style={{ width: scaleW, height: scaleH }}>
          <motion.div
            ref={scoreContentRef}
            className="score-content"
            style={{ scale, transformOrigin: 'top left', width: w, height: h, position: 'relative' }}
          >
            {pageContentWidth !== undefined && <VexflowRenderer
              document={document}
              selectedIds={selectedIds}
              carrierSelectedIds={carrierSelectedIds}
              pageContentWidth={pageContentWidth}
              onLayout={onLayout}
              voiceColors={voiceColors}
              stemOverrides={stemOverrides}
              beamPreview={beamPreview}
              slurPreview={slurPreview}
              spanPreview={spanPreview}
              placementPreview={placementPreview}
              hoveredNoteIds={tool === 'select' ? hoveredNoteIds : []}
              selectedObjectIds={selectedObjectIds}
              flash={flash}
            />}
            {layout && !reading && <StaffMarker layout={layout} />}
            {layout && (
              <Overlay
                layout={layout}
                // pointer moves report the same hover again and again: only a change re-renders
                onHoverNote={hoverFeedback.hover}
                onInserted={onInserted}
                onBeamPreview={onBeamPreview}
                slurPreview={slurPreview}
                onSlurPreview={setSlurPreview}
                spanPreview={spanPreview}
                onSpanPreview={setSpanPreview}
                onPlacementPreview={setPlacementPreview}
              />
            )}
          </motion.div>
        </motion.div>
      </motion.div>
    </div>
  );
}
