import { bodyFactor, type PresentationChange } from '@/core/model/presentation';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useReducedMotion } from 'motion/react';
import { springScrollTo } from '@/styles/motion';
import { visibleBottom } from './visibleBottom';
import { useEditor } from '@/app/store';
import { playback, usePlayback } from '@/core/playback/PlaybackController';
import { locate, voiceNoteIds, staffNoteIds, measureNoteIds, chordNoteIds, barAtBeat, entityKinds, carrierIdOf, itemOf, contentSelection, measureContentSelection, relationContentSelection, staffContainsPoint } from '@/core/model/query';
import { resolveVoiceColor } from '@/core/model/voiceColors';
import { getGhostGlyphMarkup, getGraceGhostMarkup } from '@/rendering/vexflow/noteGlyph';
import { insertionPosition } from './insertionPosition';
import { inkBox } from '@/rendering/vexflow/collisionLayout';
import { INSERT_DRAG_TYPE } from './Toolbar';
import { parseTool, VALUE_DENOMINATOR, backendAccidental } from '@/core/model/insertItems';
import { MIN_STEM_LENGTH, VEXFLOW_STEM_HEIGHT } from '@/rendering/vexflow/VexflowRenderer';
import { STAFF_SPACE } from '@/rendering/vexflow/engravingScale';
import type { BeamOverride, DurationValue, Fraction, ScoreContext } from '@/core/model/score';
import { BoundaryHandles } from './BoundaryHandles';
import { HandleMark } from './HandleMark';
import { automaticArch, dragSlur, fitted, framed, handlePoints, slurChanges, slurOffsets, SLUR_HANDLES, SLUR_HANDLE_ROLES, type Point, type SlurHandle, type SlurOffsets } from '@/core/model/slurHandles';
import { beamDragFactors, staffInsertionX, staffOnsetX, staffInsertionBeat, type ScoreLayout, type GraceSlot, type NoteBox, type StaffZone, type StemHandle, type BeamShape, type SlurShape, type SpanPreview } from '@/rendering/ScoreRenderer';
import { ContextIndex, defaultClef, endOfSpan, toBeats, fromBeats, measureBeats as lengthOfMeasure } from '@/core/model/contexts';
import { InsertRange } from './InsertRange';
import { draggedSpanRange, insertRange } from '@/core/model/insertRange';
import { isSpanMark, markClicks, parseMark, pointCommand, spanCommand, type MarkPoint } from '@/core/model/markTools';

// Piecewise-linear interpolation over the layout's real (beat, x) breakpoints — spacing is
// Gourlay (duration-weighted), not linear, so a straight-line shortcut would drift.
function interp(points: { beat: number; x: number }[], key: 'beat' | 'x', at: number): number {
  const other = key === 'beat' ? 'x' : 'beat';
  if (!points.length) return 0;
  if (at <= points[0][key]) return points[0][other];
  for (let i = 0; i < points.length - 1; i++) {
    if (at >= points[i][key] && at <= points[i + 1][key]) {
      const span = points[i + 1][key] - points[i][key] || 1;
      const t = (at - points[i][key]) / span;
      return points[i][other] + t * (points[i + 1][other] - points[i][other]);
    }
  }
  return points[points.length - 1][other];
}

/** Where the playback cursor stands at `beat`: interpolated along the time map, within ONE
 *  system. Each system break repeats its beat (barline of the last measure, then the next
 *  system's first onset), so a bracket whose ends sit on different systems is skipped — the
 *  cursor jumps to the next system rather than sweeping diagonally across the page. */
function cursorAt(layout: ScoreLayout, beat: number): {
  x: number;
  y0: number;
  y1: number
} | null {
  const map = layout.timeMap;
  if (!map.length) return null;
  if (beat <= map[0].timeBeats) return { x: map[0].x, y0: map[0].y0, y1: map[0].y1 };
  for (let i = 0; i < map.length - 1; i++) {
    const a = map[i];
    const b = map[i + 1];
    if (a.y0 !== b.y0 || beat < a.timeBeats || beat >= b.timeBeats) continue;
    const t = (beat - a.timeBeats) / (b.timeBeats - a.timeBeats || 1);
    return { x: a.x + t * (b.x - a.x), y0: a.y0, y1: a.y1 };
  }
  const last = map[map.length - 1];
  return { x: last.x, y0: last.y0, y1: last.y1 };
}

/** a point on the score a mark tool resolved the pointer to: measure, quarter beats in it, the staff
 *  row it lies on, the x it snaps to and the vertical extent of that row */
interface MarkGuide extends MarkPoint {
  x: number;
  top: number;
  bottom: number;
  zone: StaffZone;
  pointerX: number;
  pointerY: number;
}

interface Band {
  x: number;
  y: number;
  w: number;
  h: number;
}

type PickKind = 'note' | 'stem' | 'beam' | 'beamHandle' | 'tuplet' | 'time' | 'context' | 'contextHandle' | 'slurHandle';
interface PickTarget {
  kind: PickKind;
  id: string;
  side?: 'left' | 'center' | 'right' | 'start' | 'end' | SlurHandle;
  shapeIndex?: number;
}

/** how far (in staff spaces) a slur's top corner is pulled before its direction decides what it moves */
const SLUR_CORNER_DECISION = 0.3;

const pickKey = (target: PickTarget) => `${target.kind}:${target.id}:${target.side ?? ''}:${target.shapeIndex ?? ''}`;

function preferredHoverTarget(targets: PickTarget[], isSelected: (target: PickTarget) => boolean, topIsStructure: boolean): PickTarget | null {
  return targets.find((target) => (target.kind === 'beamHandle' || target.kind === 'contextHandle' || target.kind === 'slurHandle') && isSelected(target))
    ?? targets.find(isSelected)
    ?? (topIsStructure ? targets[0] : targets.find((target) => target.kind === 'stem') ?? targets[0])
    ?? null;
}

function intersects(b: NoteBox, band: Band): boolean {
  return !(b.x + b.w < band.x || b.x > band.x + band.w || b.y + b.h < band.y || b.y > band.y + band.h);
}


// TEMPORARY hardcoded pitch ceiling per clef (staff_step units) — the real bound depends on
// clef/ottava/instrument range, which the client can't know until pitch is implemented on the
// backend. TODO(pitch-range): resolve from the backend instead of hardcoding here.
const STAFF_STEP_RANGE: Record<'treble' | 'bass', { min: number; max: number }> = {
  treble: { min: -11, max: 19 },
  bass: { min: -11, max: 19 },
};

// keeps a dragged stem's free tip inside the canvas edges; a bit more than the dot's radius (5)
// so the whole grab dot stays visible.
const STEM_CANVAS_MARGIN = 0.8 * STAFF_SPACE;
// how far past `baseY` the stem's hit-line starts, clearing the notehead's own click priority.
const STEM_GRAB_INSET_PX = 1.8 * STAFF_SPACE;
// half-width of the stem's geometric interaction column (`stemAtPoint`), shared by hover and
// click/drag. Deliberately narrower than a chord's notehead-to-stem offset (~5px median) so
// clicking a notehead still selects just that note, not the whole chord.
const STEM_INTERACT_X_TOLERANCE = 0.4 * STAFF_SPACE;

// Clearance kept between the insert-ghost and both edges of its onset segment, purely visual
// (never the beat value actually sent on click) — otherwise a finer duration previewed inside a
// coarser gap visually crowds the neighboring note or barline. Only has room to act on segments
// wider than 2x this value; a real fix for narrow segments needs wider base spacing
// (durationSpacePx/SPACE_UNIT in VexflowRenderer.tsx) or a smaller ghost glyph.

// The stem's own interactive hit range [yMin, yMax] at a fixed x — shared by the hit-line's
// render and `computeHover`'s geometric check, so both always agree on "on the stem."
// The radius of the dot at a draggable stem's free tip; the dot is part of what grabs the stem.
const STEM_DOT_RADIUS = 0.5 * STAFF_SPACE;

function stemHitRange(h: StemHandle): {
  x: number;
  yMin: number;
  yMax: number
} {
  const dir = h.tipY >= h.baseY ? 1 : -1;
  const inset = Math.min(STEM_GRAB_INSET_PX, Math.abs(h.tipY - h.baseY) / 2);
  const hasSpan = h.hitY1 != null && h.hitY2 != null;
  const hitStartY = hasSpan ? (h.hitY1 as number) : h.baseY + dir * inset;
  const hitEndY = hasSpan ? (h.hitY2 as number) : h.tipY;
  // the dot sits on the tip: its far half lies beyond the stem and is grabbed too
  const reach = h.draggable !== false ? STEM_DOT_RADIUS : 0;
  return {
    x: h.x,
    yMin: Math.min(hitStartY, hitEndY) - (dir < 0 ? reach : 0),
    yMax: Math.max(hitStartY, hitEndY) + (dir > 0 ? reach : 0),
  };
}

export function Overlay({
  layout,
  onHoverNote,
  onInserted,
  onBeamPreview,
  slurPreview,
  onSlurPreview,
  spanPreview,
  onSpanPreview,
  onPlacementPreview,
}: {
  layout: ScoreLayout;
  /** ids of what an insert just created (the placed notes, or the placed rest) — flashed once */
  onInserted: (ids: string[]) => void;
  /** ids to lightly tint in the render SVG — a single note on note-hover, all of a measure's on
   *  barline-hover, or empty to clear. */
  onHoverNote: (noteIds: string[]) => void;
  onBeamPreview: (preview: { id: string; override: BeamOverride; anchorId: string | null } | null) => void;
  /** the slur being reshaped by a drag, until its offsets are committed */
  slurPreview: { id: string; offsets: SlurOffsets } | null;
  onSlurPreview: (preview: { id: string; offsets: SlurOffsets } | null) => void;
  /** the span whose start or end is being dragged: redrawn on the fly as if it already began or ended there */
  spanPreview: SpanPreview | null;
  onSpanPreview: (preview: SpanPreview | null) => void;
  /** the mark moved vertically by a drag of its edge, until the offset is committed */
  onPlacementPreview: (preview: { id: string; factor: number } | null) => void;
}) {
  const doc = useEditor((s) => s.document);
  const tool = useEditor((s) => s.tool);
  const currentVoice = useEditor((s) => s.currentVoice);
  const currentStaffId = useEditor((s) => s.currentStaff);
  const select = useEditor((s) => s.select);
  const selectMany = useEditor((s) => s.selectMany);
  const selectStructure = useEditor((s) => s.selectStructure);
  const selectMeasure = useEditor((s) => s.selectMeasure);
  const selectContextContent = useEditor((s) => s.selectContextContent);
  const dispatch = useEditor((s) => s.dispatch);
  const voiceColors = useEditor((s) => s.voiceColors);
  const selectedIds = useEditor((s) => s.selectedIds);
  const selectedMeasureIds = useEditor((s) => s.selectedMeasureIds);
  const selectedStructureIds = useEditor((s) => s.selectedStructureIds);
  const carrierSelectedIds = useEditor((s) => s.carrierSelectedIds);
  const locked = useEditor((s) => s.locked);
  const readOnly = useEditor((s) => s.source?.kind === 'saved');
  const previewStem = useEditor((s) => s.previewStem);
  const commitStems = useEditor((s) => s.commitStems);
  const stemOverrides = useEditor((s) => s.stemOverrides);
  const { timeBeats, playing, activeCarrierIds } = usePlayback();

  const currentVoiceId = doc.voices[currentVoice]?.id;
  const currentVoiceColor = currentVoiceId
    ? resolveVoiceColor(currentVoiceId, currentVoice, voiceColors)
    : undefined;

  // every insert — hotbar, library, constructor — is one spec (core/model/insertItems); null = the
  // select tool
  const insertTool = parseTool(tool);
  // a mark tool (dynamic, tempo, clef, key, hairpin, slur, octave line, transition) is armed the same
  // way: nothing on the score is picked while one is, and a click places it
  const markTool = parseMark(tool);
  const armed = !!insertTool || !!markTool;
  const pitchMode = useEditor((s) => s.pitchMode);
  // where a click would put a mark (a guide line on the score), and the start of a span mark whose
  // end is still to be clicked
  const [guide, setGuide] = useState<MarkGuide | null>(null);
  /** the clicks already made of a mark that takes several (a span two, a volta three); the first one anchors the guide */
  const [placed, setPlaced] = useState<MarkGuide[]>([]);
  const pending = placed[0] ?? null;
  const [paletteDragging, setPaletteDragging] = useState(false);
  const [overlapPicker, setOverlapPicker] = useState<{ x: number; y: number; targets: PickTarget[]; additive: boolean } | null>(null);
  const overlapPickerRef = useRef<HTMLDivElement>(null);
  const suppressPickClickRef = useRef(false);
  useEffect(() => {
    if (!overlapPicker) return;
    const closeOutside = (event: PointerEvent) => {
      if (!overlapPickerRef.current?.contains(event.target as Node)) setOverlapPicker(null);
    };
    document.addEventListener('pointerdown', closeOutside);
    return () => document.removeEventListener('pointerdown', closeOutside);
  }, [overlapPicker]);
  useEffect(() => {
    setOverlapPicker(null);
  }, [tool, locked, readOnly, doc]);
  useEffect(() => {
    const clear = () => {
      setPaletteDragging(false);
      setGuide(null);
    };
    window.addEventListener('dragend', clear);
    return () => window.removeEventListener('dragend', clear);
  }, []);
  useEffect(() => {
    setGuide(null);
    setPlaced([]);
  }, [tool]);
  // TODO(N staves): once a 3rd+ staff is real, clef needs to come from the document.
  const clefOf = (staffId: string) => defaultClef(doc.staffOrder, staffId);

  const svgRef = useRef<SVGSVGElement>(null);
  const activeKey = activeCarrierIds.join(',');
  useEffect(() => {
    const active = new Set(activeCarrierIds);
    const nodes = svgRef.current?.closest('.score-scale')?.querySelectorAll<SVGElement>('[data-note-id]');
    nodes?.forEach((node) => node.classList.toggle('playback-active', active.has(node.getAttribute('data-note-id') ?? '')));
    return () => {
      nodes?.forEach((node) => node.classList.remove('playback-active'));
    };
  }, [activeKey, layout]);
  type ContextEdge = 'start' | 'end';
  type ContextAnchor = { x: number; y: number; zone: StaffZone; beatX: number };
  const contextDragRef = useRef<{
    context: ScoreContext; edge: ContextEdge; anchor: ContextAnchor;
    grab: { x: number; y: number }; target: MarkGuide | null; moved: boolean; preview: SpanPreview | null;
    /** the pointer is past the end of the last measure: on release the span lasts until the end of the score */
    toEnd: boolean;
    /** a span's edge moves along one axis per drag, the first movement decides: along time it changes the span, up and down it moves the whole mark */
    axis: 'pending' | 'time' | 'height';
    offset: number; nextOffset: number; range?: { min: number; max: number };
    /** the mark's automatic distance from its staff and its side: the offset in px and the stored factor are two readings of the same move */
    reference: number; side: -1 | 1;
    /** a slur's arch height when the drag began */
    slurArch?: number;
    nodes: { node: SVGElement; translate: string }[];
  } | null>(null);
  const contextCommittingRef = useRef(false);
  const spanFrameRef = useRef<number | null>(null);
  const scheduleSpanPreview = () => {
    if (spanFrameRef.current !== null) return;
    spanFrameRef.current = requestAnimationFrame(() => {
      spanFrameRef.current = null;
      const current = contextDragRef.current;
      if (current?.preview) onSpanPreview(current.preview);
    });
  };
  const [contextPreview, setContextPreview] = useState<{ id: string; edge: ContextEdge; x: number; y: number; guide: MarkGuide } | null>(null);

  /** a slur's frame as drawn now: stored offsets repaired to a valid shape, or the ones being dragged */
  const slurFrameOf = (shape: SlurShape) => shape.frame ?? framed(shape.base, slurPreview?.id === shape.id ? slurPreview.offsets
    : fitted(shape.base, slurOffsets(doc.presentation, shape.id)));

  const engravingNodes = (id: string): SVGGraphicsElement[] =>
    [...(svgRef.current?.closest('.score-scale')?.querySelectorAll<SVGGraphicsElement>(`[data-object-id="${CSS.escape(id)}"]`) ?? [])]
      .filter((node) => !node.closest('.overlay'));

  /** where an edge of a context stands: its handle (read off the drawn node) and the anchor it applies to, at `at` when the edge is being dragged there */
  const contextAnchor = (context: ScoreContext, edge: ContextEdge, node: SVGGraphicsElement, at?: { measureId: string; beats: number }): ContextAnchor | null => {
    const end = edge === 'end' && 'endMeasureId' in context;
    const place = end ? endOfSpan(doc, context) : {
      measureId: context.measureId, position: context.position
    };
    const measureId = at?.measureId ?? place.measureId;
    const position = at ? fromBeats(at.beats) : place.position;
    const box = node.getBBox();
    const x = Number(node.getAttribute(`data-context-${edge}-x`) ?? box.x + box.width / 2);
    const y = Number(node.getAttribute(`data-context-${edge}-y`) ?? box.y + box.height / 2);
    const zones = layout.staffZones.filter((z) => z.measureId === measureId && (!('staffId' in context) || z.staffId === context.staffId));
    const zone = zones.reduce<StaffZone | null>((best, z) => !best || Math.abs(y - (z.bottomLineY - 4 * z.stepPx)) < Math.abs(y - (best.bottomLineY - 4 * best.stepPx)) ? z : best, null);
    return zone ? { x, y, zone, beatX: interp(zone.segments, 'beat', toBeats(position)) } : null;
  };

  const restoreContext = (drag: NonNullable<typeof contextDragRef.current>) => {
    drag.nodes.forEach(({ node, translate }) => {
      node.style.translate = translate;
      node.classList.remove('context-dragging');
    });
  };
  const cancelContextDrag = () => {
    const drag = contextDragRef.current;
    if (drag) restoreContext(drag);
    contextDragRef.current = null;
    setContextPreview(null);
    if (spanFrameRef.current !== null) {
      cancelAnimationFrame(spanFrameRef.current);
      spanFrameRef.current = null;
    }
    onSpanPreview(null);
    onPlacementPreview(null);
  };
  useEffect(() => {
    return () => {
      if (contextDragRef.current) restoreContext(contextDragRef.current);
    };
  }, []);
  useEffect(() => {
    cancelContextDrag();
  }, [tool, locked, readOnly, doc]);
  // a span is redrawn on the fly while dragged, so its layout changes under the drag; a point's marks are moved in place
  useEffect(() => {
    const drag = contextDragRef.current;
    if (drag && !('endMeasureId' in drag.context)) cancelContextDrag();
  }, [layout]);

  const start = useRef<{ x: number; y: number; additive: boolean } | null>(null);
  const bandRef = useRef<Band | null>(null);
  const [band, setBand] = useState<Band | null>(null);
  // insert-preview: a translucent notehead at the snapped (beat, staff_step) a click would land
  // on — cheap, client-only.
  const [ghost, setGhost] = useState<{ x: number; y: number; staffStep: number; staffId: string; zone: StaffZone; beat: number; writtenValue: { value: number; dots: number } } | null>(
    null,
  );
  const contextGuide = markTool ? guide : undefined;
  /** the measure that follows this one, `null` after the last */
  const measureIndex = (measureId: string): number => doc.measures.findIndex((measure) => measure.id === measureId);
  const measureAfter = (measureId: string): string | null => doc.measures[measureIndex(measureId) + 1]?.id ?? null;
  /** the stretch the mark being placed will act on, shown as a band */
  const range = markTool && contextGuide ? insertRange(doc, markTool, placed, contextGuide, { voiceId: doc.voices[currentVoice]?.id ?? '', measureAfter }) : null;
  /** the stretch of the span whose edge is being dragged, as it would be where the edge is now */
  const draggedSpan = spanPreview ? doc.contexts.find((context) => context.id === spanPreview.id) : undefined;
  const spanRange = draggedSpan && 'endMeasureId' in draggedSpan && spanPreview ? draggedSpanRange(doc, draggedSpan, spanPreview.edge, spanPreview.landing) : null;
  // last raw pointer position, kept so the ghost can be recomputed (not left stale) whenever the
  // document changes without the mouse moving, e.g. undo/redo.
  const lastPointerRef = useRef<{ clientX: number; clientY: number } | null>(null);
  // A drag preserves the initial tip-to-pointer offset. Shared stems retain their direction
  // between the outer noteheads; the length reference follows a direction flip.
  // Pointer capture keeps the drag alive outside the thin stem. Click timing handles reset/flip.
  const stemDragRef = useRef<{
    noteId: string;
    staffId: string;
    topNoteY?: number;
    bottomNoteY?: number;
    direction: 1 | -1;
    clientY: number;
    startY: number;
    /** the tip's y at grab time — the drag moves it by the pointer's DELTA from `startY`, so
     *  grabbing mid-stem doesn't snap the tip to the cursor on the first frame. */
    tipY: number;
    tipInset: number;
    /** the chord's own notehead-to-notehead span, read from what VexFlow is CURRENTLY rendering
     *  (`|tipY - baseY| - VEXFLOW_STEM_HEIGHT`), not from `layout.noteBoxes` (those are padded
     *  for click hit-testing and overestimate the span). 0 for a single note. */
    chordSpan: number;
    automaticLength: number;
    /** the automatic length beyond the noteheads: what the saved factor multiplies */
    naturalLength: number;
    staffSpace: number;
    moved: boolean;
  } | null>(null);
  const lastStemClickRef = useRef<{ noteId: string; time: number } | null>(null);
  const DOUBLE_CLICK_MS = 400;
  // The standard double-click rule, timed by hand like the stem's (see above): a second click on the
  // same element within `DOUBLE_CLICK_MS` selects everything that belongs to it — a note's chord, a
  // relation's members, what a context is applied to, a measure's content. One timer for all of them.
  const lastClickRef = useRef<{ key: string; time: number } | null>(null);
  const isDoubleClick = (key: string): boolean => {
    const now = Date.now();
    const last = lastClickRef.current;
    const second = last !== null && last.key === key && now - last.time < DOUBLE_CLICK_MS;
    lastClickRef.current = second ? null : { key, time: now };
    return second;
  };
  const lastBackgroundClickRef = useRef<{ measureId: string; staffId: string; x: number; y: number; time: number; count: number } | null>(null);
  // Suppresses the ONE native `click` that follows a stem-handle release. `click` is a legacy
  // MouseEvent that `setPointerCapture` does NOT redirect, so a drag ending over a different
  // element's hit-rect (easy for a cross-staff stem) fires THAT element's click right after,
  // silently collapsing the selection just made. Set on stem pointerup, consumed by the very
  // next `onClick` anywhere.
  const suppressNextClickRef = useRef(false);
  // One `previewStem` per animation frame, not per raw pointermove — every override fully
  // rebuilds the VexFlow SVG, and a mouse fires far more move events than the browser paints.
  const stemDragFrameRef = useRef<number | null>(null);
  const stemDragLayoutRef = useRef(layout);
  stemDragLayoutRef.current = layout;
  useEffect(() => {
    return () => {
      if (stemDragFrameRef.current !== null) cancelAnimationFrame(stemDragFrameRef.current);
    };
  }, []);

  // WebKit/Safari's `getScreenCTM()` ignores an ancestor CSS `transform: scale()` (confirmed via
  // direct inspection; Chromium is correct) — deriving scale from `getBoundingClientRect()`
  // instead is immune to this regardless of engine.
  const toSvg = (e: { clientX: number; clientY: number }) => {
    const svg = svgRef.current!;
    const rect = svg.getBoundingClientRect();
    const scaleX = rect.width / layout.width;
    const scaleY = rect.height / layout.height;
    return {
      x: (e.clientX - rect.left) / scaleX,
      y: (e.clientY - rect.top) / scaleY,
    };
  };

  // Picks the target staff zone under a point and snaps it to (beat, staff_step) — shared by the
  // actual insert (click) and the hover ghost, so the preview always matches where a click lands.
  // Edit is bound to the CURRENT staff only (never inferred from geometry) — that's what lets you
  // write off-staff with ledger lines instead of a click snapping to the nearest staff; a
  // cross-staff chord is built by switching the staff chip and clicking the same beat again.
  const resolveInsertTarget = (x: number, y: number) => {
    if (!insertTool || !currentStaffId) return null;
    // the staff row (one staff of one system — page mode stacks several) nearest the pointer
    // vertically, then that row's zone under x: zones cover only note areas, so over a header
    // there is none — x alone would pick another system's measure at the same column instead.
    const middle = (zz: StaffZone) => zz.bottomLineY - 4 * zz.stepPx;
    const nearest = layout.staffZones.reduce<StaffZone | null>(
      (best, z) => (!best || Math.abs(y - middle(z)) < Math.abs(y - middle(best)) ? z : best),
      null,
    );
    if (!nearest || nearest.staffId !== currentStaffId) return null;
    const zone = layout.staffZones.find((z) => z.bottomLineY === nearest.bottomLineY && x >= z.x0 && x <= z.x1);
    if (!zone) return null;

    const currentVoiceId = doc.voices[currentVoice]?.id;
    if (!currentVoiceId) return null;
    if (insertTool.kind === 'grace') {
      // a grace note snaps to the nearest place beside a carrier of the current voice in this measure; its
      // staff step is the pointer's, as for any note
      let slot: GraceSlot | null = null;
      for (const candidate of layout.graceSlots) {
        if (candidate.measureId !== zone.measureId || candidate.voiceId !== currentVoiceId) continue;
        if (!slot || Math.abs(x - (candidate.x + candidate.w / 2)) < Math.abs(x - (slot.x + slot.w / 2))) slot = candidate;
      }
      if (!slot) return null;
      const graceRange = STAFF_STEP_RANGE[clefOf(zone.staffId)];
      const graceStep = Math.min(Math.max(Math.round((zone.bottomLineY - y) / zone.stepPx), graceRange.min), graceRange.max);
      return {
        zone, position: { numerator: 0, denominator: 1 }, beat: 0, staffStep: graceStep, snappedX: slot.x,
        snappedY: zone.bottomLineY - graceStep * zone.stepPx,
        writtenValue: { value: VALUE_DENOMINATOR[insertTool.value], dots: 0 }, slot,
      };
    }
    const rawBeat = staffInsertionBeat(zone, x);
    if (rawBeat === null) return null;
    const resolved = insertionPosition(doc, zone.measureId, currentVoiceId, rawBeat);
    if (!resolved) return null;
    const snappedBeat = resolved.beat;
    // off-staff positions get ledger lines; clamp to the temporary pitch ceiling.
    const range = STAFF_STEP_RANGE[clefOf(zone.staffId)];
    const rawStep = Math.round((zone.bottomLineY - y) / zone.stepPx);
    const staffStep = Math.min(Math.max(rawStep, range.min), range.max);
    const snappedX = staffInsertionX(zone, snappedBeat);
    // a rest has no pitch: its ghost anchors on the staff's bottom line (see `getGhostGlyphMarkup`)
    const snappedY = insertTool.kind === 'rest' || insertTool.tuplet?.first === 'rest' ? zone.bottomLineY : zone.bottomLineY - staffStep * zone.stepPx;

    const writtenValue = { value: VALUE_DENOMINATOR[insertTool.value], dots: insertTool.dots };
    return { zone, position: resolved.position, beat: snappedBeat, staffStep, snappedX, snappedY, writtenValue, slot: null };
  };

  /** the point of the score under the pointer, snapped to an existing onset or measure start: the staff row nearest
   *  vertically, then the measure under x on it */
  const pointOnScore = (x: number, y: number, forSpan: boolean, staffId?: string): MarkGuide | null => {
    const middle = (zz: StaffZone) => zz.bottomLineY - 4 * zz.stepPx;
    const nearest = layout.staffZones.filter((z) => !staffId || z.staffId === staffId).reduce<StaffZone | null>(
      (best, z) => (!best || Math.abs(y - middle(z)) < Math.abs(y - middle(best)) ? z : best),
      null,
    );
    if (!nearest) return null;
    const zone = layout.staffZones.find((z) => z.bottomLineY === nearest.bottomLineY && x >= z.x0 && x <= z.x1);
    if (!zone) return null;
    const raw = staffInsertionBeat(zone, x);
    const voiceId = doc.voices[currentVoice]?.id;
    if (raw === null || !voiceId) return null;
    const resolved = insertionPosition(doc, zone.measureId, voiceId, raw);
    if (!resolved) return null;
    const beats = resolved.beat;
    const snappedX = interp(zone.segments, 'beat', beats);
    // the end of a span (a slur ends on a note, so not it), pointed nearer the barline after the measure than the place it snaps to, ends on that barline: a rest or a last
    // note is not the only place a span can stop, and a bar of one rest has no other
    const nextId = measureAfter(zone.measureId);
    if (forSpan && markTool?.kind !== 'slur' && nextId && x - snappedX > zone.x1 - x) {
      return {
        measureId: nextId, beats: 0, staffId: zone.staffId, x: zone.x1,
        top: zone.bottomLineY - 8 * zone.stepPx, bottom: zone.bottomLineY, zone, pointerX: x, pointerY: y,
      };
    }
    return {
      measureId: zone.measureId,
      beats,
      staffId: zone.staffId,
      x: snappedX,
      top: zone.bottomLineY - 8 * zone.stepPx,
      bottom: zone.bottomLineY,
      zone, pointerX: x, pointerY: y,
      late: x > (zone.x0 + zone.x1) / 2,
    };
  };

  const openingContext = (context: ScoreContext) => context.measureId === doc.measures[0]?.id
    && toBeats(context.position) === 0 && ['clef', 'keySignature', 'tempo', 'dynamic'].includes(context.kind);

  const onDownContext = (event: Pick<React.PointerEvent, 'stopPropagation' | 'button' | 'shiftKey' | 'clientX' | 'clientY' | 'pointerId'>, id: string, edge: ContextEdge, shapeIndex = 0, axis: 'pending' | 'time' = 'pending') => {
    event.stopPropagation();
    if (armed || locked || event.button !== 0 || contextCommittingRef.current) return;
    const context = doc.contexts.find((c) => c.id === id);
    if (!context) return;
    if (readOnly) {
      if (isDoubleClick(`context:${id}`)) void selectContextContent(id, event.shiftKey);
      else selectStructure(id, event.shiftKey);
      return;
    }
    if (isDoubleClick(`context:${id}`)) {
      void selectContextContent(id, event.shiftKey);
      return;
    }
    useEditor.setState({ auditionSuppressed: true });
    selectStructure(id, event.shiftKey);
    useEditor.setState({ auditionSuppressed: false });

    const nodes = engravingNodes(id);
    const node = nodes[shapeIndex] ?? nodes[0];
    if (!node) return;
    const anchor = contextAnchor(context, edge, node);
    if (!anchor) return;
    const contextShape = layout.contextShapes.find((shape) => shape.id === id);
    const range = contextShape?.offset;
    const reference = contextShape?.reference ?? 1;
    const side = contextShape?.side ?? 1;
    if (edge === 'start' && openingContext(context) && !range) return;
    contextDragRef.current = {
      context, edge, anchor, grab: toSvg(event), target: null, moved: false, preview: null, toEnd: false,
      axis: 'endMeasureId' in context && range ? axis : 'time',
      offset: side * (bodyFactor(doc.presentation, id) - 1) * reference, nextOffset: side * (bodyFactor(doc.presentation, id) - 1) * reference,
      range, reference, side, slurArch: slurArchOf(id),
      nodes: nodes.map((n) => ({ node: n, translate: n.style.translate })),
    };
    start.current = null;
    setBand(null);
    onHoverNote([]);
    svgRef.current?.setPointerCapture(event.pointerId);
  };

  /** the height of a slur's arch as it rests now (while its edge is dragged the layout draws it to the pointer) */
  const slurArchOf = (id: string): number | undefined => {
    const shape = layout.slurShapes.find((slur) => slur.id === id);
    return shape && Math.abs(shape.base.c1.y - shape.base.p0.y);
  };
  /** Moving an edge of a slur must not change the height of its arch, whose automatic size follows its length: the factor that gives the
   *  height it has now at the length it will have is sent with the move and stored in the same step. Nothing for a slur that is not
   *  drawn whole now or will not be drawn whole after the move. */
  const frozenSlurHeight = (context: ScoreContext, edge: ContextEdge, target: { measureId: string; beats: number }, arch = slurArchOf(context.id)): PresentationChange[] => {
    const shape = layout.slurShapes.find((slur) => slur.id === context.id);
    if (!shape || context.kind !== 'slur' || arch === undefined) return [];
    const voiceId = context.voiceIds[0];
    const first = edge === 'start' ? target : { measureId: context.measureId, beats: toBeats(context.position) };
    const endPlace = endOfSpan(doc, context);
    const last = edge === 'end' ? target : { measureId: endPlace.measureId, beats: toBeats(endPlace.position) };
    const from = doc.measures.findIndex((m) => m.id === first.measureId);
    const to = doc.measures.findIndex((m) => m.id === last.measureId);
    const zoneOf = (index: number) => layout.staffZones.find((z) => z.measureId === doc.measures[index]?.id && z.staffId === doc.staffOrder[0]);
    // a slur that would cross to another system is not drawn whole: there is no one length to keep the height at
    if (!voiceId || from < 0 || to < from || zoneOf(from)?.bottomLineY !== zoneOf(to)?.bottomLineY) return [];
    // it is drawn from its first covered note to its last, wherever the notes stand
    let left: number | null = null;
    let right: number | null = null;
    for (let i = from; i <= to; i += 1) {
      const zone = zoneOf(i);
      doc.measures[i].voices.find((v) => v.id === voiceId)?.items.forEach((item) => {
        if (item.kind === 'rest' || !zone) return;
        if (i === from && item.position < first.beats - 1e-6) return;
        if (i === to && item.position > last.beats + 1e-6) return;
        const x = staffOnsetX(zone, item.position);
        left ??= x;
        right = x;
      });
    }
    if (left === null || right === null || right - left < shape.staffSpace) return [];
    return [{ kind: 'vertical', target: { entity_id: context.id, reference: 'height' }, offset: arch / automaticArch(right - left, shape.staffSpace) }];
  };

  /** the factor of its automatic distance a dragged mark now stands at (above zero, as the server requires) */
  const contextFactor = (drag: { nextOffset: number; reference: number; side: -1 | 1 }): number =>
    Math.max(Number.EPSILON, 1 + drag.side * drag.nextOffset / drag.reference);

  const commitContextDrag = () => {
    const drag = contextDragRef.current;
    if (!drag) return;
    contextDragRef.current = null;
    setContextPreview(null);
    if (spanFrameRef.current !== null) {
      cancelAnimationFrame(spanFrameRef.current);
      spanFrameRef.current = null;
    }
    if (drag.toEnd && 'endMeasureId' in drag.context) {
      restoreContext(drag);
      if (drag.context.endMeasureId === null) {
        onSpanPreview(null);
        return;
      }
      contextCommittingRef.current = true;
      void dispatch({ type: 'openContextEnd', contextId: drag.context.id, mode: pitchMode })
        .finally(() => {
          onSpanPreview(null);
          contextCommittingRef.current = false;
        });
      return;
    }
    if (drag.axis === 'height') {
      restoreContext(drag);
      const factor: number = contextFactor(drag);
      if (!drag.moved || factor === bodyFactor(doc.presentation, drag.context.id)) {
        onPlacementPreview(null);
        return;
      }
      contextCommittingRef.current = true;
      void dispatch({ type: 'editPresentation', changes: [
        { kind: 'vertical', target: { entity_id: drag.context.id, reference: 'body' }, offset: factor === 1 ? null : factor },
      ] }).finally(() => {
        onPlacementPreview(null);
        contextCommittingRef.current = false;
      });
      return;
    }
    const target = drag.target;
    if (!drag.moved || !target) {
      restoreContext(drag);
      onSpanPreview(null);
      return;
    }
    const context = drag.context;
    const oldEnd = drag.edge === 'end' && 'endMeasureId' in context;
    const place = oldEnd ? endOfSpan(doc, context) : {
      measureId: context.measureId, position: context.position
    };
    const measureId = place.measureId;
    const position = place.position;
    const movedInTime = measureId !== target.measureId || Math.abs(toBeats(position) - target.beats) > 1e-6;
    if (!movedInTime) {
      if (drag.range && !('endMeasureId' in drag.context)) useEditor.getState().setContextFactor(drag.context.id, contextFactor(drag));
      restoreContext(drag);
      onSpanPreview(null);
      return;
    }
    contextCommittingRef.current = true;
    void dispatch({ type: drag.edge === 'end' ? 'moveContextEnd' : 'moveContextStart', contextId: drag.context.id,
      measureId: target.measureId, position: fromBeats(target.beats), mode: pitchMode, presentation: frozenSlurHeight(drag.context, drag.edge, target, drag.slurArch) }).then(() => {
        if (!useEditor.getState().error && drag.range && !('endMeasureId' in drag.context))
          useEditor.getState().setContextFactor(drag.context.id, contextFactor(drag));
      }).finally(() => {
        restoreContext(drag);
        onSpanPreview(null);
        contextCommittingRef.current = false;
      });
  };

  const moveHandleByKey = (event: React.KeyboardEvent, context: ScoreContext, edge: ContextEdge) => {
    if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    if (locked || readOnly || contextCommittingRef.current || edge === 'start' && openingContext(context)) return;
    const end = edge === 'end' && 'endMeasureId' in context;
    const place = end ? endOfSpan(doc, context) : {
      measureId: context.measureId, position: context.position
    };
    let mi = doc.measures.findIndex((m) => m.id === place.measureId);
    let beats = toBeats(place.position) + (event.key === 'ArrowLeft' ? -1 : 1) * (event.shiftKey ? 1 : 0.25);
    while (mi > 0 && beats < 0) {
      mi--;
      beats += lengthOfMeasure(doc.measures[mi].timeSignature);
    }
    while (mi < doc.measures.length - 1 && beats > lengthOfMeasure(doc.measures[mi].timeSignature)) {
      beats -= lengthOfMeasure(doc.measures[mi].timeSignature);
      mi++;
    }
    if (beats < 0 || beats > lengthOfMeasure(doc.measures[mi].timeSignature)) return;
    void dispatch({ type: edge === 'end' ? 'moveContextEnd' : 'moveContextStart', contextId: context.id,
      measureId: doc.measures[mi].id, position: fromBeats(beats), mode: pitchMode,
      presentation: frozenSlurHeight(context, edge, { measureId: doc.measures[mi].id, beats }) });
  };

  /** a click while a mark tool is armed: a point mark is placed; a span mark takes its start on the
   *  first click and its end on the second */
  const placeMark = (x: number, y: number, spec = markTool) => {
    const at = pointOnScore(x, y, !!pending);
    const voiceId = doc.voices[currentVoice]?.id;
    if (!at || !spec || !voiceId) return;
    const index = new ContextIndex(doc);
    const env = {
      voiceId,
      mode: pitchMode,
      bpmAtStart: null as number | null,
      measureAfter,
      measureIndex,
    };
    // a hairpin or a slur belongs to a voice and is drawn on the staff that voice sounds on: in a voice with no notes there is none, so it is refused
    if ((spec.kind === 'hairpin' || spec.kind === 'slur') && !index.voiceSounds(voiceId)) {
      setPlaced([]);
      useEditor.setState({ error: `Voice ${currentVoice + 1} has no notes yet, so a ${spec.kind} on it would not show.` });
      return;
    }
    if (!isSpanMark(spec)) {
      const command = pointCommand(spec, at, env);
      if (command) void dispatch(command);
      return;
    }
    const inOrder = (p: MarkGuide, q: MarkGuide): [MarkGuide, MarkGuide] => (index.order(p.measureId, p.beats) <= index.order(q.measureId, q.beats) ? [p, q] : [q, p]);
    if (placed.length + 1 < markClicks(spec)) {
      // not the last click yet: the first anchors the mark; the second of a volta closes its body, the two kept in order
      setPlaced(placed.length === 0 ? [at] : inOrder(placed[0], at));
      return;
    }
    // a volta: the body from the first two clicks, where its first ending ends from the third; a refused third click leaves the stages as they are
    const [a, b] = spec.kind === 'volta' ? [placed[0], placed[1]] : inOrder(placed[0], at);
    const third = spec.kind === 'volta' ? at : null;
    if (spec.kind !== 'volta') {
      setPlaced([]);
      if (index.order(a.measureId, a.beats) === index.order(b.measureId, b.beats)) return;
    }
    env.bpmAtStart = index.tempoAt(a.measureId, a.beats)?.bpm ?? null;
    const command = spanCommand(spec, a, b, env, third);
    if (command) {
      setPlaced([]);
      void dispatch(command);
    }
  };

  const onPaletteDragOver = (event: React.DragEvent<SVGSVGElement>) => {
    if (locked || readOnly || !parseMark(useEditor.getState().tool) || !event.dataTransfer.types.includes(INSERT_DRAG_TYPE)) return;
    const point = toSvg(event);
    const target = pointOnScore(point.x, point.y, !!pending);
    setGuide(target);
    setPaletteDragging(true);
    if (!target) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    lastPointerRef.current = { clientX: event.clientX, clientY: event.clientY };
  };

  const onPaletteDrop = (event: React.DragEvent<SVGSVGElement>) => {
    const spec = parseMark(event.dataTransfer.getData(INSERT_DRAG_TYPE));
    if (locked || readOnly || !spec) return;
    event.preventDefault();
    event.stopPropagation();
    const point = toSvg(event);
    const target = pointOnScore(point.x, point.y, false);
    setPaletteDragging(false);
    setGuide(null);
    if (!target) return;
    if (isSpanMark(spec)) setPlaced(target ? [target] : []);
    else placeMark(point.x, point.y, spec);
  };

  const placeAt = (x: number, y: number) => (markTool ? placeMark(x, y) : insertAt(x, y));

  const insertAt = (x: number, y: number) => {
    const voiceId = doc.voices[currentVoice]?.id;
    if (!voiceId) return;
    if (insertTool?.kind === 'timesig' && insertTool.timeSignature) {
      // a time-signature item sets the clicked measure's metre — a measure spans every staff, so
      // any staff row counts (not just the locked one an insert targets)
      const row = layout.staffZones.reduce<StaffZone | null>(
        (best, z) => (!best || Math.abs(y - (z.bottomLineY - 4 * z.stepPx)) < Math.abs(y - (best.bottomLineY - 4 * best.stepPx)) ? z : best),
        null,
      );
      const measureZone = row && layout.staffZones.find((z) => z.bottomLineY === row.bottomLineY && x >= z.x0 && x <= z.x1);
      if (!measureZone) return;
      const { beats, beatValue, dots } = insertTool.timeSignature;
      void dispatch({ type: 'changeTimeSignature', measureIds: [measureZone.measureId], beats, beatValue, dots });
      return;
    }
    const target = resolveInsertTarget(x, y);
    if (!target || !insertTool) return;
    const { zone, position, staffStep } = target;
    const placement = {
      measureId: zone.measureId,
      staffId: zone.staffId,
      voiceId,
      position,
      writtenValue: target.writtenValue,
    };
    const spec = insertTool;

    // what the insert creates, found by diffing the document around the round trip: the new
    // entities of the placed kind (not the rests the backend fills around them)
    const before = entityKinds(doc);
    const placedKind = spec.kind === 'rest' || spec.tuplet?.first === 'rest' ? 'rest' : 'note';
    const createdIds = () =>
      [...entityKinds(useEditor.getState().document)]
        .filter(([id, kind]) => kind === placedKind && !before.has(id))
        .map(([id]) => id);
    const flashCreated = () => {
      const created = createdIds();
      if (created.length) {
        onInserted(created);
      }
    };

    if (spec.kind === 'grace' && spec.grace && target.slot) {
      // beside a carrier: a note into the grace carrier under the pointer, else a new grace carrier after the one
      // the place names; a group that exists keeps its kind
      const { slot } = target;
      const accidental = backendAccidental(spec.accidental);
      if (slot.joinId) {
        void dispatch({ type: 'addGraceCarrierNote', carrierId: slot.joinId, staffId: zone.staffId, staffStep, accidental }).then(flashCreated);
      } else {
        void dispatch({
          type: 'addGraceNote',
          hostCarrierId: slot.hostId,
          placement: slot.side,
          graceKind: slot.kind ?? (spec.grace.slash ? 'acciaccatura' : 'appoggiatura'),
          writtenValue: target.writtenValue,
          staffId: zone.staffId,
          staffStep,
          accidental,
          afterCarrierId: slot.afterId,
        }).then(flashCreated);
      }
    } else if (spec.kind === 'rest') {
      void dispatch({ type: 'insertRest', ...placement }).then(flashCreated);
    } else if (spec.kind === 'tuplet' && spec.tuplet) {
      // n of the value in the time of m of it; the first element a note at the click, or a rest
      const unit = { value: VALUE_DENOMINATOR[spec.value], dots: 0 };
      void dispatch({
        type: 'createTuplet',
        ...placement,
        writtenSize: spec.tuplet.written ?? { value: unit, count: spec.tuplet.n },
        occupiedSize: spec.tuplet.occupied ?? { value: unit, count: spec.tuplet.m },
        note: spec.tuplet.first === 'rest' ? null : { staffStep, accidental: backendAccidental(spec.accidental), fingering: spec.fingering ?? 0 },
      }).then(flashCreated);
    } else {
      const accidental = backendAccidental(spec.accidental);
      void dispatch({ type: 'insertNote', ...placement, staffStep, accidental, fingering: spec.fingering ?? 0 }).then(async () => {
        // a constructor composite with an articulation: the backend has no composite intent yet,
        // so the articulation is a second command on what the first one created (two undo steps).
        // Only if the insert really created a note — `dispatch` reports failures via the toast.
        const created = createdIds();
        if (spec.articulations.length && created.length) {
          const doc = useEditor.getState().document;
          // an insert across a barline splits into tied notes: the articulation goes on the first
          await dispatch({ type: 'setArticulation', carrierId: carrierIdOf(doc, created[0]), articulations: spec.articulations });
        }
        flashCreated();
      });
    }
  };

  // the insert-ghost glyph for the current tool at a staff position, or null for a non-insert tool
  const ghostMarkup = (staffStep: number, staffId: string): string | null => {
    if (!insertTool) return null;
    if (insertTool.kind === 'timesig') return null;
    if (insertTool.kind === 'grace' && insertTool.grace) return getGraceGhostMarkup(insertTool.value, staffStep, clefOf(staffId), insertTool.grace.slash);
    const restGhost = insertTool.kind === 'rest' || insertTool.tuplet?.first === 'rest';
    const written = ghost?.writtenValue;
    const duration = written ? (Object.keys(VALUE_DENOMINATOR) as DurationValue[]).find((value) => VALUE_DENOMINATOR[value] === written.value) ?? insertTool.value : insertTool.value;
    return getGhostGlyphMarkup(duration, staffStep, clefOf(staffId), restGhost, written?.dots ?? insertTool.dots);
  };

  // double-click -> whole voice in the measure (across every staff it touches, since voice is
  // the real axis); Alt-click -> whole staff in the measure (every voice, notes on this staff).
  const groupFromNote = (noteId: string, kind: 'voice' | 'staff', additive: boolean) => {
    const loc = locate(doc, noteId);
    if (!loc) return;
    const ids =
      kind === 'voice'
        ? voiceNoteIds(doc, loc.measureId, loc.voiceId)
        : staffNoteIds(doc, loc.measureId, loc.staffId);
    const group = contentSelection(doc, ids);
    selectMany(group.noteIds, additive, group.carrierIds, group.structureIds);
  };

  // The stem whose narrow interaction column + y-range contains (x, y), or null — the single
  // source of truth for both hover and click/drag stem priority (see the vault note for why this
  // is geometric rather than native onPointerEnter/onClick on the hit-line).
  const stemAtPoint = (x: number, y: number): StemHandle | null => {
    for (const h of layout.stemHandles) {
      const r = stemHitRange(h);
      const flag = h.flag;
      const onFlag = !!flag && x >= flag.x + flag.dx && x <= flag.x + flag.dx + flag.width && y >= flag.y + flag.dy && y <= flag.y + flag.dy + flag.height;
      if (onFlag || (Math.abs(x - r.x) <= STEM_INTERACT_X_TOLERANCE && y >= r.yMin && y <= r.yMax)) return h;
    }
    return null;
  };

  const onDownBg = (e: React.PointerEvent) => {
    if (locked || e.button !== 0) return;
    const { x, y } = toSvg(e);
    bandRef.current = null;
    start.current = { x, y, additive: e.shiftKey };
    if (!armed) {
      setBand({ x, y, w: 0, h: 0 });
      // marquee only in select mode
      try {
        svgRef.current?.setPointerCapture(e.pointerId);
      } catch {
        /* capture optional */
      }
    }
  };

  // Stem grab, handled geometrically at the svg root via `stemAtPoint` (see its own comment) —
  // returns without effect when not on a stem, so note clicks and the marquee are untouched.
  const cancelStemDrag = () => {
    if (!stemDragRef.current) return;
    if (stemDragFrameRef.current !== null) cancelAnimationFrame(stemDragFrameRef.current);
    stemDragFrameRef.current = null;
    stemDragRef.current = null;
    useEditor.setState({ auditionSuppressed: false, stemOverrides: useEditor.getState().document.stemOverrides });
  };
  useEffect(() => {
    return () => cancelStemDrag();
  }, []);
  useEffect(() => {
    cancelStemDrag();
  }, [tool, locked, readOnly]);

  const updateStemDrag = () => {
    const drag = stemDragRef.current;
    const svg = svgRef.current;
    if (!drag || !drag.moved || !svg) return;
    const currentLayout = stemDragLayoutRef.current;
    const handle = currentLayout.stemHandles.find((h) => h.noteId === drag.noteId && h.staffId === drag.staffId);
    if (!handle) return;
    const rect = svg.getBoundingClientRect();
    const y = (drag.clientY - rect.top) / (rect.height / currentLayout.height);
    const rawTip = drag.tipY + y - drag.startY;
    const tip = Math.min(Math.max(rawTip, STEM_CANVAS_MARGIN), currentLayout.height - STEM_CANVAS_MARGIN);
    const top = handle.topNoteY ?? drag.topNoteY;
    const bottom = handle.bottomNoteY ?? drag.bottomNoteY;
    let direction = drag.direction;
    let baseY = handle.baseY;
    if (top !== undefined && bottom !== undefined) {
      if (direction === -1 && tip < top) direction = 1;
      else if (direction === 1 && tip > bottom) direction = -1;
      // Native stems start at the opposite outer note; shared stems measure their protrusion.
      const baseOffset = handle.direction === 1 ? handle.baseY - top : bottom - handle.baseY;
      baseY = direction === 1 ? top + baseOffset : bottom - baseOffset;
    } else {
      direction = tip < baseY ? 1 : -1;
    }
    drag.direction = direction;
    const minLength = drag.chordSpan + MIN_STEM_LENGTH;
    const visibleLength = Math.max((baseY - tip) * direction, minLength);
    const expectedTip = baseY - direction * visibleLength;
    // SVG bounds are rounded; ignore subpixel noise to avoid a layout/preview feedback loop.
    if (handle.direction === direction && Math.abs(handle.tipY - expectedTip) < 0.05) return;
    const length = visibleLength + drag.tipInset;
    previewStem(drag.noteId, {
      direction,
      lengthFactor: (length - drag.chordSpan) / drag.naturalLength,
    });
  };

  // A flip can change staff headroom. Reconcile against that layout even if the pointer stopped.
  useLayoutEffect(() => {
    updateStemDrag();
  }, [layout]);

  const onDownStem = (e: React.PointerEvent) => {
    if (locked) return;
    if (armed || contextDragRef.current || (e.target as Element).closest('.context-hit, .context-endpoint, .beam-handles, .slur-handles')) return;
    const pickedNote = (e.target as Element).closest<SVGElement>('[data-pick-kind="note"]');
    if (pickedNote && selectedIds.includes(pickedNote.dataset.pickId ?? '') && pickTargetsAt(e).some((target) => target.kind === 'note' && target.id === pickedNote.dataset.pickId)) return;
    const pickedStructure = (e.target as Element).closest<SVGElement>('[data-pick-kind="beam"], [data-pick-kind="tuplet"]');
    if (pickedStructure && selectedStructureIds.includes(pickedStructure.dataset.pickId ?? '')) return;
    const p = toSvg(e);
    const h = stemAtPoint(p.x, p.y);
    if (!h) return;
    // the press is the stem's: left standing, the background press it also made would pick the measure when the pointer is released
    start.current = null;
    bandRef.current = null;
    setBand(null);
    if (readOnly) {
      selectMany(chordNoteIds(doc, h.noteId), e.shiftKey, [h.noteId]);
      return;
    }
    // the shared stem selects the WHOLE chord, at carrier granularity (so a single-note carrier
    // still gets stem context — `carrierSelectedIds`).
    if (h.draggable !== false) useEditor.setState({ auditionSuppressed: true });
    selectMany(chordNoteIds(doc, h.noteId), e.shiftKey, [h.noteId]);
    if (h.draggable === false) return;
    const naturalLength = h.naturalLength ?? VEXFLOW_STEM_HEIGHT;
    const chordSpan = Math.max(0, (h.automaticLength ?? Math.abs(h.tipY - h.baseY)) - naturalLength);
    stemDragRef.current = {
      noteId: h.noteId,
      staffId: h.staffId,
      topNoteY: h.topNoteY,
      bottomNoteY: h.bottomNoteY,
      direction: h.direction,
      clientY: e.clientY,
      startY: p.y,
      tipY: h.tipY,
      tipInset: h.tipInset ?? 0,
      chordSpan,
      automaticLength: h.automaticLength ?? naturalLength + chordSpan,
      naturalLength,
      staffSpace: h.staffSpace ?? 10,
      moved: false,
    };
    try {
      svgRef.current?.setPointerCapture(e.pointerId);
    } catch {
      /* capture optional */
    }
  };

  const beamDragRef = useRef<{
    shape: BeamShape; side: 'left' | 'center' | 'right'; startClientY: number; scale: number;
    initial: BeamOverride; current: BeamOverride; anchorId: string | null; moved: boolean;
  } | null>(null);
  const beamDragFrameRef = useRef<number | null>(null);
  const beamCommitTokenRef = useRef(0);
  const cancelBeamDrag = () => {
    beamCommitTokenRef.current++;
    beamDragRef.current = null;
    if (beamDragFrameRef.current !== null) {
      cancelAnimationFrame(beamDragFrameRef.current);
      beamDragFrameRef.current = null;
    }
    onBeamPreview(null);
  };
  useEffect(() => {
    return () => cancelBeamDrag();
  }, []);
  useEffect(() => {
    if (beamDragRef.current) cancelBeamDrag();
  }, [doc, locked, readOnly, tool]);
  const onDownBeamHandle = (event: React.PointerEvent, shape: BeamShape, side: 'left' | 'center' | 'right') => {
    event.stopPropagation();
    event.preventDefault();
    if (locked || readOnly || armed || event.button !== 0 || !shape.handles) return;
    onHoverNote([]);
    const beam = doc.beams.find((b) => b.id === shape.id);
    if (!beam) return;
    const initial = beam.override ?? { leftFactor: 1, rightFactor: 1 };
    const rect = svgRef.current?.getBoundingClientRect();
    const scale = rect && layout.height ? rect.height / layout.height : 1;
    const beamMidX = (shape.handles.x0 + shape.handles.x1) / 2;
    const beamMidY = (shape.handles.y0 + shape.handles.y1) / 2;
    const anchor = layout.noteBoxes.filter((box) => beam.carrierIds.includes(box.carrierId))
      .sort((a, b) => Math.hypot(a.x - beamMidX, a.y - beamMidY) - Math.hypot(b.x - beamMidX, b.y - beamMidY))[0];
    beamCommitTokenRef.current++;
    beamDragRef.current = { shape, side, startClientY: event.clientY, scale, initial, current: initial, anchorId: anchor?.id ?? null, moved: false };
    svgRef.current?.setPointerCapture(event.pointerId);
  };

  // A slur's six handles. A top corner also moves the end in time: the first movement decides — mostly
  // vertical reshapes the slur, mostly sideways hands the gesture over to the context-end drag.
  const slurDragRef = useRef<{
    shape: SlurShape; handle: SlurHandle; grab: Point; stored: SlurOffsets; from: SlurOffsets; current: SlurOffsets;
    pending: { clientX: number; clientY: number; shiftKey: boolean; pointerId: number } | null;
  } | null>(null);
  const slurDragFrameRef = useRef<number | null>(null);
  const slurCommitTokenRef = useRef(0);
  const cancelSlurDrag = () => {
    slurCommitTokenRef.current++;
    slurDragRef.current = null;
    if (slurDragFrameRef.current !== null) {
      cancelAnimationFrame(slurDragFrameRef.current);
      slurDragFrameRef.current = null;
    }
    onSlurPreview(null);
  };
  useEffect(() => {
    return () => cancelSlurDrag();
  }, []);
  useEffect(() => {
    if (slurDragRef.current) cancelSlurDrag();
  }, [doc, locked, readOnly, tool]);
  const onDownSlurHandle = (event: React.PointerEvent, shape: SlurShape, handle: SlurHandle) => {
    event.stopPropagation();
    event.preventDefault();
    if (locked || readOnly || armed || event.button !== 0) return;
    onHoverNote([]);
    const stored: SlurOffsets = slurOffsets(doc.presentation, shape.id);
    const from: SlurOffsets = fitted(shape.base, stored);
    const corner: boolean = handle === 'topLeft' || handle === 'topRight';
    slurCommitTokenRef.current++;
    slurDragRef.current = {
      shape, handle, grab: toSvg(event), stored, from, current: from,
      pending: corner ? { clientX: event.clientX, clientY: event.clientY, shiftKey: event.shiftKey, pointerId: event.pointerId } : null,
    };
    svgRef.current?.setPointerCapture(event.pointerId);
  };
  const onNotehead = (id: string, point: { x: number; y: number }): boolean => {
    const head = svgRef.current?.closest('.score-scale')?.querySelector<SVGGraphicsElement>(`[data-individual-note-id="${CSS.escape(id)}"]`);
    if (!head) return false;
    const box = inkBox(head);
    return point.x >= box.x && point.x <= box.x + box.width && point.y >= box.y && point.y <= box.y + box.height;
  };
  const pickTargetsAt = (event: { clientX: number; clientY: number }): PickTarget[] => {
    const svg = svgRef.current;
    if (!svg) return [];
    const seen = new Set<string>();
    const targets: PickTarget[] = [];
    for (const element of document.elementsFromPoint(event.clientX, event.clientY)) {
      if (!svg.contains(element)) continue;
      const hit = element.closest<SVGElement>('[data-pick-kind]');
      if (!hit || !svg.contains(hit)) continue;
      const kind = hit.dataset.pickKind as PickKind | undefined;
      const id = hit.dataset.pickId;
      if (!kind || !id) continue;
      const target: PickTarget = { kind, id };
      if (hit.dataset.pickSide) target.side = hit.dataset.pickSide as PickTarget['side'];
      if (hit.dataset.pickShapeIndex) target.shapeIndex = Number(hit.dataset.pickShapeIndex);
      const key = pickKey(target);
      if (!seen.has(key)) {
        seen.add(key);
        targets.push(target);
      }
    }
    const point = toSvg(event);
    const stem = stemAtPoint(point.x, point.y);
    if (stem) {
      const target: PickTarget = { kind: 'stem', id: stem.noteId };
      if (!seen.has(pickKey(target))) targets.push(target);
    }
    const notes = targets.filter((target) => target.kind === 'note');
    if (notes.length > 1) {
      const heads = new Set(notes.filter((target) => onNotehead(target.id, point)).map((target) => target.id));
      return targets.filter((target) => target.kind !== 'note' || heads.has(target.id));
    }
    return targets;
  };
  const clickedNote = (event: { clientX: number; clientY: number }, fallback: NoteBox): NoteBox | null => {
    const notes = pickTargetsAt(event).filter((target) => target.kind === 'note');
    if (!notes.length) return null;
    return notes.length === 1 ? layout.noteBoxes.find((box) => box.id === notes[0].id) ?? fallback : fallback;
  };
  const isPicked = (target: PickTarget): boolean => {
    if (target.kind === 'note') return selectedIds.includes(target.id);
    if (target.kind === 'stem') {
      const ids = chordNoteIds(doc, target.id);
      return carrierSelectedIds.includes(target.id) || ids.length > 1 && ids.every((id) => selectedIds.includes(id));
    }
    if (target.kind === 'time') return selectedMeasureIds.includes(target.id);
    return target.kind === 'beamHandle' || target.kind === 'contextHandle' || target.kind === 'slurHandle' || selectedStructureIds.includes(target.id);
  };
  const computeHover = (event: React.PointerEvent) => {
    if (overlapPicker || locked || armed) {
      onHoverNote([]);
      return;
    }
    const topIsStructure = (event.target as Element).closest('.structure-hit') !== null;
    const target = preferredHoverTarget(pickTargetsAt(event), isPicked, topIsStructure);
    if (target) {
      if (target.kind === 'stem') onHoverNote([...chordNoteIds(doc, target.id), `carrier:${target.id}`]);
      else if (target.kind === 'time') onHoverNote([`ts:${target.id}`]);
      else onHoverNote([target.id]);
      return;
    }
    onHoverNote([]);
  };
  const selectPick = (target: PickTarget, additive: boolean) => {
    onHoverNote([]);
    if (target.kind === 'note') select(target.id, additive);
    else if (target.kind === 'stem') selectMany(chordNoteIds(doc, target.id), additive, [target.id]);
    else if (target.kind === 'time') selectMeasure(target.id, [], additive);
    else selectStructure(target.id, additive);
  };
  const clickRelation = (id: string, additive: boolean) => {
    if (isDoubleClick(`relation:${id}`)) {
      const group = relationContentSelection(doc, id);
      selectMany(group.noteIds, additive, group.carrierIds, group.structureIds);
    } else selectStructure(id, additive);
  };
  const pickLabel = (target: PickTarget): string => {
    if (target.kind === 'note' || target.kind === 'stem') {
      const location = locate(doc, target.id);
      const voice = location ? doc.voices.findIndex((v) => v.id === location.voiceId) + 1 : 0;
      const kind = target.kind === 'stem' ? 'Stem / chord' : entityKinds(doc).get(target.id) === 'rest' ? 'Rest' : 'Note';
      return voice ? `${kind} · Voice ${voice}` : kind;
    }
    if (target.kind === 'context' || target.kind === 'contextHandle') {
      const context = doc.contexts.find((c) => c.id === target.id);
      return context ? context.kind.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase()) : 'Marking';
    }
    if (target.kind === 'beam' || target.kind === 'beamHandle') return 'Beam';
    if (target.kind === 'tuplet') return 'Tuplet';
    if (target.kind === 'time') return 'Time signature';
    return 'Marking';
  };
  const onPickDownCapture = (event: React.PointerEvent<SVGSVGElement>) => {
    suppressPickClickRef.current = false;
    playback.unlock();
    if (locked || armed || event.button !== 0) return;
    // a boundary handle takes its own press: whatever lies under it is not a choice to offer
    if ((event.target as Element).closest('.context-endpoint')) return;
    const targets = pickTargetsAt(event);
    if (!targets.length && (event.target as Element).closest('[data-pick-kind="note"]')) {
      onDownBg(event);
      return;
    }
    const single = targets.length === 1 ? targets[0] : null;
    if (single && (single.kind === 'beam' || single.kind === 'tuplet' || single.kind === 'time')
      && (event.target as Element).closest('[data-pick-kind="note"]')) {
      event.stopPropagation();
      event.preventDefault();
      suppressPickClickRef.current = true;
      onHoverNote([]);
      if (single.kind === 'time') selectMeasure(single.id, isDoubleClick(`measure:${single.id}`) ? measureNoteIds(doc, single.id) : [], event.shiftKey);
      else clickRelation(single.id, event.shiftKey);
      setOverlapPicker(null);
      return;
    }
    if (targets.length < 2 && targets[0]?.kind !== 'beamHandle') return;
    const picked = targets.filter(isPicked);
    const selected = picked.find((target) => target.kind === 'beamHandle' || target.kind === 'contextHandle' || target.kind === 'slurHandle') ?? picked[0];
    if (selected) {
      const top = targets[0];
      const coveredStructure = selected.kind !== 'note' && selected.kind !== 'stem' && (event.target as Element).closest('[data-pick-kind="note"]') !== null;
      if (pickKey(selected) === pickKey(top) && !coveredStructure) return;
      event.stopPropagation();
      event.preventDefault();
      suppressPickClickRef.current = true;
      if (selected.kind === 'beamHandle') {
        const shape = layout.beamShapes.find((shape) => shape.id === selected.id && shape.handles);
        if (shape && (selected.side === 'left' || selected.side === 'center' || selected.side === 'right')) onDownBeamHandle(event, shape, selected.side);
      } else if (selected.kind === 'slurHandle' && selected.side) {
        const shape = layout.slurShapes.find((shape) => shape.id === selected.id);
        if (shape) onDownSlurHandle(event, shape, selected.side as SlurHandle);
      } else if (selected.kind === 'contextHandle' && (selected.side === 'start' || selected.side === 'end')) {
        onDownContext(event, selected.id, selected.side, selected.shapeIndex);
      } else selectPick(selected, event.shiftKey);
      setOverlapPicker(null);
      return;
    }
    event.stopPropagation();
    event.preventDefault();
    suppressPickClickRef.current = true;
    onHoverNote([]);
    setOverlapPicker({ x: event.clientX, y: event.clientY, targets: targets.filter((target) => target.kind !== 'beamHandle' && target.kind !== 'contextHandle' && target.kind !== 'slurHandle'), additive: event.shiftKey });
  };
  const onMove = (e: React.PointerEvent) => {
    const slurDrag = slurDragRef.current;
    if (slurDrag) {
      const point = toSvg(e);
      const dx: number = point.x - slurDrag.grab.x;
      const dy: number = point.y - slurDrag.grab.y;
      if (slurDrag.pending) {
        if (Math.hypot(dx, dy) < slurDrag.shape.staffSpace * SLUR_CORNER_DECISION) return;
        if (Math.abs(dx) > Math.abs(dy)) {
          const { pending, shape, handle } = slurDrag;
          slurDragRef.current = null;
          onDownContext({ ...pending, button: 0, stopPropagation: () => {} }, shape.id, handle === 'topLeft' ? 'start' : 'end', 0, 'time');
        } else slurDrag.pending = null;
      }
      if (slurDragRef.current) {
        slurDrag.current = dragSlur(slurDrag.handle, slurDrag.from, slurDrag.shape.base, { x: dx, y: dy });
        if (slurDragFrameRef.current === null) {
          slurDragFrameRef.current = requestAnimationFrame(() => {
            slurDragFrameRef.current = null;
            const current = slurDragRef.current;
            if (current) onSlurPreview({ id: current.shape.id, offsets: current.current });
          });
        }
        return;
      }
    }
    if (beamDragRef.current) {
      const drag = beamDragRef.current;
      const delta = (e.clientY - drag.startClientY) / drag.scale;
      const ends = drag.shape.handles!;
      drag.current = beamDragFactors(drag.initial, drag.side, delta, ends, MIN_STEM_LENGTH);
      drag.moved = Math.abs(delta) > 0.01 * ends.staffSpace;
      if (beamDragFrameRef.current === null) {
        beamDragFrameRef.current = requestAnimationFrame(() => {
          beamDragFrameRef.current = null;
          const current = beamDragRef.current;
          if (current) onBeamPreview({ id: current.shape.id, override: current.current, anchorId: current.anchorId });
        });
      }
      return;
    }

    lastPointerRef.current = { clientX: e.clientX, clientY: e.clientY };
    if (contextDragRef.current) {
      const drag = contextDragRef.current;
      const point = toSvg(e);
      const dx = point.x - drag.grab.x;
      const dy = point.y - drag.grab.y;
      if (Math.hypot(dx, dy) < drag.anchor.zone.stepPx * 0.6 && !drag.moved) return;
      drag.moved = true;
      if (drag.axis === 'pending') drag.axis = Math.abs(dx) >= Math.abs(dy) ? 'time' : 'height';
      if (drag.axis === 'height' && drag.range) {
        drag.nextOffset = Math.min(drag.range.max, Math.max(drag.range.min, drag.offset + dy));
        onPlacementPreview({ id: drag.context.id, factor: contextFactor(drag) });
        return;
      }
      if ('endMeasureId' in drag.context && drag.edge === 'end') {
        // dragged past the end of the last measure: the span will last until the end of the score
        const last = doc.measures[doc.measures.length - 1];
        const right = Math.max(0, ...layout.staffZones.filter((zone) => zone.measureId === last?.id).map((zone) => zone.x1));
        drag.toEnd = !!last && right > 0 && point.x > right + drag.anchor.zone.stepPx * 2;
        if (drag.toEnd) {
          drag.preview = { id: drag.context.id, edge: 'end', x: right, landing: { measureId: last.id, beats: lengthOfMeasure(last.timeSignature) } };
          setContextPreview(null);
          scheduleSpanPreview();
          return;
        }
      }
      const fixedStart = openingContext(drag.context);
      const target = pointOnScore(drag.anchor.beatX + (fixedStart ? 0 : dx),
        drag.anchor.zone.bottomLineY - 4 * drag.anchor.zone.stepPx + (fixedStart ? 0 : dy), true, drag.anchor.zone.staffId);
      drag.target = target;
      if (!target) {
        restoreContext(drag);
        setContextPreview(null);
        return;
      }
      if ('endMeasureId' in drag.context) {
        // the span follows the pointer continuously, at its own height; the anchor it would snap to (only where it stays a span:
        // its end after its start) is what the dotted guide points at
        const targetMeasure: number = doc.measures.findIndex((measure) => measure.id === target.measureId);
        const fixed = drag.edge === 'end' ? { measureId: drag.context.measureId, beats: toBeats(drag.context.position) } : { measureId: endOfSpan(doc, drag.context).measureId, beats: toBeats(endOfSpan(doc, drag.context).position) };
        const fixedMeasure: number = doc.measures.findIndex((measure) => measure.id === fixed.measureId);
        const after: number = (targetMeasure - fixedMeasure) || (target.beats - fixed.beats);
        const valid: boolean = drag.edge === 'end' ? after > 0 : after < 0;
        drag.preview = { id: drag.context.id, edge: drag.edge, x: drag.anchor.x + dx, landing: valid ? { measureId: target.measureId, beats: target.beats } : drag.preview?.landing };
        scheduleSpanPreview();
      }
      const targetBottom = target.bottom;
      const timeDx = target.x - drag.anchor.beatX;
      let visualDy = targetBottom - drag.anchor.zone.bottomLineY;
      if (!('endMeasureId' in drag.context)) {
        if (drag.range) {
          drag.nextOffset = Math.min(drag.range.max, Math.max(drag.range.min, drag.offset + dy - visualDy));
          visualDy += drag.nextOffset - drag.offset;
        }
        drag.nodes.forEach(({ node }) => {
          node.classList.add('context-dragging');
          node.style.translate = `${timeDx}px ${visualDy}px`;
        });
      }
      if (!('endMeasureId' in drag.context)) setContextPreview({ id: drag.context.id, edge: drag.edge, x: drag.anchor.x + timeDx, y: drag.anchor.y + visualDy, guide: target });
      return;
    }
    if (stemDragRef.current) {
      const { y } = toSvg(e);
      const drag = stemDragRef.current;
      drag.clientY = e.clientY;
      if (Math.abs(y - drag.startY) > 3) drag.moved = true;
      if (drag.moved) {
        if (stemDragFrameRef.current !== null) cancelAnimationFrame(stemDragFrameRef.current);
        stemDragFrameRef.current = requestAnimationFrame(() => {
          stemDragFrameRef.current = null;
          updateStemDrag();
        });
      }
      return;
    }
    if (markTool) {
      const { x, y } = toSvg(e);
      setGuide(pointOnScore(x, y, !!pending));
      return;
    }
    if (insertTool) {
      const { x, y } = toSvg(e);
      const target = resolveInsertTarget(x, y);
      setGhost(
        target
          ? { x: target.snappedX, y: target.snappedY, staffStep: target.staffStep, staffId: target.zone.staffId, zone: target.zone, beat: target.beat, writtenValue: target.writtenValue }
          : null,
      );
      return;
    }
    computeHover(e);
    if (!start.current) return;
    const { x, y } = toSvg(e);
    const s = start.current;
    const b: Band = { x: Math.min(s.x, x), y: Math.min(s.y, y), w: Math.abs(x - s.x), h: Math.abs(y - s.y) };
    bandRef.current = b;
    setBand(b);
  };

  const onUp = () => {
    if (slurDragRef.current) {
      const drag = slurDragRef.current;
      slurDragRef.current = null;
      if (slurDragFrameRef.current !== null) {
        cancelAnimationFrame(slurDragFrameRef.current);
        slurDragFrameRef.current = null;
      }
      const moved: boolean = !drag.pending && slurChanges(drag.shape.id, drag.from, drag.current).length > 0;
      // written against the stored values, so a shape that had to be fitted is repaired once touched
      const changes = moved ? slurChanges(drag.shape.id, drag.stored, drag.current) : [];
      if (changes.length) {
        const token = ++slurCommitTokenRef.current;
        onSlurPreview({ id: drag.shape.id, offsets: drag.current });
        void dispatch({ type: 'editPresentation', changes })
          .finally(() => {
            if (slurCommitTokenRef.current === token) onSlurPreview(null);
          });
      } else {
        onSlurPreview(null);
      }
      return;
    }
    if (beamDragRef.current) {
      const drag = beamDragRef.current;
      beamDragRef.current = null;
      if (beamDragFrameRef.current !== null) {
        cancelAnimationFrame(beamDragFrameRef.current);
        beamDragFrameRef.current = null;
      }
      if (drag.moved) {
        const token = ++beamCommitTokenRef.current;
        onBeamPreview({ id: drag.shape.id, override: drag.current, anchorId: drag.anchorId });
        void dispatch({ type: 'setBeamOverride', beamId: drag.shape.id, override: drag.current })
          .finally(() => {
            if (beamCommitTokenRef.current === token) onBeamPreview(null);
          });
      } else {
        onBeamPreview(null);
      }
      return;
    }
    if (contextDragRef.current) {
      commitContextDrag();
      return;
    }
    if (stemDragRef.current) {
      // cancel a pending rAF so a stale, one-frame-behind position can't land after release.
      if (stemDragFrameRef.current !== null) {
        cancelAnimationFrame(stemDragFrameRef.current);
        stemDragFrameRef.current = null;
      }
      suppressNextClickRef.current = true;
      const { noteId, moved } = stemDragRef.current;
      useEditor.setState({ auditionSuppressed: false });
      if (!moved) selectMany(chordNoteIds(doc, noteId), false, [noteId]);
      if (!moved) {
        const now = Date.now();
        const last = lastStemClickRef.current;
        if (last && last.noteId === noteId && now - last.time < DOUBLE_CLICK_MS) {
          // first double-click on a custom-dragged length resets to natural (same direction);
          // the next one flips — so double-click always eventually flips.
          const override = stemOverrides[noteId];
          const hasCustomLength = override != null && override.lengthFactor !== 1;
          const h = layout.stemHandles.find((sh) => sh.noteId === noteId);
          const currentDirection = h?.direction ?? 1;
          const nextDirection = (hasCustomLength ? currentDirection : currentDirection * -1) as 1 | -1;
          void commitStems([noteId], { direction: nextDirection, lengthFactor: 1 });
          lastStemClickRef.current = null;
        } else {
          lastStemClickRef.current = { noteId, time: now };
        }
      } else {
        // the drag only previewed; save where it ended, once — one request, one undo entry
        const dragged = useEditor.getState().stemOverrides[noteId];
        if (dragged) void commitStems([noteId], dragged);
      }
      stemDragRef.current = null;
      return;
    }
    const s = start.current;
    const b = bandRef.current;
    start.current = null;
    bandRef.current = null;
    setBand(null);
    if (!s) return;
    if (armed) {
      placeAt(s.x, s.y);
      // a click on the staff inserts a note of the current value, or places a mark
      return;
    }
    if (b && (b.w > 3 || b.h > 3)) {
      // marquee select is carrier-granularity: touching any one note selects the whole chord.
      const hitCarrierIds = [...new Set(layout.noteBoxes.filter((box) => intersects(box, b)).map((box) => box.carrierId))];
      const ids = hitCarrierIds.flatMap((cid) => chordNoteIds(doc, cid));
      const group = contentSelection(doc, ids);
      selectMany(group.noteIds, s.additive, group.carrierIds, group.structureIds);
      lastBackgroundClickRef.current = null;
    } else {
      const measure = layout.measures.find((m) => s.x >= m.x && s.x <= m.x + m.w && s.y >= m.y && s.y <= m.y + m.h);
      const zone = measure && layout.staffZones.find((z) => z.measureId === measure.id && staffContainsPoint(z, s.x, s.y));
      if (zone) {
        const now = Date.now();
        const last = lastBackgroundClickRef.current;
        const again = last && last.measureId === zone.measureId && last.staffId === zone.staffId
          && now - last.time < DOUBLE_CLICK_MS && Math.hypot(s.x - last.x, s.y - last.y) <= zone.stepPx * 2;
        // one click picks the measure; a second on the same staff picks what the measure holds on that staff; a third, on every staff
        const clicks = again ? last.count + 1 : 1;
        if (clicks === 1) selectMeasure(zone.measureId, [], s.additive);
        else {
          const group = measureContentSelection(doc, zone.measureId, clicks === 2 ? zone.staffId : undefined);
          // a measure with nothing in it has no contents to pick: it stays selected
          if (group.noteIds.length > 0 || group.structureIds.length > 0) selectMany(group.noteIds, s.additive, group.carrierIds, group.structureIds);
        }
        lastBackgroundClickRef.current = clicks >= 3 ? null : { measureId: zone.measureId, staffId: zone.staffId, x: s.x, y: s.y, time: now, count: clicks };
      } else {
        lastBackgroundClickRef.current = null;
        if (!s.additive) select(null);
      }
    }
  };

  // recompute the ghost from the last known pointer position whenever anything that affects its
  // target changes (not just on the next pointermove) — covers undo/redo and tool/staff switches.
  useEffect(() => {
    if (!insertTool) setGhost(null);
    const p = lastPointerRef.current;
    if (!p || !svgRef.current) return;
    const { x, y } = toSvg(p);
    if (markTool) setGuide(pointOnScore(x, y, !!pending));
    if (!insertTool) return;
    const target = resolveInsertTarget(x, y);
    setGhost(
      target
        ? { x: target.snappedX, y: target.snappedY, staffStep: target.staffStep, staffId: target.zone.staffId, zone: target.zone, beat: target.beat, writtenValue: target.writtenValue }
        : null,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout, tool, currentStaffId, currentVoice, doc]);

  const cursor = playing || timeBeats > 0 ? cursorAt(layout, timeBeats) : null;
  // `layout.measures` is in document order, one box per measure
  const playingMeasure = playing ? layout.measures[barAtBeat(doc, timeBeats).index] : undefined;

  // Follow the playhead onto the next system: when its system leaves the visible part of the
  // sheet (above any floating chrome), glide it back into view with the settle spring. Only on a
  // system change, never per frame.
  const cursorRef = useRef<SVGLineElement>(null);
  const cursorSystem = cursor?.y0 ?? null;
  const reduce = useReducedMotion();
  useEffect(() => {
    const line = cursorRef.current;
    const area = line?.closest<HTMLElement>('.canvas-area');
    if (!playing || cursorSystem === null || !line || !area) return;
    const lineRect = line.getBoundingClientRect();
    const areaRect = area.getBoundingClientRect();
    const viewBottom = visibleBottom(area);
    const margin = 32;
    if (lineRect.top >= areaRect.top + margin && lineRect.bottom <= viewBottom - margin) return;
    const max = area.scrollHeight - area.clientHeight;
    const top = Math.max(0, Math.min(max, area.scrollTop + lineRect.top - areaRect.top - margin));
    return springScrollTo(area, { top }, reduce);
  }, [playing, cursorSystem, reduce]);

  return (
    <>
    <svg
      ref={svgRef}
      className={'overlay' + (armed ? ' inserting' : '')}
      width={layout.width}
      height={layout.height}
      // stem grab is geometric, at the root (`onDownStem`) — runs before note rects' own onClick;
      // returns without effect off-stem, so bg marquee and note clicks are untouched.
      onPointerDownCapture={onPickDownCapture}
      onPointerDown={(e) => {
        playback.unlock();
        onDownStem(e);
      }}
      onClickCapture={(event) => {
        if (!suppressPickClickRef.current) return;
        suppressPickClickRef.current = false;
        event.preventDefault();
        event.stopPropagation();
      }}
      onPointerMove={onMove}
      onDragOver={onPaletteDragOver}
      onDrop={onPaletteDrop}
      onDragLeave={(event) => {
        const box = event.currentTarget.getBoundingClientRect();
        if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) {
          setGuide(null);
          setPaletteDragging(false);
        }
      }}
      onPointerUp={onUp}
      onPointerCancel={() => {
        cancelContextDrag();
        cancelBeamDrag();
        cancelStemDrag();
      }}
      onLostPointerCapture={() => {
        if (beamDragRef.current) cancelBeamDrag();
        if (contextDragRef.current) cancelContextDrag();
        cancelStemDrag();
      }}
      onPointerLeave={() => {
        lastPointerRef.current = null;
        setGhost(null);
        if (!paletteDragging) setGuide(null);
        onHoverNote([]);
      }}
    >
      <rect
        className="bg"
        x={0}
        y={0}
        width={layout.width}
        height={layout.height}
        style={{ cursor: armed ? 'copy' : 'default' }}
        onPointerDown={onDownBg}
      />
      {/* during playback, the bar being played gets a lighter wash of its own */}
      {playing && playingMeasure && (
        <rect
          className="playing-wash"
          x={playingMeasure.x}
          y={playingMeasure.y}
          width={playingMeasure.w}
          height={playingMeasure.h}
        />
      )}
      {/* measure selection: a soft wash across the measure's full system height, multiplied into
          the paper so it reads as an underlay beneath the engraving, never a box over it */}
      {layout.measures
        .filter((m) => selectedMeasureIds.includes(m.id))
        .map((m) => (
          <rect key={m.id} className="measure-wash" x={m.x} y={m.y} width={m.w} height={m.h} />
        ))}
      {/* Stem handles paint BEFORE (under) the note hit-rects, so a notehead's own click always
          wins within its bounds;
          the stem stays grabbable along the rest of its length. */}
      {!armed &&
        !locked &&
        // rendered for every stemmed note, always — the hit-line/visual/dot are invisible by
        // default, revealed by CSS `:hover` on the hit-line itself.
        layout.stemHandles.map((h) => {
            // hit-line start is inset a small flat amount past `baseY`, just enough to keep a
            // grab next to the notehead resolving as "drag the stem" — the rest of the stem
            // (including any gap to a further chord note) stays covered.
            const { yMin: hitStartY, yMax: hitEndY } = stemHitRange(h);
            const hasSpan = h.hitY1 != null && h.hitY2 != null;
            // the VISUAL line always spans the full stem regardless of the hit-line's inset, so
            // hover/selected state reads as one continuous highlighted object.
            const visualStartY = hasSpan ? (h.hitY1 as number) : h.baseY;
            const visualEndY = hasSpan ? (h.hitY2 as number) : h.tipY;
            // colored by the note's own voice, same resolution the notehead itself uses.
            const loc = locate(doc, h.noteId);
            const voiceIndex = loc ? doc.voices.findIndex((v) => v.id === loc.voiceId) : -1;
            const voiceColor =
              loc && voiceIndex >= 0 ? resolveVoiceColor(loc.voiceId, voiceIndex, voiceColors) : undefined;
            const chordIds = chordNoteIds(doc, h.noteId);
            return (
              // the whole stem (minus the notehead-adjacent inset) is the grab target, not just
              // the tip — VexFlow's own rendered stem is ~1.5px, too thin to reliably click.
              <g
                key={`${h.noteId}:${h.staffId}`}
                data-pick-kind="stem"
                data-pick-id={h.noteId}
                // `.selected`: every note of the carrier selected, AND (a real chord OR picked at
                // carrier granularity via this stem/a chord double-click — `carrierSelectedIds`).
                className={
                  'stem-handle-group' +
                  (chordIds.every((id) => selectedIds.includes(id)) &&
                  (chordIds.length > 1 || carrierSelectedIds.includes(h.noteId))
                    ? ' selected'
                    : '')
                }
                style={voiceColor ? ({ '--voice-color': voiceColor } as React.CSSProperties) : undefined}
              >
                <line
                  className="stem-handle-hit"
                  x1={h.x}
                  y1={hitStartY}
                  x2={h.x}
                  y2={hitEndY}
                  // No onPointerDown/onPointerEnter — both click/drag (`onDownStem`) and hover
                  // (`computeHover`) are handled geometrically at the root; this line stays only
                  // for its CSS `:hover` highlight where it IS the topmost element.
                />
                {h.flag && <rect className="stem-handle-hit" x={h.flag.x + h.flag.dx} y={h.flag.y + h.flag.dy} width={h.flag.width} height={h.flag.height} />}
                <line className="stem-handle-visual" x1={h.x} y1={visualStartY} x2={h.x} y2={visualEndY} />
                {h.flag && <path className="stem-handle-flag" d={h.flag.d} transform={`translate(${h.flag.dx} ${h.flag.dy})`} />}
                {/* the visible, grabbable point — a dot at the free tip, never the connected end. */}
                {h.draggable !== false && !readOnly && <circle className="stem-handle-dot" cx={h.x} cy={h.tipY} r={STEM_DOT_RADIUS} />}
              </g>
            );
          })}
      {/* beams and tuplet brackets paint under the note hit-rects: a notehead or stem always wins
          where they meet, the beam / bracket answers on the rest of its own shape */}
      {!armed &&
        !locked &&
        layout.beamShapes.flatMap((shape) =>
          shape.paths.map((d, i) => (
            <path
              key={`${shape.id}:${i}`}
              className="structure-hit"
              data-pick-kind="beam"
              data-pick-id={shape.id}
              d={d}
              onClick={(e) => {
                e.stopPropagation();
                clickRelation(shape.id, e.shiftKey);
              }}
            />
          )),
        )}
      {!armed && !locked && !readOnly && layout.beamShapes.filter((shape) => selectedStructureIds.includes(shape.id) && shape.handles).map((shape, index) => {
        const h = shape.handles!;
        const leftY = h.y0;
        const rightY = h.y1;
        const firstCarrier = doc.beams.find((beam) => beam.id === shape.id)?.carrierIds[0];
        const voice = doc.measures.flatMap((measure) => measure.voices).find((voice) => voice.items.some((item) => item.id === firstCarrier));
        const voiceIndex = doc.voices.findIndex((entry) => entry.id === voice?.id);
        const color = voice ? resolveVoiceColor(voice.id, voiceIndex, voiceColors) : 'var(--accent)';
        return <g key={`beam-handles:${shape.id}:${index}`} className="beam-handles" style={{ color }}>
          {(['left', 'center', 'right'] as const).map((side, i) => {
            const t = i / 2;
            const x = h.x0 + (h.x1 - h.x0) * t;
            const y = leftY + (rightY - leftY) * t;
            return <g key={side} role="button" aria-label={`Move beam ${side}`} data-pick-kind="beamHandle" data-pick-id={shape.id} data-pick-side={side} style={{ cursor: 'ns-resize' }} onPointerDown={event => onDownBeamHandle(event, shape, side)} onClick={event => event.stopPropagation()}>
              <circle cx={x} cy={y} r={h.staffSpace * 0.8} fill="transparent" pointerEvents="all" />
              <HandleMark role={side === 'center' ? 'move' : 'shape'} x={x} y={y} size={h.staffSpace * 0.3} fill="currentColor" pointerEvents="none" />
            </g>;
          })}
        </g>;
      })}
      {!armed &&
        !locked &&
        layout.tupletShapes.map((t, i) => (
          <g
            key={`${t.id}:${i}`}
            className="structure-hit"
            data-pick-kind="tuplet"
            data-pick-id={t.id}
            onClick={(e) => {
              e.stopPropagation();
              clickRelation(t.id, e.shiftKey);
            }}
            dangerouslySetInnerHTML={{ __html: t.html }}
          />
        ))}
      {/* a time signature belongs to its measure: picking it picks the measure (the inspector then
          offers the signature) */}
      {!armed &&
        !locked &&
        layout.timeSignatureShapes.map((t, i) => (
          <g
            key={`${t.measureId}:${i}`}
            className="structure-hit"
            data-pick-kind="time"
            data-pick-id={t.measureId}
            onClick={(e) => {
              e.stopPropagation();
              selectMeasure(t.measureId, isDoubleClick(`measure:${t.measureId}`) ? measureNoteIds(doc, t.measureId) : [], e.shiftKey);
            }}
            dangerouslySetInnerHTML={{ __html: t.html }}
          />
        ))}
      {/* the marks drawn with a chord: a click or a hover on one is on the chord, on a fingering or an accidental it is on its own note.
          Under the notehead boxes, so where a mark touches a head the head wins. */}
      {layout.modifierBoxes.map((m, index) => (
        <rect
          key={`${m.noteId ?? m.carrierId}:${index}`}
          className="hit"
          data-pick-kind={m.noteId ? 'note' : 'stem'}
          data-pick-id={m.noteId ?? m.carrierId}
          x={m.x}
          y={m.y}
          width={m.w}
          height={m.h}
          rx={2}
          onClick={(e) => {
            e.stopPropagation();
            if (suppressNextClickRef.current) {
              suppressNextClickRef.current = false;
              return;
            }
            if (armed) {
              const p = toSvg(e);
              placeAt(p.x, p.y);
              return;
            }
            if (!m.noteId) selectMany(chordNoteIds(doc, m.carrierId), e.shiftKey, [m.carrierId]);
            else if (isDoubleClick(`note:${m.noteId}`)) selectMany(chordNoteIds(doc, m.carrierId), e.shiftKey, [m.carrierId]);
            else select(m.noteId, e.shiftKey);
          }}
        />
      ))}
      {layout.noteBoxes.map((b) => (
        <rect
          key={b.id}
          className="hit"
          data-pick-kind="note"
          data-pick-id={b.id}
          x={b.x}
          y={b.y}
          width={b.w}
          height={b.h}
          rx={3}
          onClick={(e) => {
            e.stopPropagation();
            if (suppressNextClickRef.current) {
              suppressNextClickRef.current = false;
              return;
            }
            if (armed) {
              const p = toSvg(e);
              placeAt(p.x, p.y);
              return;
            }
            const note = clickedNote(e, b);
            if (!note) return;
            if (e.altKey) {
              // The individual note identifies its staff even for a cross-staff carrier.
              groupFromNote(note.id, 'staff', e.shiftKey);
              return;
            }
            // plain click selects the one note under the cursor; a fast second click on the
            // SAME note escalates to the whole chord (carrier granularity).
            if (isDoubleClick(`note:${note.id}`)) selectMany(chordNoteIds(doc, note.carrierId), e.shiftKey, [note.carrierId]);
            else select(note.id, e.shiftKey);
          }}
          onDoubleClick={(e) => {
            e.stopPropagation();
            // plain double-click is handled manually above; native dblclick is only used for the
            // Alt-modified whole-voice select.
            const note = clickedNote(e, b);
            if (!insertTool && e.altKey && note) groupFromNote(note.id, 'voice', e.shiftKey);
          }}
          // hover preview isn't wired here — see `computeHover`, which decides note-vs-stem
          // geometrically (these boxes are padded/tiled for forgiving click precision).
        />
      ))}
      {/* Context grabs: a marking is picked and dragged by its own shapes. */}
      {!armed && !locked && layout.contextShapes.map((c, i) => {
        const context = doc.contexts.find((context) => context.id === c.id);
        const shapeIndex = layout.contextShapes.slice(0, i).filter((shape) => shape.id === c.id).length;
        const node = engravingNodes(c.id)[shapeIndex];
        // a volta has several ends, so it has no `endMeasureId`, but it is picked like a span, not dragged as a point mark
        const isPoint = context && !('endMeasureId' in context) && context.kind !== 'volta';
        const box = isPoint ? node?.getBBox() : null;
        return <g key={`${c.id}:${i}`} className="structure-hit context-hit" data-pick-kind="context" data-pick-id={c.id}
          onPointerDown={(e) => {
            if (isPoint) onDownContext(e, c.id, 'start', shapeIndex);
            else {
              e.stopPropagation();
              if (isDoubleClick(`context:${c.id}`)) void selectContextContent(c.id, e.shiftKey);
              else selectStructure(c.id, e.shiftKey);
            }
          }}
          onClick={(e) => e.stopPropagation()}>
          {box && <rect x={box.x} y={box.y} width={box.width} height={box.height} />}
          <g dangerouslySetInnerHTML={{ __html: c.html }} />
        </g>;
      })}
      {!armed && !locked && !readOnly && layout.slurShapes.filter((shape) => selectedStructureIds.includes(shape.id)).map((shape) => {
        const frame = slurFrameOf(shape);
        const points = handlePoints(frame);
        const color = 'var(--score-context-ink)';
        const sp: number = shape.staffSpace;
        return <g key={`slur-handles:${shape.id}`} className="slur-handles" style={{ color }}>
          <polygon points={[frame.p0, frame.p3, frame.c2, frame.c1].map((point) => `${point.x},${point.y}`).join(' ')}
            fill="none" stroke="currentColor" strokeWidth={sp * 0.08} strokeDasharray={`${sp * 0.4} ${sp * 0.3}`} opacity={0.6} pointerEvents="none" />
          {SLUR_HANDLES.map((handle) => {
            const at: Point = points[handle];
            return <g key={handle} role="button" aria-label={`Reshape slur ${handle}`} data-pick-kind="slurHandle" data-pick-id={shape.id} data-pick-side={handle}
              style={{ cursor: handle === 'top' ? 'ns-resize' : 'move' }} onPointerDown={event => onDownSlurHandle(event, shape, handle)} onClick={event => event.stopPropagation()}>
              <circle cx={at.x} cy={at.y} r={sp * 0.8} fill="transparent" pointerEvents="all" />
              <HandleMark role={SLUR_HANDLE_ROLES[handle]} x={at.x} y={at.y} size={sp * 0.3} fill={SLUR_HANDLE_ROLES[handle] === 'move' ? 'currentColor' : 'var(--color-paper)'} stroke="currentColor" strokeWidth={sp * 0.1} pointerEvents="none" />
            </g>;
          })}
        </g>;
      })}
      {/* a selected span's edges: a dotted line from each handle, at the very edge of the mark, to the anchor it applies to, on the staff line nearest the handle;
          it leaves the handle and meets the line at a right angle */}
      {!armed && !locked && !readOnly && doc.contexts.filter((c) => selectedStructureIds.includes(c.id) && 'endMeasureId' in c && c.kind !== 'refrain').flatMap((context) =>
        engravingNodes(context.id).flatMap((node, shapeIndex) => (['start', 'end'] as const).map((edge) => {
          const landing = spanPreview?.id === context.id && spanPreview.edge === edge ? spanPreview.landing : undefined;
          const anchor = contextAnchor(context, edge, node, landing);
          if (!anchor || edge === 'start' && openingContext(context)) return null;
          const slurShape = layout.slurShapes.find((shape) => shape.id === context.id);
          const handle = slurShape ? handlePoints(slurFrameOf(slurShape))[edge === 'start' ? 'topLeft' : 'topRight'] : anchor;
          const lineStep: number = anchor.zone.stepPx * 2;
          const line: number = Math.min(4, Math.max(0, Math.round((anchor.zone.bottomLineY - handle.y) / lineStep)));
          // the guide ends in front of the element the mark attaches to (its left edge), perpendicular to the staff;
          // within a staff space of the handle it is a straight vertical there, farther it is a smooth S-curve
          const target = { x: anchor.beatX, y: anchor.zone.bottomLineY - line * lineStep };
          const from = { x: Math.abs(anchor.beatX - handle.x) < lineStep ? anchor.beatX : handle.x, y: handle.y };
          const middle: number = (from.y + target.y) / 2;
          return <g key={`${context.id}:${shapeIndex}:${edge}:guide`} className="mark-guide" aria-hidden="true">
            <path d={`M${from.x} ${from.y} C${from.x} ${middle} ${target.x} ${middle} ${target.x} ${target.y}`} fill="none" strokeWidth={anchor.zone.stepPx / 3}
              strokeDasharray={`${anchor.zone.stepPx} ${anchor.zone.stepPx / 2}`} />
            <circle className="anchor" cx={target.x} cy={target.y} r={anchor.zone.stepPx / 2} />
          </g>;
        })))}
      {!armed && !locked && !readOnly && doc.contexts.filter((c) => selectedStructureIds.includes(c.id) && 'endMeasureId' in c && c.kind !== 'refrain' && !layout.slurShapes.some((shape) => shape.id === c.id)).flatMap((context) =>
        engravingNodes(context.id).flatMap((node, shapeIndex) => (['start', 'end'] as const).map((edge) => {
          const anchor = contextAnchor(context, edge, node);
          if (!anchor || edge === 'start' && openingContext(context)) return null;
          return <g key={`${context.id}:${shapeIndex}:${edge}`} className="context-endpoint" role="button" tabIndex={0}
            aria-label={`Move ${context.kind} ${edge}`} data-context-id={context.id} data-edge={edge}
            data-pick-kind="contextHandle" data-pick-id={context.id} data-pick-side={edge} data-pick-shape-index={shapeIndex}
            transform={`translate(${anchor.x} ${anchor.y})`}
            onPointerDown={(e) => onDownContext(e, context.id, edge, shapeIndex)}
            onKeyDown={(e) => moveHandleByKey(e, context, edge)} onClick={(e) => e.stopPropagation()}>
            <circle className="context-endpoint-hit" r={anchor.zone.stepPx * 2.2} />
            <HandleMark role="span" className="context-endpoint-dot" x={0} y={0} size={anchor.zone.stepPx * 0.8} />
          </g>;
        })))}
      <BoundaryHandles layout={layout} toSvg={toSvg} enabled={!armed && !locked && !readOnly} />
      {/* a span shows where it lands by being redrawn there; only a point mark gets the vertical guide */}
      {contextPreview && !doc.contexts.some((c) => c.id === contextPreview.id && 'endMeasureId' in c) && <line className="context-drop-guide" x1={contextPreview.guide.x} x2={contextPreview.guide.x}
        y1={contextPreview.guide.top} y2={contextPreview.guide.bottom} />}
      {band && <rect className="band" x={band.x} y={band.y} width={band.w} height={band.h} />}
      {spanRange && !locked && !readOnly && <g className="mark-guide" aria-hidden="true"><InsertRange doc={doc} layout={layout} range={spanRange} /></g>}
      {(contextGuide || pending) && !locked && !readOnly && (
        <g className="mark-guide" aria-hidden="true">
          {placed.map((point, index) => <circle key={index} className="anchor pending" cx={point.x} cy={point.bottom} r={point.zone.stepPx / 2} />)}
          {range && <InsertRange doc={doc} layout={layout} range={range} />}
          {contextGuide && (() => {
            const at = contextGuide;
            const anchorY = at.pointerY < (at.top + at.bottom) / 2 ? at.top : at.bottom;
            const tip = { x: at.pointerX, y: at.pointerY };
            return <>
              <line x1={at.x} y1={anchorY} x2={tip.x} y2={tip.y} strokeWidth={at.zone.stepPx / 3}
                strokeDasharray={`${at.zone.stepPx} ${at.zone.stepPx / 2}`} />
              <circle className="anchor" cx={at.x} cy={anchorY} r={at.zone.stepPx / 2} />
              <circle className="anchor tip" cx={tip.x} cy={tip.y} r={at.zone.stepPx / 2} />
            </>;
          })()}
        </g>
      )}
      {insertTool && ghost && (
        <g
          className="insert-ghost"
          transform={`translate(${ghost.x} ${ghost.y})`}
          style={{ color: currentVoiceColor }}
          dangerouslySetInnerHTML={{ __html: ghostMarkup(ghost.staffStep, ghost.staffId) ?? '' }}
        />
      )}
      {cursor && <line ref={cursorRef} className="cursor" x1={cursor.x} y1={cursor.y0} x2={cursor.x} y2={cursor.y1} />}
    </svg>
    {overlapPicker && createPortal(
      <div className="overlap-picker glass" ref={overlapPickerRef}
        style={{ left: `clamp(var(--space-2), calc(${overlapPicker.x}px + var(--space-2)), calc(100vw - 14rem))`, top: `clamp(var(--space-2), calc(${overlapPicker.y}px + var(--space-2)), calc(100vh - 16rem))` }}
        role="menu" aria-label="Select overlapping element"
        onKeyDown={(event) => {
          if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
          event.preventDefault();
          const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button')];
          const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
          buttons[(index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus();
        }}>
        <div className="glass-lens" /><div className="glass-tint" /><div className="glass-specular" /><div className="glass-rim" />
        <div className="glass-content overlap-picker-content">
          {overlapPicker.targets.map((target, index) => (
            <button key={pickKey(target)} type="button" role="menuitem" autoFocus={index === 0}
              onClick={() => {
                selectPick(target, overlapPicker.additive);
                setOverlapPicker(null);
              }}>
              {pickLabel(target)}
            </button>
          ))}
        </div>
      </div>, document.body)}
    </>
  );
}
