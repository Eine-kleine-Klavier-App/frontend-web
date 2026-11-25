import { sizeToDevicePixels } from '@/rendering/deviceCanvas';
import { readCssToken } from '@/ui/cssToken';

/** What a frame needs to draw: the two anchors in the score's SVG, whose places on the screen the browser has already worked out. */
export interface PlaybackLayers {
  /** Draws the playhead on `line` and the washed bar on `wash` (either may be missing) in this frame, on whole device pixels, and the notes
   *  `sounding` (carrier ids; the same array until the set changes) in the ink of a selection. The notes are looked for in `scope`, by default
   *  the score sheet the line stands in. */
  draw(line: SVGLineElement | null, wash: Element | null, sounding: readonly string[], scope?: Element | null): void;
  dispose(): void;
}

/** One drawn part of a sounding note: its outline, where it stands in the engraving's SVG, and how it is stroked. */
interface Shape {
  element: SVGGraphicsElement;
  path: Path2D;
  matrix: readonly [number, number, number, number, number, number];
  width: number;
  ink: string;
  cap: CanvasLineCap;
  join: CanvasLineJoin;
}

/** How long a failed or stale lookup of the sounding notes' parts waits before it is made again, with the index of the groups made anew (the engraving may be drawn again or windowed). */
const RESOLVE_RETRY_MS = 500;

interface Layer {
  canvas: HTMLCanvasElement;
  context: CanvasRenderingContext2D;
}

/**
 * The playhead and the washed bar of the score page, painted on two canvases that stand over the sheet in the scroll area and have one pixel
 * per device pixel. The score's own SVG is scaled by a CSS transform, so a thin line drawn in it falls on the pixels of the screen differently in
 * every frame; here its place is rounded to whole device pixels, so a frame draws it the same way wherever it falls, and the sheet is never
 * repainted for it. The line and the wash of the SVG stay as invisible anchors: the browser places them (scroll, zoom, centring) and the
 * layers read where they are.
 */
export function createPlaybackLayers(area: HTMLElement): PlaybackLayers {
  const make = (className: string): Layer | null => {
    const canvas = area.ownerDocument.createElement('canvas');
    canvas.className = className;
    canvas.setAttribute('aria-hidden', 'true');
    const context = canvas.getContext('2d');
    if (!context) return null;
    area.prepend(canvas);
    return { canvas, context };
  };
  // Prepended in this order, so the notes (made last) stand first in the page, then the line, then the wash; the CSS puts all three over the paper.
  const wash = make('playback-layer playback-wash-layer');
  const line = make('playback-layer playback-line-layer');
  const notes = make('playback-layer playback-notes-layer');
  if (!wash || !line || !notes) {
    wash?.canvas.remove();
    line?.canvas.remove();
    notes?.canvas.remove();
    return { draw() {}, dispose() {} };
  }
  let width = 0;
  let height = 0;
  let ratio = 0;
  let theme = '';
  let lineColour = '';
  let washColour = '';
  let shapes: Shape[] = [];
  let resolvedFor: readonly string[] | null = null;
  let resolvedAt = 0;
  // The engraving's note groups by carrier id, made once per drawing of the engraving (a score of a few thousand notes is walked once, not at every change of the sounding notes).
  let index: { root: Element; sample: Element | null; byId: Map<string, SVGGraphicsElement[]> } | null = null;
  let drawnAt = '';
  let inked = false;
  let washInked = false;
  let lineInked = false;

  const resize = () => {
    const nextRatio = globalThis.devicePixelRatio || 1;
    const { clientWidth, clientHeight } = area;
    if (clientWidth === width && clientHeight === height && nextRatio === ratio) return;
    width = clientWidth;
    height = clientHeight;
    ratio = nextRatio;
    const style = getComputedStyle(area);
    const padTop = parseFloat(style.paddingTop) || 0;
    const padLeft = parseFloat(style.paddingLeft) || 0;
    for (const { canvas } of [notes, line, wash]) {
      // One pixel per device pixel, shown at exactly that size, laid over the scroll area's whole padding box without taking room from the sheet.
      sizeToDevicePixels(canvas, width, height, ratio);
      canvas.style.top = `${-padTop}px`;
      canvas.style.marginLeft = `${-padLeft}px`;
      canvas.style.marginRight = `${padLeft - canvas.width / ratio}px`;
    }
    // The three stand one over the other: adjacent vertical margins collapse into the most negative one, so the first pulls itself up to the top of the
    // padding box and back over its own height, the second starts on the first and does the same, and the third, which then starts on them, gives the
    // room back before the sheet.
    notes.canvas.style.marginTop = `${-padTop}px`;
    notes.canvas.style.marginBottom = `${-notes.canvas.height / ratio}px`;
    line.canvas.style.marginTop = '0px';
    line.canvas.style.marginBottom = `${-line.canvas.height / ratio}px`;
    wash.canvas.style.marginTop = '0px';
    wash.canvas.style.marginBottom = `${padTop - wash.canvas.height / ratio}px`;
    drawnAt = '';
  };

  // The ink of a selection is the colour of the note's voice: read where the note stands, resolved to a colour the canvas takes by a probe in the area.
  const probe = area.ownerDocument.createElement('span');
  probe.setAttribute('aria-hidden', 'true');
  probe.style.display = 'none';
  const inks = new Map<string, string>();
  const inkOf = (group: Element): string => {
    const token = getComputedStyle(group).getPropertyValue('--select-ink').trim();
    let ink = inks.get(token);
    if (ink === undefined) {
      area.append(probe);
      probe.style.color = token;
      ink = getComputedStyle(probe).color;
      probe.remove();
      inks.set(token, ink);
    }
    return ink;
  };

  /** The parts of the notes that sound: every path and rectangle of their groups in the engraving but the ledger lines, as the selection tints them. */
  const resolve = (root: Element, sounding: readonly string[], now: number, rebuild: boolean) => {
    resolvedFor = sounding;
    resolvedAt = now;
    drawnAt = '';
    shapes = [];
    inks.clear();
    if (sounding.length === 0) return;
    if (!index || index.root !== root || rebuild || (index.sample !== null && !index.sample.isConnected)) {
      const byId = new Map<string, SVGGraphicsElement[]>();
      let sample: Element | null = null;
      root.querySelectorAll<SVGGraphicsElement>('.vf-stavenote[data-note-id]').forEach((group) => {
        const id = group.getAttribute('data-note-id') ?? '';
        const known = byId.get(id);
        if (known) known.push(group);
        else byId.set(id, [group]);
        sample ??= group;
      });
      index = { root, sample, byId };
    }
    const groups = sounding.flatMap((id) => index?.byId.get(id) ?? []);
    groups.forEach((group) => {
      const ink = inkOf(group);
      group.querySelectorAll<SVGGraphicsElement>('path:not(.vf-ledger), rect:not(.vf-ledger)').forEach((element) => {
        const ctm = element.getCTM();
        if (!ctm) return;
        const style = getComputedStyle(element);
        const path = new Path2D();
        if (element instanceof SVGRectElement) path.rect(element.x.baseVal.value, element.y.baseVal.value, element.width.baseVal.value, element.height.baseVal.value);
        else path.addPath(new Path2D(element.getAttribute('d') ?? ''));
        shapes.push({
          element, path, matrix: [ctm.a, ctm.b, ctm.c, ctm.d, ctm.e, ctm.f], width: parseFloat(style.strokeWidth) || 0, ink,
          cap: style.strokeLinecap as CanvasLineCap, join: style.strokeLinejoin as CanvasLineJoin,
        });
      });
    });
  };

  return {
    draw(anchor, tint, sounding, scope) {
      resize();
      const colours = area.ownerDocument.documentElement.dataset.theme ?? '';
      if (colours !== theme || !lineColour) {
        theme = colours;
        lineColour = readCssToken(area, '--color-playback-cursor');
        washColour = readCssToken(area, '--score-active');
        resolvedFor = null;
        drawnAt = '';
      }
      if (washInked) wash.context.clearRect(0, 0, wash.canvas.width, wash.canvas.height);
      if (lineInked) line.context.clearRect(0, 0, line.canvas.width, line.canvas.height);
      washInked = false;
      lineInked = false;
      if (width === 0 || height === 0) return;
      // The layers lie over the sheet, so they stand on it only where it is ready: not while the paper waits for its first drawing or is hidden, and not over
      // a page that still waits for its drawing (the browser hides what is inside the paper by itself, but the layers are not inside it).
      const paper = area.querySelector<HTMLElement>('.paper');
      const sheetReady = !paper || (paper.dataset.ready !== 'false' && paper.style.visibility !== 'hidden');
      const waiting = sheetReady ? area.querySelectorAll('.sheet-page[data-waiting="true"]') : [];
      const overWaiting = (box: DOMRect) => [...waiting].some((page) => {
        const around = page.getBoundingClientRect();
        return box.left < around.right && box.right > around.left && box.top < around.bottom && box.bottom > around.top;
      });
      // The canvases' own corner on the screen, in device pixels: what the browser put at the top left of the padding box.
      const corner = line.canvas.getBoundingClientRect();
      const originX = Math.round(corner.left * ratio);
      const originY = Math.round(corner.top * ratio);
      const tintBox = sheetReady && tint ? tint.getBoundingClientRect() : null;
      if (tint && tintBox && !overWaiting(tintBox)) {
        const left = Math.round(tintBox.left * ratio) - originX;
        const top = Math.round(tintBox.top * ratio) - originY;
        washInked = true;
        wash.context.globalAlpha = 0.32;
        wash.context.fillStyle = washColour;
        wash.context.fillRect(left, top, Math.round(tintBox.right * ratio) - originX - left, Math.round(tintBox.bottom * ratio) - originY - top);
      }
      // The notes are drawn again only when the set that sounds, their place on the screen (scroll, zoom) or the layer itself changes.
      const root = scope ?? anchor?.closest('.score-scale') ?? null;
      const now = performance.now();
      if (root) {
        const stale = now - resolvedAt > RESOLVE_RETRY_MS && (shapes.length === 0 ? sounding.length > 0 : shapes.some((shape) => !shape.element.isConnected));
        if (resolvedFor !== sounding || stale) resolve(root, sounding, now, stale);
      }
      const svg = sheetReady ? shapes[0]?.element.ownerSVGElement ?? null : null;
      if (!svg || shapes.length === 0) {
        if (inked) {
          notes.context.clearRect(0, 0, notes.canvas.width, notes.canvas.height);
          inked = false;
          drawnAt = '';
        }
      } else {
        const box = svg.getBoundingClientRect();
        const scaleX = (ratio * box.width) / (svg.width.baseVal.value || 1);
        const scaleY = (ratio * box.height) / (svg.height.baseVal.value || 1);
        const left = box.left * ratio - originX;
        const top = box.top * ratio - originY;
        const place = `${left},${top},${scaleX},${scaleY}`;
        if (place !== drawnAt) {
          drawnAt = place;
          inked = true;
          notes.context.setTransform(1, 0, 0, 1, 0, 0);
          notes.context.clearRect(0, 0, notes.canvas.width, notes.canvas.height);
          for (const shape of shapes) {
            notes.context.fillStyle = shape.ink;
            notes.context.strokeStyle = shape.ink;
            const [a, b, c, d, e, f] = shape.matrix;
            notes.context.setTransform(scaleX, 0, 0, scaleY, left, top);
            notes.context.transform(a, b, c, d, e, f);
            notes.context.lineWidth = shape.width;
            notes.context.lineCap = shape.cap;
            notes.context.lineJoin = shape.join;
            notes.context.fill(shape.path);
            if (shape.width > 0) notes.context.stroke(shape.path);
          }
          notes.context.setTransform(1, 0, 0, 1, 0, 0);
        }
      }
      const anchorBox = sheetReady && anchor ? anchor.getBoundingClientRect() : null;
      if (anchor && anchorBox && !overWaiting(anchorBox)) {
        // The line is two units of the score wide: that many pixels of the screen, never less than two device pixels, whole.
        const rise = anchor.y2.baseVal.value - anchor.y1.baseVal.value;
        const unit = rise > 0 ? anchorBox.height / rise : 1;
        const thickness = Math.max(2, Math.round(2 * unit * ratio));
        const left = Math.round((anchorBox.left + anchorBox.width / 2) * ratio) - originX - Math.floor(thickness / 2);
        const top = Math.round(anchorBox.top * ratio) - originY;
        lineInked = true;
        line.context.fillStyle = lineColour;
        line.context.fillRect(left, top, thickness, Math.round(anchorBox.bottom * ratio) - originY - top);
      }
    },
    dispose() {
      wash.canvas.remove();
      line.canvas.remove();
      notes.canvas.remove();
    },
  };
}
