// Rendering-agnostic layout the interaction layers depend on. Any engraver
// (VexFlow now, custom SMuFL later) produces a ScoreLayout; the overlay, hit
// testing, playback cursor and practice highlighting all read from it — so the
// renderer can be swapped without touching interaction.

import type { SlurFrame } from '@/core/model/slurHandles';

export interface TimeMapEntry {
  timeBeats: number;
  x: number;
  /** vertical span of the system this point sits on — where the playback cursor is drawn when
   *  it is at this point. Consecutive entries on different systems meet at the same beat (the
   *  system break), so the cursor jumps to the next system instead of sweeping between them. */
  y0: number;
  y1: number;
}

export interface NoteBox {
  /** The individually-selectable note id (one key of a chord, or a rest/single-note's own id) —
   *  what a plain click selects. */
  id: string;
  /** The whole carrier this note belongs to — what a fast double-click (or the shared stem)
   *  selects (see `chordNoteIds` in core/model/query.ts). Equal to `id` for a rest. A carrier's
   *  boxes may share a `carrierId` across TWO DIFFERENT staves (a cross-staff chord) — grouping
   *  by `carrierId` alone is only safe when also disambiguated by `staffId` below. */
  carrierId: string;
  /** The physical staff this note is actually drawn on — for a cross-staff chord, its several
   *  `NoteBox`es (same `carrierId`) don't all share this. */
  staffId: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A mark drawn with a note or a chord (articulation, ornament, fingering, accidental, augmentation dot): a click target. It belongs to the
 *  chord (`carrierId`), and a fingering or an accidental to its own note too (`noteId`; null for the marks of the whole chord). */
export interface ModifierBox {
  carrierId: string;
  noteId: string | null;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A measure's own bounding box (unscaled layout units — same space as everything else in
 *  `ScoreLayout`) — the area the measure-selection wash covers (Overlay.tsx). */
export interface MeasureBox {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A clickable staff area for a measure — lets a click map to (position, staff step)
 *  for note insertion. Geometry is deterministic from the drawn staffs. */
export interface StaffZone {
  measureId: string;
  staffId: string;
  /** note-area x-range (after clef / time-sig). */
  x0: number;
  x1: number;
  /** where the measure's staff begins, before its clef / time-sig. */
  left: number;
  /** y of staff_step 0 (the staff's bottom line). */
  bottomLineY: number;
  /** vertical pixels per staff_step (half a line gap). */
  stepPx: number;
  /** the measure's beat count (num_beats), for x -> beat. */
  beats: number;
  /** the measure's beat unit (beat_value: 4 = quarter), for beat -> whole-note position. */
  beatValue: number;
  dots?: number;
  /** onset (quarter-note beats, from measure start) -> the x notes there are ACTUALLY drawn
   *  at, sorted ascending, always including 0 and the measure's end. Spacing is Gourlay
   *  (duration-weighted), not linear — interpolate piecewise between these, never straight
   *  across x0..x1, or a snapped/preview position drifts from where a click would really land. */
  segments: { beat: number; x: number }[];
  /** Insertion-only map. Equal-beat pairs reserve horizontal space for inline context glyphs;
   *  that space has no duration and cannot contain a note insertion. */
  insertionSegments?: { beat: number; x: number }[];
}

/** A note's stem tip — the MuseScore-style drag handle to change stem direction/length.
 *  Absent for notes without a stem (rests, whole notes). */
export interface StemHandle {
  draggable?: boolean;
  staffSpace?: number;
  automaticLength?: number;
  /** the stem's automatic length beyond the noteheads, the one a length factor multiplies */
  naturalLength?: number;
  noteId: string;
  /** The physical staff owning this handle; a shared cross-staff stem belongs to its upper half. */
  staffId: string;
  x: number;
  /** The stem's notehead-side end, re-read after direction or layout changes. */
  baseY: number;
  /** the stem's free end — where the handle is drawn, and what dragging moves. */
  tipY: number;
  /** Measured shortening of the drawn stem under its flag, relative to the length geometry. */
  tipInset?: number;
  /** Outer notehead positions of the carrier, used as direction-switch thresholds. */
  topNoteY?: number;
  bottomNoteY?: number;
  /** `1` = up, `-1` = down (matches VexFlow's `Stem.UP`/`Stem.DOWN`). */
  direction: 1 | -1;
  /** per-stem upper bound (px) on the dragged length, measured from `baseY`. Absent = use the
   *  editor's global default. A cross-staff stem sets this: its `baseY` (the top note) and its far
   *  note sit a whole inter-staff gap apart, so the length that merely CONNECTS them already
   *  exceeds a single note's default cap — without a larger bound, dragging clamps the stem shorter
   *  than the connection and it retracts flush to the far note (can't protrude, can't be edited). */
  maxLength?: number;
  /** the flag of an unbeamed eighth or shorter: it is part of the stem for hit-testing and for the hover highlight.
   *  `x`/`y`/`width`/`height` is its box, `d` its outline; `dx`/`dy` is how far the layout moved it since. */
  flag?: { d: string; x: number; y: number; width: number; height: number; dx: number; dy: number };
  /** explicit full grabbable span [hitY1, hitY2] of the stem, when the hit-line can't be derived
   *  from [baseY..tipY] alone. Set for a cross-staff stem, whose `baseY` sits INSIDE the drawn
   *  line (not at an end) after a direction flip; absent for a normal note, where baseY/tipY ARE
   *  the two ends. When present, Overlay draws the hit/visual line across this span instead. */
  hitY1?: number;
  hitY2?: number;
}

/** A drawn beam's own geometry — the SVG path data of its polygons — so a click on the beam (and
 *  only on it) selects it. A beam cut by a system break has one shape per run, all with its id. */
export interface BeamShape {
  /** `leftLength` and `rightLength` are the automatic stem lengths at the two ends, the ones a factor multiplies; `direction` is the beam's stems (1 up, -1 down) */
  handles?: { x0: number; x1: number; y0: number; y1: number; staffSpace: number; localX0: number; leftLength: number; rightLength: number; direction: 1 | -1; leftCarrierId: string; rightCarrierId: string };
  id: string;
  paths: string[];
}

/** The start or end of a span being dragged: `x` is where the pointer holds it (the span is drawn to there, continuously,
 *  at its own height), `landing` the anchor it would snap to on release (what the dotted guide points at). */
export interface SpanPreview {
  id: string;
  edge: 'start' | 'end';
  x: number;
  landing?: { measureId: string; beats: number };
}

/** A single-system slur's control polygon with no offsets applied, in layout coordinates: the
 *  editor frame's handles are this frame moved by the slur's presentation offsets. */
export interface SlurShape {
  id: string;
  base: SlurFrame;
  staffSpace: number;
  /** the frame as drawn while an edge of the slur is being dragged: the resting frame carried along x, nothing moved in y */
  frame?: SlurFrame;
}

/** A drawn tuplet bracket and number: the markup of the SVG shapes VexFlow drew for it — invisible
 *  hit geometry, so a click on them (and only on them) selects the tuplet; the highlight is on the
 *  engraving itself (`data-object-id`). One per measure the tuplet is drawn in, all with
 *  the tuplet's id. */
export interface TupletShape {
  id: string;
  html: string;
}

/** A drawn time signature (the markup of its glyph shapes): a click on it picks its measure, the
 *  one thing a time signature is a property of. One per staff it is drawn on. */
export interface TimeSignatureShape {
  measureId: string;
  html: string;
}

/** A drawn context mark — a clef, key signature, dynamic, hairpin, slur, octave line, tempo or tempo
 *  transition: the markup of what was drawn, as the invisible click target for picking it. `offset`
 *  is how far the user may nudge it vertically (score units) — absent where it cannot be moved. */
export interface ContextShape {
  id: string;
  html: string;
  offset?: { min: number; max: number };
  /** the automatic distance of the mark from its staff (score units) and the side it stands on (-1 above, 1 below): what its stored factor multiplies */
  reference?: number;
  side?: -1 | 1;
}

/** A place a grace note can be put beside a carrier, where an insert tool snaps to: `x` is the left edge of the
 *  notehead put there (`w` its width). A slot with `joinId` adds a note to that grace carrier; the others make a
 *  new grace carrier, after the grace carrier `afterId` of that side (the first when null). `kind` is the kind of the
 *  group the slot lies in (null: the side has none yet). Slots do not depend on the staff: the staff is the
 *  pointer's. */
export interface GraceSlot {
  hostId: string;
  voiceId: string;
  measureId: string;
  side: 'before' | 'after';
  kind: 'appoggiatura' | 'acciaccatura' | null;
  x: number;
  w: number;
  joinId: string | null;
  afterId: string | null;
}

export interface ScoreLayout {
  width: number;
  height: number;
  /** the page content width this layout was engraved for (the page's width at the time), so a layout that arrives late can be told from the current one */
  engravedFor?: number;
  /** musical time (in quarter beats) -> position, sorted ascending. */
  timeMap: TimeMapEntry[];
  totalBeats: number;
  /** clickable / selectable boxes, one per note. */
  noteBoxes: NoteBox[];
  /** the marks drawn with notes and chords, one per mark. */
  modifierBoxes: ModifierBox[];
  /** one bounding box per measure — see `MeasureBox`. */
  measures: MeasureBox[];
  /** clickable staff areas, for insertion (one per measure per staff). */
  staffZones: StaffZone[];
  /** stem drag handles, one per stemmed note. */
  stemHandles: StemHandle[];
  /** selectable beams. */
  beamShapes: BeamShape[];
  /** selectable tuplet brackets. */
  tupletShapes: TupletShape[];
  /** slurs whose curve the editor can reshape. */
  slurShapes: SlurShape[];
  /** selectable time signatures (a system's first measure, and wherever the signature changes). */
  timeSignatureShapes: TimeSignatureShape[];
  /** selectable context marks. */
  contextShapes: ContextShape[];
  /** where a grace note can be put, beside each carrier. */
  graceSlots: GraceSlot[];
  /** the same lists cut by system, each drawn `offsetY` lower than its own coordinates: a system a drag preview
   *  only moves keeps the very objects it had, so what is drawn from it need not be drawn again */
  systems: { layout: SystemLayout; offsetY: number }[];
}

/** the lists of a layout that one system publishes: all but the page's size, the piece's length and the cut by system */
export type SystemLayout = Omit<ScoreLayout, 'width' | 'height' | 'engravedFor' | 'totalBeats' | 'systems'>;


/** The x a beat is drawn at on a staff: piecewise between the measure's real onsets. */
export function staffOnsetX(zone: StaffZone, beat: number): number {
  const points = zone.segments;
  if (!points.length) return zone.x0;
  if (beat <= points[0].beat) return points[0].x;
  for (let i = 0; i < points.length - 1; i += 1) {
    if (beat >= points[i].beat && beat <= points[i + 1].beat) {
      const span = points[i + 1].beat - points[i].beat || 1;
      return points[i].x + ((beat - points[i].beat) / span) * (points[i + 1].x - points[i].x);
    }
  }
  return points[points.length - 1].x;
}

/** Right-continuous time projection: a note at a context change sits AFTER its glyphs. */
export function staffInsertionX(zone: StaffZone, beat: number): number {
  const points = zone.insertionSegments ?? zone.segments;
  if (!points.length) return zone.x0;
  for (let i = points.length - 1; i >= 0; i--) {
    const a = points[i], b = points[i + 1];
    if (beat < a.beat) continue;
    if (!b || beat === a.beat) return a.x;
    return a.x + (beat - a.beat) / (b.beat - a.beat) * (b.x - a.x);
  }
  return points[0].x;
}

/** Glyph/header gaps have no inverse musical time. */
export function staffInsertionBeat(zone: StaffZone, x: number): number | null {
  const points = zone.insertionSegments ?? zone.segments;
  if (!points.length || x < points[0].x || x > points[points.length - 1].x) return null;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i], b = points[i + 1];
    if (x < a.x || x >= b.x) continue;
    if (a.beat === b.beat) return null;
    return a.beat + (x - a.x) / (b.x - a.x) * (b.beat - a.beat);
  }
  return points[points.length - 1].beat;
}

/** Split a shaded time cell around zero-duration glyph gaps. */
export function staffInsertionSpans(zone: StaffZone, startBeat: number, endBeat: number): { x: number; width: number }[] {
  const points = zone.insertionSegments ?? zone.segments;
  const spans: { x: number; width: number }[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i], b = points[i + 1];
    const start = Math.max(startBeat, a.beat), end = Math.min(endBeat, b.beat);
    if (end <= start || b.x <= a.x) continue;
    const scale = (b.x - a.x) / (b.beat - a.beat);
    spans.push({ x: a.x + (start - a.beat) * scale, width: (end - start) * scale });
  }
  return spans;
}

/** The highest and the lowest notehead of the chord at an end of a beam, as y on the sheet. */
export interface ChordSpan { top: number; bottom: number }

/** What a drag of a beam gives: the factors of its two ends and the direction of its stems. As with a single stem, a
 *  dragged end that goes past the notes of its chord turns the stems over, every stem of the beam at once since a beam
 *  has one direction; the end that is not dragged keeps its factor. `ends` are the beam's ends as the drag found them.
 *  A center drag moves both ends by the same distance, so the slope stays. */
export function beamDragResult(
  initial: { leftFactor: number; rightFactor: number },
  side: 'left' | 'center' | 'right',
  delta: number,
  ends: { y0: number; y1: number; leftLength: number; rightLength: number },
  chords: { left: ChordSpan; right: ChordSpan },
  direction: 1 | -1,
  minLength: number,
): { direction: 1 | -1; override: { leftFactor: number; rightFactor: number } } {
  const movesLeft = side !== 'right';
  const movesRight = side !== 'left';
  const leftTip = ends.y0 + (movesLeft ? delta : 0);
  const rightTip = ends.y1 + (movesRight ? delta : 0);
  let turned = direction;
  const pass = (tip: number, chord: ChordSpan) => {
    if (turned === -1 && tip < chord.top) turned = 1;
    else if (turned === 1 && tip > chord.bottom) turned = -1;
  };
  if (movesLeft) pass(leftTip, chords.left);
  if (movesRight) pass(rightTip, chords.right);
  const factor = (moved: boolean, factorNow: number, tip: number, chord: ChordSpan, automatic: number) => {
    if (!moved) return factorNow;
    const base = turned === 1 ? chord.bottom : chord.top;
    return Math.max((chord.bottom - chord.top + minLength) / automatic, ((base - tip) * turned) / automatic);
  };
  return {
    direction: turned,
    override: {
      leftFactor: factor(movesLeft, initial.leftFactor, leftTip, chords.left, ends.leftLength),
      rightFactor: factor(movesRight, initial.rightFactor, rightTip, chords.right, ends.rightLength),
    },
  };
}

/** A center drag preserves slope; an endpoint drag leaves the opposite endpoint fixed. */
export function beamDragFactors(
  initial: { leftFactor: number; rightFactor: number },
  side: 'left' | 'center' | 'right',
  delta: number,
  ends: { leftLength: number; rightLength: number; direction: 1 | -1 },
  minLength: number,
) {
  // the end moves by `delta` px (down is positive); a stem pointing up grows when its end goes up
  const factor = (factorNow: number, length: number) => Math.max(minLength / length, (length * factorNow - ends.direction * delta) / length);
  return {
    leftFactor: side === 'right' ? initial.leftFactor : factor(initial.leftFactor, ends.leftLength),
    rightFactor: side === 'left' ? initial.rightFactor : factor(initial.rightFactor, ends.rightLength),
  };
}
