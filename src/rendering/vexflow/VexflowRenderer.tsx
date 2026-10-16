import { bodyFactor, bodyFraction } from '@/core/model/presentation';
import { useEffect, useLayoutEffect, useRef } from 'react';
import { CollisionLayout, growMinimum, inkBox, type InkBox } from './collisionLayout';
import {
  Renderer,
  Stave,
  StaveNote,
  GraceNote,
  Voice,
  Formatter,
  StaveConnector,
  Accidental,
  Dot,
  StaveTie,
  Stem,
  StaveModifierPosition,
  Beam,
  Tuplet,
  TimeSignature,
  KeySignature,
  Clef as VexClef,
  Articulation,
  Ornament,
  Tremolo,
  Annotation,
  Modifier,
  Stroke,
  Glyph,
} from 'vexflow';
import type {
  Accidental as AccidentalValue,
  ArticulationMark,
  Clef,
  ClefName,
  KeyAlteration,
  DurationValue,
  GraceKind,
  Item,
  Measure,
  ScoreDocument,
  StemPlacement,
  BeamOverride,
} from '@/core/model/score';
import { TREMOLO_STROKES, type OrnamentSign } from '@/core/model/ornament';
import type { ScoreLayout, GraceSlot, TimeMapEntry, NoteBox, ModifierBox, StaffZone, StemHandle, MeasureBox, BeamShape, TupletShape, TimeSignatureShape, ContextShape, SlurShape, SpanPreview } from '@/rendering/ScoreRenderer';
import type { SlurOffsets } from '@/core/model/slurHandles';
import { resolveVoiceColor } from '@/core/model/voiceColors';
import { readCssToken } from '@/ui/cssToken';
import { staffStepToKey } from '@/core/model/pitch';
import { ContextIndex, keyOfAlterations, letterOfStep, measureBeats as lengthOfMeasure } from '@/core/model/contexts';
import { drawContextMarks, createKeySignature } from '@/rendering/vexflow/contextMarks';
import { repeatBarlines } from '@/core/model/repeats';
import { shrinkWholeNotehead, getNotePaddingPx, fixLedgerLineWidth, REPEAT_SIGN_ROOM, STAFF_SPACE } from '@/rendering/vexflow/engravingScale';

/** the most times a score is laid out again after a measurement asked for more room */
const MAX_LAYOUT_PASSES = 40;

const BEATS: Record<string, number> = { w: 4, h: 2, q: 1, '8': 0.5, '16': 0.25, '32': 0.125 };

function noteBeats(n: { duration: DurationValue; dots: number }): number {
  let b = BEATS[n.duration] ?? 1;
  if (n.dots) b *= 2 - Math.pow(0.5, n.dots);
  return b;
}

/** The actually visible horizontal gap between a stave's begin and end modifiers. The begin
 * side may be just a barline or a whole system header (clef/key/time); the algorithm is identical
 * because it reads the rendered SVG bounds rather than reconstructing VexFlow's spacing. */
function clearSpanBetweenModifiers(stave: Stave): { left: number; right: number } {
  const boundsAt = (position: StaveModifierPosition): DOMRect[] =>
    stave
      .getModifiers(position)
      .map((modifier) => modifier.getSVGElement() as SVGGraphicsElement | undefined)
      .filter((element): element is SVGGraphicsElement => !!element && typeof element.getBBox === 'function')
      .map((element) => element.getBBox())
      .filter((bounds) => bounds.width > 0);

  const beginBounds = boundsAt(StaveModifierPosition.BEGIN);
  const endBounds = boundsAt(StaveModifierPosition.END);
  const left = Math.max(...beginBounds.map((bounds) => bounds.x + bounds.width));
  const right = Math.min(...endBounds.map((bounds) => bounds.x));

  if (!Number.isFinite(left) || !Number.isFinite(right) || left >= right) {
    throw new Error('Stave has no visible horizontal span between its begin and end modifiers');
  }
  return { left, right };
}

// The document model is voice-major and staff-blind (staff lives per-note on `Item.notes` — see
// core/model/score.ts); VexFlow draws per PHYSICAL STAFF, so this is the one place that derives a
// staff-major view, locally, at draw time. Splitting a chord `Item` by its notes' own `staffId`
// is also what turns a cross-staff chord into two drawn halves (same carrier id) on two staves.
interface RenderNote {
  /** The carrier id — the chord/rest as a WHOLE (delete-carrier, stem handle, group-select all
   *  key off this). Individual-note selection uses `noteIds` instead — see that field. */
  id: string;
  kind: 'note' | 'rest';
  /** VexFlow keys, e.g. ['c/4', 'e/4'] for a chord — only this staff's share of the chord. */
  keys: string[];
  duration: DurationValue;
  dots: number;
  /** One entry per key: the note's written accidental from `splitItemByStaff`, then — once the
   *  measure resolves them (see "accidentals to draw" in the main effect) — the one to draw, null =
   *  none. */
  accidentals: AccidentalValue[];
  /** Raw staff_step per key (0 = staff bottom line) — for vertical extent / ledger spacing. */
  staffSteps: number[];
  /** One entry per key — the backend's individual note_id, parallel to `keys`/`staffSteps`. */
  noteIds: string[];
  /** One entry per key, 0 = none. */
  fingerings: number[];
  /** The carrier's marks of articulation, drawn once: on the upper half of a cross-staff chord,
   *  none on the other half, and none at all on a carrier that only continues a tie (its marks
   *  are ignored by the sound, so they are not drawn either). */
  articulations: ArticulationMark[];
  /** The carrier's ornament, drawn once like the marks of articulation. */
  ornament: OrnamentSign | null;
}

/** Split one voice-timeline item into its per-staff drawable halves — one entry per staff it
 *  touches (almost always one; two for a cross-staff chord). A rest lives on exactly one staff. */
function splitItemByStaff(item: Item, clefOf: (staffId: string) => Clef, staffOrder: string[], tiedEnds: ReadonlySet<string> = new Set()): Map<string, RenderNote> {
  const out = new Map<string, RenderNote>();
  if (item.kind === 'rest') {
    if (item.staffId !== undefined) {
      out.set(item.staffId, {
        id: item.id,
        kind: 'rest',
        keys: [],
        duration: item.duration,
        dots: item.dots,
        accidentals: [],
        staffSteps: [],
        noteIds: [],
        fingerings: [],
        articulations: [],
        ornament: null,
      });
    }
    return out;
  }
  const byStaff = new Map<string, typeof item.notes>();
  for (const n of item.notes) {
    const arr = byStaff.get(n.staffId);
    if (arr) arr.push(n);
    else byStaff.set(n.staffId, [n]);
  }
  const continuesTie = item.notes.length > 0 && item.notes.every((n) => tiedEnds.has(n.noteId));
  const upperStaffId = [...byStaff.keys()].sort((a, b) => staffOrder.indexOf(a) - staffOrder.indexOf(b))[0];
  for (const [staffId, notes] of byStaff) {
    out.set(staffId, {
      id: item.id,
      kind: 'note',
      keys: notes.map((n) => staffStepToKey(n.staffStep, clefOf(staffId))),
      duration: item.duration,
      dots: item.dots,
      accidentals: notes.map((n) => n.accidental),
      staffSteps: notes.map((n) => n.staffStep),
      noteIds: notes.map((n) => n.noteId),
      fingerings: notes.map((n) => n.fingering),
      articulations: staffId === upperStaffId && !continuesTie ? item.articulations : [],
      ornament: staffId === upperStaffId && !continuesTie && item.ornament && item.ornament !== 'none' ? item.ornament : null,
    });
  }
  return out;
}

/** The room an arpeggio line takes left of a chord: over a chord on both staves the line is drawn once
 *  across the gap (`drawCrossStaffArpeggio`), which VexFlow's own stroke cannot do. It draws only an
 *  invisible mark where the line's left edge will be, so the note's ink box (which the layout keeps clear
 *  of the barline and of its neighbours) reaches as far left as the line does. */
class ArpeggioRoom extends Stroke {
  constructor() {
    super(Stroke.Type.ARPEGGIO_DIRECTIONLESS);
  }
  draw() {
    const ctx = this.checkContext();
    const start = this.checkAttachedNote().getModifierStartXY(this.position, this.index);
    ctx.save();
    ctx.setFillStyle('transparent');
    ctx.fillRect(start.x - 9 + this.x_shift, start.y, 1, 1);
    ctx.restore();
    this.setRendered();
  }
}

/** The wavy line of an arpeggio over a chord on two staves, in one piece from the top note to the bottom
 *  one, with its arrow at the end it rolls to (up: at the top). The geometry is VexFlow's own stroke's. */
function drawCrossStaffArpeggio(upper: StaveNote, lower: StaveNote, mark: 'arpeggio_up' | 'arpeggio_down', room: ArpeggioRoom) {
  const ctx = upper.checkContext();
  const lineSpace = upper.checkStave().getSpacingBetweenLines();
  const start = upper.getModifierStartXY(Modifier.Position.LEFT, 0);
  const x = start.x - 5 + room.getXShift();
  const ys = [...upper.getYs(), ...lower.getYs()];
  const up = mark === 'arpeggio_up';
  const top = Math.min(...ys) + (up ? 1.5 : 0.5) * lineSpace;
  const bottom = Math.max(...ys) + (up ? 1 : 0.5) * lineSpace;
  for (let y = top; y <= bottom; y += lineSpace) Glyph.renderGlyph(ctx, x - 4, y, room.render_options.font_scale, 'vexWiggleArpeggioUp');
  Glyph.renderGlyph(ctx, x + (up ? -3 : -4), up ? top - lineSpace : bottom + 0.5 * lineSpace, room.render_options.font_scale, up ? 'arrowheadBlackUp' : 'arrowheadBlackDown');
}

// VexFlow ornament codes: the backend's upper mordent is the short trill (the inverted mordent of VexFlow)
const ORNAMENT_CODE: Record<Exclude<OrnamentSign, `tremolo_${number}`>, string> = {
  trill: 'tr',
  upper_mordent: 'mordent',
  lower_mordent: 'mordent_inverted',
  turn: 'turn',
  inverted_turn: 'turn_inverted',
};

// VexFlow articulation codes (the fermata's is its above-the-note form — it is never drawn below)
const ARTICULATION_CODE: Record<Exclude<ArticulationMark, 'arpeggio_up' | 'arpeggio_down'>, string> = {
  staccato: 'a.',
  staccatissimo: 'av',
  tenuto: 'a-',
  accent: 'a>',
  marcato: 'a^',
  fermata: 'a@a',
};

// Score-space constants, in STAFF SPACES (the gap between two staff lines — VexFlow's
// `spacing_between_lines_px`, 10 score units at the default size). They live in the score's own
// coordinates, which zoom scales as a whole; expressing them in staff spaces keeps the engraving's
// proportions explicit instead of hiding them in pixel numbers.
const MARGIN_L = 2.4 * STAFF_SPACE;
/** both side margins of a system, in score units — EditorView inverts the page width with it */
export const SCORE_MARGIN_X = 2 * MARGIN_L;
const MARGIN_T = 4 * STAFF_SPACE;
const STAFF_H = 4 * STAFF_SPACE; // staff height (5 lines); stepPx = STAFF_H / 8 (half a line gap per staff_step)
const STAFF_CLEARANCE = 3.4 * STAFF_SPACE; // min gap between a treble's bottom and a bass's top, beyond ledgers
const SYSTEM_GAP = 7.6 * STAFF_SPACE; // min gap between systems, beyond ledger extents (roomy — leaves headroom for measure numbers)
const PAGE_CONTENT_W = 70 * STAFF_SPACE; // A4-ish usable width — the per-system justification target;
// fallback only for when `pageContentWidth` isn't measured yet (Props.pageContentWidth overrides
// this per render — reflow-zoom, see EditorView.tsx)
const MEASURE_RIGHT_PAD = 2.6 * STAFF_SPACE; // breathing room between the last note and the barline
const HEAD_HALF = 1.1 * STAFF_SPACE; // half a notehead's height — note-hitbox padding + extent margin
const DASH_W = 1.6 * STAFF_SPACE; // empty-measure dash width
const DASH_THICK = 0.4 * STAFF_SPACE; // empty-measure dash thickness
const CURSOR_OVERHANG = 1.6 * STAFF_SPACE; // how far the playback cursor reaches past a system's outer staff lines
const STEM_WIDTH = 1.5; // matches VexFlow's own Stem.WIDTH — the custom cross-staff connector must look identical to a native stem
// how far the merged cross-staff stem protrudes PAST the far notehead when no user override sets
// an explicit length — matches ordinary engraving (a stem always sticks out beyond its outermost
// notehead, never stops flush at it). No ambiguous "which staff is closer to the middle line"
// signal exists across two different staves, so direction defaults to DOWN (foot at the upper
// staff's note, same as any stem-down chord's foot sits at its highest note) — fully overridable
// by drag/double-click, exactly like any other note's stem (see the merge pass below).
const DEFAULT_STEM_PROTRUSION = 3.5 * STAFF_SPACE;
const CROSS_STAFF_DEFAULT_DIRECTION: 1 | -1 = -1;

// Gourlay/Ross-style engraving spacing: duration → width grows sub-linearly (each duration
// doubling adds a fixed increment, not a doubled gap) — matches MuseScore/Finale/Sibelius/LilyPond.
// These three constants are the only visual dials; tune by eyeballing rendered output.
const MIN_DURATION_BEATS = 0.125; // 32nd note — smallest supported duration, the calibration anchor
const SPACE_UNIT = STAFF_SPACE; // the room given to the shortest duration
const SPACE_STRETCH = 0.7 * STAFF_SPACE; // the room added per doubling of duration (log2 slope)
const NOTE_HEAD_MIN_GAP = 1.2 * STAFF_SPACE; // collision floor: the least room between consecutive onsets regardless of duration
const ACCIDENTAL_PAD = STAFF_SPACE; // extra room before a note carrying an accidental
const DOT_PAD = 0.4 * STAFF_SPACE; // extra room per augmentation dot after a note

function durationSpacePx(beats: number): number {
  const doublings = Math.log2(Math.max(beats, MIN_DURATION_BEATS) / MIN_DURATION_BEATS);
  return SPACE_UNIT + SPACE_STRETCH * doublings;
}

/** the room one onset of `beats` length takes before the next: its duration's space, never less
 *  than the notehead collision floor */
function onsetGapPx(beats: number): number {
  return Math.max(durationSpacePx(beats), NOTE_HEAD_MIN_GAP);
}

// the room between a grace group and the notes beside it, in staff spaces
const GRACE_PAD = 0.5 * STAFF_SPACE;
// the width of a grace notehead (a notehead's own, 1.2 staff spaces, at VexFlow's grace scale)
const GRACE_HEAD_W = 1.2 * STAFF_SPACE * 0.66;

/** The grace notes of one side (before or after) of a carrier, on one staff. They stand on the
 *  carrier's onset and take their room from the gap beside it, so they are placed by what they
 *  measure once drawn, not by a note of their own. */
interface GraceSet {
  /** the carrier they belong to */
  carrierId: string;
  staffId: string;
  voiceIndex: number;
  onset: number;
  side: 'before' | 'after';
  kind: GraceKind;
  /** this staff's share of each grace carrier, in the order they are played */
  notes: RenderNote[];
  vf: GraceNote[];
  /** the width of the group formatted among itself */
  width: number;
}

/** Builds a set's VexFlow notes (accidentals are already resolved on `notes`) and measures their
 *  width. Grace notes are not beamed here: a beam is a relation the user makes, and the model has
 *  none for grace carriers yet. */
function buildGraceNotes(set: GraceSet, clef: string, inkColor: string): void {
  set.vf = set.notes.map((n) => {
    const grace = new GraceNote({ keys: n.keys, duration: n.duration, clef, slash: set.kind === 'acciaccatura', stem_direction: Stem.UP });
    grace.setLedgerLineStyle({ strokeStyle: inkColor, fillStyle: inkColor });
    n.keys.forEach((_, i) => {
      const acc = n.accidentals[i];
      if (acc) grace.addModifier(new Accidental(acc), i);
    });
    for (let i = 0; i < n.dots; i++) Dot.buildAndAttach([grace], { all: true });
    return grace;
  });
  const voice = new Voice({ num_beats: 4, beat_value: 4 }).setStrict(false);
  voice.addTickables(set.vf);
  const formatter = new Formatter();
  formatter.joinVoices([voice]).format([voice], 0);
  set.width = formatter.getMinTotalWidth();
}

/** VexFlow's default extension, used only for interaction bounds and fallback geometry. */
export const VEXFLOW_STEM_HEIGHT = 3.5 * STAFF_SPACE;
// Minimum protrusion of a stem beyond a chord's outer notehead: a stem is never set shorter, by a drag or by a saved length.
export const MIN_STEM_LENGTH = 2 * STAFF_SPACE;

function buildStaveNote(
  n: RenderNote,
  clef: string,
  inkColor: string,
  stemOverride?: StemPlacement,
): StaveNote {
  const keys = n.keys.length ? n.keys : [clef === 'bass' ? 'd/3' : 'b/4'];
  const sn = new StaveNote({
    keys,
    duration: n.kind === 'rest' ? `${n.duration}r` : n.duration,
    clef,
    // manual override wins; otherwise MuseScore-style automatic direction (VexFlow's own
    // `calculateOptimalStemDirection`: up if the note sits below the middle line, down if at/above
    // it).
    ...(n.kind === 'note' ? (stemOverride?.direction ? { stem_direction: stemOverride.direction } : { auto_stem: true }) : {}),
  });
  sn.setAttribute('natural-stem-length', String(sn.getStemLength()));
  if (stemOverride && n.kind === 'note') {
    if (stemOverride.direction) sn.setStemDirection(stemOverride.direction);
    const natural = sn.getStemLength();
    if (stemOverride.lengthFactor !== 1) {
      sn.setStemLength(Math.max(Math.max(0, natural - VEXFLOW_STEM_HEIGHT) + MIN_STEM_LENGTH, natural * stemOverride.lengthFactor));
      sn.setStemDirection(sn.getStemDirection());
    }
  }
  // VexFlow's ledger-line default (#444, a cool grey) doesn't match either the notation's
  // black noteheads or the app's warm ink token — force them to the same ink so a note sitting
  // on ledger lines reads as one consistent color instead of the lines looking washed out.
  sn.setLedgerLineStyle({ strokeStyle: inkColor, fillStyle: inkColor });
  fixLedgerLineWidth(sn);
  n.keys.forEach((_, i) => {
    const acc = n.accidentals[i];
    if (acc) sn.addModifier(new Accidental(acc), i);
  });
  for (let i = 0; i < n.dots; i++) Dot.buildAndAttach([sn], { all: true });
  // fingering: a number above the note; a chord's numbers stack with the lowest key's nearest
  n.keys
    .map((_, i) => i)
    .filter((i) => n.fingerings[i] > 0)
    .sort((a, b) => n.staffSteps[a] - n.staffSteps[b])
    .forEach((i) =>
      sn.addModifier(
        new Annotation(String(n.fingerings[i])).setVerticalJustification(Annotation.VerticalJustify.TOP),
        i,
      ),
    );
  return sn;
}

/** Measure automatic stem ink for staff spacing, without changing the visible manual engraving. */
function naturalStemInkBox(sn: StaveNote): InkBox {
  const ctx = sn.checkContext();
  const length = sn.getStemLength();
  const direction = sn.getStemDirection();
  const probe = ctx.openGroup('stem-spacing-probe') as SVGGElement;
  try {
    sn.setStemLength(Number(sn.getAttribute('natural-stem-length')));
    sn.setStemDirection(direction);
    sn.draw();
    return inkBox(probe);
  } finally {
    ctx.closeGroup();
    probe.remove();
    sn.setStemLength(length);
    sn.setStemDirection(direction);
  }
}

interface Drawn {
  staffId: string;
  voiceIndex: number;
  notes: RenderNote[];
  sns: StaveNote[];
  /** cumulative onset (in quarter-note beats) of each note, parallel to `notes`/`sns`. */
  onsets: number[];
  /** null for a fully untouched staff (no voice at all) — see `isEmpty`. */
  voice: Voice | null;
  /** this measure's share of each tuplet on this staff and voice — drawn once the system's beams
   *  are (a bracket sits beyond the stems a beam lengthens). */
  tuplets: { id: string; vf: Tuplet }[];
  /** nothing user-entered (no voice, or a single whole-measure rest) — draw a dash instead. */
  isEmpty: boolean;
}

interface Built {
  measure: Measure;
  drawn: Drawn[];
  /** natural (unstretched) note-area width, from the merged cross-voice onset timeline. */
  naturalWidth: number;
  /** onset beat -> cumulative px offset from the measure's note-start, pre-justification. */
  segmentX: Map<number, number>;
  /** Reserved inline-context widths in the same pre-justification units as segmentX. */
  contextWidths: Map<number, number>;
  /** Carrier ids split across staffs; their stemmed halves share one connecting stem and flag. */
  crossStaffCarrierIds: Set<string>;
  /** the time signature differs from the previous measure's, so it is drawn here even mid-system. */
  timeSignatureChanged: boolean;
  /** the clef each of the two staffs has at the start of the measure */
  startClefs: [ClefName, ClefName];
  /** the key (VexFlow's name for it) each staff has at the start of the measure, and the previous
   *  measure's — to cancel it when the key changes here */
  startKeys: [KeyAlteration[], KeyAlteration[]];
  prevKeys: [KeyAlteration[], KeyAlteration[]];
  /** a clef / key change sits exactly on the measure's start, so it is drawn here even mid-system. */
  clefChanged: boolean;
  keyChanged: boolean;
  /** the grace notes of the measure, drawn beside their carriers once those are placed */
  graceSets: GraceSet[];
}

/** what a measure's header draws, in order: clef, key signature, time signature */
interface HeaderSpec {
  clefs: [ClefName, ClefName] | null;
  small: boolean;
  keys: [KeyAlteration[], KeyAlteration[]] | null;
  keyClefs?: [ClefName, ClefName];
  cancelKeys: [KeyAlteration[], KeyAlteration[]] | null;
  timeSignature: string | null;
  /** the measure begins a repeat: room for its sign is kept before the first note (contextMarks draws the sign) */
  repeatSign?: boolean;
}

interface Props {
  document: ScoreDocument;
  selectedIds: string[];
  /** carrier ids selected at CARRIER granularity (stem-click / chord double-click) — see
   *  app/store.ts. Lets a single-note carrier's stem/notehead group tint on selection when it was
   *  explicitly picked as a carrier, without a plain notehead click on that same lone note ever
   *  doing so (see the `.selected` tint effect below). */
  carrierSelectedIds: string[];
  /** The per-system justification target, in layout units (`PAGE_CONTENT_W`'s live
   *  replacement) — "reflow zoom": EditorView.tsx measures the sheet's available width and
   *  divides out the current zoom, so the RENDERED page width stays pinned to the sheet
   *  regardless of zoom level; zoom only changes how much content fits per system (more systems,
   *  taller document), never page width — the sheet never needs horizontal scroll. Undefined
   *  (before the first measurement) falls back to the fixed `PAGE_CONTENT_W` constant. */
  pageContentWidth?: number;
  onLayout: (layout: ScoreLayout) => void;
  /** custom voice-color overrides (keyed by voice id) — see core/model/voiceColors. */
  voiceColors: Record<string, string>;
  /** manual stem direction/length overrides (keyed by note carrier id) — see app/store.ts. */
  stemOverrides: Record<string, StemPlacement>;
  beamPreview?: { id: string; override: BeamOverride } | null;
  slurPreview?: { id: string; offsets: SlurOffsets } | null;
  spanPreview?: SpanPreview | null;
  /** the vertical offset (staff spaces) of the mark being moved by a drag, until it is committed */
  placementPreview?: { id: string; factor: number } | null;
  /** the currently-hovered note carrier ids (ephemeral UI state, lifted in EditorView.tsx) — a
   *  single note on note-hover, a whole measure's on barline-hover, empty otherwise. Lightly
   *  tints the actual note glyph(s), not a box behind them. */
  hoveredNoteIds: string[];
  /** beams, tuplets, time signatures (`ts:<measure id>`) and clefs (`clef:<staff id>`) that are
   *  picked — their engraving is recoloured in place (`data-object-id`). Optional: thumbnails
   *  never pass it. */
  selectedObjectIds?: string[];
  /** the user's vertical nudge of context marks (dynamics, hairpins, tempos), keyed by context id */
  /** entities an insert just created — flashed once (CSS `.insert-flash`, 400ms). Optional:
   *  thumbnails never pass it. */
  flash?: { ids: string[] } | null;
}

export function VexflowRenderer({
  document: doc,
  selectedIds,
  carrierSelectedIds,
  pageContentWidth,
  onLayout,
  voiceColors,
  stemOverrides,
  beamPreview,
  slurPreview,
  spanPreview,
  placementPreview,
  hoveredNoteIds,
  selectedObjectIds,
  flash,
}: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const effectivePageContentWidth = pageContentWidth ?? PAGE_CONTENT_W;
  const selectionKey = selectedIds.join(',');
  const carrierSelectionKey = carrierSelectedIds.join(',');
  const hoverKey = hoveredNoteIds.join(',');
  const objectSelectionKey = (selectedObjectIds ?? []).join(',');

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const horizontal = new Map<string, number>();
    const reaches = new Map<string, number>();
    // a refrain or a volta that starts or ends on a measure line is that barline, drawn by the staves themselves: its sign sits on the line
    // (at a system start, before the clef), never beside it. One that starts or ends inside a measure is drawn by contextMarks.
    const barlines = repeatBarlines(doc);
    const repeatBeginMeasures = new Set(barlines.beginMeasureIds);
    const inlineWidths = new Map<string, number>();
    const widthMinimum = new Map<string, number>();
    const engrave = (): void => {
      passCount += 1;
      host.innerHTML = '';
      const collisions = new CollisionLayout(STAFF_SPACE * 0.6);
      let changed = false;
      const emptyRests: { element: SVGGraphicsElement; staffId: string; measureId: string; left: number; right: number; cx: number; cy: number; ids: string[] }[] = [];

      const staffOrder = doc.staffOrder;
      const contexts = new ContextIndex(doc);
      const tiedEnds = new Set(doc.ties.map((t) => t.endNoteId));
      const inkColor = readCssToken(host, '--color-ink');
      const mutedColor = readCssToken(host, '--color-ink-muted');

      // renderer/context created up front (resized once the total layout is known below) so we
      // can MEASURE the real clef+time-sig glyph width via VexFlow instead of guessing a constant —
      // a guessed width lets notes drift past their own measure's barline.
      const renderer = new Renderer(host, Renderer.Backends.SVG);
      const ctx = renderer.getContext();
      // note-start x of a probe grand staff with the given begin modifiers, measured once per kind
      const noteStartByHeader = new Map<string, number>();
      const probeNoteStartX = (spec: HeaderSpec): number => {
        const key = JSON.stringify(spec);
        const cached = noteStartByHeader.get(key);
        if (cached !== undefined) return cached;
        const probes = [new Stave(0, 0, 1000).setContext(ctx), new Stave(0, 0, 1000).setContext(ctx)];
        probes.forEach((probe, i) => {
          if (spec.clefs) probe.addClef(spec.clefs[i], spec.small ? 'small' : undefined);
          if (spec.keys) { const clef = spec.keyClefs?.[i] ?? (i === 0 ? 'treble' : 'bass'); probe.setClef(clef); createKeySignature(spec.keys[i], clef, spec.cancelKeys?.[i]).addToStave(probe); }
          if (spec.timeSignature) probe.addTimeSignature(spec.timeSignature);
        });
        Stave.formatBegModifiers(probes);
        const noteStartX = Math.max(probes[0].getNoteStartX(), probes[1].getNoteStartX()) + (spec.repeatSign ? REPEAT_SIGN_ROOM : 0);
        noteStartByHeader.set(key, noteStartX);
        return noteStartX;
      };
      const timeSignatureOf = (m: Measure) => {
        const { beats, beatValue, dots = 0 } = m.timeSignature;
        return `${beats * (2 ** (dots + 1) - 1)}/${beatValue * 2 ** dots}`;
      };
      // what a measure's header draws: the clef, key signature and time signature at a system start;
      // whichever of them changes on the measure's own start where it is mid-system; nothing otherwise
      // (a plain measure's own barline padding is the baseline every measure has)
      const headerSpecOf = (b: Built, isFirst: boolean): HeaderSpec => ({
        clefs: isFirst || b.clefChanged ? b.startClefs : null,
        small: !isFirst,
        keys: isFirst || b.keyChanged ? b.startKeys : null,
        keyClefs: b.startClefs,
        cancelKeys: !isFirst && b.keyChanged ? b.prevKeys : null,
        timeSignature: isFirst || b.timeSignatureChanged ? timeSignatureOf(b.measure) : null,
        repeatSign: repeatBeginMeasures.has(b.measure.id),
      });
      const headerW = (b: Built, isFirst: boolean): number =>
        probeNoteStartX(headerSpecOf(b, isFirst)) -
        (isFirst ? 0 : probeNoteStartX({ clefs: null, small: false, keys: null, cancelKeys: null, timeSignature: null }));

      // 1) build the notes + voices per measure, then the measure's Gourlay-style onset timeline:
      // the union of onset beats across ALL its voices (both staffs) — a busy voice's fine onsets
      // force extra segments into a sparser voice's notes, visually stretching them (§ plan step 2).
      //
      // The document is voice-major (see core/model/score.ts) — a measure holds VOICES, and staff
      // is a per-note attribute on each item. VexFlow draws per physical staff, so here we derive a
      // staff-major grouping LOCALLY: walk each voice's own item stream (onset accumulated over
      // that FULL stream, before any staff-split — a cross-staff item's two halves must share the
      // same onset), split each item by its notes' own staffId (`splitItemByStaff`), and bucket the
      // halves by (staffId, voiceId). A staff can now end up with MORE THAN ONE real voice (a
      // cross-staff chord note landing on a staff another voice already occupies) — `Drawn` becomes
      // one entry per (staff, voice-with-content-there) pair instead of one entry per staff.
      interface Group {
        staffId: string;
        voiceId: string;
        notes: RenderNote[];
        onsets: number[];
      }
      const built: Built[] = doc.measures.map((measure, measureIndex) => {
        const totalBeats = lengthOfMeasure(measure.timeSignature);

        const groups = new Map<string, Group>(); // key = `${staffId}:${voiceId}`
        measure.voices.forEach((voice) => {
          voice.items.forEach((item) => {
            const o = item.position;
            const split = splitItemByStaff(item, (id) => contexts.clefNameAt(id, measure.id, item.position), staffOrder, tiedEnds);
            split.forEach((renderNote, staffId) => {
              const key = `${staffId}:${voice.id}`;
              let g = groups.get(key);
              if (!g) {
                g = { staffId, voiceId: voice.id, notes: [], onsets: [] };
                groups.set(key, g);
              }
              g.notes.push(renderNote);
              g.onsets.push(o);
            });
          });
        });

        // grace notes: each side of each carrier, split by the staff its notes stand on
        const graceSets: GraceSet[] = [];
        measure.voices.forEach((voice) => {
          const voiceIndex = doc.voices.findIndex((v) => v.id === voice.id);
          voice.items.forEach((item) => {
            for (const [side, group] of [['before', item.graceBefore], ['after', item.graceAfter]] as const) {
              if (!group) continue;
              const byStaff = new Map<string, RenderNote[]>();
              for (const carrier of group.carriers) {
                splitItemByStaff({ ...carrier, kind: 'note', position: item.position }, (id) => contexts.clefNameAt(id, measure.id, item.position), staffOrder)
                  .forEach((renderNote, staffId) => byStaff.set(staffId, [...(byStaff.get(staffId) ?? []), renderNote]));
              }
              byStaff.forEach((notes, staffId) => graceSets.push({
                carrierId: item.id, staffId, voiceIndex, onset: item.position, side, kind: group.kind, notes, vf: [], width: 0,
              }));
            }
          });
        });

        // Cross-staff chords (one carrier's notes split across MORE THAN ONE staff — see
        // splitItemByStaff) need a SINGLE stem physically connecting both halves, with EXACTLY the
        // same selection/drag/protrusion behaviour as any other note's stem — computed here, BEFORE
        // building StaveNotes, so both halves get a CONSISTENT forced direction (never each
        // independently auto-computed) even before any user override exists; the actual
        // baseY/tipY/length are only knowable once both halves are drawn (real pixel Y), so those
        // are finished in the merge pass after the draw loop below.
        const carrierStaffInfo = new Map<string, { staffs: Set<string> }>();
        for (const g of groups.values()) {
          g.notes.forEach((n) => {
            let info = carrierStaffInfo.get(n.id);
            if (!info) {
              info = { staffs: new Set() };
              carrierStaffInfo.set(n.id, info);
            }
            info.staffs.add(g.staffId);
          });
        }
        const crossStaffCarrierIds = new Set(
          [...carrierStaffInfo.entries()].filter(([, info]) => info.staffs.size > 1).map(([id]) => id),
        );

        // accidentals to draw: each staff position of a staff (staff + staff_step) carries a state
        // through the measure, starting at the key signature's (its alteration for the letter the step
        // lands on under the clef then in effect).
        // A note's accidental is drawn only when it differs from that state, and drawing it sets the
        // state; a repeat of the same accidental later in the measure is not drawn. Walked in onset
        // order across every voice on the staff.
        const keyStates = new Map<string, AccidentalValue>();
        // at one onset the grace notes before come first, then the notes, then the grace notes after
        [
          ...[...groups.values()].flatMap((g) => g.notes.map((n, i) => ({ staffId: g.staffId, n, onset: g.onsets[i], cell: 1 }))),
          ...graceSets.flatMap((set) => set.notes.map((n) => ({ staffId: set.staffId, n, onset: set.onset, cell: set.side === 'before' ? 0 : 2 }))),
        ]
          .sort((a, c) => a.onset - c.onset || a.cell - c.cell)
          .forEach(({ staffId, n, onset }) => {
            n.accidentals = n.accidentals.map((written, k) => {
              const position = `${staffId}:${n.staffSteps[k]}:${contexts.keyAt(staffId, measure.id, onset)?.id}:${contexts.clefAt(staffId, measure.id, onset)?.id}`;
              const accidental = written ?? 'n';
              const clef = contexts.clefNameAt(staffId, measure.id, onset);
              const inKey = contexts.keyAt(staffId, measure.id, onset)?.alterations[letterOfStep(n.staffSteps[k], clef)];
              const base: AccidentalValue = inKey === 'sharp' ? '#' : inKey === 'flat' ? 'b' : 'n';
              if (accidental === (keyStates.get(position) ?? base)) return null;
              keyStates.set(position, accidental);
              return accidental;
            });
          });

        const drawn: Drawn[] = [];
        staffOrder.forEach((staffId) => {
          const staffGroups = [...groups.values()]
            .filter((g) => g.staffId === staffId)
            // stable draw order = document voice order, regardless of which staff a voice lands on
            .sort(
              (a, b) =>
                doc.voices.findIndex((v) => v.id === a.voiceId) - doc.voices.findIndex((v) => v.id === b.voiceId),
            );
          // a fully untouched staff (no voice at all — a "sleeping" measure that was never
          // engine-processed, or simply nothing landed here this measure) gets the SAME
          // empty-measure dash as an explicit whole-rest fill (below).
          if (!staffGroups.length) {
            drawn.push({ staffId, voiceIndex: -1, notes: [], sns: [], onsets: [], voice: null, isEmpty: true, tuplets: [] });
            return;
          }
          staffGroups.forEach((g) => {
            const sns = g.notes.map((n, ni) => {
              const override =
                stemOverrides[n.id] ??
                (crossStaffCarrierIds.has(n.id) ? { direction: CROSS_STAFF_DEFAULT_DIRECTION, lengthFactor: 1 } : undefined);
              return buildStaveNote(n, contexts.clefNameAt(staffId, measure.id, g.onsets[ni]), inkColor, override);
            });
            // before the notes join their voice: a VexFlow tuplet rescales its notes' ticks
            const tuplets = doc.tuplets.flatMap((t) => {
              const members = sns.filter((_, i) => t.carrierIds.includes(g.notes[i].id));
              return members.length
                ? [{ id: t.id, vf: new Tuplet(members, { num_notes: t.numNotes, notes_occupied: t.notesOccupied, bracketed: true }) }]
                : [];
            });
            const voice = new Voice({
              num_beats: measure.timeSignature.beats,
              beat_value: measure.timeSignature.beatValue,
            }).setStrict(false);
            voice.addTickables(sns);
            // data-voice uses the GLOBAL voice index (voices span staffs), so voice colors
            // are consistent regardless of which staff a voice appears on.
            const voiceIndex = doc.voices.findIndex((vr) => vr.id === g.voiceId);
            // a voice with NOTHING user-entered comes back from the backend's gap-fill as a single
            // whole-measure rest — render it as a dash (MuseScore convention), not the rest glyph,
            // so "empty" reads as empty rather than "explicitly silent". Frontend-only: the data
            // model still holds a real rest (the backend has no separate "empty" concept to persist).
            const isEmpty =
              g.notes.length === 1 &&
              g.notes[0].kind === 'rest' &&
              Math.abs(noteBeats(g.notes[0]) - totalBeats) < 1e-6;
            drawn.push({ staffId, voiceIndex, notes: g.notes, sns, onsets: g.onsets, voice, isEmpty, tuplets });
          });
        });

        graceSets.forEach((set) => buildGraceNotes(set, contexts.clefNameAt(set.staffId, measure.id, set.onset), inkColor));
        // the room the grace notes at an onset take on one side of it
        const graceWidth = (onset: number, side: 'before' | 'after'): number =>
          Math.max(0, ...graceSets.filter((set) => set.onset === onset && set.side === side).map((set) => set.width + GRACE_PAD));

        const notesAtOnset = new Map<number, RenderNote[]>();
        const onsetSet = new Set<number>([0, totalBeats]);
        for (const g of groups.values()) {
          g.notes.forEach((n, i) => {
            const o = g.onsets[i];
            onsetSet.add(o);
            const at = notesAtOnset.get(o) ?? [];
            at.push(n);
            notesAtOnset.set(o, at);
          });
        }
        for (const context of doc.contexts) {
        if (context.measureId === measure.id) onsetSet.add(context.position.numerator / context.position.denominator * 4);
        if ('endMeasureId' in context && context.endPosition !== null && context.endMeasureId === measure.id) onsetSet.add(context.endPosition.numerator / context.endPosition.denominator * 4);
      }
      const contextWidth = new Map<number, number>();
        const staffContextWidth = new Map<string, number>();
        for (const c of doc.contexts) {
          if (c.measureId !== measure.id || (c.kind !== 'clef' && c.kind !== 'keySignature')) continue;
          const at = c.position.numerator / c.position.denominator * 4;
          if (at <= 0 || at >= totalBeats) continue;
          const clef = contexts.clefNameAt(c.staffId, measure.id, at);
          const probe = new Stave(0, 0, 1000).setContext(ctx).setClef(clef);
          const width = c.kind === 'keySignature'
            ? createKeySignature(c.alterations, clef, contexts.keyAt(c.staffId, measure.id, at - 0.00001)?.alterations).setStave(probe).getWidth()
            : new VexClef(c.clef, 'small').getWidth();
          const staffKey = `${c.staffId}:${at}`;
          const totalWidth = (staffContextWidth.get(staffKey) ?? 0) + (inlineWidths.get(c.id) ?? width) + STAFF_SPACE;
          staffContextWidth.set(staffKey, totalWidth);
          contextWidth.set(at, Math.max(contextWidth.get(at) ?? 0, totalWidth));
          onsetSet.add(at);
        }
        const sortedOnsets = [...onsetSet].sort((a, b) => a - b);

        // a repeat that begins the measure keeps room for its sign before the first note
        const lead = Math.max(horizontal.get(`${measure.id}:0`) ?? 0, graceWidth(sortedOnsets[0], 'before'));
        const segmentX = new Map<number, number>([[sortedOnsets[0], lead]]);
        let cum = lead;
        for (let i = 1; i < sortedOnsets.length; i++) {
          const b0 = sortedOnsets[i - 1];
          const b1 = sortedOnsets[i];
          const hasAccidentalAtEnd = (notesAtOnset.get(b1) ?? []).some((n) => n.accidentals.some((a) => a));
          const dotsAtStart = (notesAtOnset.get(b0) ?? []).reduce((max, n) => Math.max(max, n.dots), 0);
          const gapW =
            onsetGapPx(b1 - b0) +
            (hasAccidentalAtEnd ? ACCIDENTAL_PAD : 0) +
            dotsAtStart * DOT_PAD + (contextWidth.get(b1) ?? 0) +
            graceWidth(b0, 'after') + graceWidth(b1, 'before');
          cum += Math.max(gapW, horizontal.get(`${measure.id}:${b1}`) ?? 0);
          segmentX.set(b1, cum);
        }
        // A measure is never narrower than its time signature laid out in its own beat unit (4/4 =
        // four quarters' room, 6/8 = six eighths') — so an empty or sparse measure still offers each
        // beat the room a real note there would take. Content that needs less is spread over that
        // width; content that needs more keeps its own.
        const signatureW = measure.timeSignature.beats * onsetGapPx(totalBeats / measure.timeSignature.beats);
        const minimumW = Math.max(signatureW, widthMinimum.get(measure.id) ?? 0);
        if (cum < minimumW) {
          const spread = minimumW / cum;
          segmentX.forEach((segX, beat) => segmentX.set(beat, segX * spread));
          contextWidth.forEach((width, beat) => contextWidth.set(beat, width * spread));
        }
        // + MEASURE_RIGHT_PAD: the onsets above place each note's left edge, so the last note's own
        // glyph still needs room before the barline — part of what the measure needs, so it must
        // flow through packing/justification too.
        const naturalWidth = Math.max(cum, signatureW) + MEASURE_RIGHT_PAD;

        const previous = doc.measures[measureIndex - 1];
        const timeSignatureChanged = !!previous && timeSignatureOf(previous) !== timeSignatureOf(measure);
        const keyNameAt = (staffId: string, atMeasure: Measure): KeyAlteration[] =>
          contexts.keyAt(staffId, atMeasure.id, 0)?.alterations ?? Array(7).fill('natural');
        const startClefs = [0, 1].map((i) => contexts.clefNameAt(staffOrder[i], measure.id, 0)) as [ClefName, ClefName];
        const startKeys = [0, 1].map((i) => keyNameAt(staffOrder[i], measure)) as [KeyAlteration[], KeyAlteration[]];
        const prevKeys = (previous ? [0, 1].map((i) => contexts.keyAt(staffOrder[i], previous.id, lengthOfMeasure(previous.timeSignature))?.alterations ?? Array(7).fill('natural')) : startKeys) as [KeyAlteration[], KeyAlteration[]];
        return {
          measure,
          drawn,
          naturalWidth,
          segmentX,
          contextWidths: contextWidth,
          crossStaffCarrierIds,
          timeSignatureChanged,
          startClefs,
          startKeys,
          prevKeys,
          clefChanged: !!previous && contexts.atMeasureStart('clef', measure.id).length > 0,
          keyChanged: !!previous && contexts.atMeasureStart('keySignature', measure.id).length > 0,
          graceSets,
        };
      });

      // 2) pack measures into systems: greedily fill each system to the page content width by
      // natural (content-driven) width, then justify in step 3
      const systems: Built[][] = [];
      {
        let current: Built[] = [];
        let currentW = 0;
        for (const b of built) {
          const isFirst = current.length === 0;
          const addW = b.naturalWidth + headerW(b, isFirst);
          if (!isFirst && currentW + addW > effectivePageContentWidth) {
            systems.push(current);
            current = [b];
            currentW = b.naturalWidth + headerW(b, true);
          } else {
            current.push(b);
            currentW += addW;
          }
        }
        if (current.length) systems.push(current);
      }

      // compute positions (x/y/width) for every measure before drawing (resize needs totals)
      interface Placed {
        b: Built;
        x: number;
        w: number;
        /** the fixed header width inside `w` — see `headerW`. */
        header: number;
        isFirst: boolean;
        trebleY: number;
        bassY: number;
        /** justification factor applied to this measure's natural onset-segment widths. */
        stretch: number;
      }
      // vertical extents of each system's notes, to space staffs/systems by their ledger reach
      // (staff_step: 0 = staff bottom line, 8 = top line; < 0 or > 8 = ledger lines)
      const stepPx = STAFF_H / 8;
      // per-staff min/max staff_step reached (incl. ledger lines), keyed by staff id — generic over
      // however many staffs are in staffOrder (not hardcoded to treble+bass), so this keeps working
      // if a 3rd+ staff is added later. The current draw pipeline below still only positions exactly
      // two staffs (staffOrder[0]/[1]) — extending THAT to N staffs is a separate, larger change; this
      // just keeps the extent math itself from being the thing that has to be rewritten when it happens.
      const extents = systems.map((sysMeasures) => {
        const byStaff = new Map<string, { min: number; max: number }>(staffOrder.map((id) => [id, { min: 0, max: 8 }]));
        for (const b of sysMeasures) {
          for (const d of b.drawn) {
            const ext = byStaff.get(d.staffId);
            if (!ext) continue;
            for (const n of d.notes) {
              for (const s of n.staffSteps) {
                ext.min = Math.min(ext.min, s);
                ext.max = Math.max(ext.max, s);
              }
            }
          }
        }
        return byStaff;
      });
      const extentOf = (byStaff: Map<string, { min: number; max: number }>, staffId: string) =>
        byStaff.get(staffId) ?? { min: 0, max: 8 };
      const below = (step: number) => Math.max(0, -step) * stepPx + HEAD_HALF; // reach below a bottom line
      const above = (step: number) => Math.max(0, step - 8) * stepPx + HEAD_HALF; // reach above a top line

      // Measure widths follow their natural (content-driven) onset-segment width — NOT equal
      // across a system — so a measure with many small notes is visibly wider than a neighboring
      // measure of long notes. Each system is then justified (stretched, never compressed) to fill
      // the page content width. Vertical gaps are dynamic: the treble→bass gap grows
      // with the treble's lowest and the bass's highest notes (incl. ledger lines); the system gap
      // likewise with the reaches between them.
      const placedSystems: Placed[][] = [];
      let totalW = 0;
      let cursorY = MARGIN_T + Math.max(0, ...systems[0]?.map((b) => reaches.get(`${b.measure.id}:${staffOrder[0]}:above`) ?? 0) ?? [0]);
      systems.forEach((sysMeasures, si) => {
        const ex = extents[si];
        const measured = (staffId: string, side: string) => Math.max(0, ...sysMeasures.map((b) => reaches.get(`${b.measure.id}:${staffId}:${side}`) ?? 0));
        const staffGap =
          STAFF_H +
          Math.max(below(extentOf(ex, staffOrder[0]).min), measured(staffOrder[0], 'below')) +
          Math.max(above(extentOf(ex, staffOrder[1]).max), measured(staffOrder[1], 'above')) +
          STAFF_CLEARANCE;
        const trebleY = cursorY;
        const bassY = trebleY + staffGap;

        // headers (`headerW`) are fixed (never stretched — the clef glyph doesn't scale), so the
        // stretch factor must be solved against the STRETCHABLE (content-only) width, not the
        // system's full natural width incl. headers — otherwise a system with few measures (where
        // the fixed clef is a bigger fraction of the total, e.g. a short trailing system)
        // under-stretches and falls short of PAGE_CONTENT_W, leaving a gap on the right.
        const headers = sysMeasures.map((b, mi) => headerW(b, mi === 0));
        const headersW = headers.reduce((sum, h) => sum + h, 0);
        const contentNaturalW = sysMeasures.reduce((sum, b) => sum + b.naturalWidth, 0);
        const naturalSystemW = contentNaturalW + headersW;
        const stretch =
          naturalSystemW <= effectivePageContentWidth
            ? (effectivePageContentWidth - headersW) / contentNaturalW
            : 1;
        let x = MARGIN_L;
        const placed = sysMeasures.map((b, mi) => {
          const header = headers[mi];
          const w = b.naturalWidth * stretch + header;
          const item: Placed = { b, x, w, header, isFirst: mi === 0, trebleY, bassY, stretch };
          x += w;
          return item;
        });
        totalW = Math.max(totalW, x + MARGIN_L);
        placedSystems.push(placed);

        const nextTrebleUp =
          si + 1 < extents.length ? Math.max(above(extentOf(extents[si + 1], staffOrder[0]).max),
            ...systems[si + 1].map((b) => reaches.get(`${b.measure.id}:${staffOrder[0]}:above`) ?? 0)) : 0;
        cursorY = bassY + STAFF_H + Math.max(below(extentOf(ex, staffOrder[1]).min), measured(staffOrder[1], 'below')) + nextTrebleUp + SYSTEM_GAP;
      });
      const totalH = cursorY + 20;
      renderer.resize(totalW, totalH);


      // beams, before anything draws: a beamed note leaves its stem and flag to its beam. Each beam
      // is cut into runs of members that share a system (a beam can cross a barline, but not a
      // system break); a run of one keeps its own flag. A cross-staff carrier is beamed by its half
      // on the upper staff; rests are left out, the beam runs over them. Direction comes from the
      // first member with a stem override, otherwise VexFlow's automatic one for the run.
      const carrierHalf = new Map<string, { sn: StaveNote; system: number }>();
      systems.forEach((sysMeasures, si) => {
        for (const b of sysMeasures) {
          for (const d of b.drawn) {
            d.sns.forEach((sn, ni) => {
              const n = d.notes[ni];
              // `drawn` runs in staff order, so the first half seen is the upper one
              if (n.kind === 'note' && !carrierHalf.has(n.id)) carrierHalf.set(n.id, { sn, system: si });
            });
          }
        }
      });
      const beamsBySystem: { id: string; vf: Beam }[][] = systems.map(() => []);
      for (const beam of doc.beams) {
        const override = beam.carrierIds.map((id) => stemOverrides[id]).find((o) => o !== undefined);
        const members = beam.carrierIds.flatMap((id) => carrierHalf.get(id) ?? []);
        const runs: { sn: StaveNote; system: number }[][] = [];
        for (const member of members) {
          const run = runs[runs.length - 1];
          if (run && run[0].system === member.system) run.push(member);
          else runs.push([member]);
        }
        for (const run of runs) {
          if (run.length < 2) continue;
          const sns = run.map((m) => m.sn);
          if (override) sns.forEach((sn) => sn.setStemDirection(override.direction));
          beamsBySystem[run[0].system].push({ id: beam.id, vf: new Beam(sns, !override) });
        }
      }

      // A beam chooses the direction on the carrier's upper half; both halves must displace
      // adjacent noteheads on the same side of their shared stem.
      for (const b of built) for (const d of b.drawn) d.sns.forEach((sn, i) => {
        const id = d.notes[i].id;
        const upper = carrierHalf.get(id)?.sn;
        if (b.crossStaffCarrierIds.has(id) && upper?.hasBeam() && sn !== upper) {
          sn.setStemDirection(upper.getStemDirection());
        }
      });

      const tupletsBySystem: { id: string; vf: Tuplet; measureId: string; staffId: string }[][] = systems.map(() => []);
      for (const b of built) for (const d of b.drawn) for (const local of d.tuplets) local.vf.detach();
      for (const t of doc.tuplets) {
        systems.forEach((sys, si) => {
          for (const staffId of staffOrder) {
            const members = sys.flatMap((b) => b.drawn.filter((d) => d.staffId === staffId).flatMap((d) =>
              d.sns.flatMap((sn, i) => t.carrierIds.includes(d.notes[i].id) ? [{ sn, carrierId: d.notes[i].id, measureId: b.measure.id }] : [])));
            members.sort((a, b) => t.carrierIds.indexOf(a.carrierId) - t.carrierIds.indexOf(b.carrierId));
            if (!members.length) continue;
            tupletsBySystem[si].push({ id: t.id, staffId, measureId: members[0].measureId,
              vf: new Tuplet(members.map((m) => m.sn), { num_notes: t.numNotes, notes_occupied: t.notesOccupied, bracketed: true }) });
          }
        });
      }

      // articulations, once every stem direction is final (a beam may have turned it): on the side
      // opposite the stem; a fermata always above. An arpeggio is a wavy line left of the chord (a
      // chord has two or more notes, up = the arrow at the top). VexFlow's stroke names are the other
      // way round (its ROLL_DOWN has the arrow at the top). On a chord on both staves the line is drawn
      // once across them after both halves are drawn (`crossArpeggios`)
      const crossArpeggios: { upper: StaveNote; lower: StaveNote; mark: 'arpeggio_up' | 'arpeggio_down'; room: ArpeggioRoom }[] = [];
      for (const b of built) {
        for (const d of b.drawn) {
          d.sns.forEach((sn, ni) => {
            for (const mark of d.notes[ni].articulations) {
              if (mark === 'arpeggio_up' || mark === 'arpeggio_down') {
                const halves = b.drawn.flatMap((other) => other.notes.flatMap((n, i) => (n.id === d.notes[ni].id ? [{ sn: other.sns[i], count: n.keys.length }] : [])));
                if (halves.reduce((total, h) => total + h.count, 0) < 2) continue;
                const lower = halves.find((h) => h.sn !== sn);
                if (lower) {
                  const room = new ArpeggioRoom();
                  sn.addModifier(room, 0);
                  lower.sn.addModifier(new ArpeggioRoom(), 0);
                  crossArpeggios.push({ upper: sn, lower: lower.sn, mark, room });
                } else {
                  sn.addModifier(new Stroke(mark === 'arpeggio_up' ? Stroke.Type.ROLL_DOWN : Stroke.Type.ROLL_UP), 0);
                }
                continue;
              }
              const above = mark === 'fermata' || sn.getStemDirection() === Stem.DOWN;
              sn.addModifier(
                new Articulation(ARTICULATION_CODE[mark]).setPosition(
                  above ? Modifier.Position.ABOVE : Modifier.Position.BELOW,
                ),
                0,
              );
            }
            const ornament = d.notes[ni].ornament;
            const strokes = ornament ? TREMOLO_STROKES[ornament] : undefined;
            if (ornament && strokes) sn.addModifier(new Tremolo(strokes), 0);
            else if (ornament) sn.addModifier(new Ornament(ORNAMENT_CODE[ornament as keyof typeof ORNAMENT_CODE]).setPosition(Modifier.Position.ABOVE), 0);
          });
        }
      }

      // 3) draw
      const timeMap: TimeMapEntry[] = [];
      const noteBoxes: NoteBox[] = [];
      const graceSlots: GraceSlot[] = [];
      const staffZones: StaffZone[] = [];
      const stemHandles: StemHandle[] = [];
      const beamShapes: BeamShape[] = [];
      const tupletShapes: TupletShape[] = [];
      const timeSignatureShapes: TimeSignatureShape[] = [];
      const contextShapes: ContextShape[] = [];
      const slurShapes: SlurShape[] = [];
      const systemOf = new Map<string, number>();
      // the voice a carrier belongs to, for the colour of the beam / tuplet drawn over it
      const voiceOfCarrier = new Map<string, number>();
      for (const b of built) for (const d of b.drawn) for (const n of d.notes) voiceOfCarrier.set(n.id, d.voiceIndex);
      const objectVoiceColor = (carrierId: string | undefined): string | undefined => {
        const index = carrierId ? (voiceOfCarrier.get(carrierId) ?? -1) : -1;
        return index >= 0 ? resolveVoiceColor(doc.voices[index].id, index, voiceColors) : undefined;
      };
      /** marks a drawn group as a pickable object: its id and its voice's colour */
      const tagObject = (el: Element | undefined, id: string, carrierId?: string) => {
        if (!el) return;
        el.setAttribute('data-object-id', id);
        const color = objectVoiceColor(carrierId);
        (el as SVGElement).style.setProperty('--voice-color', color ?? 'var(--color-accent)');
      };
      // one box per measure, from the DRAWN staves (top line to bottom line, plus the cursor's
      // overhang) — the area the measure-selection wash covers (Overlay.tsx)
      const measures: MeasureBox[] = [];
      let cumBeat = 0;
      // VexFlow's silent per-note stave-padding offset (see `padding` below) is a fixed quirk of
      // its own `.setStave()`/draw pipeline, not a value specific to any one measure — so a
      // measure's own real note is the BEST calibration source when it has one, but any other
      // measure's real note in this same render pass is just as valid a source, and far better
      // than assuming a false zero. Carried across the whole draw loop (last real measurement
      // wins) so a measure with NO notes of its own (first insert into a fully empty measure) still
      // gets the correct offset instead of the pure, uncorrected formula. Seeded from the
      // always-available probe measurement (not 0) so this is correct even when NOTHING in the
      // document has a real note yet, or the very first measure(s) in draw order are the empty
      // ones — the systemic fix, not just "usually right because something upstream had content".
      let documentPadding = getNotePaddingPx();
      // 1-based measure number, counted across the whole piece (document order = draw order).
      let measureNumber = 0;

      // where each note was drawn (carrier half, key index, system), for the ties drawn last
      const drawnNoteAt = new Map<string, { sn: StaveNote; index: number; system: number }>();
      const sharedStems = new Map<string, { line: SVGPathElement; topNoteY: number; bottomNoteY: number }>();

      placedSystems.forEach((placed, si) => {
        const sysStaffs: { treble: Stave; bass: Stave }[] = [];

        placed.forEach(({ b, x, w, header, isFirst, trebleY, bassY, stretch }, mi) => {
          measureNumber += 1;
          // context first, so begin-modifier glyph widths are measured for alignment
          const treble = new Stave(x, trebleY, w).setContext(ctx);
          const bass = new Stave(x, bassY, w).setContext(ctx);
          const head = headerSpecOf(b, isFirst);
          [treble, bass].forEach((staff, i) => {
            if (head.clefs) staff.addClef(head.clefs[i], head.small ? 'small' : undefined);
            if (head.keys) { staff.setClef(b.startClefs[i]); createKeySignature(head.keys[i], b.startClefs[i], head.cancelKeys?.[i]).addToStave(staff); }
            if (head.timeSignature) staff.addTimeSignature(head.timeSignature);
          });
          // align both staffs' begin modifiers (treble & bass clefs differ in width) so notes
          // start at the same x → same-beat notes across the grand staff line up vertically
          Stave.formatBegModifiers([treble, bass]);
          // a repeat sign that begins the system stands after the clef, key and time signature, before the first note: the room for it
          // is added to where the notes start (contextMarks draws the sign there)
          const room = head.repeatSign ? REPEAT_SIGN_ROOM : 0;
          const noteStartX = Math.max(treble.getNoteStartX(), bass.getNoteStartX()) + room;
          treble.setNoteStartX(noteStartX);
          bass.setNoteStartX(noteStartX);
          treble.draw();
          bass.draw();
          sysStaffs.push({ treble, bass });
          [treble, bass].forEach((staff, i) => {
            for (const modifier of staff.getModifiers()) {
              if (modifier.getCategory() === 'Barline') continue;
              collisions.add(modifier.getSVGElement(), { measureId: b.measure.id, staffId: staffOrder[i], kind: 'header' });
            }
            const area = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
            area.setAttribute('x', String(x)); area.setAttribute('y', String(staff.getYForLine(0)));
            area.setAttribute('width', String(w)); area.setAttribute('height', String(STAFF_H));
            area.setAttribute('fill', 'none'); area.setAttribute('stroke', 'none');
            host.querySelector('svg')!.appendChild(area);
            collisions.add(area, { measureId: b.measure.id, staffId: staffOrder[i], kind: 'staff' });
          });
          for (const staff of [treble, bass]) {
            const sig = staff.getModifiers(StaveModifierPosition.BEGIN, TimeSignature.CATEGORY)[0]?.getSVGElement();
            if (sig) {
              tagObject(sig, `ts:${b.measure.id}`);
              timeSignatureShapes.push({ measureId: b.measure.id, html: sig.innerHTML });
            }
          }
          for (const [staff, staffId] of [[treble, staffOrder[0]], [bass, staffOrder[1]]] as const) {
            // the clef and key signature a stave draws at its start are the contexts in effect there
            for (const [category, kind] of [[VexClef.CATEGORY, 'clef'], [KeySignature.CATEGORY, 'keySignature']] as const) {
              const drawn = staff.getModifiers(StaveModifierPosition.BEGIN, category)[0]?.getSVGElement();
              const context = kind === 'clef' ? contexts.clefAt(staffId, b.measure.id, 0) : contexts.keyAt(staffId, b.measure.id, 0);
              if (drawn && context) {
                if (context.kind === 'clef' && context.octaveTransposition) {
                  const box = (drawn as SVGGraphicsElement).getBBox();
                  const number = document.createElementNS('http://www.w3.org/2000/svg', 'text');
                  number.textContent = String(Math.abs(context.octaveTransposition) * 7 + 1);
                  number.setAttribute('x', String(box.x + box.width / 2));
                  number.setAttribute('y', String(context.octaveTransposition > 0 ? box.y - STAFF_SPACE / 2 : box.y + box.height + STAFF_SPACE));
                  number.setAttribute('text-anchor', 'middle'); number.setAttribute('font-size', String(STAFF_SPACE)); number.setAttribute('fill', inkColor);
                  drawn.appendChild(number);
                }
                // the number stands a fixed share of a space off the clef: the factor scales that distance, on the side the number is on
                const numberSide = context.kind === 'clef' && context.octaveTransposition > 0 ? -1 : 1;
                const offset = numberSide * (bodyFactor(doc.presentation, context.id) - 1) * (numberSide === -1 ? STAFF_SPACE / 2 : STAFF_SPACE);
                if (offset) {
                  const placement = document.createElementNS('http://www.w3.org/2000/svg', 'g');
                  placement.setAttribute('transform', `translate(0 ${offset})`);
                  placement.append(...drawn.childNodes); drawn.appendChild(placement);
                }
                tagObject(drawn, context.id);
                contextShapes.push({ id: context.id, html: drawn.innerHTML });
              }
            }
          }
          systemOf.set(b.measure.id, si);
          // measure number above each system's FIRST measure (engraving convention). Counted
          // from 1 across the piece, on every system including the first. Sits just above the top
          // staff line, at the measure's left edge.
          if (mi === 0) {
            ctx.save();
            ctx.setFont('Georgia, serif', 11, 'italic');
            ctx.setFillStyle(mutedColor);
            ctx.fillText(String(measureNumber), x + 2, treble.getYForLine(0) - 6);
            ctx.restore();
          }
          // insertion geometry: a clickable zone per staff (bottom line = staff_step 0).
          // The bottom line's y is read from the Stave itself: the y given to `new Stave(x, y, w)`
          // is the staff's box top, which VexFlow places `space_above_staff_ln` lines above the
          // first drawn line. `Stave.getBottomLineY()` is not it either — despite its name it
          // returns `getYForLine(num_lines)`, one line spacing below the real bottom line
          // (`num_lines - 1`, 0-indexed), which `getYForLine(getNumLines() - 1)` is.
          const staffBottomLineY = (staff: Stave) => staff.getYForLine(staff.getNumLines() - 1);
          // A zone is the measure's NOTE AREA only: it starts after the measure's header (clef /
          // key / time signature — `header`, the fixed width measured by `headerW`, so any future
          // begin modifier is excluded the same way), and a header is no insert target. A plain
          // measure has no header, so its zone starts at its own left edge (`x`, the previous
          // measure's barline) and adjacent zones share a boundary with no gap — a barline always
          // resolves inside its own measure row, never a dead gap (not `noteStartX`, which sits a
          // few px right of the barline). interp() over `segments` (not x0/x1) still does the actual
          // beat snapping, so this only decides WHETHER and which zone is picked, never the snapped
          // position within it.
          const zoneX0 = x + header;
          const stepPx = STAFF_H / 8;
          const beats = b.measure.timeSignature.beats;
          const beatValue = b.measure.timeSignature.beatValue;

          const staffInfo: Record<string, { staff: Stave; y: number }> = {
            [staffOrder[0]]: { staff: treble, y: trebleY },
            [staffOrder[1]]: { staff: bass, y: bassY },
          };

          // note area width is this measure's own (possibly justified) natural width
          const formatW = Math.max(w - header - MEASURE_RIGHT_PAD, 40); // pad already in `w` via naturalWidth
          // join voices GROUPED BY STAFF (not all together, and not each alone) — joining voices
          // across the two staffs makes VexFlow shift same-beat notes apart as if they collided on
          // one staff, but two REAL voices sharing the SAME staff (e.g. a cross-staff chord note
          // landing where another voice already lives) need VexFlow's own multi-voice collision
          // avoidance, which only kicks in when they're joined TOGETHER. format() still tick-aligns
          // every voice across the grand staff regardless of grouping.
          // Bound to its OWN staff by staff-id (not a positional voices[0]/[1] index) — a staff
          // with no voice at all (empty) must not shift which real voice lands on which staff.
          const realVoices = b.drawn
            .map((d) => ({ voice: d.voice, staff: staffInfo[d.staffId]?.staff }))
            .filter((v): v is { voice: Voice; staff: Stave } => v.voice !== null && !!v.staff);
          if (realVoices.length) {
            realVoices.forEach(({ voice, staff }) => voice.setStave(staff));
            const formatter = new Formatter({ softmaxFactor: 1 });
            const byStaffVoices = new Map<Stave, Voice[]>();
            realVoices.forEach(({ voice, staff }) => {
              const arr = byStaffVoices.get(staff) ?? [];
              arr.push(voice);
              byStaffVoices.set(staff, arr);
            });
            byStaffVoices.forEach((voices) => formatter.joinVoices(voices));
            formatter.format(
              realVoices.map((v) => v.voice),
              formatW,
            );
            // override the formatter's own x with the Gourlay-style position: cumulative width
            // over the measure's merged cross-voice onset timeline (built in step 1), scaled by
            // this system's justification factor — so a note's gap depends on the busiest voice
            // at that beat, not just its own duration, and can differ measure to measure.
            // NB: Note.getAbsoluteX() deliberately EXCLUDES x_shift (VexFlow's own doc comment),
            // and — at this point, before the note's own `.stave` back-reference is set during
            // draw — it ALSO excludes staff.getNoteStartX(), returning just the tick context's
            // own x. The staff offset gets added a SECOND time at actual render, so noteStartX
            // must NOT be baked into the shift here (double-counted otherwise): target the
            // content-relative segX only, not `noteStartX + segX`.
            b.drawn.forEach((d) => {
              if (d.isEmpty) return;
              d.sns.forEach((sn, ni) => {
                const segX = b.segmentX.get(d.onsets[ni]) ?? 0;
                const targetX = segX * stretch;
                sn.setXShift(sn.getXShift() + (targetX - sn.getAbsoluteX()));
                // Where a mark sits relative to its note comes from `getModifierStartXY`, which builds on
                // `getAbsoluteX()` — and that leaves out `x_shift`, the shift just given. A RIGHT mark
                // (a dot) adds the note's `x_shift` itself; accidentals (LEFT) and articulations /
                // fingering (ABOVE / BELOW) do not, so they would drift off their note by the shift,
                // growing along the measure. Give those the shift here, at the source.
                const nativeStart = sn.getModifierStartXY.bind(sn);
                sn.getModifierStartXY = (position, index, options) => {
                  const start = nativeStart(position, index, options);
                  return position === Modifier.Position.RIGHT ? start : { x: start.x + sn.getXShift(), y: start.y };
                };
              });
            });
          }

          // accumulates each half of a cross-staff chord (`b.crossStaffCarrierIds`) as it's drawn,
          // so a single connecting stem can be drawn ONCE both halves' real pixel positions are
          // known — see the merge pass right after this loop.
          const crossStaffHalves = new Map<string, { sn: StaveNote; staffId: string }[]>();
          // where each carrier was drawn (all its halves), for the grace notes beside it
          const hostInk = new Map<string, { left: number; right: number }>();
          // where each grace carrier was drawn, by the carrier and side it belongs to
          const graceColumns = new Map<string, Map<string, { left: number; right: number; headLeft: number }>>();
          b.drawn.forEach((d) => {
            const info = staffInfo[d.staffId];
            if (!info) return;

            if (d.isEmpty) {
              // Empty-measure dash (MuseScore convention): center it in the real visible gap between
              // the nearest rendered elements. In a regular measure those are the two barlines; at
              // a system start the left element is whichever begin modifier actually ends last.
              const { left, right } = clearSpanBetweenModifiers(info.staff);
              const cx = (left + right) / 2;
              // Standard whole-rest position: a filled bar hanging directly below the staff's
              // second line from the top. `cy` is the rectangle's own center, so its top edge sits
              // flush against that line.
              const cy = info.staff.getYForLine(1) + DASH_THICK / 2 + (d.notes[0] ? bodyFraction(doc.presentation, d.notes[0].id) * STAFF_H : 0);
              ctx.save();
              ctx.setFillStyle(inkColor);
              const restGroup = ctx.openGroup('measure-rest') as SVGGElement;
              ctx.fillRect(cx - DASH_W / 2, cy - DASH_THICK / 2, DASH_W, DASH_THICK);
              ctx.closeGroup();
              emptyRests.push({ element: restGroup, staffId: d.staffId, measureId: b.measure.id, left, right, cx, cy, ids: d.notes.map((n) => n.id) });
              ctx.restore();
              // Only a real whole-measure rest (a voice's gap-fill) is selectable. A staff no voice
              // reaches in this measure has no entity behind its dash, so it gets no hit target —
              // a click there is a click on the empty staff.
              const rest = d.notes[0];
              if (rest) {
                noteBoxes.push({
                  id: rest.id,
                  carrierId: rest.id,
                  staffId: d.staffId,
                  x: cx - DASH_W / 2 - 7,
                  y: cy - HEAD_HALF,
                  w: DASH_W + 14,
                  h: HEAD_HALF * 2,
                });
              }
              return;
            }

            d.sns.forEach((sn, ni) => {
              if (d.notes[ni].kind === 'rest') sn.setKeyLine(0, sn.getKeyLine(0) - bodyFraction(doc.presentation, d.notes[ni].id) * (STAFF_H / STAFF_SPACE));
            });
            d.voice?.draw(ctx, info.staff);
            d.sns.forEach((sn, ni) => {
              const g = sn.getSVGElement();
              // VexFlow draws a note's modifiers (articulation, fingering) inside the notehead group
              // after its glyph; moved into one group of their own so a notehead's box stays its glyph
              // alone (hit boxes, chord columns and the whole-note shrink measure it) and no modifier
              // path reads as a ledger line below
              const headModifiers = g ? [...g.querySelectorAll('.vf-notehead')].map((head) => ({ head, els: [...head.children].slice(1) })) : [];
              const modifierEls = headModifiers.flatMap((entry) => entry.els);
              // an ornament stands above the other marks drawn above its note: VexFlow stacks the two independently, so the
              // ornament is lifted clear of the measured ink of those marks
              const ornamentEl = modifierEls.find((el): el is SVGGraphicsElement => el instanceof SVGGraphicsElement && el.classList.contains('vf-ornament'));
              if (g && ornamentEl) {
                const noteTop = Math.min(...[...g.querySelectorAll('.vf-notehead')].flatMap((nh) => (nh.firstElementChild instanceof SVGGraphicsElement ? [inkBox(nh.firstElementChild).y] : [])));
                const marksAbove = modifierEls.filter((el): el is SVGGraphicsElement => el instanceof SVGGraphicsElement && el !== ornamentEl)
                  .map(inkBox).filter((box) => box.y < noteTop);
                const ornamentBox = inkBox(ornamentEl);
                const lift = marksAbove.length ? ornamentBox.y + ornamentBox.height - Math.min(...marksAbove.map((box) => box.y)) + collisions.gap : 0;
                if (lift > 0) ornamentEl.setAttribute('transform', `translate(0 ${-lift})`);
              }
              if (g && modifierEls.length) {
                const holder = document.createElementNS('http://www.w3.org/2000/svg', 'g');
                holder.setAttribute('class', 'vf-note-modifiers');
                holder.append(...modifierEls);
                g.appendChild(holder);
              }
              g?.setAttribute('data-note-id', d.notes[ni].id);
              g?.setAttribute('data-voice', String(d.voiceIndex));
              const manualStem = sn.hasStem() && !sn.hasBeam() && !b.crossStaffCarrierIds.has(d.notes[ni].id)
                && (stemOverrides[d.notes[ni].id]?.lengthFactor ?? 1) !== 1;
              const spacingBox = manualStem ? naturalStemInkBox(sn) : undefined;
              const ink = collisions.add(g, { staffId: d.staffId, measureId: b.measure.id, beat: d.onsets[ni], kind: 'rhythm' }, spacingBox)?.box;
              if (ink) {
                const known = hostInk.get(d.notes[ni].id);
                hostInk.set(d.notes[ni].id, { left: Math.min(known?.left ?? Infinity, ink.x), right: Math.max(known?.right ?? -Infinity, ink.x + ink.width) });
              }
              // Tag ledger lines with `vf-ledger` so the selection tint can skip them — they're bare
              // horizontal `<path>` children under `.vf-stavenote` with no VexFlow class, same as
              // the flag glyph and augmentation dots, so a naive "skip direct-child paths" rule
              // would leave those un-tinted too. Identified by their flat horizontal `d`.
              if (g) {
                const nheads = [...g.querySelectorAll('.vf-notehead')];
                [...g.children].forEach((el) => {
                  if (el.tagName !== 'path' || nheads.some((nh) => nh.contains(el))) return;
                  const m = (el.getAttribute('d') ?? '').match(/^M([\d.-]+) ([\d.-]+)L([\d.-]+) ([\d.-]+)/);
                  if (m && Math.abs(parseFloat(m[2]) - parseFloat(m[4])) < 0.01) el.classList.add('vf-ledger');
                });
              }
              // the stem and its flag are one engraved unit: one group, so the highlight, the selection tint and the hit area treat them as a whole
              // A cross-staff chord gets its shared stem and flag in the merge pass.
              const stemEl = g?.querySelector(':scope > .vf-stem');
              if (g && stemEl && !b.crossStaffCarrierIds.has(d.notes[ni].id)) {
                const unit = document.createElementNS('http://www.w3.org/2000/svg', 'g');
                unit.setAttribute('class', 'vf-stem-unit');
                const flagEl = [...g.children].find((el) => el.tagName === 'path' && !el.classList.contains('vf-ledger'));
                g.insertBefore(unit, stemEl);
                unit.append(stemEl, ...(flagEl ? [flagEl] : []));
              }
              if (d.notes[ni].kind === 'note' && d.notes[ni].duration === 'w') shrinkWholeNotehead(g);
              const voiceId = doc.voices[d.voiceIndex]?.id;
              if (voiceId) {
                g?.style.setProperty('--voice-color', resolveVoiceColor(voiceId, d.voiceIndex, voiceColors));
              }
              // hitbox = a tight box around the NOTEHEAD(S) only (never the stem). One box per
              // INDIVIDUAL note (a chord's several keys, tagged `data-individual-note-id`, each
              // click-selectable on its own) rather than one box spanning the whole chord — a real
              // requested feature: click a specific notehead to select just that note; fast
              // double-click (Overlay.tsx) expands to the whole chord via `carrierId`.
              const carrierId = d.notes[ni].id;
              const noteIdsForKeys = d.notes[ni].noteIds;
              if (g && d.notes[ni].kind === 'note' && noteIdsForKeys.length > 1) {
                const order = noteIdsForKeys
                  .map((id, i) => ({ id, step: d.notes[ni].staffSteps[i] }))
                  .sort((a, b) => a.step - b.step); // ascending pitch — matches the notehead sort order
                const noteheadEls = [...g.querySelectorAll<SVGGraphicsElement>('.vf-notehead')].sort(
                  (a, b) => b.getBBox().y - a.getBBox().y,
                );
                // ascending-pitch order (index 0 = lowest = largest y) — same convention as `sorted`
                // above, so consecutive entries here are always immediate pitch-neighbors.
                const centers = noteheadEls.map((el) => {
                  const b = el.getBBox();
                  return b.y + b.height / 2;
                });
                order.forEach((o, i) => {
                  const el = noteheadEls[i];
                  if (!el) return;
                  el.setAttribute('data-individual-note-id', o.id);
                  const box = el.getBBox();
                  const cy = centers[i];
                  // Clamp the vertical extent to the midpoint with each pitch-neighbor — a
                  // 2nd-interval chord's notes sit only ~5px apart, so a fixed pad made adjacent
                  // boxes overlap and steal each other's clicks. At the chord's top/bottom (no
                  // neighbor to split with) extend by half a notehead height, not the full
                  // `HEAD_HALF` (~11px), which made the outermost note grabbable far past its glyph.
                  const outerPad = box.height * 0.7;
                  const topLimit = i + 1 < centers.length ? (cy + centers[i + 1]) / 2 : box.y - outerPad;
                  const bottomLimit = i - 1 >= 0 ? (cy + centers[i - 1]) / 2 : box.y + box.height + outerPad;
                  noteBoxes.push({
                    id: o.id,
                    carrierId,
                    staffId: d.staffId,
                    x: box.x - 6,
                    y: topLimit,
                    w: box.width + 12,
                    h: bottomLimit - topLimit,
                  });
                });
              } else {
                // single note or rest — one box, id === its own single note id (or the carrier id
                // for a rest, which has no individual notes at all).
                const singleId = noteIdsForKeys[0] ?? carrierId;
                const el = g?.querySelector<SVGGraphicsElement>('.vf-notehead');
                el?.setAttribute('data-individual-note-id', singleId);
                const headX0 = sn.getNoteHeadBeginX();
                const headX1 = sn.getNoteHeadEndX();
                const ys = sn.getYs();
                const top = Math.min(...ys);
                const bottom = Math.max(...ys);
                noteBoxes.push({
                  id: singleId,
                  carrierId,
                  staffId: d.staffId,
                  x: headX0 - 7,
                  y: top - HEAD_HALF,
                  w: headX1 - headX0 + 14,
                  h: bottom - top + HEAD_HALF * 2,
                });
              }
              // what each mark is, and for the ones that belong to one key (its fingering, its accidental) which note: hovering or
              // picking such a mark is hovering or picking that note, any other mark belongs to the chord
              for (const { head, els } of headModifiers) {
                const noteId = head.getAttribute('data-individual-note-id');
                // the accidental is a bare path like the accent and the dots: it is the one that stands left of its notehead
                const glyph = head.firstElementChild;
                const glyphBox = glyph instanceof SVGGraphicsElement ? inkBox(glyph) : null;
                for (const el of els) {
                  const leftOfHead = glyphBox !== null && el instanceof SVGGraphicsElement && el.tagName === 'path' && !el.getAttribute('class')
                    && inkBox(el).x + inkBox(el).width <= glyphBox.x + glyphBox.width * 0.35;
                  const kind = el.classList.contains('vf-annotation') ? 'fingering'
                    : el.classList.contains('vf-articulation') ? 'articulation'
                    : el.classList.contains('vf-ornament') ? 'ornament'
                    : el.classList.contains('vf-accidental') || leftOfHead ? 'accidental' : 'mark';
                  el.setAttribute('data-modifier', kind);
                  if (noteId && (kind === 'fingering' || kind === 'accidental')) el.setAttribute('data-modifier-note', noteId);
                }
              }
              // whole notes never have a stem at all (real engraving convention) — a whole-note
              // cross-staff chord stays two plain, unconnected noteheads; only STEMMED halves get
              // merged below.
              const crossStaffCarrierId =
                sn.hasStem() && b.crossStaffCarrierIds.has(d.notes[ni].id) ? d.notes[ni].id : null;
              if (crossStaffCarrierId) {
                // ONE stemHandle for the whole merged stem is pushed in the post-pass below (once
                // BOTH halves are drawn) — not here, and not per half: selection/drag/double-click
                // flip must work exactly like any other note's stem, through the exact same
                // `stemHandles`/`stemOverrides` mechanism, just with ONE handle for the whole chord
                // instead of one per physical staff.
                const arr = crossStaffHalves.get(crossStaffCarrierId) ?? [];
                arr.push({ sn, staffId: d.staffId });
                crossStaffHalves.set(crossStaffCarrierId, arr);
              } else if (sn.hasStem()) {
                // a beamed stem's length belongs to its beam, so it gets no drag handle
                const { topY, baseY } = sn.getStemExtents();
                const stemElement = sn.getStem()?.getSVGElement();
                const stemBox = stemElement instanceof SVGGraphicsElement ? inkBox(stemElement) : null;
                const tipY = stemBox
                  ? sn.getStemDirection() === Stem.UP ? stemBox.y : stemBox.y + stemBox.height
                  : topY;
                const flagEl = sn.getSVGElement()?.querySelector<SVGGraphicsElement>('.vf-stem-unit > path');
                const flagBox = flagEl ? inkBox(flagEl) : null;
                stemHandles.push({
                  noteId: d.notes[ni].id,
                  staffId: d.staffId,
                  x: stemBox ? stemBox.x + stemBox.width / 2 : sn.getStemX(),
                  baseY,
                  tipY,
                  topNoteY: Math.min(...sn.getYs()),
                  bottomNoteY: Math.max(...sn.getYs()),
                  tipInset: Math.abs(topY - tipY),
                  draggable: !sn.hasBeam(),
                  staffSpace: STAFF_H / 4,
                  automaticLength: Math.abs(topY - baseY) - sn.getStemLength() + Number(sn.getAttribute('natural-stem-length')),
                  naturalLength: Number(sn.getAttribute('natural-stem-length')),
                  direction: sn.getStemDirection() as 1 | -1,
                  ...(flagBox && flagEl ? { flag: { d: flagEl.getAttribute('d') ?? '', x: flagBox.x, y: flagBox.y, width: flagBox.width, height: flagBox.height, dx: 0, dy: 0 } } : {}),
                });
              }
            });
            d.notes.forEach((n, ni) => {
              n.noteIds.forEach((noteId, index) => drawnNoteAt.set(noteId, { sn: d.sns[ni], index, system: si }));
            });
          });

          // grace notes, beside the carrier they belong to: the group is drawn where it falls, then moved
          // so that its measured ink stands clear of the carrier's ink
          for (const set of b.graceSets) {
            const host = hostInk.get(set.carrierId);
            const info = staffInfo[set.staffId];
            if (!host || !info) continue;
            set.vf.forEach((grace) => grace.setStave(info.staff));
            const group = ctx.openGroup('vf-grace-group') as SVGGElement;
            set.vf.forEach((grace) => grace.setContext(ctx).draw());
            ctx.closeGroup();
            const ink = inkBox(group);
            const dx = set.side === 'before' ? host.left - GRACE_PAD - (ink.x + ink.width) : host.right + GRACE_PAD - ink.x;
            group.setAttribute('transform', `translate(${dx} 0)`);
            group.setAttribute('data-voice', String(set.voiceIndex));
            const voiceId = doc.voices[set.voiceIndex]?.id;
            if (voiceId) group.style.setProperty('--voice-color', resolveVoiceColor(voiceId, set.voiceIndex, voiceColors));
            // each grace carrier is selectable like any carrier: its own id on the note, and one box per note
            set.vf.forEach((grace, i) => {
              const el = grace.getSVGElement();
              if (!el) return;
              const note = set.notes[i];
              el.setAttribute('data-note-id', note.id);
              el.setAttribute('data-voice', String(set.voiceIndex));
              const ink = inkBox(el as SVGGraphicsElement);
              const columns = graceColumns.get(`${set.carrierId}:${set.side}`) ?? new Map<string, { left: number; right: number; headLeft: number }>();
              graceColumns.set(`${set.carrierId}:${set.side}`, columns);
              const known = columns.get(note.id);
              // heads from the lowest up, the order of the notes by staff step
              const heads = [...el.querySelectorAll<SVGGraphicsElement>('.vf-notehead')].sort((a, c) => inkBox(c).y - inkBox(a).y);
              note.noteIds.map((id, k) => ({ id, step: note.staffSteps[k] })).sort((a, c) => a.step - c.step).forEach(({ id }, k) => {
                const head = heads[k];
                if (!head) return;
                head.setAttribute('data-individual-note-id', id);
                const box = inkBox(head);
                columns.set(note.id, {
                  left: Math.min(known?.left ?? Infinity, ink.x),
                  right: Math.max(known?.right ?? -Infinity, ink.x + ink.width),
                  headLeft: Math.min(known?.headLeft ?? Infinity, box.x),
                });
                noteBoxes.push({ id, carrierId: note.id, staffId: set.staffId, x: box.x - box.width * 0.3, y: box.y, w: box.width * 1.6, h: box.height });
              });
            });
            collisions.add(group, { staffId: set.staffId, measureId: b.measure.id, beat: set.onset, kind: 'rhythm' });
          }

          // where a grace note can be put beside each carrier: before the grace carriers of a side, between them, after
          // them, and on each (a note added to it); a side with none has just one place
          b.measure.voices.forEach((voice) => voice.items.forEach((item) => {
            const host = hostInk.get(item.id);
            if (!host) return;
            for (const [side, group] of [['before', item.graceBefore], ['after', item.graceAfter]] as const) {
              const known = graceColumns.get(`${item.id}:${side}`);
              const columns = (group?.carriers ?? []).flatMap((carrier) => {
                const column = known?.get(carrier.id);
                return column ? [{ id: carrier.id, ...column }] : [];
              });
              const slot = (x: number, afterId: string | null, joinId: string | null = null) =>
                graceSlots.push({ hostId: item.id, voiceId: voice.id, measureId: b.measure.id, side, kind: group?.kind ?? null, x, w: GRACE_HEAD_W, joinId, afterId });
              const middle = (right: number, left: number) => (right + left) / 2 - GRACE_HEAD_W / 2;
              if (!columns.length) {
                slot(side === 'before' ? host.left - GRACE_PAD - GRACE_HEAD_W : host.right + GRACE_PAD, null);
                continue;
              }
              if (side === 'before') {
                slot(columns[0].left - GRACE_PAD - GRACE_HEAD_W, null);
                columns.forEach((column, i) => slot(middle(column.right, columns[i + 1]?.left ?? host.left), column.id));
              } else {
                slot(middle(host.right, columns[0].left), null);
                columns.forEach((column, i) => slot(columns[i + 1] ? middle(column.right, columns[i + 1].left) : column.right + GRACE_PAD, column.id));
              }
              columns.forEach((column) => slot(column.headLeft, null, column.id));
            }
          }));

          crossArpeggios
            .filter((a) => b.drawn.some((d) => d.sns.includes(a.upper)))
            .forEach(({ upper, lower, mark, room }) => {
              ctx.save();
              ctx.setFillStyle(inkColor);
              drawCrossStaffArpeggio(upper, lower, mark, room);
              ctx.restore();
            });

          // Join all noteheads with one stem. Its free end carries one native flag, or follows
          // the beam after formatting. The entire shared unit is registered as a spacing bridge.
          crossStaffHalves.forEach((halves, carrierId) => {
            if (halves.length < 2) return; // the other half didn't actually draw a stem this measure
            const ordered = [...halves].sort((a, c) => staffOrder.indexOf(a.staffId) - staffOrder.indexOf(c.staffId));
            const topHalf = ordered[0];
            const override = stemOverrides[carrierId];
            const beamed = topHalf.sn.hasBeam();
            const direction: 1 | -1 = beamed ? topHalf.sn.getStemDirection() as 1 | -1 : override?.direction ?? CROSS_STAFF_DEFAULT_DIRECTION;
            // Span the stem over every notehead's actual y (`getYs()`), not `getStemExtents()`:
            // its base/tip are direction-dependent (a stem-up half reports its base at its lowest
            // note, stem-down at its highest), so anchoring off it tore outer notes off the stem on
            // flip. Note y's are direction-invariant, so `topNoteY..botNoteY` always covers everything.
            const allNoteYs = ordered.flatMap((h) => h.sn.getYs());
            const topNoteY = Math.min(...allNoteYs);
            const botNoteY = Math.max(...allNoteYs);
            // Use VexFlow's stem side so both the flag and the beam meet the shared line.
            const stemX = topHalf.sn.getStemX();
            // Length is the protrusion beyond the outer note on the stem's free side.
            const baseY = direction === -1 ? botNoteY : topNoteY;
            // protrusion past `baseY` on the free side; a dragged length is that protrusion directly.
            const protrusion =
              Math.max(MIN_STEM_LENGTH, DEFAULT_STEM_PROTRUSION * (override?.lengthFactor ?? 1));
            const freeEndY = baseY - direction * protrusion; // down: botNoteY + P ; up: topNoteY - P
            // the drawn line always covers EVERY notehead [topNoteY, botNoteY] PLUS whatever the free
            // end adds beyond either side — never less than the full note span, in any direction.
            const lineTopY = Math.min(topNoteY, freeEndY);
            const lineBottomY = Math.max(botNoteY, freeEndY);
            const unit = document.createElementNS('http://www.w3.org/2000/svg', 'g');
            unit.setAttribute('class', 'vf-stem-unit vf-cross-staff-stem');
            const flagEl = topHalf.sn.getSVGElement()?.querySelector<SVGPathElement>(':scope > path:not(.vf-ledger)');
            const flag = !beamed && flagEl ? {
              element: flagEl,
              dx: stemX - topHalf.sn.getStemX(),
              dy: freeEndY - topHalf.sn.getStemExtents().topY,
            } : null;
            ordered.forEach((h) => {
              const group = h.sn.getSVGElement();
              group?.querySelector('.vf-stem')?.remove();
              group?.querySelectorAll(':scope > path:not(.vf-ledger)').forEach((path) => path.remove());
            });
            // Appended as a DOM child of the TOP half's own `.vf-stavenote` group (not a bare
            // top-level shape) so the EXISTING selection/hover CSS
            // (`.vf-stavenote.selected path:not(.vf-ledger)`) tints it automatically, with zero new
            // styling rules — it's just another path alongside the noteheads/ledgers, exactly like a
            // real stem is.
            const line = document.createElementNS('http://www.w3.org/2000/svg', 'path');
            line.setAttribute('d', `M${stemX} ${lineTopY}L${stemX} ${lineBottomY}`);
            line.setAttribute('stroke', inkColor);
            line.setAttribute('stroke-width', String(STEM_WIDTH));
            line.setAttribute('fill', 'none');
            line.setAttribute('class', 'vf-cross-staff-line');
            unit.appendChild(line);
            if (flag) {
              flag.element.setAttribute('transform', `translate(${flag.dx} ${flag.dy})`);
              unit.appendChild(flag.element);
            }
            topHalf.sn.getSVGElement()?.appendChild(unit);
            sharedStems.set(carrierId, { line, topNoteY, bottomNoteY: botNoteY });
            // `tipY` (drag DOT + drag reference) = the DRAWN stem's free extremity, i.e. the end on
            // the free (protrusion) side: `lineBottomY` for a down stem, `lineTopY` for an up one.
            // NOT the raw `freeEndY`: on a SHORT drag `freeEndY` can fall SHORT of the far note, at
            // which point the drawn stem is clamped to the note (`lineBottomY = max(botNoteY,
            // freeEndY)`) to stay connected — but the dot must sit on the visible tip, not float in
            // the stem's interior at the un-clamped `freeEndY` (reported: "точка может оставаться не
            // на кончике штиля"). Using the clamped extremity keeps the dot on the tip AND makes the
            // next grab's drag reference match what's on screen. It is never the CONNECTED far end:
            // the free-side extremity is always the protruding tip, never the note the stem hangs off.
            const tipY = direction === -1 ? lineBottomY : lineTopY;
            // Overlay's hit-line spans [baseY-inset, tipY] for a normal note — always the whole
            // visible stem, since baseY and tipY are its two extremities. For a cross-staff stem the
            // drawn line is [lineTopY, lineBottomY] and baseY sits INSIDE it after a flip, so the
            // hit-line must be given the full drawn extent explicitly, or the core span between the
            // notes has no hit target and a grab there falls through to a marquee-select (which then
            // overwrites the chord's selection — the reported "сломан селект штиля").
            const hitY1 = lineTopY;
            const hitY2 = lineBottomY;
            // Length measures the protrusion past the outer note; the shared minimum and canvas
            // bounds govern dragging, as for an ordinary chord.
            collisions.add(unit, { measureId: b.measure.id, staffId: topHalf.staffId, kind: 'bridge' });
            const flagBox = flag?.element.getBBox();
            stemHandles.push({
              noteId: carrierId, staffId: topHalf.staffId, x: stemX, baseY, tipY, direction,
              topNoteY, bottomNoteY: botNoteY, hitY1, hitY2, draggable: !beamed,
              staffSpace: STAFF_H / 4, automaticLength: DEFAULT_STEM_PROTRUSION, naturalLength: DEFAULT_STEM_PROTRUSION,
              ...(flag && flagBox ? { flag: {
                d: flag.element.getAttribute('d') ?? '', x: flagBox.x, y: flagBox.y,
                width: flagBox.width, height: flagBox.height, dx: flag.dx, dy: flag.dy,
              } } : {}),
            });
          });

          // insert snapping / the ghost preview must land where notes are ACTUALLY drawn — not
          // re-derive that position: VexFlow silently adds its own internal stave-padding offset
          // the moment a note's `.stave` is set (see the noteStartX shift above), which
          // a from-scratch `noteStartX + segX*stretch` reconstruction has no way to know about.
          // So read real notehead positions off the just-drawn notes for every onset that has one,
          // and only fall back to the formula — using whatever padding a real note in this same
          // measure revealed — for onsets with none (the end-of-measure boundary; a fully empty
          // staff).
          //
          // MUST key by `getNoteHeadBeginX()` (the LEFT edge), never `(begin+end)/2` (the notehead
          // CENTER): `sn.setXShift(...)` above aligns every note at a shared onset to the exact
          // SAME `getNoteHeadBeginX()` regardless of duration/width (the shift target never
          // references glyph width) — begin-X is the one thing guaranteed consistent across a
          // same-onset collision between differently-wide noteheads (e.g. an upper-staff 8th note
          // and a lower-staff whole note sharing beat 0: whole notes render ~5px wider than filled
          // noteheads, so their CENTERS differ even at an identical begin-X). `segments` is SHARED
          // across both staff zones (cross-staff alignment), and multiple staffs/voices can and do
          // share an onset — whichever note is recorded last here must not corrupt the position for
          // a different-width note at the same beat on the OTHER staff.
          const realBeatX = new Map<number, number>();
          for (const d of b.drawn) {
            // Measure-rest dashes bypass VexFlow drawing; their unused notes have no layout x.
            if (d.isEmpty) continue;
            d.sns.forEach((sn, ni) => {
              realBeatX.set(d.onsets[ni], sn.getNoteHeadBeginX());
            });
          }
          const [sampleBeat, sampleX] = [...realBeatX.entries()][0] ?? [];
          // a fully empty measure (no real note on either staff — e.g. the FIRST insert ever
          // lands here) has nothing of its own to calibrate from; falling back to a bare 0 assumed
          // VexFlow's silent stave-padding offset away entirely, landing the ghost measurably too
          // far left. Fall back to `documentPadding` instead — the offset is a fixed VexFlow quirk,
          // not measure-specific data (see the comment above), so any other measure's real note in
          // this same render is a valid source.
          const padding =
            sampleBeat !== undefined
              ? sampleX - (noteStartX + (b.segmentX.get(sampleBeat) ?? 0) * stretch)
              : documentPadding;
          if (sampleBeat !== undefined) documentPadding = padding;
          // the LAST breakpoint (beat = measure end) is pinned to the true right edge (`x + w`),
          // not `noteStartX + cum*stretch` — `segmentX`'s cumulative value deliberately excludes
          // MEASURE_RIGHT_PAD (real notes must stop short of the barline), but that leaves the pad
          // region outside every breakpoint's domain, so `interp()` clamps ANY click that lands in
          // it onto the last valid beat — collapsing the last grid position onto (and beyond) half
          // the measure's clickable width instead of getting a fair, proportional share. Click
          // targeting must span the FULL visible measure, pad included.
          const rawSegments = [...b.segmentX.entries()]
            .sort(([beatA], [beatB]) => beatA - beatB)
            .map(([beat, segX]) => ({
              beat,
              x: realBeatX.get(beat) ?? noteStartX + segX * stretch + padding,
            }));
          const segments = rawSegments.map((p, i) =>
            i === rawSegments.length - 1 ? { ...p, x: x + w } : p,
          );
          // Context reservation is a horizontal jump at one beat, not elapsed musical time.
          const insertionSegments = segments.flatMap((point, i) => {
            const width = (b.contextWidths.get(point.beat) ?? 0) * stretch;
            if (!width || !i) return [{ ...point }];
            const left = Math.max(segments[i - 1].x, point.x - width);
            return [{ beat: point.beat, x: left }, { ...point }];
          });
          // playback timeline: built from `segments` (the true MERGED cross-voice/cross-staff onset
          // timeline for this measure) rather than any one voice's own onsets — with more than one
          // real voice possibly sharing a staff now (cross-staff chords), no single "spine" voice is
          // guaranteed to carry every onset any more (e.g. a whole-note voice would report only 1
          // point for a measure where another voice has 4). `segments` already covers every real
          // onset across the whole measure, so this is strictly more complete than the old
          // one-voice-spine approach, not just an equivalent rewrite.
          const measureBeats = lengthOfMeasure(b.measure.timeSignature);
          // each entry carries its own system's vertical band, so the playback cursor can follow the
          // music onto the next system (one grand staff: treble top line to bass bottom line)
          const bandY0 = treble.getYForLine(0) - CURSOR_OVERHANG;
          const bandY1 = bass.getYForLine(4) + CURSOR_OVERHANG;
          // One timestamp has one position within a system. Approach the next onset
          // continuously instead of reaching the barline and jumping over its padding.
          const previous = timeMap.at(-1);
          if (previous?.timeBeats === cumBeat && previous.y0 === bandY0) timeMap.pop();
          segments.forEach((s) => timeMap.push({ timeBeats: cumBeat + s.beat, x: s.x, y0: bandY0, y1: bandY1 }));
          measures.push({ id: b.measure.id, x, y: bandY0, w, h: bandY1 - bandY0 });
          cumBeat += measureBeats;
          staffZones.push(
            { measureId: b.measure.id, staffId: staffOrder[0], x0: zoneX0, x1: x + w, left: x, bottomLineY: staffBottomLineY(treble), stepPx, beats, beatValue, dots: b.measure.timeSignature.dots, segments, insertionSegments },
            { measureId: b.measure.id, staffId: staffOrder[1], x0: zoneX0, x1: x + w, left: x, bottomLineY: staffBottomLineY(bass), stepPx, beats, beatValue, dots: b.measure.timeSignature.dots, segments, insertionSegments },
          );
        });

        // beams, then tuplet brackets — a bracket sits beyond the stems its notes' beam lengthened
        beamsBySystem[si].forEach(({ id, vf }) => {
          vf.postFormat();
          const beamNotes = vf.getNotes();
          const firstX = beamNotes[0].getStemX(), lastX = beamNotes[beamNotes.length - 1].getStemX();
          const override = beamPreview?.id === id ? beamPreview.override : doc.beams.find(bm => bm.id === id)?.override;
          const staffSpace = STAFF_H / 4;
          const stemLengthOf = (note: { getStemExtents(): { baseY: number; topY: number } }) => { const extents = note.getStemExtents(); return Math.abs(extents.baseY - extents.topY); };
          const leftLength = stemLengthOf(beamNotes[0]), rightLength = stemLengthOf(beamNotes[beamNotes.length - 1]);
          const beamDirection = beamNotes[0].getStemDirection() as 1 | -1;
          if (override && lastX > firstX) {
            // an end moves by the growth of its stem: its automatic length times the factor less one
            const left = -beamDirection * leftLength * (override.leftFactor - 1), right = -beamDirection * rightLength * (override.rightFactor - 1);
            vf.slope += (right - left) / (lastX - firstX);
            for (const note of beamNotes) {
              const stem = note.getStem();
              if (stem) {
                const dy = left + (right - left) * (note.getStemX() - firstX) / (lastX - firstX);
                stem.setExtension(stem.getExtension() - dy * note.getStemDirection());
              }
            }
          }
          vf.setContext(ctx).draw();
          for (const note of beamNotes) {
            note.getStem()?.getSVGElement()?.setAttribute('data-beam-stem', id);
            const carrierId = note.getSVGElement()?.getAttribute('data-note-id');
            const handle = stemHandles.find(h => h.noteId === carrierId);
            if (handle) {
              const extents = note.getStemExtents();
              handle.baseY = extents.baseY; handle.tipY = extents.topY; handle.draggable = false;
              const shared = sharedStems.get(carrierId ?? '');
              if (shared) {
                note.getStem()?.getSVGElement()?.remove();
                const top = Math.min(shared.topNoteY, extents.topY);
                const bottom = Math.max(shared.bottomNoteY, extents.topY);
                shared.line.setAttribute('d', `M${note.getStemX()} ${top}L${note.getStemX()} ${bottom}`);
                handle.x = note.getStemX();
                handle.hitY1 = top; handle.hitY2 = bottom;
              }
            }
          }
          const beamY = vf.getBeamYToDraw();
          const handles = { x0: firstX, x1: lastX, y0: beamY, y1: beamY + vf.slope * (lastX - firstX), staffSpace, localX0: firstX, leftLength, rightLength, direction: beamDirection };
          const group = vf.getSVGElement();
          const firstCarrier = doc.beams.find((bm) => bm.id === id)?.carrierIds[0];
          tagObject(group, id, firstCarrier);
          const member = collisions.items.find((it) => it.element === beamNotes[0].getSVGElement());
          const pieceCarriers = new Set(beamNotes.map((note) => note.getSVGElement()?.getAttribute('data-note-id')));
          const memberStaffs = new Set(collisions.items.filter((it) => it.kind === 'rhythm' &&
            pieceCarriers.has(it.element.getAttribute('data-note-id'))).map((it) => it.staffId));
          if (member) collisions.add(group, { measureId: member.measureId, staffId: member.staffId, kind: memberStaffs.size > 1 ? 'bridge' : 'attached' });
          const paths = [...(group?.querySelectorAll('path') ?? [])].map((el) => el.getAttribute('d') ?? '');
          if (paths.length) beamShapes.push({ id, paths, handles });
        });
        // The model lists parents first; place children first so collision clearance lifts parents above them.
        [...tupletsBySystem[si]].reverse().forEach(({ id, vf, staffId, measureId }) => {
          vf.setContext(ctx);
          const group = ctx.openGroup('tuplet', id) as SVGGElement;
          vf.draw();
          ctx.closeGroup();
          tagObject(group, id, doc.tuplets.find((t) => t.id === id)?.carrierIds[0]);
          collisions.placeOutside(group, { measureId, staffId, kind: 'attached' }, -1);
          tupletShapes.push({ id, html: group.innerHTML });
        });

        if (sysStaffs.length) {
          const first = sysStaffs[0];
          const last = sysStaffs[sysStaffs.length - 1];
          new StaveConnector(first.treble, first.bass).setType('brace').setContext(ctx).draw();
          new StaveConnector(first.treble, first.bass).setType('singleLeft').setContext(ctx).draw();
          // every barline of the system joins the two staves across the gap between them (the signs of a repeat are drawn by contextMarks)
          for (const entry of sysStaffs) new StaveConnector(entry.treble, entry.bass).setType('singleRight').setContext(ctx).draw();
        }
      });

      // ties, once every note is drawn: one tie within a system; across a system break, a half tie
      // out of the first note to its staff's end and a half tie into the second from its staff's start
      for (const tie of doc.ties) {
        const start = drawnNoteAt.get(tie.startNoteId);
        const end = drawnNoteAt.get(tie.endNoteId);
        if (!start || !end) continue;
        const halves =
          start.system === end.system
            ? [{ first: start, last: end }]
            : [
                { first: start, last: null },
                { first: null, last: end },
              ];
        for (const { first, last } of halves) {
          const tieGroup = ctx.openGroup('tie', tie.id) as SVGElement;
          new StaveTie({
            first_note: first?.sn ?? null,
            last_note: last?.sn ?? null,
            first_indices: [(first ?? last)!.index],
            last_indices: [(last ?? first)!.index],
          })
            .setContext(ctx)
            .draw();
          ctx.closeGroup();
          tagObject(tieGroup, tie.id, noteBoxes.find(box => box.id === tie.startNoteId)?.carrierId);
          const noteId = first ? tie.startNoteId : tie.endNoteId;
          const box = noteBoxes.find((it) => it.id === noteId);
          const member = collisions.items.find((it) => box && it.staffId === box.staffId && it.element.getAttribute('data-note-id') === box.carrierId);
          const other = noteBoxes.find((it) => it.id === tie.endNoteId);
          if (member) collisions.add(tieGroup, { measureId: member.measureId, staffId: member.staffId,
            kind: first && last && box && other && box.staffId !== other.staffId ? 'bridge' : 'attached' });
          tupletShapes.push({ id: tie.id, html: tieGroup.innerHTML });
        }
      }

      // glissandos, once every note is drawn: a line from the first notehead to the second within one
      // system, straight or wavy (a sine along the line, its size and period from the staff space)
      for (const gliss of doc.glissandos) {
        const start = drawnNoteAt.get(gliss.startNoteId);
        const end = drawnNoteAt.get(gliss.endNoteId);
        if (!start || !end || start.system !== end.system) continue;
        const inset = 0.4 * STAFF_SPACE;
        const x0 = start.sn.getNoteHeadEndX() + inset, x1 = end.sn.getNoteHeadBeginX() - inset;
        const y0 = start.sn.getYs()[start.index], y1 = end.sn.getYs()[end.index];
        if (!(x1 > x0)) continue;
        const length = Math.hypot(x1 - x0, y1 - y0);
        const cycles = Math.max(1, Math.round(length / (2 * STAFF_SPACE)));
        const samples = gliss.glissandoType === 'wavy' ? cycles * 12 : 1;
        const points: string[] = [];
        for (let i = 0; i <= samples; i += 1) {
          const t = i / samples;
          const wave = gliss.glissandoType === 'wavy' ? 0.2 * STAFF_SPACE * Math.sin(2 * Math.PI * cycles * t) : 0;
          points.push(`${i === 0 ? 'M' : 'L'}${x0 + t * (x1 - x0) - ((y1 - y0) / length) * wave} ${y0 + t * (y1 - y0) + ((x1 - x0) / length) * wave}`);
        }
        const glissGroup = ctx.openGroup('glissando', gliss.id) as SVGElement;
        const line = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        line.setAttribute('d', points.join(' '));
        line.setAttribute('fill', 'none');
        line.setAttribute('stroke', inkColor);
        line.setAttribute('stroke-width', '1.2');
        line.setAttribute('stroke-linecap', 'round');
        glissGroup.appendChild(line);
        ctx.closeGroup();
        tagObject(glissGroup, gliss.id, noteBoxes.find(box => box.id === gliss.startNoteId)?.carrierId);
        const box = noteBoxes.find((it) => it.id === gliss.startNoteId);
        const member = collisions.items.find((it) => box && it.staffId === box.staffId && it.element.getAttribute('data-note-id') === box.carrierId);
        const other = noteBoxes.find((it) => it.id === gliss.endNoteId);
        if (member) collisions.add(glissGroup, { measureId: member.measureId, staffId: member.staffId,
          kind: box && other && box.staffId !== other.staffId ? 'bridge' : 'attached' });
        tupletShapes.push({ id: gliss.id, html: glissGroup.innerHTML });
      }

      // the contexts the stave does not draw itself: dynamics, hairpins, slurs, octave lines, tempos
      // and clefs inside a measure
      for (const item of collisions.items) item.box = inkBox(item.element);
      const hostSvg = host.querySelector('svg');
      if (hostSvg) {
        const marks = drawContextMarks({
            svg: hostSvg,
            ctx,
            doc,
            index: contexts,
            zones: staffZones,
            systemOf,
            voiceColors,
            ink: inkColor,
            factors: Object.fromEntries(doc.contexts.map(c => [c.id, placementPreview?.id === c.id ? placementPreview.factor : bodyFactor(doc.presentation, c.id)])),
            slurPreview,
            spanPreview,
            collisions,
            inlineWidths,
          });
        contextShapes.push(...marks.shapes);
        slurShapes.push(...marks.slurShapes);
      }

      for (const rest of emptyRests) {
        const cx = collisions.restX(rest.left, rest.right, rest.cy - DASH_THICK / 2, DASH_THICK, DASH_W, rest.staffId, rest.measureId);
        if (cx === null) {
          const b = built.find((item) => item.measure.id === rest.measureId)!;
          changed = growMinimum(widthMinimum, rest.measureId, b.naturalWidth + DASH_W + 2 * STAFF_SPACE) || changed;
        } else {
          rest.element.setAttribute('transform', `translate(${cx - rest.cx} 0)`);
          for (const box of noteBoxes) if (rest.ids.includes(box.carrierId)) box.x += cx - rest.cx;
          collisions.add(rest.element, { staffId: rest.staffId, measureId: rest.measureId, kind: 'rest' });
        }
      }
      for (const b of built) {
        const onsets = [...b.segmentX.keys()].sort((a, z) => a - z);
        const placed = placedSystems.flat().find((p) => p.b === b)!;
        for (const staffId of staffOrder) {
          const rhythmic = collisions.items.filter((it) => it.measureId === b.measure.id && it.staffId === staffId && (it.kind === 'rhythm' || it.kind === 'inline'));
          for (const note of rhythmic.filter((it) => it.kind === 'rhythm' && it.beat === 0)) {
            const headers = collisions.items.filter((it) => it.kind === 'header' && it.measureId === b.measure.id && it.staffId === staffId &&
              it.box.y < note.box.y + note.box.height && it.box.y + it.box.height > note.box.y);
            // what a first note carries to its left (an accidental, an arpeggio line) must also clear the barline
            const deficiency = Math.max(0, placed.x + collisions.gap - note.box.x, ...headers.map((it) => it.box.x + it.box.width + collisions.gap - note.box.x));
            if (deficiency > 0.25) changed = growMinimum(horizontal, `${b.measure.id}:0`, (b.segmentX.get(0) ?? 0) + deficiency / placed.stretch) || changed;
          }
          for (const a of rhythmic) for (const z of rhythmic) {
            if (a.beat! >= z.beat! || a.box.y >= z.box.y + z.box.height || z.box.y >= a.box.y + a.box.height) continue;
            const deficiency = a.box.x + a.box.width + collisions.gap - z.box.x;
            if (deficiency <= 0.25) continue;
            const end = onsets.indexOf(z.beat!);
            const previous = onsets[end - 1];
            const gap = (b.segmentX.get(z.beat!)! - b.segmentX.get(previous)!) + deficiency / placed.stretch;
            changed = growMinimum(horizontal, `${b.measure.id}:${z.beat}`, gap) || changed;
          }
        }
      }
      for (const item of collisions.items) {
        if (item.kind === 'staff') continue;
        const context = doc.contexts.find((c) => c.id === (item.element.getAttribute('data-layout-context') ?? item.element.getAttribute('data-object-id')));
        if (item.kind === 'context' && context && 'endMeasureId' in context && context.endPosition !== null) {
          const textBounds = [...item.element.querySelectorAll<SVGGraphicsElement>('text')].map(inkBox);
          const pieceRight = Number(item.element.getAttribute('data-piece-right'));
          const deficiency = Math.max(0, ...textBounds.map((box) => box.x + box.width + STAFF_SPACE - pieceRight));
          if (deficiency > 0.25 && (context.endMeasureId !== context.measureId || context.endPosition.numerator / context.endPosition.denominator > context.position.numerator / context.position.denominator)) {
            const system = placedSystems.find((items) => items.some((p) => p.b.measure.id === item.measureId))!;
            // the piece's end stands in this system, unless the span ends at the start of the next one (it is then drawn to the end of this system)
            const endsHere = item.element.hasAttribute('data-context-end-x') ? system.find((p) => p.b.measure.id === context.endMeasureId) : undefined;
            const last = endsHere ?? system[system.length - 1];
            const beat = endsHere
              ? context.endPosition.numerator / context.endPosition.denominator * 4 : lengthOfMeasure(last.b.measure.timeSignature);
            const beats = [...last.b.segmentX.keys()].sort((a, z) => a - z);
            const previous = beats[beats.indexOf(beat) - 1];
            if (previous !== undefined) {
              const gap = last.b.segmentX.get(beat)! - last.b.segmentX.get(previous)!;
              changed = growMinimum(horizontal, `${last.b.measure.id}:${beat}`, gap + deficiency / last.stretch) || changed;
            }
          }
        }
        if (item.kind === 'context' && context && !('endMeasureId' in context)) {
          const placed = placedSystems.flat().find((p) => p.b.measure.id === item.measureId)!;
          const b = placed.b;
          const left = Math.max(0, placed.x + STAFF_SPACE - item.box.x);
          const right = Math.max(0, item.box.x + item.box.width + STAFF_SPACE - placed.x - placed.w);
          if (left > 0.25) changed = growMinimum(horizontal, `${item.measureId}:0`, (b.segmentX.get(0) ?? 0) + left / placed.stretch) || changed;
          if (right > 0.25 && context.position.numerator / context.position.denominator * 4 < lengthOfMeasure(b.measure.timeSignature)) {
            const end = lengthOfMeasure(b.measure.timeSignature);
            const beats = [...b.segmentX.keys()].sort((a, z) => a - z);
            const gap = b.segmentX.get(end)! - b.segmentX.get(beats[beats.length - 2])!;
            changed = growMinimum(horizontal, `${item.measureId}:${end}`, gap + right / placed.stretch) || changed;
          }
        }
        const zone = staffZones.find((z) => z.measureId === item.measureId && z.staffId === item.staffId);
        if (!zone) continue;
        item.box = inkBox(item.element);
        if (item.kind !== 'bridge') {
          const spacing = item.spacingBox ?? item.box;
          changed = growMinimum(reaches, `${item.measureId}:${item.staffId}:above`, zone.bottomLineY - STAFF_H - spacing.y) || changed;
          changed = growMinimum(reaches, `${item.measureId}:${item.staffId}:below`, spacing.y + spacing.height - zone.bottomLineY) || changed;
        }
        item.element.setAttribute('data-ink-x', String(item.box.x));
        item.element.setAttribute('data-ink-y', String(item.box.y));
        item.element.setAttribute('data-ink-width', String(item.box.width));
        item.element.setAttribute('data-ink-height', String(item.box.height));
        if (item.kind === 'inline') changed = growMinimum(inlineWidths, item.element.getAttribute('data-object-id')!, item.box.width) || changed;
      }
      // the layout settles in a few passes; a score it cannot settle is drawn as it is rather than stalling the page
      if (changed && passCount < MAX_LAYOUT_PASSES) { engrave(); return; }
      // the marks drawn with a chord, as click targets: each mark's ink, and the augmentation dots (bare paths of the note's group)
      const modifierBoxes: ModifierBox[] = [];
      hostSvg!.querySelectorAll<SVGGraphicsElement>('.vf-stavenote').forEach((group) => {
        const carrierId = group.getAttribute('data-note-id');
        if (!carrierId) return;
        const marks = [
          ...group.querySelectorAll<SVGGraphicsElement>('.vf-note-modifiers > *'),
          ...[...group.children].filter((el): el is SVGGraphicsElement =>
            el instanceof SVGGraphicsElement && el.tagName === 'path' && !el.classList.contains('vf-ledger')),
        ];
        for (const el of marks) {
          const box = inkBox(el);
          modifierBoxes.push({ carrierId, noteId: el.getAttribute('data-modifier-note'), x: box.x, y: box.y, w: box.width, h: box.height });
        }
      });
      const bounds = (hostSvg as SVGGraphicsElement).getBBox();
      const shiftX = Math.max(0, -bounds.x + collisions.gap);
      const shiftY = Math.max(0, -bounds.y + collisions.gap);
      if (shiftX || shiftY) {
        const root = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        root.setAttribute('transform', `translate(${shiftX} ${shiftY})`);
        for (const mark of hostSvg!.querySelectorAll('[data-object-id]')) {
          for (const edge of ['start', 'end']) for (const [axis, shift] of [['x', shiftX], ['y', shiftY]] as const) {
            const name = `data-context-${edge}-${axis}`;
            const box = inkBox(mark as SVGGraphicsElement);
            const coordinate = axis === 'x' ? box.x + box.width / 2 : box.y + box.height / 2;
            mark.setAttribute(name, String(Number(mark.getAttribute(name) ?? coordinate) + shift));
          }
        }
        root.append(...hostSvg!.childNodes);
        hostSvg!.appendChild(root);
        for (const box of noteBoxes) { box.x += shiftX; box.y += shiftY; }
        for (const box of modifierBoxes) { box.x += shiftX; box.y += shiftY; }
        for (const slot of graceSlots) slot.x += shiftX;
        for (const box of measures) { box.x += shiftX; box.y += shiftY; }
        for (const zone of staffZones) { zone.x0 += shiftX; zone.x1 += shiftX; zone.left += shiftX; zone.bottomLineY += shiftY; }
        const segments = new Set(staffZones.flatMap((z) => [...z.segments, ...(z.insertionSegments ?? [])]));
        for (const segment of segments) segment.x += shiftX;
        for (const entry of timeMap) { entry.x += shiftX; entry.y0 += shiftY; entry.y1 += shiftY; }
        for (const stem of stemHandles) {
          stem.x += shiftX; stem.baseY += shiftY; stem.tipY += shiftY;
          if (stem.flag) { stem.flag.dx += shiftX; stem.flag.dy += shiftY; }
          if (stem.topNoteY !== undefined) stem.topNoteY += shiftY;
          if (stem.bottomNoteY !== undefined) stem.bottomNoteY += shiftY;
          if (stem.hitY1 !== undefined) stem.hitY1 += shiftY;
          if (stem.hitY2 !== undefined) stem.hitY2 += shiftY;
        }
        const wrap = (html: string) => `<g transform="translate(${shiftX} ${shiftY})">${html}</g>`;
        for (const shape of [...contextShapes, ...timeSignatureShapes, ...tupletShapes]) shape.html = wrap(shape.html);
        for (const slur of slurShapes) for (const point of [...Object.values(slur.base), ...Object.values(slur.frame ?? {})]) { point.x += shiftX; point.y += shiftY; }
        for (const beam of beamShapes) {
          if (beam.handles) { beam.handles.x0 += shiftX; beam.handles.x1 += shiftX; beam.handles.y0 += shiftY; beam.handles.y1 += shiftY; }
          // Beam hit geometry stores paths, so its coordinates need the same score-origin shift.
          beam.paths = beam.paths.map((path) => path.replace(/([ML])([\d.e+-]+)[ ,]+([\d.e+-]+)/g,
            (_, op: string, x: string, y: string) => `${op}${Number(x) + shiftX} ${Number(y) + shiftY}`));
        }
      }
      const finalW = Math.max(totalW, bounds.x + bounds.width + shiftX + MARGIN_L);
      const finalH = Math.max(totalH, bounds.y + bounds.height + shiftY + MARGIN_T);
      renderer.resize(finalW, finalH);
      hostSvg!.setAttribute('data-layout-passes', String(passCount));
      onLayout({
        width: finalW,
        height: finalH,
        engravedFor: effectivePageContentWidth,
        timeMap,
        totalBeats: cumBeat,
        noteBoxes,
        modifierBoxes,
        staffZones,
        stemHandles,
        beamShapes,
        tupletShapes,
        timeSignatureShapes,
        contextShapes,
        graceSlots,
        slurShapes,
        measures,
      });
    };
    let passCount = 0;
    engrave();
  }, [doc, effectivePageContentWidth, onLayout, voiceColors, stemOverrides, beamPreview, slurPreview, spanPreview, placementPreview]);

  // selection = DOM recolour on the already-rendered SVG (CSS class), no re-layout. MUST also
  // re-run on every dep the MAIN draw effect rebuilds the DOM from (`voiceColors`, `stemOverrides`)
  // — that effect does `host.innerHTML = ''` and redraws from scratch, wiping every class
  // including `.selected`; if only ITS deps changed (this effect's deps didn't), React skips this
  // effect for that render and the freshly-rebuilt DOM is left with no selection styling at all.
  // Found via a real repro: dragging a stem handle (which updates `stemOverrides` on every
  // pointermove, `selectedIds` unchanged) silently cleared the visible selection highlight.
  // `selectedIds` holds INDIVIDUAL note ids (one per key — see `data-individual-note-id`, set in
  // the main draw effect above), not carrier ids: a chord's noteheads select one at a time.
  // `.selected` on each `.vf-notehead` tints just that notehead; `.selected` on the CARRIER group
  // (`[data-note-id]`, tints stem/ledgers too — see index.css) is a CARRIER-CONTEXT thing — the
  // stem belongs to the carrier, not to any one note — so it requires EVERY key selected AND
  // either a REAL chord (2+ keys, "every key" already implies a deliberate whole-chord pick) OR
  // this exact carrier having been picked at CARRIER granularity (`carrierSelectedIds` — set only
  // by the stem handle's own click/drag or a chord double-click, see app/store.ts). A single-note
  // carrier's stem must NEVER tint from a plain notehead click on its one note: that's a NOTE
  // selection (the note's own context is accidental/fingering, not the stem — see
  // PropertiesPanel's `isStemCarrier`), not a carrier selection — even though clicking/double-
  // clicking the STEM of that very carrier must still tint it (explicitly requested: "одиночную
  // ноту тоже нужно выделять как carrier по штилю/двойному клику"). An earlier version let a
  // single-note carrier's one key trivially satisfy "every key selected" via ANY click and tint
  // the stem — explicitly rejected by the user ("селект ноты все еще выделяет и стем, а не
  // должен... именно одиночной ноты, отдельные ноты в аккорде можно выделить" — individual notes
  // WITHIN a chord select fine, only the single-note case must never imply the stem from a plain
  // note click).
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const set = new Set(selectedIds);
    const carrierSet = new Set(carrierSelectedIds);
    host.querySelectorAll<SVGElement>('[data-note-id]').forEach((g) => {
      const keyEls = [...g.querySelectorAll<SVGElement>('[data-individual-note-id]')];
      const carrierId = g.getAttribute('data-note-id') || '';
      const allSelected =
        keyEls.length > 0 &&
        keyEls.every((el) => set.has(el.getAttribute('data-individual-note-id') || '')) &&
        (keyEls.length > 1 || carrierSet.has(carrierId));
      g.classList.toggle('selected', allSelected);
      g.classList.toggle('carrier-selected', allSelected && carrierSet.has(carrierId));
      keyEls.forEach((el) => {
        el.classList.toggle('selected', set.has(el.getAttribute('data-individual-note-id') || ''));
      });
      // a fingering or an accidental follows its own note
      g.querySelectorAll<SVGElement>('[data-modifier-note]').forEach((el) => {
        el.classList.toggle('selected', set.has(el.getAttribute('data-modifier-note') || ''));
      });
    });
  }, [selectionKey, carrierSelectionKey, doc, effectivePageContentWidth, onLayout, voiceColors, stemOverrides, beamPreview, slurPreview, spanPreview, placementPreview]);

  // hover = same DOM-recolour pattern as selection (must re-run whenever the main effect could
  // have rebuilt the DOM) — a light tint on the note glyph itself, per-individual-note like
  // `.selected` above (Overlay.tsx's stem hover separately tints the whole chord). `hoveredNoteIds`
  // is lifted UI state in EditorView.tsx, not the global store — too ephemeral to belong there.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const set = new Set(hoveredNoteIds);
    host.querySelectorAll<SVGElement>('[data-individual-note-id]').forEach((el) => {
      el.classList.toggle('hovered', set.has(el.getAttribute('data-individual-note-id') || ''));
    });
    // `carrier:<id>` hovers a whole chord (the group of its note), like the tint of a picked chord; a fingering or an accidental hovers with its note
    host.querySelectorAll<SVGElement>('[data-note-id]').forEach((el) => {
      el.classList.toggle('hovered', set.has(`carrier:${el.getAttribute('data-note-id') || ''}`));
    });
    host.querySelectorAll<SVGElement>('[data-modifier-note]').forEach((el) => {
      el.classList.toggle('hovered', set.has(el.getAttribute('data-modifier-note') || ''));
    });
    host.querySelectorAll<SVGElement>('[data-object-id]').forEach((el) => {
      el.classList.toggle('hovered', set.has(el.getAttribute('data-object-id') || ''));
    });
  }, [hoverKey, doc, effectivePageContentWidth, onLayout, voiceColors, stemOverrides, beamPreview, slurPreview, spanPreview, placementPreview]);

  // picked beams / tuplets / time signatures / clefs: the same recolour-in-place as a note's
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const set = new Set(selectedObjectIds ?? []);
    host.querySelectorAll<SVGElement>('[data-object-id]').forEach((el) => {
      el.classList.toggle('selected', set.has(el.getAttribute('data-object-id') || ''));
    });
  }, [objectSelectionKey, doc, effectivePageContentWidth, onLayout, voiceColors, stemOverrides, beamPreview, slurPreview, spanPreview, placementPreview]);

  // insert flash: the same DOM-class pattern as hover/selection, applied once per insert (the
  // flash object's identity is the trigger). The class removes itself when its animation ends;
  // a later re-engrave simply drops it.
  useEffect(() => {
    const host = hostRef.current;
    if (!host || !flash) return;
    const ids = new Set(flash.ids);
    host.querySelectorAll<SVGElement>('[data-individual-note-id]').forEach((el) => {
      if (!ids.has(el.getAttribute('data-individual-note-id') || '')) return;
      el.classList.remove('insert-flash');
      el.classList.add('insert-flash');
      el.addEventListener('animationend', () => el.classList.remove('insert-flash'), { once: true });
    });
  }, [flash]);

  return <div ref={hostRef} />;
}
