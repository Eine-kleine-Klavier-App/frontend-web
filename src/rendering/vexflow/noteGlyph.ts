// Shared VexFlow note-glyph rendering, used by both the toolbar duration icons and the
// insert-ghost preview — one real rendering path so neither can drift from actual score
// engraving, and one shared anchor convention (the notehead's own center) so a glyph always
// projects to the same point regardless of its size (a whole note vs. a flagged 16th).
import { Barline, Renderer, Stave, StaveNote, GraceNote, StaveTie, Stem, Voice, Formatter, Beam, Tuplet, Dot, Articulation, Accidental, Modifier, TimeSignature, Annotation } from 'vexflow';
import type { Clef, DurationValue } from '@/core/model/score';
import type { InsertSpec } from '@/core/model/insertItems';
import { staffStepToKey } from '@/core/model/pitch';
import { shrinkWholeNotehead, fixLedgerLineWidth, type Box } from '@/rendering/vexflow/engravingScale';
import { createScratchHost } from '@/rendering/vexflow/scratchHost';
import { STAFF_SPACE } from '@/rendering/vexflow/engravingScale';

export type DurationTool = 'w' | 'h' | 'q' | '8' | '16';
export const DURATION_TOOLS: readonly DurationTool[] = ['w', 'h', 'q', '8', '16'];

export function isDurationTool(id: string): id is DurationTool {
  return (DURATION_TOOLS as readonly string[]).includes(id);
}

/** Tool glyphs that are notation but not a single duration: a quarter rest, an eighth triplet, and
 *  the (parked) tie tool — all drawn by VexFlow, never by hand. */
export type StampTool = 'rest' | 'triplet' | 'tie';

export function isStampTool(id: string): id is StampTool {
  return id === 'rest' || id === 'triplet' || id === 'tie';
}

/**
 * Renders one stem-up note into `host`, returning both its `<svg>` and the `StaveNote` itself
 * (the note is the source of truth for where VexFlow actually anchored it — see
 * `getGhostGlyphMarkup`). Defaults to key 'a/4' (safely mid-staff, no ledger lines) for the
 * toolbar icons; pass `staffStep` for the insert-ghost, so ledger lines render exactly as they
 * would for a real note landing there. VexFlow's own standard sizes, except the whole-note glyph
 * correction (see `engravingScale.ts`) — kept in sync with the real renderer so the ghost/icon
 * never drifts from actual score engraving.
 */
function renderDurationNote(
  duration: DurationValue,
  host: HTMLDivElement,
  opts?: { staffStep?: number; clef?: Clef; ledgerColor?: string; rest?: boolean; dots?: number },
): { svg: SVGSVGElement; note: StaveNote; staff: Stave; noteheadBox: Box | null } {
  host.innerHTML = '';
  const renderer = new Renderer(host, Renderer.Backends.SVG);
  renderer.resize(200, 200); // generous scratch canvas — real geometry comes from measurement, not this
  const ctx = renderer.getContext();
  const clef = opts?.clef ?? 'treble';
  // a rest takes the key the real renderer gives every rest (VexflowRenderer.tsx `buildStaveNote`)
  const key = opts?.rest ? (clef === 'bass' ? 'd/3' : 'b/4') : opts?.staffStep !== undefined ? staffStepToKey(opts.staffStep, clef) : 'a/4';
  const staff = new Stave(0, 0, 40).setContext(ctx);
  // auto_stem so the ghost preview shows the SAME direction the real inserted note will get
  // (VexflowRenderer.tsx uses the same option) — a fixed "always up" ghost would mislead whenever
  // the real note lands with a down stem.
  const note = opts?.rest
    ? new StaveNote({ keys: [key], duration: `${duration}r`, clef })
    : new StaveNote({ keys: [key], duration, clef, auto_stem: true });
  for (let i = 0; i < (opts?.dots ?? 0); i++) Dot.buildAndAttach([note], { all: true });
  note.setStyle({ fillStyle: 'currentColor', strokeStyle: 'currentColor' });
  note.setLedgerLineStyle({ strokeStyle: opts?.ledgerColor ?? 'currentColor', fillStyle: opts?.ledgerColor ?? 'currentColor' });
  fixLedgerLineWidth(note);
  const voice = new Voice({ num_beats: 4, beat_value: 4 }).setStrict(false);
  voice.addTickables([note]);
  new Formatter().joinVoices([voice]).format([voice], 30);
  note.setStave(staff);
  voice.draw(ctx, staff); // note (+ ledger lines) only — `staff` is never `.draw()`n, no staff lines
  const g = note.getSVGElement();
  // for the whole note, `shrinkWholeNotehead` both mutates the DOM AND returns the box that
  // actually matches what's painted — a fresh `.getBBox()` on the notehead itself would report
  // its PRE-shrink extent forever (see engravingScale.ts), silently breaking any caller that
  // needs the glyph's real footprint (the toolbar icon's centering math).
  const noteheadBox =
    duration === 'w' ? shrinkWholeNotehead(g) : (g?.querySelector<SVGGraphicsElement>('.vf-notehead')?.getBBox() ?? null);
  return { svg: host.querySelector('svg')!, note, staff, noteheadBox };
}

/** Renders one stem-up note into `host` — see `renderDurationNote`. */
export function renderDurationSvg(
  duration: DurationTool,
  host: HTMLDivElement,
  opts?: { staffStep?: number; clef?: Clef; ledgerColor?: string },
): { svg: SVGSVGElement; noteheadBox: Box | null } {
  const { svg, noteheadBox } = renderDurationNote(duration, host, opts);
  return { svg, noteheadBox };
}

/** Renders a single note or rest of any written duration (incl. 32nds) — the inspector header's
 *  glyph for the selected object. */
export function renderNoteOrRestSvg(duration: DurationValue, host: HTMLDivElement, rest: boolean): SVGSVGElement {
  return renderDurationNote(duration, host, { rest }).svg;
}

/** Renders a hotbar stamp into `host` through the same engine as the score: the quarter rest the
 *  Rest stamp places, or three beamed eighths under their "3" for the Triplet stamp. */
export function renderStampSvg(stamp: StampTool, host: HTMLDivElement): SVGSVGElement {
  if (stamp === 'rest') return renderDurationNote('q', host, { rest: true }).svg;
  host.innerHTML = '';
  const renderer = new Renderer(host, Renderer.Backends.SVG);
  renderer.resize(200, 200);
  const ctx = renderer.getContext();
  const staff = new Stave(0, 0, 120).setContext(ctx);
  if (stamp === 'tie') {
    // two quarter notes joined by VexFlow's own tie curve — the tie as it engraves on the score
    const pair = [0, 1].map(() => new StaveNote({ keys: ['a/4'], duration: 'q', stem_direction: 1 }));
    pair.forEach((note) => note.setStyle({ fillStyle: 'currentColor', strokeStyle: 'currentColor' }));
    const pairVoice = new Voice({ num_beats: 2, beat_value: 4 }).setStrict(false);
    pairVoice.addTickables(pair);
    new Formatter().joinVoices([pairVoice]).format([pairVoice], 44);
    pairVoice.draw(ctx, staff);
    ctx.save();
    ctx.setFillStyle('currentColor');
    ctx.setStrokeStyle('currentColor');
    new StaveTie({ first_note: pair[0], last_note: pair[1], first_indices: [0], last_indices: [0] }).setContext(ctx).draw();
    ctx.restore();
    return host.querySelector('svg')!;
  }
  const notes = [0, 1, 2].map(() => new StaveNote({ keys: ['a/4'], duration: '8', stem_direction: 1 }));
  const ink = { fillStyle: 'currentColor', strokeStyle: 'currentColor' };
  notes.forEach((note) => note.setStyle(ink));
  const beam = new Beam(notes);
  beam.setStyle(ink);
  const tuplet = new Tuplet(notes);
  const voice = new Voice({ num_beats: 4, beat_value: 4 }).setStrict(false);
  voice.addTickables(notes);
  new Formatter().joinVoices([voice]).format([voice], 60);
  voice.draw(ctx, staff); // notes only — `staff` is never `.draw()`n, no staff lines
  ctx.save();
  ctx.setFillStyle('currentColor');
  ctx.setStrokeStyle('currentColor');
  beam.setContext(ctx).draw();
  tuplet.setContext(ctx).draw();
  ctx.restore();
  return host.querySelector('svg')!;
}

let scratchHost: HTMLDivElement | null = null;
function getScratchHost(): HTMLDivElement {
  scratchHost ??= createScratchHost();
  return scratchHost;
}

interface SharedGlyphBox {
  halfW: number; // furthest any duration's content reaches left/right of ITS OWN notehead center
  above: number; // furthest any reaches above its notehead's bottom edge
  below: number; // furthest any reaches below it
}
let sharedGlyphBox: SharedGlyphBox | null = null;

// Measured ONCE across all 5 durations (not guessed per-icon): every duration icon then shares
// this one box, anchored to ITS OWN notehead center each time — so a note lands at the same
// relative spot in its slot no matter the duration, instead of hand-picked padding constants
// that happen to fit one glyph and not another.
export function getSharedGlyphBox(): SharedGlyphBox {
  if (sharedGlyphBox) return sharedGlyphBox;
  const scratch = getScratchHost();
  let halfW = 0;
  let above = 0;
  let below = 0;
  for (const duration of DURATION_TOOLS) {
    const { svg, noteheadBox: box } = renderDurationSvg(duration, scratch);
    const noteheadBox = box ?? svg.getBBox();
    const contentBox = svg.getBBox();
    const cx = noteheadBox.x + noteheadBox.width / 2;
    const noteheadBottom = noteheadBox.y + noteheadBox.height;
    halfW = Math.max(halfW, cx - contentBox.x, contentBox.x + contentBox.width - cx);
    above = Math.max(above, noteheadBottom - contentBox.y);
    below = Math.max(below, contentBox.y + contentBox.height - noteheadBottom);
  }
  sharedGlyphBox = { halfW, above, below };
  return sharedGlyphBox;
}

const ghostMarkupCache = new Map<string, string>();

/**
 * SVG markup (a `<g>`, as a string) for one duration's full note glyph AT a given staff position
 * — including ledger lines, if `staffStep` puts it off the staff — with its anchor translated to
 * local (0, 0). Wrap it in `<g transform="translate(x,y)">` and the notehead's LEFT edge lands
 * exactly at (x, y) for any duration/position, since they all share this one convention.
 *
 * The anchor X is `getNoteHeadBeginX()` — the notehead's LEFT edge, not its center — because
 * that's what the renderer's own cross-staff position sharing (`VexflowRenderer.tsx`'s
 * `realBeatX`) aligns to: `sn.setXShift(...)` moves every note at a shared onset to the SAME
 * `getNoteHeadBeginX()` regardless of duration/width (the shift target never references glyph
 * width), so begin-X is the one x reference guaranteed consistent between notes of different
 * widths at the same beat (e.g. a filled notehead vs. a whole note, ~5px wider). Anchoring the
 * ghost by center instead would silently reintroduce a per-duration offset — `ghost.x` (read from
 * `zone.segments`, itself begin-X) would land the ghost's CENTER where a real note's BEGIN
 * belongs, off by half the ghost's own notehead width.
 *
 * The anchor Y is the note's own `getYs()[0]` — the same value VexFlow itself used to place both
 * the notehead AND its ledger lines — NOT a measured bbox center of the rendered notehead glyph.
 * Those two are not always the same point: a notehead glyph's rendered ink isn't necessarily
 * centered in its own bounding box (font-metric quirk), so anchoring by measured bbox center
 * silently reintroduces that offset as a rigid shift of the WHOLE group (ledger lines included)
 * when this markup gets repositioned — the notehead ends up in the right place but its ledger
 * lines don't, since they were drawn relative to the stave's line positions, not the notehead's
 * bbox. Anchoring by the note's own target position keeps notehead and ledgers mutually
 * consistent by construction, exactly like a real note.
 *
 * A rest (`rest: true`) ignores `staffStep`: it sits where the renderer draws every rest, so its
 * anchor Y is the staff's bottom line (staff_step 0) instead of a note position.
 */
export function getGhostGlyphMarkup(duration: DurationValue, staffStep: number, clef: Clef, rest = false, dots = 0): string {
  const key = `${duration}:${dots}:${rest ? 'rest' : staffStep}:${clef}`;
  const cached = ghostMarkupCache.get(key);
  if (cached) return cached;
  const { svg, note, staff } = renderDurationNote(duration, getScratchHost(), { staffStep, clef, rest, dots });
  const anchorX = note.getNoteHeadBeginX();
  const anchorY = rest ? staff.getYForLine(staff.getNumLines() - 1) : note.getYs()[0];
  const noteGroup = svg.querySelector('.vf-stavenote');
  const markup = `<g transform="translate(${-anchorX} ${-anchorY})">${noteGroup?.outerHTML ?? ''}</g>`;
  ghostMarkupCache.set(key, markup);
  return markup;
}

/** One grace note (stem up, slashed or plain, as the score draws it) on a scratch stave, at a staff step. */
function renderGraceNote(
  duration: DurationValue,
  host: HTMLDivElement,
  opts: { staffStep: number; clef: Clef; slash: boolean },
): { svg: SVGSVGElement; note: GraceNote } {
  host.innerHTML = '';
  const renderer = new Renderer(host, Renderer.Backends.SVG);
  renderer.resize(200, 200);
  const ctx = renderer.getContext();
  const staff = new Stave(0, 0, 40).setContext(ctx);
  const note = new GraceNote({ keys: [staffStepToKey(opts.staffStep, opts.clef)], duration, clef: opts.clef, slash: opts.slash, stem_direction: Stem.UP });
  note.setStyle({ fillStyle: 'currentColor', strokeStyle: 'currentColor' });
  note.setLedgerLineStyle({ strokeStyle: 'currentColor', fillStyle: 'currentColor' });
  const voice = new Voice({ num_beats: 4, beat_value: 4 }).setStrict(false);
  voice.addTickables([note]);
  new Formatter().joinVoices([voice]).format([voice], 30);
  note.setStave(staff);
  voice.draw(ctx, staff);
  return { svg: host.querySelector('svg')!, note };
}

/** The ghost of a grace note at a staff position: like `getGhostGlyphMarkup`, anchored at the left edge of
 *  the notehead and at its own line, so a grace note lands exactly where it is placed. */
export function getGraceGhostMarkup(duration: DurationValue, staffStep: number, clef: Clef, slash: boolean): string {
  const key = `grace:${duration}:${slash}:${staffStep}:${clef}`;
  const cached = ghostMarkupCache.get(key);
  if (cached) return cached;
  const { svg, note } = renderGraceNote(duration, getScratchHost(), { staffStep, clef, slash });
  const markup = `<g transform="translate(${-note.getNoteHeadBeginX()} ${-note.getYs()[0]})">${svg.querySelector('.vf-stavenote')?.outerHTML ?? ''}</g>`;
  ghostMarkupCache.set(key, markup);
  return markup;
}

// VexFlow's own articulation codes — the same ones the score renderer uses
const SPEC_ARTICULATION: Record<string, string> = { staccato: 'a.', staccatissimo: 'av', tenuto: 'a-', accent: 'a>', marcato: 'a^', fermata: 'a@a' };

/** Renders an insert item as the score would engrave it: the note or rest of its value with its
 *  dots, articulation and accidental attached as real VexFlow modifiers (never composed by hand).
 *  For the hot panel, the hotbar and the constructor's preview. */
export function renderSpecSvg(spec: InsertSpec, host: HTMLDivElement): SVGSVGElement {
  if (spec.kind === 'grace' && spec.grace) return renderGraceNote(spec.value, host, { staffStep: 2, clef: 'treble', slash: spec.grace.slash }).svg;
  if (spec.kind === 'tuplet' && spec.tuplet) return renderTupletSvg(spec, host);
  if (spec.kind === 'timesig' && spec.timeSignature) return renderTimeSignatureSvg(spec.timeSignature, host);
  host.innerHTML = '';
  const renderer = new Renderer(host, Renderer.Backends.SVG);
  renderer.resize(200, 200);
  const ctx = renderer.getContext();
  const staff = new Stave(0, 40, 80).setContext(ctx);
  const rest = spec.kind === 'rest';
  const note = new StaveNote({
    keys: [rest ? 'b/4' : 'a/4'],
    duration: rest ? `${spec.value}r` : spec.value,
    stem_direction: 1,
  });
  note.setStyle({ fillStyle: 'currentColor', strokeStyle: 'currentColor' });
  if (!rest && spec.accidental) note.addModifier(new Accidental(spec.accidental), 0);
  if (!rest) {
    // an arpeggio belongs to a chord: a single-note icon has none to show
    for (const mark of spec.articulations) {
      if (SPEC_ARTICULATION[mark]) note.addModifier(new Articulation(SPEC_ARTICULATION[mark]).setPosition(Modifier.Position.ABOVE), 0);
    }
  }
  for (let i = 0; i < spec.dots; i++) Dot.buildAndAttach([note], { all: true });
  if (!rest && spec.fingering) note.addModifier(new Annotation(String(spec.fingering)).setVerticalJustification(Annotation.VerticalJustify.TOP), 0);
  note.getModifiers().forEach((m) => m.setStyle?.({ fillStyle: 'currentColor', strokeStyle: 'currentColor' }));
  // the stave must be attached before formatting: articulations position against its lines
  note.setStave(staff);
  const voice = new Voice({ num_beats: 4, beat_value: 4 }).setStrict(false);
  voice.addTickables([note]);
  new Formatter().joinVoices([voice]).format([voice], 60);
  voice.draw(ctx, staff); // the note and its modifiers only — the staff is never drawn
  if (spec.value === 'w') shrinkWholeNotehead(note.getSVGElement());
  return host.querySelector('svg')!;
}

/** n notes of the tuplet's value under VexFlow's own "n:m" bracket (beamed when flagged), the first
 *  a rest when the tuplet starts on one. */
function renderTupletSvg(spec: InsertSpec, host: HTMLDivElement): SVGSVGElement {
  const { n, m, first, written, occupied } = spec.tuplet!;
  const sampleCount = Math.min(n, 8);
  const writtenUnit = written ? (2 - 2 ** -written.value.dots) / written.value.value : 1 / ({w:1,h:2,q:4,'8':8,'16':16,'32':32}[spec.value]);
  const occupiedTotal = occupied ? occupied.count * (2 - 2 ** -occupied.value.dots) / occupied.value.value : m * writtenUnit;
  // Both rhythmic lengths are binary fractions; reduce their ratio to integers for VexFlow.
  const gcd = (a: number, b: number): number => b ? gcd(b, a % b) : a;
  const writtenTicks = Math.round(n * writtenUnit * 1024);
  const occupiedTicks = Math.round(occupiedTotal * 1024);
  const divisor = gcd(writtenTicks, occupiedTicks);
  const ratioN = Number.isInteger(occupiedTotal / writtenUnit) ? n : writtenTicks / divisor;
  const ratioM = Number.isInteger(occupiedTotal / writtenUnit) ? occupiedTotal / writtenUnit : occupiedTicks / divisor;
  host.innerHTML = '';
  const renderer = new Renderer(host, Renderer.Backends.SVG);
  renderer.resize(400, 200);
  const ctx = renderer.getContext();
  const staff = new Stave(0, 40, 40 + sampleCount * 22).setContext(ctx);
  const ink = { fillStyle: 'currentColor', strokeStyle: 'currentColor' };
  const notes = Array.from({ length: sampleCount }, (_, i) => {
    const rest = i === 0 && first === 'rest';
    const note = new StaveNote({ keys: [rest ? 'b/4' : 'a/4'], duration: rest ? `${spec.value}r` : spec.value, stem_direction: 1 });
    note.setStyle(ink);
    if (i === 0) {
      for (let dot = 0; dot < spec.dots; dot++) Dot.buildAndAttach([note], { all: true });
      if (!rest && spec.accidental) note.addModifier(new Accidental(spec.accidental), 0);
      if (!rest && spec.fingering) note.addModifier(new Annotation(String(spec.fingering)).setVerticalJustification(Annotation.VerticalJustify.TOP), 0);
    }
    note.setStave(staff);
    return note;
  });
  const flagged = ['8', '16', '32'].includes(spec.value);
  const beamed = notes.filter((note) => !note.isRest());
  const beam = flagged && beamed.length > 1 ? new Beam(beamed) : null;
  beam?.setStyle(ink);
  const tuplet = new Tuplet(notes, { num_notes: ratioN, notes_occupied: ratioM, ratioed: !(ratioN === 3 && ratioM === 2), bracketed: !beam || first === 'rest' });
  const voice = new Voice({ num_beats: 4, beat_value: 4 }).setStrict(false);
  voice.addTickables(notes);
  new Formatter().joinVoices([voice]).format([voice], sampleCount * 20);
  voice.draw(ctx, staff);
  ctx.save();
  ctx.setFillStyle('currentColor');
  ctx.setStrokeStyle('currentColor');
  beam?.setContext(ctx).draw();
  tuplet.setContext(ctx).draw();
  ctx.restore();
  return host.querySelector('svg')!;
}

/** A time signature on a miniature staff, shared by palette, slots and constructor. */
function renderTimeSignatureSvg(ts: { beats: number; beatValue: number; dots?: number }, host: HTMLDivElement): SVGSVGElement {
  host.innerHTML = '';
  const renderer = new Renderer(host, Renderer.Backends.SVG);
  renderer.resize(200, 200);
  const ctx = renderer.getContext();
  ctx.setFillStyle('currentColor');
  ctx.setStrokeStyle('currentColor');
  const space = new Stave(0, 0, 0).getSpacingBetweenLines();
  const sig = new TimeSignature(`${ts.beats * (2 ** ((ts.dots ?? 0) + 1) - 1)}/${ts.beatValue * 2 ** (ts.dots ?? 0)}`);
  const width = Math.max(space * 7, sig.getWidth() + space * 4);
  const staff = new Stave(0, 0, width).setContext(ctx);
  staff.setBegBarType(Barline.type.NONE).setEndBarType(Barline.type.NONE).draw();
  sig.setStave(staff);
  sig.setX((width - sig.getWidth()) / 2);
  sig.draw();
  return host.querySelector('svg')!;
}

// a short staff for an example: room for a clef and a few notes, the staff a little below the top
const EXAMPLE_WIDTH = 20 * STAFF_SPACE;
const EXAMPLE_HEIGHT = 11 * STAFF_SPACE;
const EXAMPLE_TOP = 3.5 * STAFF_SPACE;
const EXAMPLE_END_PAD = 1.2 * STAFF_SPACE;

/** A few quarter notes (by staff step) engraved on a short staff with its clef, drawn in `host`'s
 *  text colour and scaled by its box (the SVG keeps only its viewBox). */
export function renderStaffExampleSvg(clef: Clef, steps: number[], host: HTMLDivElement): void {
  host.innerHTML = '';
  const renderer = new Renderer(host, Renderer.Backends.SVG);
  renderer.resize(EXAMPLE_WIDTH, EXAMPLE_HEIGHT);
  const ctx = renderer.getContext();
  const ink = getComputedStyle(host).color;
  ctx.setFillStyle(ink);
  ctx.setStrokeStyle(ink);
  const stave = new Stave(0, EXAMPLE_TOP, EXAMPLE_WIDTH - 1).addClef(clef);
  stave.setContext(ctx).draw();
  if (steps.length) {
    const notes = steps.map((step) => new StaveNote({ keys: [staffStepToKey(step, clef)], duration: 'q', clef }));
    const voice = new Voice({ num_beats: notes.length, beat_value: 4 }).setMode(Voice.Mode.SOFT).addTickables(notes);
    new Formatter().joinVoices([voice]).format([voice], EXAMPLE_WIDTH - stave.getNoteStartX() - EXAMPLE_END_PAD);
    voice.draw(ctx, stave);
  }
  const svg = host.querySelector('svg');
  svg?.setAttribute('viewBox', `0 0 ${EXAMPLE_WIDTH} ${EXAMPLE_HEIGHT}`);
  svg?.removeAttribute('width');
  svg?.removeAttribute('height');
  svg?.setAttribute('aria-hidden', 'true');
}
