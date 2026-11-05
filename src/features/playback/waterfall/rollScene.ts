import { KeyStage, type KeyLight, type StageKey } from './keyStage';
import type { WaterfallNote } from './waterfallNotes';
import { clamp, hexRgb, readWaterfallPalette, rgba, type Rgb, type VoiceRamp, type WaterfallPalette } from './waterfallPalette';
import { BLACK_KEY_WIDTH, KEY_RANGE, NATURAL_PITCH_CLASSES, PLANE_HEIGHT, PLANE_WIDTH } from './waterfallProportions';

// Geometry measured on the first frame of the reference video, in plane units (see PLANE_WIDTH).
/** How much the octave lines lean per octave, and where middle C's line meets the horizon. */
const OCTAVE_LEAN = 0.0863;
const MIDDLE_C_LEAN = 0.0193;
const MIDDLE_C = 60;
const BED_DEPTH_OF_HEIGHT = 0.215;
const BED_DEPTH_OF_PITCH = 5;
/** The pitch the 2D optics (footprints, ridge, grain sizes) were tuned at. */
const REFERENCE_PITCH = 10.8;
const FAR_SCALE = 0.92;
/** Relative widening of the far edge for the moderate From sides preset. */
const SIDE_SPREAD = 0.2;
const LOOKAHEAD_RANGE = { min: 2.2, max: 4.35 } as const;
const LOOKAHEAD_AT_FRAMING = 4.18;
/** The roll's depth on screen compared with the width of a keyboard that fills the reference plane. */
const REFERENCE_FRAMING = 51;
/** A ribbon's tail and head are clipped just outside the visible slab. */
const RIBBON_HEAD_CLIP = 0.035;
const RIBBON_TAIL_CLIP = 0.16;
/** A note leaves a visible release before the next strike of the same key; the strike and its travel keep their score durations. */
const RELEASE_GAP = 0.045;
const RELEASE_GAP_SHARE = 0.3;
const KEY_PRESS_SECONDS = 0.055;
const KEY_RELEASE_SECONDS = 0.09;
const TAIL_SECONDS = 4.5;
const HIT_SECONDS = 1.35;
const INCOMING_SECONDS = 0.2;
const FRONT_SECONDS = 0.4;
const UNDER_STOPS = 25;
const GRAIN_COUNT = 430;
const GRAIN_CYCLE = 8;

/** The keys and the glow are drawn at the display's density up to this; the 2D roll behind them is a soft picture and is drawn at one pixel per CSS pixel, because it is uploaded to the GPU every frame. */
const GL_RATIO_MAX = 1.5;
const SHEET_RATIO = 1;

const noise = (n: number): number => {
  const x = Math.sin(n * 78.233 + 17.41) * 43758.5453;
  return x - Math.floor(x);
};

const gradient = (g: CanvasRenderingContext2D, from: number, to: number, stops: readonly (readonly [number, string])[]): CanvasGradient => {
  const result = g.createLinearGradient(0, from, 0, to);
  for (const [at, color] of stops) result.addColorStop(at, color);
  return result;
};

interface SceneKey extends StageKey {
  unit: number;
  width: number;
}

interface SceneNote extends WaterfallNote {
  seed: number;
  /** how long the ribbon is: the note's length, cut short by the next strike of the same key */
  ribbon: number;
}

interface Hit {
  note: SceneNote;
  age: number;
  press: number;
  light: number;
  x: number;
  rgb: Rgb;
}

interface Tail {
  note: SceneNote;
  age: number;
  release: number;
  energy: number;
  x: number;
  rgb: Rgb;
}

interface Incoming {
  x: number;
  age: number;
  width: number;
}

interface Emitter extends Hit {
  onset: number;
}

interface Projected {
  x: number;
  y: number;
  scale: number;
}

/** The roll: notes falling in perspective towards the keys, and everything the strike throws up. The clock comes from outside; the scene owns no time. */
export class WaterfallScene {
  private readonly sheet = document.createElement('canvas');
  private readonly ctx: CanvasRenderingContext2D;
  private readonly stage: KeyStage;
  private readonly underField = new Float32Array(UNDER_STOPS * 3);
  private readonly sprites = new Map<string, HTMLCanvasElement>();
  private readonly densityMasks = new Map<string, HTMLCanvasElement>();
  private readonly grains = Array.from({ length: GRAIN_COUNT }, (_, index) => ({ u: noise(index + 211), when: noise(index + 733) * GRAIN_CYCLE, v: noise(index * 2 + 31) }));
  private readonly grainAtlas = document.createElement('canvas');
  private notes: SceneNote[] = [];
  private bars: number[] = [];
  private ramps: VoiceRamp[] = [];
  private readonly palette: WaterfallPalette;
  private background: string;
  private stripColor: Rgb;
  private sky: HTMLCanvasElement | null = null;
  private keys: SceneKey[] = [];
  private byMidi = new Map<number, SceneKey>();
  private octaveEdges: { midi: number; x: number }[] = [];
  private fronts: [number, number, number][] = [];
  private airSurface: HTMLCanvasElement | null = null;
  private airContext: CanvasRenderingContext2D | null = null;
  private airPixels: ImageData | null = null;
  private time = 0;
  private width = PLANE_WIDTH;
  private height = PLANE_HEIGHT;
  private viewportHeight = 0;
  private rollTop = 0;
  private unit = 1;
  private pitch = 1;
  private depth = 1;
  private rail = 1;
  private stripY = 1;
  private convergenceX = 0;
  private convergenceDistance = 1;
  private tilt = 1;
  private octaveLines = true;
  private measureLines = true;
  private lookAhead = 1;
  private visibleAhead = 1;
  private eyeTime = 1;
  private nearSpeed = 1;

  constructor(private readonly canvas: HTMLCanvasElement) {
    const context = this.sheet.getContext('2d', { alpha: false });
    if (!context) throw new Error('A 2D canvas is unavailable');
    this.ctx = context;
    this.palette = readWaterfallPalette(canvas);
    this.background = this.palette.skyBlack;
    this.stripColor = this.palette.stripDefault;
    this.stage = new KeyStage(canvas);
    this.grainAtlas.width = this.grainAtlas.height = 20;
    const atlas = this.grainAtlas.getContext('2d');
    if (atlas) {
      const grain = atlas.createRadialGradient(10, 10, 0, 10, 10, 10);
      const [core, mid, edge] = this.palette.grain;
      grain.addColorStop(0, rgba(core, 0.7));
      grain.addColorStop(0.3, rgba(mid, 0.55));
      grain.addColorStop(1, rgba(edge, 0));
      atlas.fillStyle = grain;
      atlas.fillRect(0, 0, 20, 20);
    }
  }

  /** The notes to play, in any order, and the start of each measure; the roll shows them as the clock passes. */
  private pedals: { down: number; up: number }[] = [];

  setPiece(notes: WaterfallNote[], bars: number[], pedals: { down: number; up: number }[] = []): void {
    this.pedals = pedals;
    const sorted = notes.slice().sort((a, b) => a.start - b.start);
    const nextStrike = new Map<number, number>();
    this.notes = new Array<SceneNote>(sorted.length);
    for (let index = sorted.length - 1; index >= 0; index--) {
      const note = sorted[index];
      const next = nextStrike.get(note.pitch);
      const interval = next === undefined ? Infinity : next - note.start;
      const gap = Math.min(RELEASE_GAP, interval * RELEASE_GAP_SHARE);
      this.notes[index] = { ...note, seed: index * 13 + 1, ribbon: Math.min(note.duration, interval - gap) };
      nextStrike.set(note.pitch, note.start);
    }
    this.bars = bars;
  }

  /** The ramp of each voice, by the voice's index in the score. */
  setRamps(ramps: VoiceRamp[]): void {
    this.ramps = ramps;
  }

  /** The colour of the sky; the rest of the scene is lit against it. */
  setStripLight(color: string): void {
    this.stripColor = hexRgb(color);
  }

  /** -1 = from sides, 0 = vertical, 1 = the reference fan; only horizontal projection changes. */
  setTilt(value: number): void {
    this.tilt = clamp(value, -1, 1);
  }

  /** Independent view flags; neither changes the projection or the playback clock. */
  setGuides(octaveLines: boolean, measureLines: boolean): void {
    this.octaveLines = octaveLines;
    this.measureLines = measureLines;
  }

  setBackground(color: string): void {
    this.background = color;
    if (this.sky) this.sky = this.makeSky();
  }

  dispose(): void {
    this.stage.dispose();
  }

  /** Fits the drawing surface while keeping key geometry and near-note timing tied to the viewport. */
  resize(viewportHeight = this.canvas.clientHeight): void {
    // the layout size, not the drawn one: a transform on the stage (the panel's slide) must not change what the canvas is sized to
    const bounds = { width: this.canvas.clientWidth, height: this.canvas.clientHeight };
    if (!(bounds.width > 0 && bounds.height > 0)) return;
    const ratio = Math.min(window.devicePixelRatio || 1, GL_RATIO_MAX);
    const pixelsX = Math.max(1, Math.round(bounds.width * ratio));
    const pixelsY = Math.max(1, Math.round(bounds.height * ratio));
    const visibleHeight = Math.min(bounds.height, viewportHeight);
    if (this.sky && this.canvas.width === pixelsX && this.canvas.height === pixelsY && this.viewportHeight === visibleHeight) return;
    this.viewportHeight = visibleHeight;
    this.unit = Math.min(bounds.width / PLANE_WIDTH, visibleHeight / PLANE_HEIGHT);
    this.width = bounds.width / this.unit;
    this.height = bounds.height / this.unit;
    const baseHeight = visibleHeight / this.unit;
    this.rollTop = this.height - baseHeight;
    this.canvas.width = pixelsX;
    this.canvas.height = pixelsY;
    this.sheet.width = Math.max(1, Math.round(bounds.width * SHEET_RATIO));
    this.sheet.height = Math.max(1, Math.round(bounds.height * SHEET_RATIO));
    let whites = 0;
    const placed: { midi: number; black: boolean; unit: number }[] = [];
    for (let midi = KEY_RANGE.min; midi <= KEY_RANGE.max; midi++) {
      const black = !NATURAL_PITCH_CLASSES.includes(midi % 12);
      placed.push({ midi, black, unit: black ? whites : whites + 0.5 });
      if (!black) whites++;
    }
    const first = placed[0];
    const last = placed[placed.length - 1];
    const left = first.unit - (first.black ? 0.31 : 0.5);
    const right = last.unit + (last.black ? 0.31 : 0.5);
    this.pitch = this.width / (right - left);
    this.octaveEdges = placed.filter((key) => key.midi % 12 === 0).map((key) => ({ midi: key.midi, x: (key.unit - 0.5 - left) * this.pitch }));
    this.keys = placed.map((key) => ({ ...key, x: (key.unit - left) * this.pitch, width: this.pitch * (key.black ? BLACK_KEY_WIDTH : 1) }));
    this.byMidi = new Map(this.keys.map((key) => [key.midi, key]));
    this.depth = Math.min(baseHeight * BED_DEPTH_OF_HEIGHT, this.pitch * BED_DEPTH_OF_PITCH);
    const pitchScale = clamp(this.pitch / REFERENCE_PITCH, 0.78, 1.75);
    this.rail = this.height - this.depth - Math.max(15, this.depth * 0.147 + Math.max(13, 7 * pitchScale + 6));
    // The octave lines are rays to a vanishing point; their lean is measured in screen coordinates so a wide canvas does not fan them out.
    const octaveWidth = 7 * this.pitch - 0;
    const middleC = this.octaveEdges.find((edge) => edge.midi === MIDDLE_C);
    const measuredDistance = octaveWidth / OCTAVE_LEAN;
    this.convergenceX = middleC ? middleC.x : this.width / 2 + MIDDLE_C_LEAN * measuredDistance;
    this.convergenceDistance = Math.max(measuredDistance, this.rail / 0.9);
    const baseRail = this.rail - this.rollTop;
    const framing = clamp(baseRail / this.pitch / REFERENCE_FRAMING, 0.2, 1.15);
    this.lookAhead = clamp(LOOKAHEAD_AT_FRAMING * Math.sqrt(framing), LOOKAHEAD_RANGE.min, LOOKAHEAD_RANGE.max);
    // A shallow perspective keeps the spacing of repeated notes legible at the far edge.
    this.eyeTime = (this.lookAhead * FAR_SCALE) / (1 - FAR_SCALE);
    this.nearSpeed = baseRail / (this.lookAhead * FAR_SCALE);
    // Invert projectRoll at the top of the reserved surface, rather than clipping at the old viewport.
    this.visibleAhead = this.rail / (baseRail / this.lookAhead - this.rollTop / this.eyeTime);
    this.stripY = this.rail + this.depth + Math.max(7.5, this.depth * 0.147);
    this.sky = this.makeSky();
  }

  /** Draws the scene at `timeSeconds` of the piece. */
  render(timeSeconds: number): void {
    const g = this.ctx;
    if (!this.sky || !this.ramps.length) return;
    this.time = timeSeconds;
    g.setTransform(this.sheet.width / this.width, 0, 0, this.sheet.height / this.height, 0, 0);
    g.fillStyle = this.background;
    g.fillRect(0, 0, this.width, this.height);
    g.drawImage(this.sky, 0, 0, this.width, this.rail);
    this.rollTexture();
    this.guides();
    this.pedalLane();
    this.fronts = [];
    const hits: Hit[] = [];
    const incoming: Incoming[] = [];
    const tails: Tail[] = [];
    for (const note of this.notes) {
      const age = timeSeconds - note.start;
      if (age < -this.visibleAhead) break;
      const key = this.byMidi.get(note.pitch);
      if (!key || age > note.sustainDuration + TAIL_SECONDS) continue;
      const rgb = (this.ramps[note.voice] ?? this.ramps[0]).glow;
      const release = Math.max(0, age - note.duration);
      const soundRelease = Math.max(0, age - note.sustainDuration);
      if (age >= 0) {
        const energy = note.velocity * (1 - Math.exp(-age / 0.052)) * Math.exp(-soundRelease / 1.16) * Math.min(1, (TAIL_SECONDS - soundRelease) / 0.29);
        tails.push({ note, age, release, energy, x: key.x, rgb });
      }
      if (note.sustainDuration > note.duration && age < note.sustainDuration) {
        this.ribbon({ ...note, ribbon: note.sustainDuration - note.duration }, age - note.duration, key, 0.2, false);
      }
      if (age > note.duration + HIT_SECONDS) continue;
      if (age < note.duration) {
        this.ribbon(note, age, key);
        if (age < 0 && age > -FRONT_SECONDS) {
          const front = this.projectRoll(key.x, -age);
          this.fronts.push([front.x, front.y, key.width * front.scale]);
        }
      }
      if (age < 0) {
        if (age > -INCOMING_SECONDS) incoming.push({ x: key.x, age, width: key.width });
        continue;
      }
      const press = clamp(Math.min(age, note.duration) / KEY_PRESS_SECONDS, 0, 1) * Math.max(0, 1 - release / KEY_RELEASE_SECONDS);
      const light = note.velocity * (0.95 + 0.48 * Math.exp(-age / 0.16)) * (1 - Math.exp(-age / 0.013)) * Math.exp(-release / 0.205);
      hits.push({ note, age, press, light, x: key.x, rgb });
    }
    // Repeated attacks light one physical key; dust from the earlier attacks stays in flight.
    const emitters = new Map<number, Emitter>();
    for (const hit of hits) {
      const old = emitters.get(hit.note.pitch);
      const impulse = hit.note.velocity * Math.min(1, hit.age / 0.013) * Math.exp(-0.5 * (hit.age / 0.068) ** 2) * Math.exp(-Math.max(0, hit.age - hit.note.duration) / 0.036);
      const brightest = old && old.light > hit.light ? old : hit;
      emitters.set(hit.note.pitch, { ...brightest, press: Math.max(hit.press, old?.press ?? 0), onset: Math.max(impulse, old?.onset ?? 0) });
    }
    const lit = Array.from(emitters.values());
    g.fillStyle = this.palette.bed;
    g.fillRect(0, this.rail, this.width, this.height - this.rail);
    this.underRail();
    this.contact(hits, lit, incoming, tails);
    const lights: KeyLight[] = lit.map((emitter) => ({ midi: emitter.note.pitch, x: emitter.x, light: emitter.light, press: emitter.press, onset: emitter.onset, rgb: emitter.rgb }));
    this.stage.draw({ sheet: this.sheet, width: this.width, height: this.height, rail: this.rail, depth: this.depth, pitch: this.pitch, keys: this.keys, underField: this.underField }, lights);
  }

  /** A point of the roll at a lane of the plane, `seconds` before it strikes: the roll is one plane seen through one fixed perspective. */
  private projectRoll(lane: number, seconds: number): Projected {
    const timeScale = 1 / (1 + seconds / this.eyeTime);
    const y = this.rollTop + (this.rail - this.rollTop) * (1 - seconds / this.lookAhead) * timeScale;
    const lean = this.tilt < 0 ? this.tilt * SIDE_SPREAD / this.rail : this.tilt / this.convergenceDistance;
    const scale = 1 + (y - this.rail) * lean;
    return { x: this.convergenceX + (lane - this.convergenceX) * scale, y, scale };
  }

  private makeSky(): HTMLCanvasElement {
    const surface = document.createElement('canvas');
    surface.width = this.width;
    surface.height = this.rail;
    const g = surface.getContext('2d');
    if (!g) return surface;
    g.fillStyle = this.background;
    g.fillRect(0, 0, this.width, this.rail);
    const mist = g.createRadialGradient(this.width * 0.45, this.rail * 0.92, 5, this.width * 0.46, this.rail * 0.9, Math.max(300, this.width * 0.75));
    mist.addColorStop(0, rgba(this.palette.mist, 0.27));
    mist.addColorStop(1, rgba(this.palette.mistEdge, 0));
    g.fillStyle = mist;
    g.fillRect(0, 0, this.width, this.rail);
    return surface;
  }

  /** A soft light of a voice (or the white of the hottest spots) as a cached sprite, drawn at `x, y`. */
  private spot(x: number, y: number, rx: number, ry: number, voice: number | 'core', alpha: number): void {
    if (alpha < 0.003) return;
    const key = String(voice);
    let sprite = this.sprites.get(key);
    if (!sprite) {
      sprite = document.createElement('canvas');
      sprite.width = sprite.height = 64;
      const g = sprite.getContext('2d');
      if (g) {
        const color = voice === 'core' ? this.palette.coreLight : (this.ramps[voice] ?? this.ramps[0]).glow;
        const radial = g.createRadialGradient(32, 32, 0, 32, 32, 32);
        for (const [at, a] of [[0, 1], [0.18, 0.76], [0.46, 0.27], [0.72, 0.068], [1, 0]]) radial.addColorStop(at, rgba(color, a));
        g.fillStyle = radial;
        g.fillRect(0, 0, 64, 64);
      }
      this.sprites.set(key, sprite);
    }
    this.ctx.globalAlpha = clamp(alpha, 0, 1);
    this.ctx.drawImage(sprite, x - rx, y - ry, rx * 2, ry * 2);
    this.ctx.globalAlpha = 1;
  }

  /** A field of faint grains anchored in score time, so they stream towards the keys with the notes. */
  private rollTexture(): void {
    const g = this.ctx;
    g.save();
    g.beginPath();
    g.rect(0, 0, this.width, this.rail);
    g.clip();
    for (const grain of this.grains) {
      let seconds = (grain.when - this.time) % GRAIN_CYCLE;
      if (seconds < 0) seconds += GRAIN_CYCLE;
      if (seconds > this.visibleAhead) continue;
      const at = this.projectRoll(grain.u * this.width, seconds);
      const radius = (1 + grain.v ** 3 * 3.1) * at.scale;
      g.globalAlpha = 0.1 + 0.29 * grain.v ** 2;
      g.drawImage(this.grainAtlas, at.x - radius, at.y - radius, 2 * radius, 2 * radius);
    }
    g.restore();
  }

  /** The octave lines running up from the keys, and a line across the roll at every measure start. */
  private guides(): void {
    const g = this.ctx;
    g.lineWidth = Math.max(0.63, 0.54 / this.unit);
    const guide = this.palette.guide;
    g.strokeStyle = gradient(g, 0, this.rail, [[0, rgba(guide.far, 0.15)], [0.75, rgba(guide.mid, 0.23)], [1, rgba(guide.near, 0.36)]]);
    if (this.octaveLines) {
      g.beginPath();
      for (const boundary of this.octaveEdges) {
        const edge = boundary.x;
        const far = this.projectRoll(edge, this.visibleAhead);
        g.moveTo(edge, this.rail);
        g.lineTo(far.x, far.y);
      }
      g.stroke();
    }
    if (!this.measureLines) return;
    for (const start of this.bars) {
      const seconds = start - this.time;
      if (seconds < 0) continue;
      if (seconds >= this.visibleAhead) break;
      const left = this.projectRoll(0, seconds);
      const right = this.projectRoll(this.width, seconds);
      const pixel = this.height / this.sheet.height;
      const thick = Math.max(pixel, (0.92 / this.unit) * left.scale);
      g.fillStyle = rgba(this.palette.barLine, 0.3 + (0.12 * left.y) / this.rail);
      g.fillRect(left.x, left.y, right.x - left.x, thick);
      g.fillStyle = rgba(this.palette.mark, 0.53);
      const end = (5 * left.scale) / this.unit;
      for (const x of [left.x, right.x - end]) g.fillRect(x, left.y, end, thick);
    }
  }

  /** One note as a slab of its voice's gradient, hot where it meets the keys. */
  private ribbon(note: SceneNote, age: number, key: SceneKey, opacity = 1, emission = true): void {
    const g = this.ctx;
    const ramp = this.ramps[note.voice] ?? this.ramps[0];
    const start = -age;
    const end = note.ribbon - age;
    if (note.ribbon <= 0 || start > this.visibleAhead || end <= 0) return;
    const center = key.x;
    const half = key.width * 0.42;
    // The duration fixes the rectangle in the plane. Projecting both edges maps its length, and the gap to the next rectangle, through the same function.
    const front = Math.max(start, -RIBBON_HEAD_CLIP);
    const back = Math.min(end, this.visibleAhead + RIBBON_TAIL_CLIP);
    const head = this.projectRoll(center, front);
    const tail = this.projectRoll(center, back);
    const roundRadius = Math.min(half * 0.31, 1.6);
    const roundTime = Math.min(roundRadius / this.nearSpeed, note.ribbon * 0.49);
    const radius = roundTime * this.nearSpeed;
    const ratio = head.scale;
    const width = 2 * half * ratio;
    const corners: [number, number, number, number][] = [[1, front, 1, Math.PI / 2], [-1, front, 1, Math.PI], [-1, back, -1, (3 * Math.PI) / 2], [1, back, -1, 2 * Math.PI]];
    const outline: Projected[] = [];
    for (const [side, time, direction, last] of corners) {
      const cut = direction > 0 ? front !== start : back !== end;
      if (cut) {
        outline.push(this.projectRoll(center + side * half, time));
        continue;
      }
      for (let step = 0; step <= 3; step++) {
        const theta = last - Math.PI / 2 + (step * Math.PI) / 6;
        outline.push(this.projectRoll(center + side * (half - radius) + radius * Math.cos(theta), time + direction * roundTime - roundTime * Math.sin(theta)));
      }
    }
    const shape = () => {
      g.beginPath();
      g.moveTo(outline[0].x, outline[0].y);
      for (let index = 1; index < outline.length; index++) g.lineTo(outline[index].x, outline[index].y);
      g.closePath();
    };
    g.save();
    g.beginPath();
    g.rect(0, 0, this.width, this.rail);
    g.clip();
    g.globalAlpha = opacity;
    shape();
    g.strokeStyle = rgba(ramp.near, 0.085);
    g.lineWidth = Math.max(1.6, width * 0.29);
    g.stroke();
    const face = gradient(g, head.y, tail.y, [[0, rgba(ramp.near.map((value) => value * 0.9))], [1, rgba(ramp.far.map((value) => value * 0.86))]]);
    g.fillStyle = face;
    g.fill();
    const shade = g.createLinearGradient(head.x - half * ratio, 0, head.x + half * ratio, 0);
    shade.addColorStop(0, rgba(this.palette.sheen, 0.16));
    shade.addColorStop(0.24, rgba(this.palette.sheen, 0));
    shade.addColorStop(1, rgba(this.palette.shadow, 0.14));
    g.fillStyle = shade;
    g.fill();
    g.strokeStyle = rgba(ramp.near.map((value) => 0.28 * value + 182), 0.98);
    g.lineWidth = Math.max(0.7, 1.25 * ratio);
    g.stroke();
    // Where the slab reaches the keys it burns white; the same emission runs through the outline, so there is no second frame at the cut.
    const gap = Math.max(0, this.rail - head.y);
    const power = !emission ? 0 : age >= 0 ? 1 : Math.max(0, 1 - gap / (width * 0.65)) ** 1.5;
    if (power > 0.003) {
      const anchor = Math.min(head.y, this.rail);
      const band = Math.max(width * 2.05, this.pitch * 1.42);
      const hot = gradient(g, anchor - band, anchor, [
        [0, rgba(ramp.near, 0)], [0.17, rgba(ramp.near, power * 0.13)], [0.37, rgba(this.palette.burn[0], power * 0.92)], [0.48, rgba(this.palette.burn[1], power)], [1, rgba(this.palette.burn[2], power)],
      ]);
      g.save();
      g.clip();
      g.fillStyle = hot;
      g.fillRect(Math.min(head.x, tail.x) - width, anchor - band, Math.abs(head.x - tail.x) + 2 * width, band + 1);
      g.restore();
      shape();
      g.strokeStyle = hot;
      g.lineWidth = Math.max(0.76, 1.4 * ratio);
      g.stroke();
    }
    g.restore();
  }

  /** Sustain uses the same time projection, in a narrow lane before the first key. */
  private pedalLane(): void {
    if (!this.pedals.length) return;
    const g = this.ctx;
    const center = this.pitch * 0.24;
    const half = this.pitch * 0.12;
    const shape = (start: number, end: number) => {
      const points = [this.projectRoll(center - half, start), this.projectRoll(center + half, start), this.projectRoll(center + half, end), this.projectRoll(center - half, end)];
      g.beginPath();
      g.moveTo(points[0].x, points[0].y);
      for (const point of points.slice(1)) g.lineTo(point.x, point.y);
      g.closePath();
    };
    g.save();
    g.beginPath();
    g.rect(0, 0, this.width, this.rail);
    g.clip();
    shape(0, this.visibleAhead);
    g.strokeStyle = rgba(this.palette.mark, 0.25);
    g.lineWidth = this.pitch * 0.055;
    g.stroke();
    for (const pedal of this.pedals) {
      const start = Math.max(0, pedal.down - this.time);
      const end = Math.min(this.visibleAhead, pedal.up - this.time);
      if (end <= start) continue;
      shape(start, end);
      g.fillStyle = rgba(this.palette.mark, pedal.down <= this.time ? 0.85 : 0.5);
      g.fill();
    }
    g.font = `${this.pitch * 0.65}px sans-serif`;
    g.fillStyle = rgba(this.palette.mark, 0.85);
    g.fillText('Pedal', this.pitch * 0.65, this.rail - this.pitch * 0.3);
    g.restore();
  }

  /** Independent strip light: one selected colour at constant brightness. */
  private underRail(): void {
    const g = this.ctx;
    const y = this.stripY;
    const profile = g.createLinearGradient(0, 0, this.width, 0);
    const lit = this.stripColor;
    const base = this.palette.stripBase;
    const center = 0.52;
    const spread = 0.35;
    for (let stop = 0; stop < UNDER_STOPS; stop++) {
      const u = stop / (UNDER_STOPS - 1);
      const dx = (u - center) / spread;
      const beam = Math.exp(-0.5 * dx * dx) * Math.min(1, 0.012 + u * 7.5, 0.012 + (1 - u) * 7.5);
      const color = lit.map((value, channel) => Math.min(255, base[channel] + value * beam));
      profile.addColorStop(u, rgba(color));
      this.underField.set(color.map((value) => value / 255), stop * 3);
    }
    g.save();
    const scale = clamp(this.pitch / REFERENCE_PITCH, 0.72, 1.75);
    const [railTop, railUpper, railLower, railBottom] = this.palette.rail;
    g.fillStyle = gradient(g, y - 5 * scale, y + 5 * scale, [[0, railTop], [0.3, railUpper], [0.53, railLower], [0.95, railBottom], [1, railBottom]]);
    g.fillRect(0, y - 5 * scale, this.width, this.height - y + 5 * scale);
    g.globalCompositeOperation = 'screen';
    g.fillStyle = profile;
    for (let row = -5; row <= 6; row++) {
      g.globalAlpha = row < 0 ? Math.exp(-(row * row) / 7.5) : Math.exp(-(row * row) / 10);
      g.fillRect(0, y + row * scale, this.width, scale + 0.03);
    }
    g.restore();
  }

  /** What a strike leaves: the ridge along the keys, the footprints of the hot spots, the dust in the air. */
  private contact(hits: Hit[], lit: Emitter[], incoming: Incoming[], tails: Tail[]): void {
    const g = this.ctx;
    const scale = clamp(this.pitch / REFERENCE_PITCH, 0.78, 2.75);
    const rail = this.rail;
    const width = this.width;
    g.save();
    g.beginPath();
    g.rect(0, 0, width, rail);
    g.clip();
    g.globalCompositeOperation = 'screen';
    // Each attack leaves a low ridge in its own colour after the airborne particles have died out.
    const residues = tails.filter((tail) => tail.energy > 0.009);
    const samples = Math.ceil(width / (1.4 * scale));
    const crest: { x: number; y: number; heat: number; color: Rgb; attack: number }[] = [];
    const stops = g.createLinearGradient(0, 0, width, 0);
    for (let sample = 0; sample <= samples; sample++) {
      const x = (sample / samples) * width;
      let mound = 0;
      let heat = 0;
      let fresh = 0;
      let ripple = 0;
      const sum: Rgb = [0, 0, 0];
      for (const tail of residues) {
        const dx = (x - tail.x) / scale;
        const distance = Math.abs(dx);
        if (distance > 99) continue;
        const weight = Math.min(1, tail.energy * 1.4);
        const seed = tail.note.seed;
        const keyWidth = this.byMidi.get(tail.note.pitch)?.width ?? this.pitch;
        const reach = (keyWidth / scale) * 0.47;
        const ledge = Math.exp(-Math.pow(distance / (reach + 1.4), 3));
        const ring = Math.exp(-Math.pow((distance - 50 * tail.age) / 8.5, 2) - 3 * tail.age);
        const envelope = weight * (0.63 * Math.exp(-distance / 26) + 0.38 * ledge);
        heat += envelope;
        fresh += envelope * Math.exp(-tail.release / 0.28);
        for (let channel = 0; channel < 3; channel++) sum[channel] += envelope * tail.rgb[channel];
        mound += weight * ledge * (1.6 + 0.85 * Math.sin((x / scale) * 0.52 + seed + 0.7 * tail.age) + 0.75 * Math.exp(-tail.age / 0.14));
        ripple += 2.9 * weight * ring * (1 + 0.3 * Math.sin(0.7 * dx + seed));
      }
      for (const arriving of incoming) {
        const dx = (x - arriving.x) / arriving.width;
        mound += 1.55 * Math.exp(arriving.age / 0.047 - 2.6 * dx * dx);
      }
      const rise = 2.15 * (1 - Math.exp(-Math.max(0, mound + 0.32 * ripple) / 3.9));
      const wave = 0.24 * Math.sin((x / scale) * 0.28) * Math.cos((x / scale) * 0.086) + 0.1 * Math.sin((x / scale) * 0.91);
      const color: Rgb = heat ? [sum[0] / heat, sum[1] / heat, sum[2] / heat] : this.palette.crestIdle;
      crest.push({ x, y: rail - scale * (0.61 + rise + wave), heat: 1 - Math.exp(-heat), color, attack: heat ? fresh / heat : 0 });
      if (sample % 3 === 0 || sample === samples) stops.addColorStop(sample / samples, rgba(color, 0.1 + 0.86 * (1 - Math.exp(-heat))));
    }
    const path = () => {
      g.beginPath();
      crest.forEach((point, index) => (index ? g.lineTo(point.x, point.y) : g.moveTo(point.x, point.y)));
    };
    // The haze above the ridge follows the ridge itself; it does not paint a white spot onto the keys.
    const rows = 48;
    if (!this.airSurface) this.airSurface = document.createElement('canvas');
    if (this.airSurface.width !== samples + 1 || this.airSurface.height !== rows || !this.airPixels) {
      this.airSurface.width = samples + 1;
      this.airSurface.height = rows;
      this.airContext = this.airSurface.getContext('2d');
      this.airPixels = this.airContext ? this.airContext.createImageData(samples + 1, rows) : null;
    }
    if (this.airContext && this.airPixels) {
      const out = this.airPixels.data;
      for (let column = 0; column <= samples; column++) {
        const point = crest[column];
        const above = (rail - point.y) / scale;
        for (let row = 0; row < rows; row++) {
          const distance = Math.max(0, rows - 1 - row - above);
          const index = (row * (samples + 1) + column) * 4;
          const haze = 0.16 * Math.exp(-distance / 3.15) + point.heat * (0.65 * Math.exp(-distance / (7 + 6 * point.heat)) + 0.13 * Math.exp(-distance / 2.3));
          out[index] = Math.min(255, point.color[0] * (0.66 + 0.4 * point.attack));
          out[index + 1] = point.color[1] * (0.5 + 0.12 * point.attack);
          out[index + 2] = Math.min(255, point.color[2] * (0.88 + 0.3 * point.attack));
          out[index + 3] = 255 * haze * Math.min(1, row / 4);
        }
      }
      this.airContext.putImageData(this.airPixels, 0, 0);
      g.drawImage(this.airSurface, 0, rail - rows * scale, width, rows * scale);
    }
    g.lineJoin = 'round';
    g.globalAlpha = 1;
    path();
    g.lineTo(width, rail);
    g.lineTo(0, rail);
    g.closePath();
    g.fillStyle = stops;
    g.fill();
    path();
    g.lineWidth = 2.25 * Math.sqrt(scale);
    g.strokeStyle = rgba(this.palette.crestGlow, 0.39);
    g.stroke();
    path();
    g.lineWidth = Math.max(0.91, Math.sqrt(scale) * 1.2);
    g.strokeStyle = rgba(this.palette.crestLine, 0.93);
    g.stroke();
    // A thin, filled contact footprint: a single note and a repeat have different widths.
    const root = Math.sqrt(scale);
    for (const light of lit) {
      this.airDust(light, root);
      const note = light.note;
      const release = Math.max(0, light.age - note.duration);
      const repeat = tails.reduce((value, tail) => (tail.note.pitch === note.pitch && tail.age > light.age + 0.025 ? Math.max(value, Math.exp(-(tail.age - light.age) / 0.42)) : value), 0);
      const envelope = note.velocity * (1 - Math.exp(-light.age / 0.012)) * Math.exp(-release / 0.12);
      if (envelope < 0.014) continue;
      const halfWidth = (0.68 + 0.59 * repeat) * this.pitch;
      const reach = Math.ceil(halfWidth * 3.25);
      const base = rail - 0.28 * root;
      for (let dx = -reach; dx <= reach; dx += root) {
        const patch = Math.exp(-0.7 * (Math.abs(dx) / halfWidth) ** 1.75);
        const strength = patch * envelope;
        if (strength < 0.012) continue;
        const tint = light.rgb.map((value) => value + (252 - value) * (0.53 + 0.22 * patch));
        const swell = 1 + 0.14 * Math.sin((dx / root) * 0.78 + note.seed) * Math.exp(-light.age / 0.22);
        const height = (3.2 + 6.8 * patch) * root * swell;
        g.fillStyle = gradient(g, base - height, base, [
          [0, rgba(light.rgb, 0)], [0.35, rgba(light.rgb, strength * 0.34)], [0.62, rgba(tint, Math.min(1, strength * 0.92))], [0.84, rgba(this.palette.footprint[0], strength * 0.96)], [1, rgba(this.palette.footprint[1], strength)],
        ]);
        g.fillRect(light.x + dx, base - height, root + 0.03, height + 0.32 * root);
      }
    }
    for (const hit of hits) {
      const half = (this.byMidi.get(hit.note.pitch)?.width ?? this.pitch) * 0.46;
      g.save();
      g.translate(hit.x, rail);
      g.scale(root, root);
      g.translate(-hit.x, -rail);
      this.dust(hit, half / root);
      g.restore();
    }
    g.restore();
  }

  /** The cloud that hangs over a held key: a cached density mask per voice and variant, grown from the strike. */
  private airDust(light: Emitter, scale: number): void {
    const note = light.note;
    const release = Math.max(0, light.age - note.duration);
    if (light.age < 0.018 || release > 0.72) return;
    const phase = 1 - Math.exp(-light.age / 0.088);
    const power = note.velocity * (1 - Math.exp(-light.age / 0.045)) * Math.exp(-release / 0.19);
    const variant = (note.seed >>> 0) % 5;
    const key = `${variant}:${note.voice}`;
    let mask = this.densityMasks.get(key);
    if (!mask) {
      const maskWidth = 42;
      const maskHeight = 58;
      mask = document.createElement('canvas');
      mask.width = maskWidth;
      mask.height = maskHeight;
      const g = mask.getContext('2d');
      if (g) {
        const image = g.createImageData(maskWidth, maskHeight);
        const color = (this.ramps[note.voice] ?? this.ramps[0]).glow;
        const field = (x: number, y: number) => {
          const i = Math.floor(x);
          const j = Math.floor(y);
          let u = x - i;
          let v = y - j;
          u = u * u * (3 - 2 * u);
          v = v * v * (3 - 2 * v);
          const sample = (a: number, b: number) => noise((i + a) * 7.71 + (j + b) * 31.9 + variant * 53.2);
          return (1 - v) * ((1 - u) * sample(0, 0) + u * sample(1, 0)) + v * ((1 - u) * sample(0, 1) + u * sample(1, 1));
        };
        for (let y = 0; y < maskHeight; y++) {
          for (let x = 0; x < maskWidth; x++) {
            const altitude = 1 - (y + 0.5) / maskHeight;
            const spine = (field(0.1, altitude * 5) - 0.5) * 0.23;
            const dx = ((x + 0.5) / maskWidth - 0.5 - spine) / (0.16 + 0.2 * altitude);
            const knots = field(x * 0.115, y * 0.102);
            const fine = field(x * 0.38, y * 0.29);
            const envelope = Math.exp(-dx * dx * 1.7) * Math.sin(Math.PI * altitude) ** 0.73;
            const density = envelope * Math.min(1, (0.25 + 1.22 * knots) * (0.65 + 0.5 * fine));
            const ink = 0.12 + 0.46 * knots * fine;
            const index = 4 * (y * maskWidth + x);
            for (let channel = 0; channel < 3; channel++) image.data[index + channel] = color[channel] + (249 - color[channel]) * ink;
            image.data[index + 3] = 255 * density;
          }
        }
        g.putImageData(image, 0, 0);
      }
      this.densityMasks.set(key, mask);
    }
    const drawWidth = (24 + 21 * phase) * scale;
    const drawHeight = (8 + 17.5 * phase) * scale;
    const sway = Math.sin(note.seed + light.age * 6) * 2.1 * scale;
    const lift = Math.min(3.4, release * 12) * scale;
    const g = this.ctx;
    g.globalAlpha = Math.min(1, 1.21 * power);
    g.drawImage(mask, light.x + sway - drawWidth / 2, this.rail - (1.5 * scale + lift + drawHeight), drawWidth, drawHeight);
    g.globalAlpha = 1;
  }

  /** The grains thrown off by one key: bursts at a fixed cadence while it is held, each grain with its own birth, drift and release. */
  private dust(hit: Hit, half: number): void {
    const g = this.ctx;
    const { note, x, age, rgb } = hit;
    const held = Math.min(age, note.duration);
    const bright = rgb.map((value) => value * 0.24 + 184);
    const life = 1.12;
    const interval = 0.245;
    const emit = (birth: number, burst: number) => {
      const t = age - birth;
      if (t < 0 || t > life) return;
      for (let index = 0; index < 38; index++) {
        const id = note.seed * 67 + burst * 323 + index * 3.7;
        const p = t - 0.055 * noise(id);
        const grainLife = 0.26 + 0.79 * noise(id + 7);
        if (p < 0 || p >= grainLife) continue;
        const progress = p / grainLife;
        const fade = (1 - progress) ** 1.3 * note.velocity;
        const origin = (noise(id + 3) - 0.5) * half * 1.8;
        const drift = (noise(id + 5) - 0.5) * 51;
        const speed = 30 + 94 * noise(id + 6);
        let px = x + origin + drift * p + Math.sin(p * 7 + id) * p * 5;
        let py = this.rail - 1 - speed * p + 22 * p * p;
        for (const [nx, ny, reach] of this.fronts) {
          const dx = px - nx;
          const dy = py - ny;
          if (dy >= 0 && dy < 16 && Math.abs(dx) < reach) {
            const push = (1 - dy / 16) * (1 - Math.abs(dx) / reach);
            px += (dx < 0 ? -1 : 1) * push * 3.5;
            py += push * 2;
          }
        }
        const altitude = this.rail - py;
        const visibility = 0.035 + 0.965 * clamp((altitude - 3.2) / 8, 0, 1);
        const radius = (0.36 + 0.7 * noise(id + 2)) * (1 - 0.26 * progress);
        g.fillStyle = rgba(index % 4 === 0 ? rgb : bright, visibility * fade * (0.53 + 0.47 * noise(id + 9)));
        g.beginPath();
        g.arc(px, py, radius, 0, Math.PI * 2);
        g.fill();
        if (index % 6 === 0 && p > 0.035) {
          const spark = (1.3 + 2.4 * noise(id + 2)) * (0.85 + 0.55 * progress);
          this.spot(px, py, spark * 1.45, spark * 1.25, note.voice, fade * 0.48);
          this.spot(px, py, spark * 0.52, spark * 0.57, 'core', fade * 0.55);
        }
      }
    };
    const lastBurst = Math.floor(held / interval);
    const firstBurst = Math.max(0, Math.ceil((age - life) / interval));
    for (let burst = firstBurst; burst <= lastBurst; burst++) emit(burst * interval, burst);
  }
}
