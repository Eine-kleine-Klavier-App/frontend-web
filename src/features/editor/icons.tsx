import { useEffect, useId, useRef } from 'react';
import { Barline, Curve, TextBracket, TickContext, StaveNote, TextDynamics, Renderer, Stave, Voice, Formatter, Volta, VoltaType } from 'vexflow';
import type { Tool } from '@/app/store';
import { alterationsOfFifths, KEY_NAMES } from '@/core/model/contexts';
import { createKeySignature } from '@/rendering/vexflow/contextMarks';
import type { ClefName, DurationValue } from '@/core/model/score';
import { MousePointerIcon } from '@/ui/icons';
import { ChoiceThumb } from '@/ui/ChoiceGroup';
import { parseMark, markLabel } from '@/core/model/markTools';
import { parseTool, type InsertSpec } from '@/core/model/insertItems';
import { getGlyphMarkup } from '@/rendering/vexflow/clefGlyph';
import {
  type DurationTool,
  type StampTool,
  isDurationTool,
  isStampTool,
  renderDurationSvg,
  renderStampSvg,
  renderNoteOrRestSvg,
  renderSpecSvg,
  getSharedGlyphBox,
} from '@/rendering/vexflow/noteGlyph';

// Duration icons are REAL VexFlow glyphs (see rendering/vexflow/noteGlyph.ts) — this guarantees
// the toolbar matches the actual score engraving pixel-for-pixel, instead of a hand-drawn
// approximation drifting out of sync with it, and shares its notehead-centered anchoring with
// the insert-ghost preview (Overlay.tsx) so both come from one mechanism. The rest and triplet
// stamps and the tie are notation too, so they render through the same engine (`VexStampIcon`);
// the cursor is a UI symbol and comes from Lucide.

function VexDurationIcon({ duration }: { duration: DurationTool }) {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const { svg, noteheadBox: box } = renderDurationSvg(duration, host);
    const noteheadBox = box ?? svg.getBBox();
    const cx = noteheadBox.x + noteheadBox.width / 2;
    const noteheadBottom = noteheadBox.y + noteheadBox.height;

    // one shared, measured box for every duration — this icon's own notehead center is placed
    // at its horizontal middle, and its bottom sits `above` a fixed distance up from the box
    // bottom, so all 5 icons render at the same size with their noteheads at the same spot.
    const { halfW, above, below } = getSharedGlyphBox();
    const pad = halfW * 0.15; // proportional breathing room — scales with the measured box, not a flat guess
    const left = cx - halfW - pad;
    const width = 2 * (halfW + pad);
    const top = noteheadBottom - above - pad;
    const height = above + below + pad * 2;
    svg.setAttribute('viewBox', `${left} ${top} ${width} ${height}`);

    const ICON_H = 24; // fixed render height, shared by every duration icon — sized for legibility
    // inside the 32px deck cell
    const scale = ICON_H / height;
    const iconW = Math.round(width * scale);
    svg.setAttribute('width', String(iconW));
    svg.setAttribute('height', String(ICON_H));
    // Renderer.resize() set an inline width (SVGContext) that otherwise wins over the
    // attributes above for layout size — override it explicitly to match the crop.
    // rem, so the icon follows the reader's font size like the rest of the UI (16 = px per rem)
    svg.style.width = `${iconW / 16}rem`;
    svg.style.height = `${ICON_H / 16}rem`;
  }, [duration]);

  return <div className="vex-icon" ref={hostRef} />;
}

// A stamp has no single notehead to anchor on, so it is centred on its own measured ink and scaled
// to fit the same 24px icon height — never wider than the 28px a 32px deck cell leaves inside.
// One engraving scale (px per score unit) for glyphs drawn at their TRUE size — a whole rest stays
// a small block, a 32nd keeps its long stem — the same scale the 24px duration icons work out to.
const ENGRAVING_SCALE = 0.6;

function VexCenteredIcon({
  render,
  renderKey,
  trueSize = false,
  maxWidth = 28,
  maxHeight = 24,
}: {
  render: (host: HTMLDivElement) => SVGSVGElement;
  renderKey: string;
  /** draw at the engraving scale instead of fitting the 24px icon box */
  trueSize?: boolean;
  maxWidth?: number;
  maxHeight?: number;
}) {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const svg = render(host);
    const box = svg.getBBox();
    const pad = Math.max(box.width, box.height) * 0.08;
    svg.setAttribute('viewBox', `${box.x - pad} ${box.y - pad} ${box.width + 2 * pad} ${box.height + 2 * pad}`);
    const fit = Math.min(maxHeight / (box.height + 2 * pad), maxWidth / (box.width + 2 * pad));
    const scale = trueSize ? Math.min(ENGRAVING_SCALE, fit * 1.15) : fit;
    const iconW = Math.round((box.width + 2 * pad) * scale);
    const iconH = Math.round((box.height + 2 * pad) * scale);
    svg.setAttribute('width', String(iconW));
    svg.setAttribute('height', String(iconH));
    // same inline-size override as `VexDurationIcon` — Renderer.resize() set one that wins otherwise
    svg.style.width = `${iconW / 16}rem`;
    svg.style.height = `${iconH / 16}rem`;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [renderKey, maxWidth, maxHeight]);

  return <div className="vex-icon" ref={hostRef} />;
}

function VexStampIcon({ stamp }: { stamp: StampTool }) {
  return <VexCenteredIcon render={(host) => renderStampSvg(stamp, host)} renderKey={stamp} />;
}

/** The glyph of one written note or rest, straight from VexFlow — the inspector header's object
 *  glyph. Durations the toolbar knows reuse its exact icon; any other (a 32nd, every rest) is
 *  centred on its own ink like the stamps. */
export function NotationIcon({ duration, rest }: { duration: DurationValue; rest: boolean }) {
  if (!rest && isDurationTool(duration)) return <VexDurationIcon duration={duration} />;
  return <VexCenteredIcon render={(host) => renderNoteOrRestSvg(duration, host, rest)} renderKey={`${duration}:${rest}`} trueSize />;
}

/** An insert item drawn by VexFlow with its modifiers (dots, articulation, accidental). */
function VexSpecIcon({ spec, id }: { spec: InsertSpec; id: string }) {
  return <VexCenteredIcon render={(host) => renderSpecSvg(spec, host)} renderKey={id} trueSize />;
}

// SMuFL glyphs (VexFlow's Bravura, through the existing `getGlyphMarkup` helper) at one engraving
// size: the point size the score's own notes use, mapped to the same scale as the 24-unit tool
// icons, so a dot, an accent or a clef sits at its true size next to a note. Lengths in rem.
const SYMBOL_POINT_SIZE = 38;
const SYMBOL_SCALE = 0.62 / 16; // score units -> rem, matching the tool icons' scale

/** One or more SMuFL glyphs side by side (`row`) or stacked (`stack`, e.g. a time signature). */
export function SmuflIcon({ codes, stack = false }: { codes: string[]; stack?: boolean }) {
  const glyphs = codes.map((code) => ({ code, g: getGlyphMarkup(code, SYMBOL_POINT_SIZE) }));
  return (
    <span className={'smufl-icon' + (stack ? ' stack' : '')} aria-hidden="true">
      {glyphs.map(({ code, g }, i) => {
        if (!g) return null;
        const [, , w, h] = g.viewBox.split(/[ ,]+/).map(Number);
        return (
          <svg
            key={`${code}-${i}`}
            viewBox={g.viewBox}
            style={{ width: `${(w * SYMBOL_SCALE).toFixed(3)}rem`, height: `${(h * SYMBOL_SCALE).toFixed(3)}rem` }}
            dangerouslySetInnerHTML={{ __html: g.markup }}
          />
        );
      })}
    </span>
  );
}

/** VexFlow composes the marking on one baseline with its dynamic-specific spacing. */
export function DynamicIcon({ level }: { level: string }) {
  return <VexCenteredIcon renderKey={`dynamic:${level}`} trueSize maxWidth={48} render={(host) => {
    host.innerHTML = '';
    const renderer = new Renderer(host, Renderer.Backends.SVG);
    renderer.resize(200, 100);
    const context = renderer.getContext();
    context.setFillStyle('currentColor');
    const staff = new Stave(0, 0, 100).setContext(context);
    const voice = new Voice({ num_beats: 4, beat_value: 4 }).setStrict(false);
    voice.addTickables([new TextDynamics({ text: level, duration: 'q' })]);
    new Formatter().joinVoices([voice]).format([voice], 80);
    voice.draw(context, staff);
    return host.querySelector('svg')!;
  }} />;
}

/** A hairpin wedge over the level it ends on, drawn with the score's own two-arm shape: it opens to a loud level and closes to a quiet one. */
export function HairpinIcon({ level, opens }: { level: string; opens: boolean }) {
  return <span className="hairpin-icon" aria-hidden="true">
    <svg viewBox="0 0 24 10"><path d={opens ? 'M22 0.5 L2 5 L22 9.5' : 'M2 0.5 L22 5 L2 9.5'} fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" /></svg>
    <DynamicIcon level={level} />
  </span>;
}

function ClefIcon({ clef }: { clef: 'treble' | 'bass' }) {
  const hostRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    host.innerHTML = '';
    const renderer = new Renderer(host, Renderer.Backends.SVG);
    const ctx = renderer.getContext();
    ctx.setFillStyle('currentColor');
    ctx.setStrokeStyle('currentColor');
    const space = new Stave(0, 0, 0).getSpacingBetweenLines();
    const width = space * 7;
    const boxes = (['treble', 'bass'] as const).map((type) => {
      const group = ctx.openGroup('palette-clef') as SVGGElement;
      const staff = new Stave(0, 0, width).setContext(ctx);
      staff.setBegBarType(Barline.type.NONE).setEndBarType(Barline.type.NONE);
      staff.addClef(type);
      staff.format();
      const modifier = staff.getModifiers().find((m) => m.getCategory() === 'Clef');
      if (modifier) modifier.setX((width - modifier.getWidth()) / 2);
      staff.draw();
      ctx.closeGroup();
      const box = group.getBBox();
      if (type !== clef) group.remove();
      return box;
    });
    const top = Math.min(...boxes.map((b) => b.y)) - space;
    const bottom = Math.max(...boxes.map((b) => b.y + b.height)) + space;
    const svg = host.querySelector('svg')!;
    svg.setAttribute('viewBox', `${-space / 2} ${top} ${width + space} ${bottom - top}`);
    svg.removeAttribute('width');
    svg.removeAttribute('height');
    svg.style.width = '100%';
    svg.style.height = '100%';
  }, [clef]);
  return <div className="clef-icon" ref={hostRef} aria-hidden="true" />;
}

export function KeySignatureIcon({ fifths, clef = 'treble' }: { fifths: number; clef?: ClefName }) {
  const hostRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    host.innerHTML = '';
    const ctx = new Renderer(host, Renderer.Backends.SVG).getContext();
    ctx.setFillStyle('currentColor'); ctx.setStrokeStyle('currentColor');
    const probe = new Stave(0, 0, 100).setContext(ctx).setClef(clef);
    const space = probe.getSpacingBetweenLines();
    const maximum = createKeySignature(alterationsOfFifths(7), clef).setStave(probe).getWidth();
    const width = maximum + space * 4;
    const staff = new Stave(0, 0, width).setContext(ctx).setClef(clef);
    staff.setBegBarType(Barline.type.NONE).setEndBarType(Barline.type.NONE).draw();
    const key = createKeySignature(alterationsOfFifths(fifths), clef).setStave(staff);
    key.setX((width - key.getWidth()) / 2); key.draw();
    const svg = host.querySelector('svg')!;
    const top = staff.getYForLine(0) - space * 1.5;
    svg.setAttribute('viewBox', `${-space / 2} ${top} ${width + space} ${space * 7}`);
    svg.style.width = '100%'; svg.style.height = '100%';
  }, [fifths, clef]);
  return <span className="key-signature-icon" ref={hostRef} aria-hidden="true" />;
}

export function KeySignatureChoices({ value, onChange, clef = 'treble' }: {
  value: number | null; onChange: (fifths: number) => void; clef?: ClefName;
}) {
  const groupId = useId();
  return <div className="signature-grid keycap-grid" role="group" aria-label="Key signature">
    {[1, 2, 3, 4, 5, 6, 7, -7, -6, -5, -4, -3, -2, -1, 0].map((fifths) => {
      const name = KEY_NAMES.find((k) => k.fifths === fifths)!.name;
      const label = fifths === 0 ? 'No key signature accidentals' : `${Math.abs(fifths)} ${fifths > 0 ? 'sharps' : 'flats'}`;
      return <button key={fifths} type="button" className={'hp-cell signature-cell' + (value === fifths ? ' active' : '')}
        aria-label={label} aria-pressed={value === fifths} title={`${label} · ${name} major`} onClick={() => onChange(fifths)}>
        {value === fifths && <ChoiceThumb groupId={groupId} />}
        <KeySignatureIcon fifths={fifths} clef={clef} />
      </button>;
    })}
  </div>;
}

export function OctaveIcon({ octaves }: { octaves: number }) {
  return <span className="octave-icon"><VexCenteredIcon renderKey={`octave:${octaves}`} maxWidth={64} render={(host) => {
    host.innerHTML = '';
    const ctx = new Renderer(host, Renderer.Backends.SVG).getContext();
    const staff = new Stave(0, 0, 120).setContext(ctx);
    const notes = [0, 70].map((x) => new StaveNote({ keys: ['b/4'], duration: 'q' }).setStave(staff).setTickContext(new TickContext().setX(x)));
    const bracket = new TextBracket({ start: notes[0], stop: notes[1], text: Math.abs(octaves) === 2 ? '15' : '8',
      superscript: Math.abs(octaves) === 2 ? (octaves > 0 ? 'ma' : 'mb') : (octaves > 0 ? 'va' : 'vb'),
      position: octaves > 0 ? TextBracket.Position.TOP : TextBracket.Position.BOTTOM });
    bracket.render_options.color = 'currentColor';
    bracket.setContext(ctx).draw();
    return host.querySelector('svg')!;
  }} /></span>;
}

/** A repeat, engraved as a measure between repeat barlines with their dots; with `volta`, under the bracket of its first ending. */
export function RepeatIcon({ volta }: { volta: boolean }) {
  return <span className="line-icon"><VexCenteredIcon renderKey={volta ? 'repeat:volta' : 'repeat'} maxWidth={44} maxHeight={36} render={(host) => {
    host.innerHTML = '';
    const ctx = new Renderer(host, Renderer.Backends.SVG).getContext();
    ctx.setFillStyle('currentColor');
    ctx.setStrokeStyle('currentColor');
    const staff = new Stave(0, 0, 60).setContext(ctx);
    staff.setBegBarType(Barline.type.REPEAT_BEGIN).setEndBarType(Barline.type.REPEAT_END);
    if (volta) staff.addModifier(new Volta(VoltaType.BEGIN_END, '1.', 0, 3.4 * staff.getSpacingBetweenLines()));
    staff.draw();
    return host.querySelector('svg')!;
  }} /></span>;
}

/** A slur: two noteheads joined by VexFlow's own curve. */
export function SlurIcon() {
  return <span className="line-icon"><VexCenteredIcon renderKey="slur" maxWidth={44} maxHeight={36} render={(host) => {
    host.innerHTML = '';
    const ctx = new Renderer(host, Renderer.Backends.SVG).getContext();
    ctx.setFillStyle('currentColor');
    ctx.setStrokeStyle('currentColor');
    const staff = new Stave(0, 0, 64).setContext(ctx);
    staff.draw();
    const notes = [8, 40].map((x) => {
      const note = new StaveNote({ keys: ['b/4'], duration: 'q', stem_direction: -1 }).setStave(staff).setContext(ctx);
      new TickContext().addTickable(note).preFormat().setX(x);
      note.draw();
      return note;
    });
    new Curve(notes[0], notes[1], {}).setContext(ctx).draw();
    return host.querySelector('svg')!;
  }} /></span>;
}

/** Any tool's glyph: the cursor (Lucide), the historic stamps and durations exactly as before, and
 *  every other insert item (32nds, other rests, constructor composites) engraved by VexFlow. */
export function ToolIcon({ id }: { id: Tool }) {
  const mark = parseMark(id);
  if (mark) {
    if (mark.kind === 'clef') return <ClefIcon clef={mark.clef} />;
    if (mark.kind === 'key') return <KeySignatureIcon fifths={mark.fifths} />;
    if (mark.kind === 'octave') return <OctaveIcon octaves={mark.octaves} />;
    if (mark.kind === 'slur') return <SlurIcon />;
    if (mark.kind === 'sustain') return <SmuflIcon codes={['keyboardPedalPed']} />;
    if (mark.kind === 'refrain' || mark.kind === 'volta') return <RepeatIcon volta={mark.kind === 'volta'} />;
    if (mark.kind === 'dynamic') return <DynamicIcon level={mark.dynamic} />;
    return <span className="hp-txt" title={markLabel(mark)}>{mark.kind === 'hairpin' ? `→${mark.target}` : mark.kind === 'transition' ? 'Tempo →' : 'Tempo'}</span>;
  }
  if (id === 'select') return <MousePointerIcon />;
  if (isDurationTool(id)) return <VexDurationIcon duration={id} />;
  if (isStampTool(id)) return <VexStampIcon stamp={id} />;
  const spec = parseTool(id);
  return spec ? <VexSpecIcon spec={spec} id={id} /> : null;
}
