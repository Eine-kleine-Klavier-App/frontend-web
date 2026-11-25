// Engraves the backend's contexts that VexFlow's stave does not carry itself: dynamics, hairpins,
// slurs, octave lines, tempos, tempo transitions and the clefs that change inside a measure. Each
// mark is one `<g data-object-id="<context id>">` appended to the score's SVG, so it is picked,
// hovered and recoloured exactly like any other engraved object (see index.css `[data-object-id]`).
//
// Musical anchors come from staff zones; measured engraving bounds reserve collision-free space.
import { inkBox, type CollisionLayout, type Placement } from './collisionLayout';
import { Flow, Glyph, KeySignature, Stave, TextDynamics, Voice, Formatter, type RenderContext } from 'vexflow';
import type { ContextIndex } from '@/core/model/contexts';
import { toBeats, keyOfAlterations, markKey } from '@/core/model/contexts';
import type { DurationValue, Fraction, RefrainContext, ScoreContext, ScoreDocument, KeyAlteration, ClefName, VoltaContext } from '@/core/model/score';
import { staffOnsetX, type ContextShape, type SlurShape, type SpanPreview, type StaffZone } from '@/rendering/ScoreRenderer';
import { derivedEnding, passesLabel, refrainLabel, voltaParts, type Place } from '@/core/model/repeats';
import { automaticArch, fitted, framed, slurOffsets, type SlurFrame, type SlurOffsets } from '@/core/model/slurHandles';
import { slurHeight } from '@/core/model/presentation';
import { getGhostGlyphMarkup } from './noteGlyph';
import { REPEAT_SIGN_ROOM, STAFF_SPACE } from './engravingScale';

/** the highest a slur's arch may be pushed to clear engraving, in staff spaces */
const MAX_SLUR_LIFT = 10;

/** how far the user may move a mark that has no row of its own (octave, sustain) from where it is put: the range its vertical offset is clamped to */
/** how far a hairpin stops before a barline */
const HAIRPIN_BARLINE_GAP = 0.7 * STAFF_SPACE;
/** the face for numbers on the staff (volta endings, repeat counts): Georgia's figures are old-style, so a 1 is short and a 3 or 4 hangs below the line */
const NUMBER_FONT = '"Times New Roman", Times, serif';
const SPAN_NUDGE = { min: -2 * STAFF_SPACE, max: 2 * STAFF_SPACE };

const SVG_NS = 'http://www.w3.org/2000/svg';

/** the tempo word as it is printed */
const capitalise = (word: string) => word.charAt(0).toUpperCase() + word.slice(1);

/** the note a metronome mark counts in, as the duration VexFlow engraves it with */
const BEAT_DURATION: Record<number, DurationValue> = { 1: 'w', 2: 'h', 4: 'q', 8: '8', 16: '16', 32: '32' };
/** a metronome note is the score's own stem-up note drawn at this part of its size, so it reads as a note beside the text */
const METRONOME_NOTE_SCALE = 0.62;
/** the staff step it is engraved on: below the middle line, so the stem goes up and no ledger line is drawn */
const METRONOME_NOTE_STEP = 2;

/** Saved custom signatures use the same order and staff positions as standard engraving. */
class LetterKeySignature extends KeySignature {
  constructor(private readonly alterations: KeyAlteration[], private readonly clefName: ClefName,
    private readonly previous?: KeyAlteration[]) { super('C'); }
  override format(): void {
    this.width = 0; this.glyphs = []; this.xPositions = [0]; this.accList = [];
    for (const [type, alteration, order, key] of [
      ['#', 'sharp', [3, 0, 4, 1, 5, 2, 6], 'C#'],
      ['b', 'flat', [6, 2, 5, 1, 4, 0, 3], 'Cb'],
    ] as const) {
      const template = Flow.keySignature(key);
      this.convertAccLines(this.clefName, type, template);
      order.forEach((letter, i) => {
        if (this.previous?.[letter] === alteration && this.alterations[letter] !== alteration)
          this.accList.push({ type: 'n', line: template[i].line });
      });
    }
    for (const [type, alteration, order, key] of [
      ['#', 'sharp', [3, 0, 4, 1, 5, 2, 6], 'C#'],
      ['b', 'flat', [6, 2, 5, 1, 4, 0, 3], 'Cb'],
    ] as const) {
      const template = Flow.keySignature(key);
      this.convertAccLines(this.clefName, type, template);
      order.forEach((letter, i) => {
        if (this.alterations[letter] === alteration) this.accList.push({ type, line: template[i].line });
      });
    }
    for (let i = 0; i < this.accList.length; i++) this.convertToGlyph(this.accList[i], this.accList[i + 1]);
    this.formatted = true;
  }
}
export function createKeySignature(alterations: KeyAlteration[], clef: ClefName, previous?: KeyAlteration[]): KeySignature {
  const current = keyOfAlterations(alterations);
  const before = previous && keyOfAlterations(previous);
  return current.standard === false || before?.standard === false
    ? new LetterKeySignature(alterations, clef, previous)
    : new KeySignature(current.name, before?.name);
}

export interface MarkEnv {
  /** the group of each system: a mark, and each piece of a span, is drawn into the group of the system it stands in */
  systemGroups: SVGGElement[];
  ctx: RenderContext;
  doc: ScoreDocument;
  index: ContextIndex;
  zones: StaffZone[];
  /** system number of every measure */
  systemOf: Map<string, number>;
  voiceColors: Record<string, string>;
  ink: string;
  /** the stored factor of the automatic distance from the staff, per context id (1 = automatic) */
  factors: Record<string, number>;
  /** the slur being reshaped by a drag: its offsets until the drag is committed */
  slurPreview?: { id: string; offsets: SlurOffsets } | null;
  /** the span whose start or end is being dragged: drawn as if it already began or ended there */
  spanPreview?: SpanPreview | null;
  collisions: CollisionLayout;
  inlineWidths: Map<string, number>;
  /** the systems drawn when a preview draws only some: a mark that touches none of them is left out */
  systems?: ReadonlySet<number>;
}

interface Point {
  measureId: string;
  beats: number;
}

export function drawContextMarks(env: MarkEnv): { shapes: ContextShape[]; nodes: SVGGElement[]; slurShapes: SlurShape[] } {
  const { doc, index, zones, systemOf } = env;
  const shapes: ContextShape[] = [];
  /** the drawn mark of each shape, in the same order */
  const nodes: SVGGElement[] = [];
  const slurShapes: SlurShape[] = [];
  const staffOrder = doc.staffOrder;
  let activeContext: ScoreContext;
  const zoneOf = new Map<string, StaffZone>();
  for (const z of zones) zoneOf.set(`${z.measureId}:${z.staffId}`, z);
  const stepPx = zones[0]?.stepPx ?? STAFF_SPACE / 2;

  /** the x a (measure, beats) point is drawn at — piecewise between the measure's real onsets */
  const xAt = (measureId: string, beats: number): number | null => {
    const zone = zoneOf.get(`${measureId}:${staffOrder[0]}`);
    return zone ? staffOnsetX(zone, beats) : null;
  };
  const bottomOf = (measureId: string, staffId: string): number | null => zoneOf.get(`${measureId}:${staffId}`)?.bottomLineY ?? null;
  const topOf = (measureId: string, staffId: string): number | null => {
    const bottom = bottomOf(measureId, staffId);
    return bottom === null ? null : bottom - 8 * stepPx;
  };

  /** a span cut into one piece per system it touches: where it starts and ends on each. A span whose end is the
   *  start of a later measure covers the last note of the one before and is drawn to that measure's end, not into the next
   *  (`toBarline` on its last piece). */
  const pieces = (start: Point, end: Point, atRest = false): { measureId: string; x0: number; x1: number; first: boolean; last: boolean; toBarline: boolean }[] => {
    const from = index.measureIndex.get(start.measureId) ?? 0;
    const toScoreEnd: boolean = end.beats === Infinity;
    const endsAtBarline: boolean = toScoreEnd || (end.beats === 0 && (index.measureIndex.get(end.measureId) ?? 0) > from);
    const to = (index.measureIndex.get(end.measureId) ?? 0) - (endsAtBarline && !toScoreEnd ? 1 : 0);
    const out: { measureId: string; x0: number; x1: number; first: boolean; last: boolean; toBarline: boolean }[] = [];
    let current: { system: number; firstM: string; lastM: string } | null = null;
    const runs: { system: number; firstM: string; lastM: string }[] = [];
    for (let i = from; i <= to; i += 1) {
      const m = doc.measures[i]?.id;
      if (!m) continue;
      const system = systemOf.get(m);
      if (system === undefined) continue;
      if (current && current.system === system) current.lastM = m;
      else {
        current = { system, firstM: m, lastM: m };
        runs.push(current);
      }
    }
    // a span whose edge is being dragged is drawn to where the pointer holds it, never past the other edge
    const dragged = !atRest && env.spanPreview?.id === activeContext.id ? env.spanPreview : null;
    runs.forEach((run, i) => {
      const first = i === 0;
      const last = i === runs.length - 1;
      let x0 = first ? xAt(start.measureId, start.beats) : zoneOf.get(`${run.firstM}:${staffOrder[0]}`)?.x0 ?? null;
      let x1 = last && !endsAtBarline ? xAt(end.measureId, end.beats) : zoneOf.get(`${run.lastM}:${staffOrder[0]}`)?.x1 ?? null;
      if (dragged && x0 !== null && x1 !== null) {
        if (first && dragged.edge === 'start') x0 = Math.min(dragged.x, x1 - STAFF_SPACE);
        if (last && dragged.edge === 'end') x1 = Math.max(dragged.x, x0 + STAFF_SPACE);
      }
      if (x0 !== null && x1 !== null) out.push({ measureId: run.firstM, x0, x1, first, last, toBarline: last && endsAtBarline });
    });
    return out;
  };

  const make = (tag: string, attrs: Record<string, string | number>): SVGElement => {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
    return node;
  };
  const text = (value: string, x: number, y: number, attrs: Record<string, string | number> = {}): SVGElement => {
    const node = make('text', { x, y, fill: env.ink, ...attrs });
    node.textContent = value;
    return node;
  };

  const handle = (g: SVGGElement, edge: 'start' | 'end', x: number, y: number) => {
    g.setAttribute(`data-context-${edge}-x`, String(x));
    g.setAttribute(`data-context-${edge}-y`, String(y));
  };

  /** a piece of a span, as its own group inside the span's group */
  const pieceGroup = (parent: SVGGElement, piece: { measureId: string; x0: number; x1: number }): SVGGElement => {
    const g = document.createElementNS(SVG_NS, 'g');
    g.setAttribute('data-layout-piece', piece.measureId);
    g.setAttribute('data-piece-left', String(piece.x0));
    parent.appendChild(g);
    return g;
  };
  /** a repeat sign on every staff: a thick and a thin bar with a pair of dots between the lines */
  const barSign = (g: SVGGElement, measureId: string, x: number, side: 'start' | 'end') => {
    const thin = side === 'start' ? x + 0.8 * STAFF_SPACE : x - 0.8 * STAFF_SPACE;
    const dots = side === 'start' ? x + 1.4 * STAFF_SPACE : x - 1.4 * STAFF_SPACE;
    // the thick and the thin bar run through every staff and the gap between them; the dots stand on each staff
    const top = topOf(measureId, staffOrder[0]);
    const bottomEdge = bottomOf(measureId, staffOrder[staffOrder.length - 1]);
    if (top !== null && bottomEdge !== null) {
      g.appendChild(make('rect', { x: x - 0.25 * STAFF_SPACE, y: top, width: 0.5 * STAFF_SPACE, height: bottomEdge - top, fill: env.ink }));
      g.appendChild(make('line', { x1: thin, x2: thin, y1: top, y2: bottomEdge, stroke: env.ink, 'stroke-width': 1 }));
    }
    for (const staffId of staffOrder) {
      const bottom = bottomOf(measureId, staffId);
      if (bottom === null) continue;
      for (const lift of [1.5, 2.5]) g.appendChild(make('circle', { cx: dots, cy: bottom - lift * STAFF_SPACE, r: 0.22 * STAFF_SPACE, fill: env.ink }));
    }
  };
  /** the `|:` of a repeat that begins this measure, with its click zone: on the measure's left barline, and at the start of a system after
   *  the clef, key and time signature, in the room kept before the first note */
  const startSign = (g: SVGGElement, measureId: string, startBeats: number) => {
    const zone = zoneOf.get(`${measureId}:${staffOrder[0]}`);
    if (startBeats !== 0 || !zone) return;
    const measureAt = index.measureIndex.get(measureId) ?? 0;
    const beginsSystem = measureAt === 0 || systemOf.get(doc.measures[measureAt - 1].id) !== systemOf.get(measureId);
    const x = beginsSystem ? zone.x0 - REPEAT_SIGN_ROOM + 0.9 * STAFF_SPACE : zone.left;
    barSign(g, measureId, x, 'start');
    signHit(g, measureId, x, 'start');
  };
  /** the `:|` of a repeat or an ending that ends on the barline at `x`, with its click zone */
  const endSign = (g: SVGGElement, measureId: string, x: number) => {
    barSign(g, measureId, x, 'end');
    signHit(g, measureId, x, 'end');
  };
  /** the click zone of a repeat sign: the bars and the dots, across every staff. The sign itself is drawn by the staves, so without
   *  this the repeat would have nothing to click on there. `x` is the barline, `side` which way the sign faces */
  const signHit = (g: SVGGElement, measureId: string, x: number, side: 'start' | 'end') => {
    const top = topOf(measureId, staffOrder[0]);
    const bottom = bottomOf(measureId, staffOrder[staffOrder.length - 1]);
    if (top === null || bottom === null) return;
    const reach = 1.8 * STAFF_SPACE;
    const margin = 0.5 * STAFF_SPACE;
    g.appendChild(make('rect', { x: side === 'start' ? x - margin : x - reach, y: top, width: reach + margin, height: bottom - top, fill: 'none', style: 'fill:none;stroke:none' }));
  };
  const placementOf = (c: ScoreContext, measureId: string): Placement => ({
    measureId,
    staffId: c.kind === 'sustain' ? staffOrder[staffOrder.length - 1]
      : 'staffId' in c ? c.staffId
      : 'voiceId' in c ? index.staffOfVoice(c.voiceId, measureId, toBeats(c.position)) : staffOrder[0],
    kind: c.kind === 'slur' ? 'attached' : 'context',
  });
  const sideOf = (c: ScoreContext): -1 | 1 => c.kind === 'tempo' || c.kind === 'tempoTransition' || c.kind === 'octave' && c.octaves > 0 ? -1 : 1;
  const finish = (node: SVGGElement, c: ScoreContext, measureId: string, offset?: { min: number; max: number }, publish = true): number | undefined => {
    node.setAttribute('data-layout-context', c.id);
    if (publish) {
      node.setAttribute('class', 'vf-context-mark');
      node.setAttribute('data-object-id', c.id);
    }
    const placement = { ...placementOf(c, measureId), timed: 'endMeasureId' in c };
    // a span whose edge is being dragged is laid out against the other marks at its resting length: it follows the pointer
    // sideways, and neither it nor the marks around it move up or down
    const resting = env.spanPreview?.id === c.id && 'endMeasureId' in c ? pieces(startOf(c), endOf(c), true).find((piece) => piece.measureId === measureId) : undefined;
    const span = resting && { x0: resting.x0, x1: resting.x1 };
    // a refrain's signs span the staves and stand on the barlines: they are not laid out against other marks (an item ink
    // box across two staves would be re-measured against the staff below it on every pass, and never settle)
    // a pedal's height is the system's, set where it is drawn: it is registered, never moved
    if (c.kind === 'refrain' || c.kind === 'volta') { /* stays where it is drawn */ } else if (c.kind === 'sustain') env.collisions.add(node, placement, undefined, span);
    else if (c.kind === 'slur') env.collisions.add(node, { ...placement, kind: node.hasAttribute('data-cross-staff') ? 'bridge' : 'attached' }, undefined, span);
    else env.collisions.placeOutside(node, placement, sideOf(c), span, 'endMeasureId' in c);
    let reference: number | undefined;
    let manualOffset = 0;
    if (c.kind !== 'slur' && c.kind !== 'refrain' && c.kind !== 'volta') {
      const zone = zoneOf.get(`${measureId}:${placement.staffId}`);
      if (zone) {
        const box = inkBox(node);
        const gap = sideOf(c) === 1 ? box.y - zone.bottomLineY : zone.bottomLineY - 8 * zone.stepPx - (box.y + box.height);
        // a mark touching its staff has no distance to scale: its own height stands in
        reference = gap > 0 ? gap : box.height;
        manualOffset = sideOf(c) * ((env.factors[c.id] ?? 1) - 1) * reference;
      }
    }
    if (manualOffset) {
      const placement = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      placement.setAttribute('transform', `translate(0 ${manualOffset})`);
      placement.append(...node.childNodes); node.appendChild(placement);
      for (const edge of ['start', 'end']) {
        const name = `data-context-${edge}-y`;
        if (node.hasAttribute(name)) node.setAttribute(name, String(Number(node.getAttribute(name)) + manualOffset));
      }
    }
    if (publish) {
      shapes.push({ id: c.id, html: node.innerHTML, offset, reference, side: sideOf(c) });
      nodes.push(node);
    }
    return reference;
  };

  /** a pickable mark: the group is added to the score, its markup handed on as the click target */
  const group = (
    id: string,
    build: (g: SVGGElement) => void,
    voiceId?: string,
    offset?: { min: number; max: number },
  ): void => {
    const g = document.createElementNS(SVG_NS, 'g');
    g.setAttribute('class', 'vf-context-mark');
    g.setAttribute('data-object-id', id);
    g.style.setProperty('--voice-color', 'var(--color-accent)');
    env.systemGroups[systemOf.get(activeContext.measureId) ?? 0].appendChild(g);
    build(g);
    if (!g.childNodes.length) { g.remove(); return; }
    const parts = [...g.querySelectorAll<SVGGElement>('[data-layout-piece]')];
    let reference: number | undefined;
    if (parts.length) {
      // each piece of a span is a mark of its own in its system's group, with the span's id
      const pieceMarks: SVGGElement[] = [];
      for (const part of parts) {
        const pieceMark = g.cloneNode(false) as SVGGElement;
        // a span is as long as the music it covers: it only takes the hover colour, it is not enlarged about its centre
        pieceMark.classList.add('vf-span');
        pieceMark.append(part);
        env.systemGroups[systemOf.get(part.getAttribute('data-layout-piece')!) ?? 0].appendChild(pieceMark);
        if (voiceId && g.style.getPropertyValue('--voice-color')) part.style.setProperty('--voice-color', g.style.getPropertyValue('--voice-color'));
        const partReference = finish(part, activeContext, part.getAttribute('data-layout-piece')!, offset, false);
        reference ??= partReference;
        for (const edge of ['start', 'end']) for (const axis of ['x', 'y']) {
          const name = `data-context-${edge}-${axis}`;
          if (part.hasAttribute(name)) pieceMark.setAttribute(name, part.getAttribute(name)!);
        }
        pieceMarks.push(pieceMark);
      }
      g.remove();
      for (const pieceMark of pieceMarks) {
        shapes.push({ id, html: pieceMark.innerHTML, offset, reference, side: sideOf(activeContext) });
        nodes.push(pieceMark);
      }
    } else finish(g, activeContext, activeContext.measureId, offset);
  };

  const nudge = (_id: string, range: { min: number; max: number }): number =>
    Math.min(range.max, Math.max(range.min, 0));

  /** the row dynamics and hairpins stand on, under a staff: its baseline, and how far the user may
   *  move it (never into the staff above, never into the one below) */
  const rowUnder = (measureId: string, staffId: string): { y: number; range: { min: number; max: number } } | null => {
    const bottom = bottomOf(measureId, staffId);
    if (bottom === null) return null;
    const base = bottom + 3.4 * STAFF_SPACE;
    const below = staffOrder[staffOrder.indexOf(staffId) + 1];
    const nextTop = below ? topOf(measureId, below) : null;
    const max = (nextTop !== null ? nextTop - 1.4 * STAFF_SPACE : bottom + 14 * STAFF_SPACE) - base;
    return { y: base, range: { min: -0.9 * STAFF_SPACE, max: Math.max(max, -0.9 * STAFF_SPACE) } };
  };
  /** the row above the top staff, for tempos */
  const rowAbove = (measureId: string): { y: number; range: { min: number; max: number } } | null => {
    const top = topOf(measureId, staffOrder[0]);
    return top === null ? null : { y: top - 5.2 * STAFF_SPACE, range: { min: -2 * STAFF_SPACE, max: 3.4 * STAFF_SPACE } };
  };

  const itemsOfVoice = (voiceId: string, start: Point, end: Point) => {
    const from = index.measureIndex.get(start.measureId) ?? 0;
    const to = index.measureIndex.get(end.measureId) ?? 0;
    const out: { measureId: string; beats: number; staffId: string; steps: number[] }[] = [];
    for (let i = from; i <= to; i += 1) {
      const measure = doc.measures[i];
      const voice = measure?.voices.find((v) => v.id === voiceId);
      voice?.items.forEach((item) => {
        if (item.kind === 'rest') return;
        const key = i * 1e4 + item.position;
        if (key < from * 1e4 + start.beats - 1e-6 && i === from) return;
        if (key > to * 1e4 + end.beats + 1e-6) return;
        out.push({ measureId: measure.id, beats: item.position, staffId: item.notes[0]?.staffId ?? staffOrder[0], steps: item.notes.map((n) => n.staffStep) });
      });
    }
    return out;
  };

  const startOf = (c: ScoreContext): Point => ({ measureId: c.measureId, beats: toBeats(c.position) });
  /** where a span ends; one with no end lasts to the end of the score: the end of the last measure */
  const endOf = (c: { endMeasureId: string | null; endPosition: Fraction | null }): Point =>
    c.endMeasureId === null || c.endPosition === null
      ? { measureId: doc.measures[doc.measures.length - 1]?.id ?? '', beats: Infinity }
      : { measureId: c.endMeasureId, beats: toBeats(c.endPosition) };
  const inlineRight = new Map<string, number>();
  const inline = doc.contexts.filter((c) => c.kind === 'clef' || c.kind === 'keySignature')
    .sort((a, b) => (a.kind === 'clef' ? 0 : 1) - (b.kind === 'clef' ? 0 : 1));
  const slots = new Map<string, typeof inline>();
  for (const c of inline) {
    if (!('staffId' in c) || toBeats(c.position) <= 0) continue;
    const key = `${c.measureId}:${c.staffId}:${toBeats(c.position)}`;
    const values = slots.get(key) ?? []; values.push(c); slots.set(key, values);
  }
  for (const values of slots.values()) {
    const last = values[0];
    if (!('staffId' in last)) continue;
    const beat = toBeats(last.position);
    const rhythmic = env.collisions.items.filter((it) => it.measureId === last.measureId && it.staffId === last.staffId && it.beat === beat);
    let right = Math.min(xAt(last.measureId, beat) ?? Infinity, ...rhythmic.map((it) => it.box.x)) - STAFF_SPACE;
    for (const c of [...values].reverse()) {
      inlineRight.set(c.id, right);
      right -= (env.inlineWidths.get(c.id) ?? (c.kind === 'clef' ? 2.4 * STAFF_SPACE : 4 * STAFF_SPACE)) + STAFF_SPACE;
    }
  }


  // a dynamic or a hairpin for several voices is a context for each voice: those of one place and
  // value are one mark, drawn once from the voice of the topmost staff
  const rankOf = (c: ScoreContext & { voiceId: string }): number =>
    staffOrder.indexOf(index.staffOfVoice(c.voiceId, c.measureId, toBeats(c.position)));
  const drawn = new Map<string, ScoreContext & { voiceId: string }>();
  for (const c of doc.contexts) {
    const key = markKey(c);
    if (key === null || !('voiceId' in c) || (c.kind === 'hairpin' && !index.voiceSounds(c.voiceId))) continue;
    const best = drawn.get(key);
    if (!best || rankOf(c) < rankOf(best)) drawn.set(key, c);
  }
  const expanded = doc.contexts.filter((c) => {
    const key = markKey(c);
    if (key !== null) return drawn.get(key) === c;
    return !('voiceId' in c) || index.voiceSounds(c.voiceId);
  });
  // a pedal stands under everything else in its system, so it is drawn after every other mark
  const priority = (c: ScoreContext) => c.kind === 'clef' || c.kind === 'keySignature' ? 0 : c.kind === 'slur' ? 1 : c.kind === 'sustain' ? 3 : 2;
  expanded.sort((a, b) => priority(a) - priority(b));
  for (const c of expanded) {
    if (env.systems) {
      const from = index.measureIndex.get(c.measureId) ?? 0;
      const endId = 'endMeasureId' in c ? c.endMeasureId : c.measureId;
      const to = endId === null ? doc.measures.length - 1 : index.measureIndex.get(endId) ?? from;
      let touched = false;
      for (let i = from; i <= to && !touched; i++) touched = env.systems.has(systemOf.get(doc.measures[i].id) ?? -1);
      if (!touched) continue;
    }
    activeContext = c;
    switch (c.kind) {
      case 'dynamic': {
        const voiceId = c.voiceId;
        const at = startOf(c);
        const staffId = index.staffOfVoice(voiceId, at.measureId, at.beats);
        const x = xAt(at.measureId, at.beats);
        const row = rowUnder(at.measureId, staffId);
        if (x === null || !row) break;
        group(
          c.id,
          (g) => {
            env.ctx.save();
            env.ctx.setFillStyle(env.ink);
            const glyphs = env.ctx.openGroup('dynamic-glyphs') as SVGGElement;
            const staff = new Stave(0, 0, 100).setContext(env.ctx);
            const voice = new Voice({ num_beats: 4, beat_value: 4 }).setStrict(false);
            voice.addTickables([new TextDynamics({ text: c.dynamic, duration: 'q' })]);
            new Formatter().joinVoices([voice]).format([voice], 80);
            voice.draw(env.ctx, staff);
            env.ctx.closeGroup();
            const box = glyphs.getBBox();
            glyphs.setAttribute('transform', `translate(${x + 6 - box.x - box.width / 2} ${row.y + nudge(c.id, row.range) - box.y - box.height})`);
            g.appendChild(glyphs);
            env.ctx.restore();
          },
          undefined,
          row.range,
        );
        break;
      }
      case 'hairpin': {
        const voiceId = c.voiceId;
        const start = startOf(c);
        const end = endOf(c);
        const staffId = index.staffOfVoice(voiceId, start.measureId, start.beats);
        group(
          c.id,
          (g) => {
            const parent = g;
            for (const piece of pieces(start, end)) {
              const g = document.createElementNS(SVG_NS, 'g');
              g.setAttribute('data-layout-piece', piece.measureId);
              g.setAttribute('data-piece-left', String(piece.x0));
              parent.appendChild(g);
              const row = rowUnder(piece.measureId, staffId);
              if (!row) continue;
              const y = row.y + nudge(c.id, row.range) - 0.6 * STAFF_SPACE;
              const half = 0.55 * STAFF_SPACE;
              // an end that lies on a barline (the span's own, or the system's) stops short of it, so the point does not touch the line
              const x0 = piece.first ? piece.x0 : piece.x0 + HAIRPIN_BARLINE_GAP;
              const x1 = piece.last && !piece.toBarline ? piece.x1 : piece.x1 - HAIRPIN_BARLINE_GAP;
              if (piece.first) handle(g, 'start', x0, y);
              if (piece.last) handle(g, 'end', x1, y);
              // two arms meeting at a point: a crescendo meets at its start and opens to the right, a diminuendo opens at its start and meets at its end
              const open = c.type === 'crescendo' ? x1 : x0;
              const apex = c.type === 'crescendo' ? x0 : x1;
              g.appendChild(make('path', { d: `M${open} ${y - half} L${apex} ${y} L${open} ${y + half}`, fill: 'none', stroke: env.ink, 'stroke-width': 1.2, 'stroke-linejoin': 'round' }));
            }
          },
          voiceId,
          rowUnder(start.measureId, staffId)?.range,
        );
        break;
      }
      case 'slur': {
        const voiceId = c.voiceId;
        const start = startOf(c);
        const end = endOf(c);
        const items = itemsOfVoice(voiceId, start, end);
        if (items.length < 1) break;
        group(
          c.id,
          (g) => {
            const parent = g;
            for (const piece of pieces(start, end)) {
              const g = document.createElementNS(SVG_NS, 'g');
              g.setAttribute('data-layout-piece', piece.measureId);
              g.setAttribute('data-piece-left', String(piece.x0));
              parent.appendChild(g);
              const inPiece = items.filter((it) => (systemOf.get(it.measureId) ?? -1) === (systemOf.get(piece.measureId) ?? -2));
              if (!inPiece.length) continue;
              const a = inPiece[0];
              const z = inPiece[inPiece.length - 1];
              const za = zoneOf.get(`${a.measureId}:${a.staffId}`);
              const zz = zoneOf.get(`${z.measureId}:${z.staffId}`);
              const xa = xAt(a.measureId, a.beats);
              const xz = xAt(z.measureId, z.beats);
              if (!za || !zz || xa === null || xz === null) continue;
              if (a.staffId !== z.staffId) g.setAttribute('data-cross-staff', 'true');
              const mean = (it: typeof a) => it.steps.reduce((s, v) => s + v, 0) / (it.steps.length || 1);
              const above = (mean(a) + mean(z)) / 2 >= 4;
              const side = above ? -1 : 1;
              const ya = za.bottomLineY - (above ? Math.max(...a.steps) : Math.min(...a.steps)) * stepPx + side * 1.1 * STAFF_SPACE;
              const yz = zz.bottomLineY - (above ? Math.max(...z.steps) : Math.min(...z.steps)) * stepPx + side * 1.1 * STAFF_SPACE;
              const dragged = env.spanPreview?.id === c.id ? env.spanPreview.edge : null;
              const x0 = dragged === 'start' && piece.first ? piece.x0 : (piece.first ? xa : piece.x0) + 6;
              const x1 = dragged === 'end' && piece.last ? piece.x1 : piece.toBarline ? piece.x1 : (piece.last ? xz : piece.x1) + 6;
              // an edge pulled sideways changes only the x of the points: the slur is shaped at its resting length and its points are
              // carried along x, so none of them rises or sinks while the edge is dragged
              const restingFrom = (piece.first ? xa : piece.x0) + 6;
              const restingTo = (piece.toBarline ? piece.x1 : (piece.last ? xz : piece.x1) + 6);
              const restingWidth = restingTo - restingFrom;
              // a stored height is a factor of the arch the slur has of itself; until then the arch is that one, raised where the notes under it need it
              const storedHeight = slurHeight(doc.presentation, c.id);
              const arch = automaticArch(restingWidth, STAFF_SPACE);
              const lift = storedHeight !== null ? side * storedHeight * arch : env.collisions.curveLift(restingFrom, ya, restingTo, yz, side * arch, a.staffId,
                new Set([...systemOf].filter(([, system]) => system === systemOf.get(piece.measureId)).map(([measure]) => measure)), MAX_SLUR_LIFT * STAFF_SPACE);
              const thick = 0.32 * STAFF_SPACE;
              const base: SlurFrame = {
                p0: { x: restingFrom, y: ya },
                p3: { x: restingTo, y: yz },
                c1: { x: restingFrom + restingWidth * 0.25, y: ya + lift },
                c2: { x: restingFrom + restingWidth * 0.75, y: yz + lift },
              };
              const offsets: SlurOffsets = env.slurPreview?.id === c.id ? env.slurPreview.offsets : slurOffsets(doc.presentation, c.id);
              const restingFrame: SlurFrame = framed(base, fitted(base, offsets));
              const carried = x0 !== restingFrom || x1 !== restingTo;
              const carryX = (x: number): number => restingWidth > 0 ? x0 + (x - restingFrom) * (x1 - x0) / restingWidth : x0;
              const frame: SlurFrame = carried ? {
                p0: { x: x0, y: restingFrame.p0.y },
                p3: { x: x1, y: restingFrame.p3.y },
                c1: { x: carryX(restingFrame.c1.x), y: restingFrame.c1.y },
                c2: { x: carryX(restingFrame.c2.x), y: restingFrame.c2.y },
              } : restingFrame;
              if (piece.first) handle(g, 'start', frame.p0.x, frame.p0.y);
              if (piece.last) handle(g, 'end', frame.p3.x, frame.p3.y);
              if (piece.first && piece.last) slurShapes.push({ id: c.id, base, staffSpace: STAFF_SPACE, ...(carried ? { frame } : {}) });
              g.appendChild(
                make('path', {
                  d: `M${frame.p0.x} ${frame.p0.y} C${frame.c1.x} ${frame.c1.y} ${frame.c2.x} ${frame.c2.y} ${frame.p3.x} ${frame.p3.y} C${frame.c2.x} ${frame.c2.y - side * thick * 2} ${frame.c1.x} ${frame.c1.y - side * thick * 2} ${frame.p0.x} ${frame.p0.y} Z`,
                  fill: env.ink,
                  stroke: env.ink,
                  'stroke-width': 0.4,
                }),
              );
            }
          },
          voiceId,
        );
        break;
      }
      case 'octave': {
        const start = startOf(c);
        const end = endOf(c);
        const label = { 1: '8va', 2: '15ma', '-1': '8vb', '-2': '15mb' }[String(c.octaves) as '1' | '2' | '-1' | '-2'] ?? `${c.octaves > 0 ? '+' : ''}${c.octaves * 8}`;
        const upward = c.octaves > 0;
        const steps: number[] = [];
        for (let i = index.measureIndex.get(start.measureId) ?? 0; i <= (index.measureIndex.get(end.measureId) ?? 0); i += 1) {
          doc.measures[i]?.voices.forEach((v) => v.items.forEach((it) => it.notes.forEach((n) => { if (n.staffId === c.staffId) steps.push(n.staffStep); })));
        }
        group(c.id, (g) => {
          const parent = g;
            for (const piece of pieces(start, end)) {
              const g = document.createElementNS(SVG_NS, 'g');
              g.setAttribute('data-layout-piece', piece.measureId);
              g.setAttribute('data-piece-left', String(piece.x0));
              parent.appendChild(g);
            const bottom = bottomOf(piece.measureId, c.staffId);
            if (bottom === null) continue;
            const reach = upward ? Math.max(8, ...steps) : Math.min(0, ...steps);
            const y = upward ? bottom - reach * stepPx - 2.4 * STAFF_SPACE : bottom - reach * stepPx + 2.6 * STAFF_SPACE;
            const x0 = piece.x0;
            const x1 = piece.x1;
            if (piece.first) handle(g, 'start', x0, y);
            if (piece.last) handle(g, 'end', x1, y);
            const labelNode = piece.first ? text(label, x0, y + 0.4 * STAFF_SPACE, { 'font-family': 'Georgia, "Times New Roman", serif', 'font-style': 'italic', 'font-weight': 700, 'font-size': 1.3 * STAFF_SPACE }) : null;
            if (labelNode) g.appendChild(labelNode);
            const lineFrom = labelNode ? x0 + (labelNode as SVGGraphicsElement).getBBox().width + STAFF_SPACE * 0.5 : x0;
            const tick = piece.last ? (upward ? 0.9 * STAFF_SPACE : -0.9 * STAFF_SPACE) : 0;
            g.appendChild(make('path', { d: `M${lineFrom} ${y} L${x1} ${y}${piece.last ? ` L${x1} ${y + tick}` : ''}`, fill: 'none', stroke: env.ink, 'stroke-width': 1, 'stroke-dasharray': `${0.5 * STAFF_SPACE} ${0.4 * STAFF_SPACE}` }));
            }
        }, undefined, SPAN_NUDGE);
        break;
      }
      case 'tempo': {
        const at = startOf(c);
        const x = xAt(at.measureId, at.beats);
        const row = rowAbove(at.measureId);
        if (x === null || !row) break;
        const y = row.y + nudge(c.id, row.range);
        group(
          c.id,
          (g) => {
            const font = { 'font-family': 'Georgia, "Times New Roman", serif', 'font-weight': 700, 'font-size': 1.35 * STAFF_SPACE };
            let cursor = x - 2;
            if (c.label) {
              const word = text(capitalise(c.label), cursor, y, font);
              g.appendChild(word);
              cursor += (word as SVGGraphicsElement).getBBox().width + 1.2 * STAFF_SPACE;
            }
            if (c.bpm !== null) {
              // the beat note engraved by VexFlow, its notehead centred on the digits' height, then "= 90"
              const note = make('g', { color: env.ink });
              note.innerHTML = getGhostGlyphMarkup(BEAT_DURATION[c.beat?.value ?? 4] ?? 'q', METRONOME_NOTE_STEP, 'treble', false, c.beat?.dots ?? 0);
              g.appendChild(note);
              note.setAttribute('transform', `translate(${cursor} ${y - 0.3 * font['font-size']}) scale(${METRONOME_NOTE_SCALE})`);
              cursor += (note as unknown as SVGGraphicsElement).getBBox().width * METRONOME_NOTE_SCALE + 0.5 * STAFF_SPACE;
              g.appendChild(text(`= ${c.bpm}`, cursor, y, font));
            }
          },
          undefined,
          row.range,
        );
        break;
      }
      case 'tempoTransition': {
        const start = startOf(c);
        const end = endOf(c);
        const slower = c.endBpm !== null && c.startBpm !== null ? c.endBpm < c.startBpm : true;
        const row = rowAbove(start.measureId);
        group(
          c.id,
          (g) => {
            const parent = g;
            for (const piece of pieces(start, end)) {
              const g = document.createElementNS(SVG_NS, 'g');
              g.setAttribute('data-layout-piece', piece.measureId);
              g.setAttribute('data-piece-left', String(piece.x0));
              parent.appendChild(g);
              const r = rowAbove(piece.measureId);
              if (!r) continue;
              const y = r.y + nudge(c.id, r.range) + 1.6 * STAFF_SPACE;
              if (piece.first) handle(g, 'start', piece.x0, y - 0.3 * STAFF_SPACE);
              if (piece.last) handle(g, 'end', piece.x1, y - 0.3 * STAFF_SPACE);
              const labelNode = piece.first ? text(slower ? 'rit.' : 'accel.', piece.x0, y - 0.3 * STAFF_SPACE, { 'font-family': 'Georgia, "Times New Roman", serif', 'font-style': 'italic', 'font-size': 1.3 * STAFF_SPACE }) : null;
              if (labelNode) g.appendChild(labelNode);
              const from = labelNode ? piece.x0 + (labelNode as SVGGraphicsElement).getBBox().width + STAFF_SPACE * 0.5 : piece.x0;
              g.appendChild(make('path', { d: `M${from} ${y - 0.3 * STAFF_SPACE} L${piece.x1} ${y - 0.3 * STAFF_SPACE}`, fill: 'none', stroke: env.ink, 'stroke-width': 1, 'stroke-dasharray': `${0.5 * STAFF_SPACE} ${0.4 * STAFF_SPACE}` }));
            }
          },
          undefined,
          row?.range,
        );
        break;
      }
      case 'refrain': {
        // the signs stand on the barlines (the staves draw them); here the `|:` at the left edge of a system and, when the stretch is
        // played more than twice, the words over the closing sign
        const times = (c as RefrainContext).times;
        const start = startOf(c);
        const end = endOf(c);
        group(c.id, (g) => {
          const parent = g;
          for (const piece of pieces(start, end)) {
            const g = pieceGroup(parent, piece);
            const top = topOf(piece.measureId, staffOrder[0]);
            if (top === null) continue;
            const above = document.createElementNS(SVG_NS, 'g');
            if (piece.first) startSign(g, piece.measureId, start.beats);
            if (piece.last && piece.toBarline) endSign(g, piece.measureId, piece.x1);
            if (piece.last && refrainLabel(times)) {
              above.appendChild(text(refrainLabel(times), piece.x1, top - 1.3 * STAFF_SPACE, { 'font-family': NUMBER_FONT, 'font-style': 'italic', 'font-size': 1.2 * STAFF_SPACE, 'text-anchor': 'end' }));
            }
            if (above.childNodes.length) {
              g.appendChild(above);
              env.collisions.placeOutside(above, { measureId: piece.measureId, staffId: staffOrder[0], kind: 'context' }, -1);
            }
          }
        });
        break;
      }
      case 'volta': {
        // the body's `|:` at a system's left edge, a bracket over every stored ending (closed on both sides: the music jumps back after
        // it) and one over the bar after the last of them, the last ending, which is worked out and open on the right
        const volta = c as VoltaContext;
        const point = (place: Place | null): Point => place
          ? { measureId: place.measureId, beats: toBeats(place.position) }
          : { measureId: doc.measures[doc.measures.length - 1]?.id ?? '', beats: Infinity };
        const parts = voltaParts(volta);
        const derived = derivedEnding(doc, volta);
        const endings = [
          ...parts.slice(1).map((part) => ({ start: part.start, end: part.end, label: passesLabel(part.passes ?? []), closed: true })),
          ...(derived ? [{ start: derived.start, end: derived.end, label: passesLabel(derived.passes), closed: false }] : []),
        ];
        group(c.id, (g) => {
          const parent = g;
          const body = pieces(point(parts[0].start), point(parts[0].end)).find((piece) => piece.first);
          if (body) {
            const bodyGroup = pieceGroup(parent, body);
            startSign(bodyGroup, body.measureId, point(parts[0].start).beats);
          }
          for (const ending of endings) {
            for (const piece of pieces(point(ending.start), point(ending.end))) {
              const g = pieceGroup(parent, piece);
              const top = topOf(piece.measureId, staffOrder[0]);
              if (top === null) continue;
              const row = top - 2.4 * STAFF_SPACE;
              const above = document.createElementNS(SVG_NS, 'g');
              const closedRight = ending.closed && piece.last;
              if (closedRight && piece.toBarline) endSign(g, piece.measureId, piece.x1);
              above.appendChild(make('path', { d: `M${piece.x0} ${row + (piece.first ? 1.2 * STAFF_SPACE : 0)} V${row} H${piece.x1}${closedRight ? ` V${row + 1.2 * STAFF_SPACE}` : ''}`, fill: 'none', stroke: env.ink, 'stroke-width': 1 }));
              if (piece.first) above.appendChild(text(ending.label, piece.x0 + 0.4 * STAFF_SPACE, row + 1.1 * STAFF_SPACE, { 'font-family': NUMBER_FONT, 'font-size': 1.2 * STAFF_SPACE }));
              g.appendChild(above);
              env.collisions.placeOutside(above, { measureId: piece.measureId, staffId: staffOrder[0], kind: 'context' }, -1);
            }
          }
        });
        break;
      }
      case 'sustain': {
        const start = startOf(c);
        const end = endOf(c);
        // where one pedal is released and the next pressed at the same place the two ticks become one peak
        const pointKey = (p: Point) => `${p.measureId}:${p.beats}`;
        const others = doc.contexts.filter((o) => o.kind === 'sustain' && o.id !== c.id) as (typeof c)[];
        const joinedBefore = others.some((o) => pointKey(endOf(o)) === pointKey(start));
        const joinedAfter = others.some((o) => pointKey(startOf(o)) === pointKey(end));
        const lastStaff: string = staffOrder[staffOrder.length - 1];
        const sustainIds: Set<string> = new Set(others.map((o) => o.id));
        sustainIds.add(c.id);
        group(c.id, (g) => {
          const parent = g;
            for (const piece of pieces(start, end)) {
              const g = document.createElementNS(SVG_NS, 'g');
              g.setAttribute('data-layout-piece', piece.measureId);
              g.setAttribute('data-piece-left', String(piece.x0));
              parent.appendChild(g);
            const bottom = bottomOf(piece.measureId, lastStaff);
            if (bottom === null) continue;
            // every pedal of a system stands on one line, under the lowest ink of the whole system on the last staff
            const system: number | undefined = systemOf.get(piece.measureId);
            let floor: number = bottom;
            for (const item of env.collisions.items) {
              if (item.staffId !== lastStaff || systemOf.get(item.measureId) !== system) continue;
              if (sustainIds.has(item.element.getAttribute('data-layout-context') ?? '')) continue;
              const box = item.spacingBox ?? item.box;
              floor = Math.max(floor, box.y + box.height);
            }
            const y: number = Math.max(bottom + 6 * STAFF_SPACE, floor + env.collisions.gap + STAFF_SPACE);
            // a pedal that follows another one into the next measure of the same system starts on the barline the other ends on
            const measureAt: number = index.measureIndex.get(piece.measureId) ?? 0;
            const opens = piece.first && joinedBefore;
            const meetsOnBarline: boolean = opens && start.beats === 0 && measureAt > 0 && systemOf.get(doc.measures[measureAt - 1].id) === system;
            const left: number = meetsOnBarline ? zoneOf.get(`${piece.measureId}:${staffOrder[0]}`)?.x0 ?? piece.x0 : piece.x0;
            if (piece.first) handle(g, 'start', left, y);
            if (piece.last) handle(g, 'end', piece.x1, y);
            // a peak is as wide as it is tall, half on each side of the place the pedals meet
            const closes = piece.last && joinedAfter;
            const head = `M${left} ${y - (piece.first ? STAFF_SPACE : 0)}${opens ? ` L${left + STAFF_SPACE / 2} ${y}` : ` V${y}`}`;
            const tail = closes ? ` H${piece.x1 - STAFF_SPACE / 2} L${piece.x1} ${y - STAFF_SPACE}` : ` H${piece.x1} V${y - (piece.last ? STAFF_SPACE : 0)}`;
            g.appendChild(make('path', { d: head + tail, fill: 'none', stroke: env.ink, 'stroke-width': 1.2 }));
            }
        }, undefined, SPAN_NUDGE);
        break;
      }
      case 'keySignature': {
        const at = startOf(c);
        if (at.beats < 1e-6) break;
        const x = xAt(at.measureId, at.beats), bottom = bottomOf(at.measureId, c.staffId);
        if (x === null || bottom === null) break;
        const clef = index.clefAt(c.staffId, at.measureId, at.beats)?.clef ?? 'treble';
        const previous = index.keyAt(c.staffId, at.measureId, at.beats - 0.00001);
        const stave = new Stave(0, bottom - 8 * STAFF_SPACE, 200).setContext(env.ctx).setClef(clef);
        const key = createKeySignature(c.alterations, clef, previous?.alterations).setStave(stave);
        key.setX((inlineRight.get(c.id) ?? x - STAFF_SPACE) - key.getWidth());
        key.draw();
        const el = key.getSVGElement();
        if (el) {
          env.systemGroups[systemOf.get(c.measureId) ?? 0].appendChild(el);
          el.setAttribute('data-object-id', c.id);
          env.collisions.add(el, { staffId: c.staffId, measureId: c.measureId, beat: at.beats, kind: 'inline' });
          shapes.push({ id: c.id, html: el.innerHTML });
          nodes.push(el as SVGGElement);
        }
        break;
      }
      case 'clef': {
        // a clef on a measure's first beat is drawn by the stave itself; one inside a measure is a
        // small clef set before its note
        const at = startOf(c);
        if (at.beats < 1e-6) break;
        const x = xAt(at.measureId, at.beats);
        const bottom = bottomOf(at.measureId, c.staffId);
        if (x === null || bottom === null) break;
        const line = c.clef === 'treble' ? 3 : 1;
        const left = (inlineRight.get(c.id) ?? x - STAFF_SPACE) - (env.inlineWidths.get(c.id) ?? 2.4 * STAFF_SPACE);
        const mark = env.ctx.openGroup('context-clef', c.id) as SVGGElement;
        Glyph.renderGlyph(env.ctx, left, bottom - (4 - line) * STAFF_SPACE, 32, c.clef === 'treble' ? 'gClef' : 'fClef');
        env.ctx.closeGroup();
        if (c.octaveTransposition) mark.appendChild(text(String(Math.abs(c.octaveTransposition) * 7 + 1), left + 0.4 * STAFF_SPACE, bottom + (c.octaveTransposition > 0 ? -10 * STAFF_SPACE : 2 * STAFF_SPACE), { 'font-size': STAFF_SPACE }));
        env.systemGroups[systemOf.get(c.measureId) ?? 0].appendChild(mark);
        mark.setAttribute('data-object-id', c.id);
        env.collisions.add(mark, { staffId: c.staffId, measureId: c.measureId, beat: at.beats, kind: 'inline' });
        shapes.push({ id: c.id, html: mark.innerHTML });
        nodes.push(mark);
        break;
      }
      default:
        break;
    }
  }
  return { shapes, nodes, slurShapes };
}
