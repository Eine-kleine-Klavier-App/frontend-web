import { CONTACT_LIGHT_ROWS, CONTACT_LIGHT_STOPS, CONTACT_LIGHT_TEXELS_HIGH, KeyStage, type KeyLight, type StageKey } from './keyStage';
import type { KeyMark } from '@/core/keys/KeyMarks';
import { waterfallSurfaceRatios, type WaterfallWindow, type WaterfallWindowSource } from './waterfallFrameCache';
import { sizeToDevicePixels } from '@/rendering/deviceCanvas';
import type { WaterfallNote } from './waterfallNotes';
import { clamp, hexRgb, readWaterfallPalette, rgba, type Rgb, type VoiceRamp, type WaterfallPalette } from './waterfallPalette';
import { BLACK_KEY_WIDTH, KEY_RANGE, NATURAL_PITCH_CLASSES, PLANE_HEIGHT, PLANE_WIDTH } from './waterfallProportions';

// Geometry measured on the first frame of the reference video, in plane units (see PLANE_WIDTH).
/** How much the octave lines lean per octave, and where middle C's line meets the horizon. */
const OCTAVE_LEAN = 0.0863;
const MIDDLE_C_LEAN = 0.0193;
const MIDDLE_C = 60;
/** A note that starts this close to the time (or later) is the one a marked key is for: a clock that stops on a note's start may stand a rounding short of it. */
const SAME_MOMENT_SECONDS = 0.002;
const BED_DEPTH_OF_HEIGHT = 0.215;
const BED_DEPTH_OF_PITCH = 5;
/** The pitch the 2D optics (footprints, ridge, grain sizes) were tuned at. */
const REFERENCE_PITCH = 10.8;
/** Relative widening of the far edge for the moderate From sides preset. */
const SIDE_SPREAD = 0.2;
const LOOKAHEAD_RANGE = { min: 2.2, max: 4.35 } as const;
const LOOKAHEAD_AT_FRAMING = 4.18;
/** The roll's depth on screen compared with the width of a keyboard that fills the reference plane. */
const REFERENCE_FRAMING = 51;
/** A ribbon's tail and head are clipped just outside the visible slab. */
const RIBBON_HEAD_CLIP = 0.035;
const RIBBON_TAIL_CLIP = 0.16;
const RIBBON_RIM_WIDTH = 1.25;
/** A cell of the halo's grid is a source of light when the silhouette covers at least this much of it (enough for its voice to read back). */
const RIBBON_HALO_SOURCE_COVERAGE = 0.25;
/** A ribbon is this fraction of its key's width. */
const RIBBON_WIDTH_OF_KEY = 0.84;
/**
 * The halo is a function of the distance to the nearest ribbon, measured in widths of a white-key ribbon: two exponentials
 * fitted to the reference picture, taken to zero (with no slope) at the reach, so it has no edge and does not depend on the
 * size of a ribbon or on what lies next to it.
 */
const RIBBON_HALO_NEAR = { gain: 0.6, decay: 0.19 };
const RIBBON_HALO_FAR = { gain: 0.18, decay: 0.4 };
const RIBBON_HALO_REACH = 1;
/** Over this difference between the distances to two voices' ribbons (in halo decays) the halo's colour goes from one voice to the other. */
const RIBBON_HALO_BLEND = 0.5;
const RIBBON_HALO_WINDOW_START = 0.55;
/** The distance field is sampled this many times per decay length of the near glow, and in at most this many cells. */
const RIBBON_HALO_CELLS_PER_DECAY = 4;
const RIBBON_HALO_CELL_BUDGET = 250_000;
/** The baked glow is worked out once for a stretch of the piece, not in every frame, so it can afford a coarser grid than the per-frame one. */
const RIBBON_HALO_STRIP_CELL_BUDGET = 62_500;
/** The strip is baked in slices of this many rows; its canvas holds this many screens of rows. */
const HALO_STRIP_SLICE_ROWS = 32;
const HALO_STRIP_SCREENS = 4;
/** What is baked ahead of a frame without a stall, in milliseconds. */
const HALO_STRIP_BUDGET_MS = 1.2;
/** The bright strip along a ribbon: its place and spread across the ribbon, in ribbon widths, and how it is sampled. */
const RIBBON_CORE_CENTER = -0.10;
const RIBBON_CORE_SPREAD = 0.18;
const RIBBON_CORE_STOPS = 9;
/** The face of a ribbon lets this much of what lies under it show. */
const RIBBON_FACE_ALPHA = 0.86;
const RIBBON_GAP_OF_WIDTH = 1 / 6;
const RIBBON_MAX_TRIM = 0.25;
const KEY_ATTACK_SLOW_SECONDS = 0.054;
const KEY_ATTACK_FAST_SECONDS = 0.026;
const LIGHT_REACH = 7;
const KEY_RELEASE_SECONDS = 0.09;
/** Time the return curve needs to lift a key by 60% of its travel: a repeat is struck on a key raised this far. */
const KEY_REPEAT_LIFT_SECONDS = 0.051;
const TAIL_SECONDS = 4.5;
const HIT_SECONDS = 1.35;
const FRONT_SECONDS = 0.4;
const UNDER_STOPS = 25;
const CONTACT_SIDE_SAMPLES = CONTACT_LIGHT_STOPS * CONTACT_LIGHT_ROWS;
// The aerial halo is soft horizontally. Its mask needs fewer samples than the thin crest.
const AIR_COLUMNS = 2 * CONTACT_LIGHT_STOPS - 1;
const AIR_IDLE_DECAY = 4.8;
const AIR_IDLE_STEP = Math.exp(1 / AIR_IDLE_DECAY);
const AIR_CORE_STEP = Math.exp(1 / 2.3);
const PEDAL_ATTACK_SECONDS = 0.08;
const PEDAL_RELEASE_SECONDS = 0.18;
const GRAIN_COUNT = 430;
const GRAIN_CYCLE = 8;

/** Keep the Canvas 2D backing density within the same work budget for every browser. */
const MAX_RASTER_RATIO = 1.5;

type DrawingSurface = HTMLCanvasElement | OffscreenCanvas;
type DrawingContext = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

function drawingContext(surface: DrawingSurface, options?: CanvasRenderingContext2DSettings): DrawingContext | null {
  if ('ownerDocument' in surface) return surface.getContext('2d', options);
  return surface.getContext('2d', options);
}

/** The two canvases that stand under the roll canvas: the sky (drawn once) and the guide lines (drawn on whole device pixels). */
export interface WaterfallLayers<Surface> {
  sky: Surface;
  lines: Surface;
}

export interface WaterfallLayout {
  width: number;
  height: number;
  viewportHeight: number;
  pixelRatio: number;
}

const noise = (n: number): number => {
  const x = Math.sin(n * 78.233 + 17.41) * 43758.5453;
  return x - Math.floor(x);
};

const gradient = (g: DrawingContext, from: number, to: number, stops: readonly (readonly [number, string])[]): CanvasGradient => {
  const result = g.createLinearGradient(0, from, 0, to);
  for (const [at, color] of stops) result.addColorStop(at, color);
  return result;
};

/** First index for which the sorted range is no longer before the boundary. */
function lowerBound(length: number, before: (index: number) => boolean, from = 0): number {
  let left = from;
  let right = length;
  while (left < right) {
    const middle = left + Math.floor((right - left) / 2);
    if (before(middle)) left = middle + 1;
    else right = middle;
  }
  return left;
}

interface SceneKey extends StageKey {
  unit: number;
  width: number;
}

interface SceneNote extends WaterfallNote {
  seed: number;
  expiresAt: number;
  startPress: number;
  /** Seconds from the end of this note to the next strike of the same key; infinite when there is none. */
  gapToNext: number;
}

/** Evaluate the pose at score time, including when the frame is reached by a seek. */
function keyPressAt(note: SceneNote, age: number): number {
  if (age < 0 || note.duration <= 0) return 0;
  const attackTime = Math.min(
    note.duration * 0.8,
    KEY_ATTACK_SLOW_SECONDS + (KEY_ATTACK_FAST_SECONDS - KEY_ATTACK_SLOW_SECONDS) * note.velocity,
  );
  const attack = clamp(age / attackTime, 0, 1);
  // The key starts rising when the sound ends. Only when the same key is struck again sooner does it start rising
  // early enough to be lifted by `KEY_REPEAT_LIFT_SECONDS` at the strike, and never before half of the note.
  const earlyReturn = clamp(KEY_REPEAT_LIFT_SECONDS - note.gapToNext, 0, KEY_REPEAT_LIFT_SECONDS);
  const returnStart = Math.max(note.duration * 0.5, note.duration - earlyReturn);
  const release = clamp((age - returnStart) / KEY_RELEASE_SECONDS, 0, 1);
  const press = 1 - (1 - note.startPress) * (1 - attack) ** 3;
  return press * (1 - release * release * (3 - 2 * release));
}

export interface PedalInterval {
  down: number;
  up: number;
}

interface ScenePedal extends PedalInterval {
  startLevel: number;
}

function pedalEase(progress: number): number {
  const phase = clamp(progress, 0, 1);
  return phase * phase * (3 - 2 * phase);
}

function pedalLevelAt(pedal: ScenePedal, time: number): number {
  const attack = pedalEase((Math.min(time, pedal.up) - pedal.down) / PEDAL_ATTACK_SECONDS);
  const release = pedalEase((time - pedal.up) / PEDAL_RELEASE_SECONDS);
  return (pedal.startLevel + (1 - pedal.startLevel) * attack) * (1 - release);
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
  x: number;
  rgb: Rgb;
}

interface Emitter extends Hit {
  onset: number;
}

interface Projected {
  x: number;
  y: number;
  scale: number;
}

/** 0 below `from`, 1 above `to`, a smooth step between with no slope at either end. */
function smoothStep(from: number, to: number, value: number): number {
  const t = clamp((value - from) / (to - from), 0, 1);
  return t * t * (3 - 2 * t);
}

/** The strength of the halo, 0..1, at a distance in white-key ribbon widths. */
function haloStrength(distance: number): number {
  const glow = RIBBON_HALO_NEAR.gain * Math.exp(-distance / RIBBON_HALO_NEAR.decay) +
    RIBBON_HALO_FAR.gain * Math.exp(-distance / RIBBON_HALO_FAR.decay);
  return glow * (1 - smoothStep(RIBBON_HALO_WINDOW_START, 1, distance / RIBBON_HALO_REACH));
}

/** The grid the halo's distance field lives on, and its buffers. */
interface HaloField {
  columns: number;
  rows: number;
  mask: DrawingSurface;
  glow: DrawingSurface;
  maskContext: DrawingContext;
  glowContext: DrawingContext;
  distance: Float32Array;
  voice: Uint8Array;
  /** The nearest silhouette of a different voice: where it is about as near as the first, the two colours blend. */
  otherDistance: Float32Array;
  otherVoice: Uint8Array;
}

/** One ribbon of the frame: its outline and what painting it needs. */
/**
 * The glow of the ribbons, baked in score time: a grid of cells, one row per `rowSeconds` of the piece, so it moves with the notes and a stretch of
 * the piece is worked out once. The canvas holds the global rows [baseTop - capacity, baseTop), the latest row at the top; `validLo..validHi` is baked.
 */
interface HaloStrip {
  cell: number;
  columns: number;
  rowSeconds: number;
  /** Rows around a slice that are worked on as well, so that a slice is what the whole grid would give: the reach of the glow. */
  apron: number;
  capacity: number;
  behind: number;
  ahead: number;
  baseTop: number;
  validLo: number;
  validHi: number;
  canvas: DrawingSurface;
  context: DrawingContext;
  spare: DrawingSurface;
  spareContext: DrawingContext;
  mask: DrawingSurface;
  maskContext: DrawingContext;
  distance: Float32Array;
  voice: Uint8Array;
  otherDistance: Float32Array;
  otherVoice: Uint8Array;
  /** Slices baked so far; read by the tests. */
  slices: number;
}

/** A cell offers the two nearest voices of a neighbour to itself: it keeps its nearest voice and the nearest voice that differs from it. */
function offerHalo(distance: Float32Array, voice: Uint8Array, otherDistance: Float32Array, otherVoice: Uint8Array, index: number, candidate: number, candidateVoice: number): void {
  if (!candidateVoice) return;
  const own = voice[index];
  if (candidateVoice === own) {
    if (candidate < distance[index]) distance[index] = candidate;
  } else if (candidate < distance[index]) {
    otherDistance[index] = distance[index];
    otherVoice[index] = own;
    distance[index] = candidate;
    voice[index] = candidateVoice;
  } else if (candidateVoice === otherVoice[index]) {
    if (candidate < otherDistance[index]) otherDistance[index] = candidate;
  } else if (candidate < otherDistance[index]) {
    otherDistance[index] = candidate;
    otherVoice[index] = candidateVoice;
  }
}

interface RibbonShape {
  note: SceneNote;
  age: number;
  ramp: VoiceRamp;
  outline: Path2D;
  head: Projected;
  tail: Projected;
  width: number;
  half: number;
  height: number;
  skew: number;
}

function ribbonPaint(ramp: VoiceRamp) {
  const lit = (rgb: Rgb, white: number, exposure = 1) => {
    const value = Math.max(...rgb) / 255;
    const lift = 1 + .78 * (1 - value);
    const mix = white * value;
    return rgb.map(channel => Math.min(255, channel * lift + (255 - channel) * mix) * exposure);
  };
  const cool = clamp((ramp.near[2] - ramp.near[0]) / 128, 0, 1);
  const mix = (from: Rgb, to: Rgb, portion: number) =>
    from.map((channel, index) => channel + (to[index] - channel) * portion) as Rgb;
  const distant = mix(ramp.near, ramp.far, .64 * cool);
  const close = mix(ramp.near, ramp.far, .72 * (1 - cool));
  const ink = lit(ramp.near, .20 + .19 * cool);
  const core = lit(ramp.near, .72);
  return {
    stops: [
      [0, rgba(lit(distant, .12, .78), RIBBON_FACE_ALPHA)],
      [.34, rgba(lit(distant, .22 + .07 * cool, .88), RIBBON_FACE_ALPHA)],
      [.68, rgba(lit(mix(ramp.near, close, .3), .32 + .14 * cool, .96), RIBBON_FACE_ALPHA)],
      [.9, rgba(lit(close, .65 + .14 * cool), RIBBON_FACE_ALPHA)],
      [1, rgba(lit(close, .83 + .10 * cool), RIBBON_FACE_ALPHA)],
    ] as const,
    ink,
    core,
  };
}

/** The roll: notes falling in perspective towards the keys, and everything the strike throws up. The clock comes from outside; the scene owns no time. */
export class WaterfallScene {
  private readonly makeCanvas: () => DrawingSurface;
  private readonly sheet: DrawingSurface;
  private readonly layers: WaterfallLayers<DrawingSurface> | undefined;
  private skyContext: DrawingContext | undefined;
  private linesContext: DrawingContext | undefined;
  private readonly ctx: DrawingContext;
  private readonly keyboard: DrawingContext;
  private readonly stage: KeyStage;
  private keyMarks: readonly KeyMark[] = [];
  private readonly stripVoiceField = new Float32Array(UNDER_STOPS * 3);
  private readonly stripVoiceWeights = new Float32Array(UNDER_STOPS);
  private readonly ridgeField = new Float32Array(CONTACT_LIGHT_STOPS * 3);
  private readonly ridgeFlashField = new Float32Array(CONTACT_LIGHT_STOPS * 3);
  private readonly ridgeRippleField = new Float32Array(CONTACT_LIGHT_STOPS);
  private readonly contactField = new Float32Array(2 * CONTACT_SIDE_SAMPLES * 3);
  private readonly contactPixels = new Float32Array(CONTACT_LIGHT_STOPS * CONTACT_LIGHT_TEXELS_HIGH * 4);
  private readonly contactMoment = new Float32Array(2 * CONTACT_SIDE_SAMPLES);
  private readonly contactWeight = new Float32Array(2 * CONTACT_SIDE_SAMPLES);
  private readonly sprites = new Map<string, DrawingSurface>();
  private readonly densityMasks = new Map<string, DrawingSurface>();
  private readonly grains = Array.from({ length: GRAIN_COUNT }, (_, index) => ({ u: noise(index + 211), when: noise(index + 733) * GRAIN_CYCLE, v: noise(index * 2 + 31) }));
  private readonly grainAtlas: DrawingSurface;
  private notes: SceneNote[] = [];
  private latestExpiry = new Float64Array(0);
  private bars: number[] = [];
  private pedals: ScenePedal[] = [];
  private ramps: VoiceRamp[] = [];
  private ribbonColors: ReturnType<typeof ribbonPaint>[] = [];
  private ribbonFaces: CanvasGradient[] = [];
  private readonly coreGradients = new Map<string, CanvasGradient>();
  private haloField: HaloField | undefined;
  private halo: HaloStrip | undefined;
  private readonly palette: WaterfallPalette;
  private background: string;
  private stripColor: Rgb;
  private sky: DrawingSurface | null = null;
  private keys: SceneKey[] = [];
  private byMidi = new Map<number, SceneKey>();
  private octaveEdges: { midi: number; x: number }[] = [];
  private fronts: [number, number, number][] = [];
  private airSurface: DrawingSurface | null = null;
  private airContext: DrawingContext | null = null;
  private airPixels: ImageData | null = null;
  private time = 0;
  private width = PLANE_WIDTH;
  private height = PLANE_HEIGHT;
  private rollTop = 0;
  private unit = 1;
  private pitch = 1;
  private depth = 1;
  private rail = 1;
  private stripY = 1;
  private convergenceX = 0;
  private convergenceDistance = 1;
  private tilt = 0;
  private octaveLines = true;
  private measureLines = true;
  private backgroundDust = true;
  private lookAhead = 1;
  private visibleAhead = 1;
  private nearSpeed = 1;
  private rasterLayout = '';
  private rollEnd = 1;
  private keyboardTop = 0;

  /**
   * With `layers` (and a keyboard canvas) the roll canvas holds only what moves with the notes and is transparent. The sky stands under it,
   * drawn once, and the guide lines stand between them on a canvas of whole device pixels, so that nothing resamples a line the frame draws.
   */
  constructor(canvas: HTMLCanvasElement, palette?: WaterfallPalette, keyboardCanvas?: HTMLCanvasElement, layers?: WaterfallLayers<HTMLCanvasElement>);
  constructor(canvas: OffscreenCanvas, palette: WaterfallPalette, keyboardCanvas?: OffscreenCanvas, layers?: WaterfallLayers<OffscreenCanvas>);
  constructor(private readonly canvas: DrawingSurface, palette?: WaterfallPalette,
    private readonly keyboardCanvas?: DrawingSurface, layers?: WaterfallLayers<DrawingSurface>) {
    const inDocument = 'ownerDocument' in canvas;
    this.makeCanvas = inDocument ? () => canvas.ownerDocument.createElement('canvas') : () => new OffscreenCanvas(1, 1);
    if (!palette && !inDocument) throw new Error('The offscreen waterfall needs CSS colours from the page');
    this.palette = palette ?? readWaterfallPalette(canvas as HTMLCanvasElement);
    this.sheet = canvas;
    this.layers = keyboardCanvas ? layers : undefined;
    const context = drawingContext(this.sheet, { alpha: this.layers !== undefined });
    if (!context) throw new Error('A 2D canvas is unavailable');
    this.ctx = context;
    if (this.layers) {
      const sky = drawingContext(this.layers.sky, { alpha: false });
      const lines = drawingContext(this.layers.lines);
      if (!sky || !lines) throw new Error('The sky and guide canvases are unavailable');
      this.skyContext = sky;
      this.linesContext = lines;
    }
    const keyboard = keyboardCanvas ? drawingContext(keyboardCanvas) : context;
    if (!keyboard) throw new Error('The keyboard canvas is unavailable');
    this.keyboard = keyboard;
    this.background = this.palette.skyBlack;
    this.stripColor = this.palette.stripDefault;
    this.stage = new KeyStage(canvas, this.palette.crestIdle);
    this.grainAtlas = this.makeCanvas();
    this.prepareGrain();
  }

  private prepareGrain(): void {
    this.grainAtlas.width = this.grainAtlas.height = 20;
    const atlas = drawingContext(this.grainAtlas);
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

  /** Playback times for the notes, bar lines and pedal indicator. */
  setPiece(notes: WaterfallNote[], bars: number[], pedals: readonly PedalInterval[] = []): void {
    const sorted = notes.slice().sort((a, b) => a.start - b.start);
    this.notes = sorted.map((note, index) => ({
      ...note,
      seed: index * 13 + 1,
      expiresAt: note.start + Math.max(note.sustainDuration + TAIL_SECONDS, note.duration + HIT_SECONDS),
      startPress: 0,
      gapToNext: Infinity,
    }));
    this.latestExpiry = new Float64Array(sorted.length);
    let latestExpiry = -Infinity;
    const previousStrike = new Map<number, SceneNote>();
    for (const [index, note] of this.notes.entries()) {
      const previous = previousStrike.get(note.pitch);
      if (previous) {
        previous.gapToNext = note.start - (previous.start + previous.duration);
        note.startPress = keyPressAt(previous, note.start - previous.start);
      }
      if (note.duration > 0) previousStrike.set(note.pitch, note);
      latestExpiry = Math.max(latestExpiry, note.expiresAt);
      this.latestExpiry[index] = latestExpiry;
    }
    this.halo = undefined;
    this.bars = bars.slice().sort((a, b) => a - b);
    this.pedals = [];
    for (const pedal of pedals.slice().sort((a, b) => a.down - b.down)) {
      const previous = this.pedals.at(-1);
      const startLevel = previous ? pedalLevelAt(previous, pedal.down) : 0;
      this.pedals.push({ ...pedal, startLevel });
    }
  }

  /** The ramp of each voice, by the voice's index in the score. */
  setRamps(ramps: VoiceRamp[]): void {
    for (let voice = 0; voice < Math.max(this.ramps.length, ramps.length); voice++) {
      const old = (this.ramps[voice] ?? this.ramps[0])?.glow;
      const next = (ramps[voice] ?? ramps[0])?.glow;
      if (old && next && old.every((channel, index) => channel === next[index])) continue;
      this.sprites.delete(String(voice));
      for (let variant = 0; variant < 5; variant++) this.densityMasks.delete(`${variant}:${voice}`);
    }
    const paints = ramps.map((ramp, voice) => {
      const previous = this.ramps[voice];
      const paint = this.ribbonColors[voice];
      if (paint && previous?.near.every((channel, index) => channel === ramp.near[index]) &&
          previous.far.every((channel, index) => channel === ramp.far[index])) return paint;
      return ribbonPaint(ramp);
    });
    this.coreGradients.clear();
    this.ribbonColors = paints;
    this.halo = undefined;
    this.prepareRibbonFaces();
    this.ramps = ramps;
    this.stage.setPalette(ramps.filter(Boolean).map(ramp => ramp.glow));
  }

  private prepareRibbonFaces(): void {
    this.ribbonFaces = this.ribbonColors.map(paint => gradient(this.ctx, this.rollTop, this.rail, paint.stops));
  }

  /** The base colour of the pedal light in the absence of sounding voices. */
  setStripLight(color: string): void {
    this.stripColor = hexRgb(color);
  }

  /** -1 = from sides, 0 = vertical, 1 = the reference fan; only horizontal projection changes. */
  setTilt(value: number): void {
    this.tilt = clamp(value, -1, 1);
    this.halo = undefined;
  }

  /** Independent view flags; neither changes the projection or the playback clock. */
  setGuides(octaveLines: boolean, measureLines: boolean): void {
    this.octaveLines = octaveLines;
    this.measureLines = measureLines;
  }

  /** The faint dust drifting down the sky with the notes; a view flag like the guides. */
  setBackgroundDust(visible: boolean): void {
    this.backgroundDust = visible;
  }

  setBackground(color: string): void {
    this.background = color;
    if (this.sky) {
      this.sky = this.makeSky();
      this.paintSkyLayer();
    }
  }

  dispose(): void {
    this.stage.dispose();
    this.haloField = undefined;
    this.halo = undefined;
    this.ribbonColors = [];
    this.ribbonFaces = [];
  }

  invalidateRasters(): void {
    this.rasterLayout = '';
    this.halo = undefined;
    this.stage.invalidateRasters();
    this.sprites.clear();
    this.densityMasks.clear();
    this.prepareGrain();
  }

  /** Fits the drawing surface while keeping key geometry and near-note timing tied to the viewport. */
  resize(viewportHeight?: number): void {
    if (!('clientWidth' in this.canvas)) return;
    const fullSurface = this.keyboardCanvas ? this.canvas.parentElement ?? this.canvas : this.canvas;
    const { clientWidth: width, clientHeight: height } = fullSurface;
    this.resizeTo({ width, height, viewportHeight: viewportHeight || height, pixelRatio: window.devicePixelRatio || 1 });
  }

  resizeTo(layout: WaterfallLayout): void {
    const { width, height, viewportHeight, pixelRatio } = layout;
    if (!(width > 0 && height > 0 && viewportHeight > 0)) return;
    const visibleHeight = Math.min(height, viewportHeight);
    const rasterLayout = [width, height, visibleHeight, pixelRatio].join('/');
    if (this.sky && this.rasterLayout === rasterLayout) return;
    this.rasterLayout = rasterLayout;
    this.unit = Math.min(width / PLANE_WIDTH, visibleHeight / PLANE_HEIGHT);
    this.width = width / this.unit;
    this.height = height / this.unit;
    const baseHeight = visibleHeight / this.unit;
    this.rollTop = this.height - baseHeight;
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
    this.resizeRasters(width, height, pixelRatio);
    // The octave lines are rays to a vanishing point; their lean is measured in screen coordinates so a wide canvas does not fan them out.
    const octaveWidth = 7 * this.pitch - 0;
    const middleC = this.octaveEdges.find((edge) => edge.midi === MIDDLE_C);
    const measuredDistance = octaveWidth / OCTAVE_LEAN;
    this.convergenceX = middleC ? middleC.x : this.width / 2 + MIDDLE_C_LEAN * measuredDistance;
    this.convergenceDistance = Math.max(measuredDistance, this.rail / 0.9);
    const baseRail = this.rail - this.rollTop;
    const framing = clamp(baseRail / this.pitch / REFERENCE_FRAMING, 0.2, 1.15);
    this.lookAhead = clamp(LOOKAHEAD_AT_FRAMING * Math.sqrt(framing), LOOKAHEAD_RANGE.min, LOOKAHEAD_RANGE.max);
    this.nearSpeed = baseRail / this.lookAhead;
    // Invert the projection at the actual top, including the reserve behind a wide panel.
    this.visibleAhead = this.rail / this.nearSpeed;
    this.stripY = this.rail + this.depth + Math.max(7.5, this.depth * 0.175);
    this.sky = this.makeSky();
    this.paintSkyLayer();
    this.halo = undefined;
    this.prepareRibbonFaces();
  }

  private resizeRasters(width: number, height: number, deviceRatio: number): void {
    const keyboard = this.keyboardCanvas;
    this.rollEnd = keyboard ? Math.min(this.height, this.rail + this.pitch * .12) : this.height;
    this.keyboardTop = keyboard ? Math.max(0, this.rail - this.pitch * .76) : 0;
    const rollHeight = height * this.rollEnd / this.height;
    const keyboardHeight = height * (this.height - this.keyboardTop) / this.height;
    const ratios = keyboard ? waterfallSurfaceRatios(width, rollHeight, keyboardHeight, deviceRatio)
      : { roll: Math.min(deviceRatio, MAX_RASTER_RATIO), keyboard: 1 };
    this.canvas.width = Math.max(1, Math.round(width * ratios.roll));
    this.canvas.height = Math.max(1, Math.round(rollHeight * ratios.roll));
    this.ctx.imageSmoothingQuality = 'medium';
    if (!keyboard) return;
    // A white key spans a whole number of keyboard pixels, so every key edge falls on the same pixel phase and every groove is drawn alike.
    const keys = this.width / this.pitch;
    const keyPixels = width * ratios.keyboard / keys;
    const keyboardRatio = keyPixels >= 1 ? Math.floor(keyPixels) * keys / width : ratios.keyboard;
    keyboard.width = Math.max(1, Math.round(width * keyboardRatio));
    keyboard.height = Math.max(1, Math.round(keyboardHeight * keyboardRatio));
    this.keyboard.imageSmoothingQuality = 'high';
    if ('style' in keyboard && 'style' in this.canvas) {
      this.canvas.style.height = `${100 * this.rollEnd / this.height}%`;
      keyboard.style.height = `${100 * (this.height - this.keyboardTop) / this.height}%`;
    }
    const layers = this.layers;
    if (!layers) return;
    // The guide canvas has one pixel per device pixel and is shown at exactly that size, so the browser never resamples what the frame draws on it.
    const railHeight = this.rail * this.unit;
    layers.sky.width = Math.max(1, Math.round(width * ratios.roll));
    layers.sky.height = Math.max(1, Math.round(railHeight * ratios.roll));
    sizeToDevicePixels(layers.lines, width, railHeight, deviceRatio);
    if (this.linesContext) this.linesContext.imageSmoothingQuality = 'medium';
    if ('style' in layers.sky) layers.sky.style.height = `${100 * this.rail / this.height}%`;
  }

  /** The sky stands still: it is drawn onto its own canvas when it changes, not on every frame. */
  private paintSkyLayer(): void {
    if (!this.layers || !this.skyContext || !this.sky) return;
    this.skyContext.drawImage(this.sky, 0, 0, this.layers.sky.width, this.layers.sky.height);
  }

  get lookAheadSeconds(): number {
    return this.visibleAhead;
  }

  /** How many CSS pixels of the roll one second of the music is, at the keys: the time and the place on the roll are one line. (The scene works in its own units, `unit` pixels each.) */
  get pixelsPerSecond(): number {
    return this.nearSpeed * this.unit;
  }

  /** Where the keys begin, in CSS pixels from the top of the roll's canvas. */
  get keysTop(): number {
    return this.rail * this.unit;
  }

  windowSource(extent: number): WaterfallWindowSource {
    return {
      bars: [0, ...new Set(this.bars.filter(bar => bar > 0 && bar < extent))],
      extent,
      starts: Float64Array.from(this.notes, note => note.start),
      latestExpiry: this.latestExpiry,
      pedalStarts: Float64Array.from(this.pedals, pedal => pedal.down),
    };
  }

  /** A long-held note can start well before the current window and still affect the picture. */
  private noteWindow(time: number, prepared?: WaterfallWindow): [number, number] {
    const first = prepared?.noteFrom ?? 0;
    const end = lowerBound(prepared?.noteTo ?? this.notes.length,
      index => this.notes[index].start <= time + this.visibleAhead, first);
    const start = lowerBound(end, index => this.latestExpiry[index] < time, first);
    return [start, end];
  }

  /** Keys the keyboard is asked to show beyond what the notes do to them; they replace the notes' light on their pitch. */
  setKeyMarks(marks: readonly KeyMark[]): void {
    this.keyMarks = marks;
  }

  /** Draws the scene at timeSeconds of the piece. */
  render(timeSeconds: number, prepared?: WaterfallWindow): void {
    const g = this.ctx;
    if (!this.sky || !this.ramps.length) return;
    this.time = timeSeconds;
    g.setTransform(this.sheet.width / this.width, 0, 0, this.sheet.height / this.rollEnd, 0, 0);
    if (this.layers) g.clearRect(0, 0, this.width, this.rollEnd);
    else g.drawImage(this.sky, 0, 0, this.width, this.rail);
    if (this.keyboardCanvas) {
      g.fillStyle = this.background;
      g.fillRect(0, this.rail, this.width, this.rollEnd - this.rail);
    }
    // The back of the roll (the dust, then the guide lines) is drawn on its own canvas under the roll canvas, in the same scene units.
    if (this.layers && this.linesContext) {
      this.linesContext.setTransform(this.layers.lines.width / this.width, 0, 0, this.layers.lines.height / this.rail, 0, 0);
      this.linesContext.clearRect(0, 0, this.width, this.rail);
    }
    g.save();
    g.beginPath();
    g.rect(0, 0, this.width, this.rail);
    g.clip();
    if (this.backgroundDust) this.rollTexture();
    this.guides();
    this.fronts = [];
    const hits: Hit[] = [];
    const tails: Tail[] = [];
    const shapes: RibbonShape[] = [];
    const [start, end] = this.noteWindow(timeSeconds, prepared);
    for (let index = start; index < end; index++) {
      const note = this.notes[index];
      if (note.expiresAt < timeSeconds) continue;
      const key = this.byMidi.get(note.pitch);
      if (!key) continue;
      const age = timeSeconds - note.start;
      const rgb = (this.ramps[note.voice] ?? this.ramps[0]).glow;
      const release = Math.max(0, age - note.duration);
      const soundRelease = Math.max(0, age - note.sustainDuration);
      if (age >= 0 && soundRelease <= TAIL_SECONDS) {
        tails.push({ note, age, x: key.x, rgb });
      }
      if (age > note.duration + HIT_SECONDS) continue;
      if (age < note.duration) {
        const shape = this.ribbonShape(note, age, key);
        if (shape) shapes.push(shape);
        if (age < 0 && age > -FRONT_SECONDS) {
          const front = this.projectRoll(key.x, -age);
          this.fronts.push([front.x, front.y, key.width]);
        }
      }
      if (age < 0) continue;
      const press = keyPressAt(note, age);
      const light = note.velocity * (0.95 + 0.48 * Math.exp(-age / 0.16)) * (1 - Math.exp(-age / 0.013)) * Math.exp(-release / 0.205);
      hits.push({ note, age, press, light, x: key.x, rgb });
    }
    if (this.layers && this.tilt === 0) this.drawHaloStrip(timeSeconds);
    else this.drawHalo(shapes);
    for (const shape of shapes) this.paintRibbon(shape);
    g.restore();
    // Repeated attacks light one physical key; dust from the earlier attacks stays in flight.
    const emitters = new Map<number, Emitter>();
    for (const hit of hits) {
      const old = emitters.get(hit.note.pitch);
      const impulse = hit.note.velocity * Math.min(1, hit.age / 0.013) * Math.exp(-0.5 * (hit.age / 0.068) ** 2) * Math.exp(-Math.max(0, hit.age - hit.note.duration) / 0.036);
      const held = hit.age < hit.note.duration;
      const oldHeld = old !== undefined && old.age < old.note.duration;
      // A new attack owns its voice and flash. Preserve the continuous pose if
      // the previous voice was still returning when the key was struck again.
      const keepOld = old !== undefined && (
        (!held && oldHeld) ||
        (!held && old.light * keyPressAt(old.note, old.age) > hit.light * hit.press) ||
        (held && oldHeld && old.note.start === hit.note.start && old.light > hit.light)
      );
      const source = keepOld ? old : hit;
      emitters.set(hit.note.pitch, {
        ...source,
        press: Math.max(hit.press, old?.press ?? 0),
        onset: keepOld ? old.onset : impulse,
      });
    }
    const lit = Array.from(emitters.values());
    const bed = this.keyboard;
    const backing = this.keyboardCanvas ?? this.sheet;
    const rasterScaleY = backing.height / (this.height - this.keyboardTop);
    if (this.keyboardCanvas) {
      bed.setTransform(backing.width / this.width, 0, 0, rasterScaleY, 0, -this.keyboardTop * rasterScaleY);
    }
    // Complete the boundary pixel before painting the moving contact light.
    const bedTop = this.keyboardTop + Math.floor((this.rail - this.keyboardTop) * rasterScaleY) / rasterScaleY;
    if (this.keyboardCanvas) bed.clearRect(0, this.keyboardTop, this.width, bedTop - this.keyboardTop);
    bed.fillStyle = this.palette.bed;
    bed.fillRect(0, bedTop, this.width, this.height - bedTop);
    this.underRail(tails, prepared);
    this.buildRidgeField(lit);
    this.buildContactField(lit);
    const contactLight = this.contact(hits, lit);
    const lights: KeyLight[] = lit.map((emitter) => ({ midi: emitter.note.pitch, light: emitter.light, press: emitter.press, onset: emitter.onset, rgb: emitter.rgb }));
    for (const mark of this.keyMarks) {
      let rgb: Rgb;
      if (mark.colour !== null) {
        rgb = hexRgb(mark.colour);
      } else {
        // The voice of the note this key is for: the next one of this pitch, else the last one before.
        let found: WaterfallNote | undefined;
        for (let index = start; index < end; index++) {
          const note = this.notes[index];
          if (note.pitch !== mark.pitch) continue;
          found = note;
          if (note.start >= timeSeconds - SAME_MOMENT_SECONDS) break;
        }
        rgb = (this.ramps[found?.voice ?? 0] ?? this.ramps[0]).glow;
      }
      const at = lights.findIndex((light) => light.midi === mark.pitch);
      if (at >= 0) lights.splice(at, 1);
      lights.push(mark.shown === 'pressed'
        ? { midi: mark.pitch, light: 1, press: 1, onset: 0, rgb }
        : { midi: mark.pitch, light: 0, press: 0, onset: 0, rgb, hint: 1 });
    }
    this.stage.draw(bed, { width: this.width, rail: this.rail, depth: this.depth, pitch: this.pitch, keys: this.keys, contactPixels: this.contactPixels }, lights);
    // Carry the light across the join of the roll and the keycaps.
    const overlap = 0.043 * this.pitch;
    bed.save();
    bed.globalCompositeOperation = 'screen';
    bed.fillStyle = contactLight;
    bed.fillRect(0, this.rail - overlap, this.width, 2 * overlap);
    bed.restore();
  }

  /** Time controls distance down the roll. Tilt moves the lane but does not scale a note's own width. */
  private projectRoll(lane: number, seconds: number, noteOffset = 0): Projected {
    const y = this.rail - seconds * this.nearSpeed;
    const lean = this.tilt < 0 ? this.tilt * SIDE_SPREAD / this.rail : this.tilt / this.convergenceDistance;
    const scale = 1 + (y - this.rail) * lean;
    return { x: this.convergenceX + (lane - this.convergenceX) * scale + noteOffset, y, scale };
  }

  private makeSky(): DrawingSurface {
    const surface = this.makeCanvas();
    surface.width = this.width;
    surface.height = this.rail;
    const g = drawingContext(surface);
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
      sprite = this.makeCanvas();
      sprite.width = sprite.height = 64;
      const g = drawingContext(sprite);
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
    const g = this.linesContext ?? this.ctx;
    for (const grain of this.grains) {
      let seconds = (grain.when - this.time) % GRAIN_CYCLE;
      if (seconds < 0) seconds += GRAIN_CYCLE;
      if (seconds > this.visibleAhead) continue;
      const at = this.projectRoll(grain.u * this.width, seconds);
      const radius = (1 + grain.v ** 3 * 3.1) * at.scale;
      g.globalAlpha = 0.1 + 0.29 * grain.v ** 2;
      g.drawImage(this.grainAtlas, at.x - radius, at.y - radius, 2 * radius, 2 * radius);
    }
    g.globalAlpha = 1;
  }

  /** The octave lines running up from the keys, and a line across the roll at every measure start. */
  private guides(): void {
    const layers = this.layers;
    const g = this.linesContext ?? this.ctx;
    // Rows of the surface the lines are drawn on, per unit of the scene. A line stands on whole rows, so every frame draws it the same way.
    const rows = layers ? layers.lines.height / this.rail : this.sheet.height / this.rollEnd;
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
    const start = lowerBound(this.bars.length, (index) => this.bars[index] < this.time);
    for (let index = start; index < this.bars.length; index++) {
      const seconds = this.bars[index] - this.time;
      if (seconds >= this.visibleAhead) break;
      const left = this.projectRoll(0, seconds);
      const right = this.projectRoll(this.width, seconds);
      const top = Math.round(left.y * rows) / rows;
      const thick = Math.max(1, Math.round((0.92 / this.unit) * left.scale * rows)) / rows;
      g.fillStyle = rgba(this.palette.barLine, 0.3 + (0.12 * left.y) / this.rail);
      g.fillRect(left.x, top, right.x - left.x, thick);
      g.fillStyle = rgba(this.palette.mark, 0.53);
      const end = (5 * left.scale) / this.unit;
      for (const x of [left.x, right.x - end]) g.fillRect(x, top, end, thick);
    }
  }

  /** One note on its own: its halo and its slab. The frame paints all halos first, from one field (see `drawHalo`). */
  private ribbon(note: SceneNote, age: number, key: SceneKey): void {
    const shape = this.ribbonShape(note, age, key);
    if (!shape) return;
    this.drawHalo([shape]);
    this.paintRibbon(shape);
  }

  /** The outline of a note's slab at this moment, or nothing when it is not on the screen. `span` is the seconds ahead that are shown and `project` puts a lane and a time on the surface: the screen by default, a baked band of the glow otherwise. */
  private ribbonShape(note: SceneNote, age: number, key: SceneKey, span = this.visibleAhead,
    project: (lane: number, seconds: number, offset?: number) => Projected = (lane, seconds, offset) => this.projectRoll(lane, seconds, offset)): RibbonShape | undefined {
    const ramp = this.ramps[note.voice] ?? this.ramps[0];
    const center = key.x;
    const half = key.width * RIBBON_WIDTH_OF_KEY / 2;
    const width = 2 * half;
    const trim = Math.min((width * RIBBON_GAP_OF_WIDTH + RIBBON_RIM_WIDTH) / this.nearSpeed,
      note.duration * RIBBON_MAX_TRIM);
    // Shorten the painted tail while the leading edge reaches the key at the note's onset.
    const duration = note.duration - trim;
    const start = -age;
    const end = duration - age;
    if (duration <= 0 || start > span || end <= 0) return undefined;
    const front = Math.max(start, -RIBBON_HEAD_CLIP);
    const back = Math.min(end, span + RIBBON_TAIL_CLIP);
    const head = project(center, front);
    const tail = project(center, back);
    const height = head.y - tail.y;
    const skew = (head.x - tail.x) / height;
    const extent = half + Math.max(RIBBON_RIM_WIDTH / 2, RIBBON_HALO_REACH * this.ribbonUnit);
    if (Math.max(head.x, tail.x) + extent < 0 || Math.min(head.x, tail.x) - extent > this.width) return undefined;
    const roundRadius = Math.min(half * 0.31, 1.6);
    const roundTime = Math.min(roundRadius / this.nearSpeed, duration * 0.49);
    const radius = roundTime * this.nearSpeed;
    const corners: [number, number, number, number][] = [[1, front, 1, Math.PI / 2], [-1, front, 1, Math.PI], [-1, back, -1, (3 * Math.PI) / 2], [1, back, -1, 2 * Math.PI]];
    const outline = new Path2D();
    let first = true;
    for (const [side, time, direction, last] of corners) {
      const cut = direction > 0 ? front !== start : back !== end;
      const begin = (point: Projected) => {
        if (first) outline.moveTo(point.x, point.y);
        else outline.lineTo(point.x, point.y);
        first = false;
      };
      const corner = project(center, time, side * half);
      if (cut) {
        begin(corner);
        continue;
      }
      const point = (theta: number) => project(center,
        time + direction * roundTime - roundTime * Math.sin(theta),
        side * (half - radius) + radius * Math.cos(theta));
      begin(point(last - Math.PI / 2));
      const finish = point(last);
      outline.quadraticCurveTo(corner.x, corner.y, finish.x, finish.y);
    }
    outline.closePath();
    return { note, age, ramp, outline, head, tail, width, half, height, skew };
  }

  /** The width of a white-key ribbon: the length the halo is measured in. */
  private get ribbonUnit(): number {
    return this.pitch * RIBBON_WIDTH_OF_KEY;
  }

  /**
   * The halo of every ribbon of the frame, in one layer under them: at each point the strength follows the distance to the
   * nearest ribbon (`haloStrength`), in the colour of that ribbon. So it is the same beside every ribbon, whatever its size,
   * glows never add up and never hide each other where ribbons are close, and nothing in it has an edge. The distance is
   * found on a coarse grid (a chamfer transform of the ribbons' silhouettes) and the layer is drawn smoothed.
   */
  private drawHalo(shapes: RibbonShape[]): void {
    if (!shapes.length || !this.ramps.length) return;
    const unit = this.ribbonUnit;
    const cell = Math.max(RIBBON_HALO_NEAR.decay * unit / RIBBON_HALO_CELLS_PER_DECAY, Math.sqrt(this.width * this.rail / RIBBON_HALO_CELL_BUDGET));
    const columns = Math.max(1, Math.ceil(this.width / cell));
    const rows = Math.max(1, Math.ceil(this.rail / cell));
    let field = this.haloField;
    if (!field || field.columns !== columns || field.rows !== rows) {
      const mask = this.makeCanvas();
      const glow = this.makeCanvas();
      mask.width = glow.width = columns;
      mask.height = glow.height = rows;
      const maskContext = drawingContext(mask);
      const glowContext = drawingContext(glow);
      if (!maskContext || !glowContext) return;
      field = { columns, rows, mask, glow, maskContext, glowContext,
        distance: new Float32Array(columns * rows), voice: new Uint8Array(columns * rows),
        otherDistance: new Float32Array(columns * rows), otherVoice: new Uint8Array(columns * rows) };
      this.haloField = field;
    }
    const { maskContext, glowContext, distance, voice, otherDistance, otherVoice } = field;
    // Only the part of the roll the ribbons and their halos reach is worked on.
    const reach = RIBBON_HALO_REACH * unit;
    let left = Infinity;
    let right = -Infinity;
    let top = Infinity;
    let bottom = -Infinity;
    for (const { head, tail, half } of shapes) {
      left = Math.min(left, head.x - half, tail.x - half);
      right = Math.max(right, head.x + half, tail.x + half);
      top = Math.min(top, tail.y);
      bottom = Math.max(bottom, head.y);
    }
    const firstColumn = clamp(Math.floor((left - reach) / this.width * columns), 0, columns - 1);
    const lastColumn = clamp(Math.ceil((right + reach) / this.width * columns), 0, columns - 1);
    const firstRow = clamp(Math.floor((top - reach) / this.rail * rows), 0, rows - 1);
    const lastRow = clamp(Math.ceil((bottom + reach) / this.rail * rows), 0, rows - 1);
    const boxColumns = lastColumn - firstColumn + 1;
    const boxRows = lastRow - firstRow + 1;
    // The silhouettes, each in a flat colour that names its voice (spaced so that anti-aliased edges still read back).
    const voices = this.ramps.length;
    const step = Math.max(1, Math.floor(255 / (voices + 1)));
    maskContext.setTransform(1, 0, 0, 1, 0, 0);
    maskContext.clearRect(firstColumn, firstRow, boxColumns, boxRows);
    maskContext.setTransform(columns / this.width, 0, 0, rows / this.rail, 0, 0);
    for (const shape of shapes) {
      maskContext.fillStyle = `rgb(${step * (Math.min(shape.note.voice, voices - 1) + 1)},0,0)`;
      maskContext.fill(shape.outline);
    }
    const pixels = maskContext.getImageData(firstColumn, firstRow, boxColumns, boxRows).data;
    // Distance to the nearest silhouette, in white-key ribbon widths, with the voice of that silhouette.
    const across = (this.width / columns) / unit;
    const along = (this.rail / rows) / unit;
    const diagonal = Math.hypot(across, along);
    const cellLength = Math.min(across, along);
    const at = (row: number, column: number) => (row - firstRow) * boxColumns + (column - firstColumn);
    const coverage = (box: number) => pixels[box * 4 + 3] / 255;
    // A cell the silhouette touches is a source. Its distance is the signed distance from its centre to the edge, read from how much
    // of it is covered, so that the halo does not depend on where an edge falls in the grid; a faintly covered cell takes the voice
    // of the best covered cell next to it (its own colour no longer reads back).
    for (let box = 0; box < boxColumns * boxRows; box++) {
      const covered = coverage(box);
      const solid = covered >= RIBBON_HALO_SOURCE_COVERAGE;
      const index = (firstRow + Math.floor(box / boxColumns)) * columns + firstColumn + box % boxColumns;
      distance[index] = solid ? (0.5 - covered) * cellLength : Infinity;
      voice[index] = solid ? Math.round(pixels[box * 4] / step) : 0;
      otherDistance[index] = Infinity;
      otherVoice[index] = 0;
    }
    for (let row = firstRow; row <= lastRow; row++) {
      for (let column = firstColumn; column <= lastColumn; column++) {
        const box = at(row, column);
        const covered = coverage(box);
        if (covered <= 0 || covered >= RIBBON_HALO_SOURCE_COVERAGE) continue;
        let best = 0;
        let bestVoice = 0;
        for (let nextRow = Math.max(firstRow, row - 1); nextRow <= Math.min(lastRow, row + 1); nextRow++) {
          for (let nextColumn = Math.max(firstColumn, column - 1); nextColumn <= Math.min(lastColumn, column + 1); nextColumn++) {
            const next = at(nextRow, nextColumn);
            if (coverage(next) >= RIBBON_HALO_SOURCE_COVERAGE && coverage(next) > best) {
              best = coverage(next);
              bestVoice = Math.round(pixels[next * 4] / step);
            }
          }
        }
        if (best > 0) {
          distance[row * columns + column] = (0.5 - covered) * cellLength;
          voice[row * columns + column] = bestVoice;
        }
      }
    }
    // Each cell keeps its nearest voice and the nearest voice that differs from it.
    const offer = (index: number, candidate: number, candidateVoice: number) => {
      if (!candidateVoice) return;
      if (candidateVoice === voice[index]) {
        if (candidate < distance[index]) distance[index] = candidate;
      } else if (candidate < distance[index]) {
        otherDistance[index] = distance[index];
        otherVoice[index] = voice[index];
        distance[index] = candidate;
        voice[index] = candidateVoice;
      } else if (candidateVoice === otherVoice[index]) {
        if (candidate < otherDistance[index]) otherDistance[index] = candidate;
      } else if (candidate < otherDistance[index]) {
        otherDistance[index] = candidate;
        otherVoice[index] = candidateVoice;
      }
    };
    const relax = (index: number, from: number, cost: number) => {
      offer(index, distance[from] + cost, voice[from]);
      offer(index, otherDistance[from] + cost, otherVoice[from]);
    };
    for (let row = firstRow; row <= lastRow; row++) {
      for (let column = firstColumn; column <= lastColumn; column++) {
        const index = row * columns + column;
        if (column > firstColumn) relax(index, index - 1, across);
        if (row > firstRow) {
          relax(index, index - columns, along);
          if (column > firstColumn) relax(index, index - columns - 1, diagonal);
          if (column < lastColumn) relax(index, index - columns + 1, diagonal);
        }
      }
    }
    for (let row = lastRow; row >= firstRow; row--) {
      for (let column = lastColumn; column >= firstColumn; column--) {
        const index = row * columns + column;
        if (column < lastColumn) relax(index, index + 1, across);
        if (row < lastRow) {
          relax(index, index + columns, along);
          if (column < lastColumn) relax(index, index + columns + 1, diagonal);
          if (column > firstColumn) relax(index, index + columns - 1, diagonal);
        }
      }
    }
    const strengths = this.haloStrengths;
    const levels = strengths.length - 1;
    const image = glowContext.createImageData(boxColumns, boxRows);
    const data = image.data;
    for (let row = firstRow; row <= lastRow; row++) {
      for (let column = firstColumn; column <= lastColumn; column++) {
        const index = row * columns + column;
        const away = distance[index] / RIBBON_HALO_REACH;
        if (away >= 1 || !voice[index]) continue;
        // Under the ribbon the light is full, as the backing the face lets show through.
        const strength = away <= 0 ? 1 : strengths[Math.round(away * levels)];
        if (strength <= 0) continue;
        const ink = (this.ribbonColors[voice[index] - 1] ?? this.ribbonColors[0]).ink;
        // Where another voice's ribbon is about as near, its colour comes in: half and half at equal distance, none a blend width on.
        const other = otherVoice[index];
        const share = other ? 0.5 * (1 - smoothStep(0, 1, (otherDistance[index] - distance[index]) / (RIBBON_HALO_BLEND * RIBBON_HALO_NEAR.decay * unit))) : 0;
        const otherInk = (this.ribbonColors[other - 1] ?? this.ribbonColors[0]).ink;
        const offset = at(row, column) * 4;
        data[offset] = ink[0] + (otherInk[0] - ink[0]) * share;
        data[offset + 1] = ink[1] + (otherInk[1] - ink[1]) * share;
        data[offset + 2] = ink[2] + (otherInk[2] - ink[2]) * share;
        data[offset + 3] = Math.round(255 * strength);
      }
    }
    glowContext.clearRect(0, 0, columns, rows);
    glowContext.putImageData(image, firstColumn, firstRow);
    const g = this.ctx;
    g.save();
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = 'high';
    g.drawImage(field.glow, firstColumn, firstRow, boxColumns, boxRows,
      firstColumn * this.width / columns, firstRow * this.rail / rows, boxColumns * this.width / columns, boxRows * this.rail / rows);
    g.restore();
  }

  /** The baked glow of the roll: made on first use, dropped whenever what it was made from changes (the notes, the colours, the size, the tilt). */
  private haloStrip(): HaloStrip | undefined {
    if (this.halo) return this.halo;
    const unit = this.ribbonUnit;
    const cell = Math.max(RIBBON_HALO_NEAR.decay * unit / RIBBON_HALO_CELLS_PER_DECAY, Math.sqrt(this.width * this.rail / RIBBON_HALO_STRIP_CELL_BUDGET));
    const columns = Math.max(1, Math.ceil(this.width / cell));
    const screenRows = Math.ceil(this.rail / cell) + 3;
    const apron = Math.ceil((RIBBON_HALO_REACH + RIBBON_HALO_BLEND * RIBBON_HALO_NEAR.decay) * unit / cell) + 2;
    const capacity = HALO_STRIP_SCREENS * screenRows;
    const sheet = (rows: number, options?: CanvasRenderingContext2DSettings) => {
      const surface = this.makeCanvas();
      surface.width = columns;
      surface.height = rows;
      return { surface, context: drawingContext(surface, options) };
    };
    const strip = sheet(capacity);
    const spare = sheet(capacity);
    const bandRows = HALO_STRIP_SLICE_ROWS + 2 * apron;
    // The mask is read back on every slice: a canvas kept in memory reads fast and does not depend on a graphics card.
    const mask = sheet(bandRows, { willReadFrequently: true });
    if (!strip.context || !spare.context || !mask.context) return undefined;
    this.halo = {
      cell, columns, apron, capacity, rowSeconds: cell / this.nearSpeed,
      behind: Math.ceil(screenRows / 8), ahead: Math.ceil(screenRows / 2),
      baseTop: 0, validLo: 0, validHi: 0,
      canvas: strip.surface, context: strip.context, spare: spare.surface, spareContext: spare.context,
      mask: mask.surface, maskContext: mask.context,
      distance: new Float32Array(columns * bandRows), voice: new Uint8Array(columns * bandRows),
      otherDistance: new Float32Array(columns * bandRows), otherVoice: new Uint8Array(columns * bandRows),
      slices: 0,
    };
    return this.halo;
  }

  /**
   * Bakes the rows [wantLo, wantHi) of the strip, working outwards from what is baked, for at most `budget` milliseconds. A stretch that lies
   * apart from what is baked (a seek) starts the strip again there. Returns whether the wanted rows are all baked.
   */
  private bakeHalo(strip: HaloStrip, wantLo: number, wantHi: number, budget: number): boolean {
    if (wantHi > strip.baseTop || wantLo < strip.baseTop - strip.capacity) {
      // The canvas moves to hold the wanted rows with room above them; what is baked and still held is carried over.
      const baseTop = Math.min(wantHi + Math.floor(strip.capacity / 4), wantLo + strip.capacity);
      const kept = strip.validHi > strip.validLo ? { lo: Math.max(strip.validLo, baseTop - strip.capacity), hi: Math.min(strip.validHi, baseTop) } : undefined;
      if (kept && kept.hi > kept.lo) {
        strip.spareContext.clearRect(0, 0, strip.columns, strip.capacity);
        strip.spareContext.drawImage(strip.canvas, 0, baseTop - strip.baseTop);
        [strip.canvas, strip.spare] = [strip.spare, strip.canvas];
        [strip.context, strip.spareContext] = [strip.spareContext, strip.context];
        strip.validLo = kept.lo;
        strip.validHi = kept.hi;
      } else {
        strip.validLo = strip.validHi = 0;
      }
      strip.baseTop = baseTop;
    }
    if (strip.validHi <= strip.validLo || wantLo >= strip.validHi || wantHi <= strip.validLo) strip.validLo = strip.validHi = wantLo;
    const started = performance.now();
    // A bake ahead (a limited budget) takes only whole slices: a slice of a row or two costs as much as a full one for its apron.
    const whole = budget === Infinity ? 1 : HALO_STRIP_SLICE_ROWS;
    while (strip.validHi < wantHi && (budget === Infinity || performance.now() - started < budget)) {
      const to = Math.min(strip.validHi + HALO_STRIP_SLICE_ROWS, wantHi);
      if (to - strip.validHi < whole) break;
      this.bakeHaloSlice(strip, strip.validHi, to);
      strip.validHi = to;
    }
    while (strip.validLo > wantLo && (budget === Infinity || performance.now() - started < budget)) {
      const from = Math.max(strip.validLo - HALO_STRIP_SLICE_ROWS, wantLo);
      if (strip.validLo - from < whole) break;
      this.bakeHaloSlice(strip, from, strip.validLo);
      strip.validLo = from;
    }
    return strip.validLo <= wantLo && strip.validHi >= wantHi;
  }

  /**
   * The glow of the rows [from, to): the same field as the per-frame one (the distance to the nearest ribbon and the voice of it, by a chamfer
   * pass over the silhouettes), taken over the slice and an apron of its reach on both sides, so that the slice is what the whole grid would give.
   */
  private bakeHaloSlice(strip: HaloStrip, from: number, to: number): void {
    const { cell, columns, apron, maskContext, distance, voice, otherDistance, otherVoice } = strip;
    const unit = this.ribbonUnit;
    const rows = to - from + 2 * apron;
    const bottomTime = (from - apron) * strip.rowSeconds;
    const topTime = (to + apron) * strip.rowSeconds;
    const bandHeight = rows * cell;
    const project = (lane: number, seconds: number, offset = 0): Projected => ({ x: lane + offset, y: bandHeight - seconds * this.nearSpeed, scale: 1 });
    const end = lowerBound(this.notes.length, index => this.notes[index].start <= topTime);
    const begin = lowerBound(end, index => this.latestExpiry[index] < bottomTime);
    const shapes: RibbonShape[] = [];
    for (let index = begin; index < end; index++) {
      const note = this.notes[index];
      const key = this.byMidi.get(note.pitch);
      const shape = key && this.ribbonShape(note, bottomTime - note.start, key, topTime - bottomTime, project);
      if (shape) shapes.push(shape);
    }
    strip.slices++;
    const top = strip.baseTop - to;
    if (!shapes.length) {
      strip.context.clearRect(0, top, columns, to - from);
      return;
    }
    const reach = RIBBON_HALO_REACH * unit;
    let left = Infinity;
    let right = -Infinity;
    for (const { head, tail, half } of shapes) {
      left = Math.min(left, head.x - half, tail.x - half);
      right = Math.max(right, head.x + half, tail.x + half);
    }
    const firstColumn = clamp(Math.floor((left - reach) / cell), 0, columns - 1);
    const lastColumn = clamp(Math.ceil((right + reach) / cell), 0, columns - 1);
    const boxColumns = lastColumn - firstColumn + 1;
    const voices = this.ramps.length;
    const step = Math.max(1, Math.floor(255 / (voices + 1)));
    maskContext.setTransform(1, 0, 0, 1, 0, 0);
    maskContext.clearRect(0, 0, columns, rows);
    maskContext.setTransform(1 / cell, 0, 0, 1 / cell, 0, 0);
    for (const shape of shapes) {
      maskContext.fillStyle = `rgb(${step * (Math.min(shape.note.voice, voices - 1) + 1)},0,0)`;
      maskContext.fill(shape.outline);
    }
    const pixels = maskContext.getImageData(firstColumn, 0, boxColumns, rows).data;
    const across = cell / unit;
    const diagonal = Math.hypot(across, across);
    // A cell the silhouette touches is a source, at the signed distance read from how much of it is covered; a faintly covered cell
    // takes the voice of the best covered cell next to it.
    for (let row = 0; row < rows; row++) {
      for (let column = 0; column < boxColumns; column++) {
        const box = row * boxColumns + column;
        const index = row * columns + firstColumn + column;
        const covered = pixels[box * 4 + 3] / 255;
        const solid = covered >= RIBBON_HALO_SOURCE_COVERAGE;
        distance[index] = solid ? (0.5 - covered) * across : Infinity;
        voice[index] = solid ? Math.round(pixels[box * 4] / step) : 0;
        otherDistance[index] = Infinity;
        otherVoice[index] = 0;
      }
    }
    for (let row = 0; row < rows; row++) {
      for (let column = 0; column < boxColumns; column++) {
        const covered = pixels[(row * boxColumns + column) * 4 + 3] / 255;
        if (covered <= 0 || covered >= RIBBON_HALO_SOURCE_COVERAGE) continue;
        let best = 0;
        let bestVoice = 0;
        for (let nextRow = Math.max(0, row - 1); nextRow <= Math.min(rows - 1, row + 1); nextRow++) {
          for (let nextColumn = Math.max(0, column - 1); nextColumn <= Math.min(boxColumns - 1, column + 1); nextColumn++) {
            const next = (nextRow * boxColumns + nextColumn) * 4;
            const nextCovered = pixels[next + 3] / 255;
            if (nextCovered >= RIBBON_HALO_SOURCE_COVERAGE && nextCovered > best) {
              best = nextCovered;
              bestVoice = Math.round(pixels[next] / step);
            }
          }
        }
        if (best > 0) {
          distance[row * columns + firstColumn + column] = (0.5 - covered) * across;
          voice[row * columns + firstColumn + column] = bestVoice;
        }
      }
    }
    const lastRow = rows - 1;
    for (let row = 0; row <= lastRow; row++) {
      for (let column = firstColumn; column <= lastColumn; column++) {
        const index = row * columns + column;
        if (column > firstColumn) {
          offerHalo(distance, voice, otherDistance, otherVoice, index, distance[index - 1] + across, voice[index - 1]);
          offerHalo(distance, voice, otherDistance, otherVoice, index, otherDistance[index - 1] + across, otherVoice[index - 1]);
        }
        if (row > 0) {
          const above = index - columns;
          offerHalo(distance, voice, otherDistance, otherVoice, index, distance[above] + across, voice[above]);
          offerHalo(distance, voice, otherDistance, otherVoice, index, otherDistance[above] + across, otherVoice[above]);
          if (column > firstColumn) {
            offerHalo(distance, voice, otherDistance, otherVoice, index, distance[above - 1] + diagonal, voice[above - 1]);
            offerHalo(distance, voice, otherDistance, otherVoice, index, otherDistance[above - 1] + diagonal, otherVoice[above - 1]);
          }
          if (column < lastColumn) {
            offerHalo(distance, voice, otherDistance, otherVoice, index, distance[above + 1] + diagonal, voice[above + 1]);
            offerHalo(distance, voice, otherDistance, otherVoice, index, otherDistance[above + 1] + diagonal, otherVoice[above + 1]);
          }
        }
      }
    }
    for (let row = lastRow; row >= 0; row--) {
      for (let column = lastColumn; column >= firstColumn; column--) {
        const index = row * columns + column;
        if (column < lastColumn) {
          offerHalo(distance, voice, otherDistance, otherVoice, index, distance[index + 1] + across, voice[index + 1]);
          offerHalo(distance, voice, otherDistance, otherVoice, index, otherDistance[index + 1] + across, otherVoice[index + 1]);
        }
        if (row < lastRow) {
          const below = index + columns;
          offerHalo(distance, voice, otherDistance, otherVoice, index, distance[below] + across, voice[below]);
          offerHalo(distance, voice, otherDistance, otherVoice, index, otherDistance[below] + across, otherVoice[below]);
          if (column < lastColumn) {
            offerHalo(distance, voice, otherDistance, otherVoice, index, distance[below + 1] + diagonal, voice[below + 1]);
            offerHalo(distance, voice, otherDistance, otherVoice, index, otherDistance[below + 1] + diagonal, otherVoice[below + 1]);
          }
          if (column > firstColumn) {
            offerHalo(distance, voice, otherDistance, otherVoice, index, distance[below - 1] + diagonal, voice[below - 1]);
            offerHalo(distance, voice, otherDistance, otherVoice, index, otherDistance[below - 1] + diagonal, otherVoice[below - 1]);
          }
        }
      }
    }
    // Only the rows of the slice are kept; the apron rows were there for their distances.
    const strengths = this.haloStrengths;
    const levels = strengths.length - 1;
    const image = new ImageData(columns, to - from);
    const data = image.data;
    const blendSpan = RIBBON_HALO_BLEND * RIBBON_HALO_NEAR.decay * unit;
    for (let row = apron; row < apron + to - from; row++) {
      for (let column = firstColumn; column <= lastColumn; column++) {
        const index = row * columns + column;
        const away = distance[index] / RIBBON_HALO_REACH;
        if (away >= 1 || !voice[index]) continue;
        const strength = away <= 0 ? 1 : strengths[Math.round(away * levels)];
        if (strength <= 0) continue;
        const ink = (this.ribbonColors[voice[index] - 1] ?? this.ribbonColors[0]).ink;
        const other = otherVoice[index];
        const share = other ? 0.5 * (1 - smoothStep(0, 1, (otherDistance[index] - distance[index]) / blendSpan)) : 0;
        const otherInk = (this.ribbonColors[other - 1] ?? this.ribbonColors[0]).ink;
        const offset = ((row - apron) * columns + column) * 4;
        data[offset] = ink[0] + (otherInk[0] - ink[0]) * share;
        data[offset + 1] = ink[1] + (otherInk[1] - ink[1]) * share;
        data[offset + 2] = ink[2] + (otherInk[2] - ink[2]) * share;
        data[offset + 3] = Math.round(255 * strength);
      }
    }
    strip.context.putImageData(image, 0, top);
  }

  /** Draws the baked glow for the rows the roll shows at `timeSeconds`, shifted by how far time has moved; then bakes a little ahead. */
  private drawHaloStrip(timeSeconds: number): void {
    const strip = this.haloStrip();
    if (!strip) return;
    const first = Math.floor(timeSeconds / strip.rowSeconds) - 1;
    const rows = Math.ceil(this.rail / strip.cell) + 3;
    this.bakeHalo(strip, first, first + rows, Infinity);
    const g = this.ctx;
    g.save();
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = 'high';
    g.drawImage(strip.canvas, 0, strip.baseTop - (first + rows), strip.columns, rows,
      0, this.rail - ((first + rows) * strip.rowSeconds - timeSeconds) * this.nearSpeed, strip.columns * strip.cell, rows * strip.cell);
    g.restore();
    this.bakeHalo(strip, first - strip.behind, first + rows + strip.ahead, HALO_STRIP_BUDGET_MS);
  }

  /** `haloStrength` over the reach, tabulated once. */
  private readonly haloStrengths = Float32Array.from({ length: 257 }, (_, level) => haloStrength(level / 256 * RIBBON_HALO_REACH));

  /** The slab of a note in its voice's gradient, with the bright strip along it, hot where it meets the keys. */
  private paintRibbon(shape: RibbonShape): void {
    const { note, age, ramp, outline, head, tail, width, half, height, skew } = shape;
    const g = this.ctx;
    const paint = this.ribbonColors[note.voice] ?? this.ribbonColors[0];
    // A bright strip along the slab, under the face, which lets as much of it show as its alpha leaves.
    const key = `${note.voice}:${half}`;
    let strip = this.coreGradients.get(key);
    if (!strip) {
      strip = g.createLinearGradient(-half, 0, half, 0);
      for (let stop = 0; stop < RIBBON_CORE_STOPS; stop++) {
        const along = stop / (RIBBON_CORE_STOPS - 1);
        const glint = Math.exp(-0.5 * ((along - 0.5 - RIBBON_CORE_CENTER) / RIBBON_CORE_SPREAD) ** 2);
        strip.addColorStop(along, rgba(paint.core, glint));
      }
      this.coreGradients.set(key, strip);
    }
    g.save();
    g.clip(outline);
    g.transform(1, 0, skew, 1, tail.x, tail.y);
    g.fillStyle = strip;
    g.fillRect(-half - RIBBON_RIM_WIDTH, -RIBBON_RIM_WIDTH, width + 2 * RIBBON_RIM_WIDTH, height + 2 * RIBBON_RIM_WIDTH);
    g.restore();
    // Every note in a voice takes its colour from the same depth gradient.
    const face = this.ribbonFaces[note.voice] ?? this.ribbonFaces[0];
    g.fillStyle = face;
    g.fill(outline);
    g.strokeStyle = face;
    g.lineWidth = RIBBON_RIM_WIDTH;
    g.stroke(outline);
    // Where the slab reaches the keys it burns white; the same emission runs through the outline, so there is no second frame at the cut.
    const gap = Math.max(0, this.rail - head.y);
    const power = 0.58 * (age >= 0 ? 1 : Math.max(0, 1 - gap / (width * 0.65)) ** 1.5);
    if (power > 0.003) {
      const anchor = Math.min(head.y, this.rail);
      const band = Math.max(width * 2.05, this.pitch * 1.42);
      const contactColor = this.palette.burn[2].map((channel, index) => (channel + ramp.near[index]) / 2);
      const hot = gradient(g, anchor - band, anchor, [
        [0, rgba(ramp.near, 0)], [0.17, rgba(ramp.near, power * 0.13)], [0.37, rgba(this.palette.burn[0], power * 0.92)], [0.48, rgba(this.palette.burn[1], power)], [1, rgba(contactColor, power)],
      ]);
      g.save();
      g.clip(outline);
      g.fillStyle = hot;
      g.fillRect(Math.min(head.x, tail.x) - width, anchor - band, Math.abs(head.x - tail.x) + 2 * width, band + 1);
      g.restore();
      g.strokeStyle = hot;
      g.lineWidth = 1.4;
      g.stroke(outline);
    }
  }

  /** Mix pressed voices and the voices held by the pedal at each location on the lower strip. */
  private buildStripVoiceField(tails: Tail[], pedal: ScenePedal | undefined, pedalLevel: number): void {
    this.stripVoiceField.fill(0);
    this.stripVoiceWeights.fill(0);
    const step = this.width / (UNDER_STOPS - 1);
    const spread = 3.6 * this.pitch;
    const release = pedal !== undefined && this.time >= pedal.up;
    const sampleTime = release ? pedal.up : this.time;
    for (const tail of tails) {
      const age = sampleTime - tail.note.start;
      // On release keep the last sounding colours while the light fades out.
      const remaining = tail.note.sustainDuration - age;
      const sustained = release ? age > 0 && remaining >= -1e-9 : age >= 0 && remaining > 0;
      const strength = Math.max(keyPressAt(tail.note, tail.age), sustained ? pedalLevel : 0);
      if (strength <= 0) continue;
      const first = Math.max(0, Math.ceil((tail.x - 3 * spread) / step));
      const last = Math.min(UNDER_STOPS - 1, Math.floor((tail.x + 3 * spread) / step));
      for (let stop = first; stop <= last; stop++) {
        const distance = (stop * step - tail.x) / spread;
        const weight = strength * tail.note.velocity * Math.exp(-0.5 * distance * distance);
        this.stripVoiceWeights[stop] += weight;
        for (let channel = 0; channel < 3; channel++) {
          this.stripVoiceField[stop * 3 + channel] += weight * tail.rgb[channel];
        }
      }
    }
  }

  /** The pedal changes the indicator width and brightness. Sounding voices colour their regions. */
  private underRail(tails: Tail[], prepared?: WaterfallWindow): void {
    const g = this.keyboard;
    const y = this.stripY;
    const at = lowerBound(prepared?.pedalTo ?? this.pedals.length,
      index => this.pedals[index].down <= this.time, prepared?.pedalFrom ?? 0);
    const pedal = this.pedals[at - 1];
    const level = pedal ? pedalLevelAt(pedal, this.time) : 0;
    this.buildStripVoiceField(tails, pedal, level);
    const profile = g.createLinearGradient(0, 0, this.width, 0);
    for (let stop = 0; stop < UNDER_STOPS; stop++) {
      const u = stop / (UNDER_STOPS - 1);
      const edge = Math.min(1, 0.12 + u * 9, 0.12 + (1 - u) * 9);
      const weight = this.stripVoiceWeights[stop];
      const tint = 1 - Math.exp(-2.9 * weight);
      const brightness = edge * (0.57 + 0.21 * level);
      const voiceBrightness = edge * (0.82 + 0.15 * level);
      const color = this.stripColor.map((base, channel) => {
        const voice = weight ? this.stripVoiceField[stop * 3 + channel] / weight : base;
        const idle = base * brightness;
        const mixed = idle + (voice * voiceBrightness - idle) * tint;
        return Math.min(255, this.palette.stripBase[channel] + mixed);
      });
      profile.addColorStop(u, rgba(color));
    }
    g.save();
    const scale = clamp(this.pitch / REFERENCE_PITCH, 0.72, 1.75);
    const [railTop, railUpper, railLower, railBottom] = this.palette.rail;
    g.fillStyle = gradient(g, y - 5 * scale, y + 5 * scale, [[0, railTop], [0.3, railUpper], [0.53, railLower], [0.95, railBottom], [1, railBottom]]);
    g.fillRect(0, y - 5 * scale, this.width, this.height - y + 5 * scale);
    g.fillStyle = profile;
    const core = scale * (0.94 + 1.15 * level);
    g.fillRect(0, y - core / 2, this.width, core);
    g.restore();
  }

  /** Paint a horizontal slice of light, bounded to the region reached by the source. */
  private addLightRow(field: Float32Array, row: number, x: number, spread: number, energy: number, rgb: Rgb): void {
    const step = this.width / (CONTACT_LIGHT_STOPS - 1);
    const radius = Math.min(LIGHT_REACH * this.pitch, 3.4 * spread);
    const first = Math.max(0, Math.ceil((x - radius) / step));
    const last = Math.min(CONTACT_LIGHT_STOPS - 1, Math.floor((x + radius) / step));
    for (let stop = first; stop <= last; stop++) {
      const distance = (stop * step - x) / spread;
      const strength = energy * Math.exp(-0.5 * distance * distance) / 255;
      const sample = row * CONTACT_LIGHT_STOPS + stop;
      const offset = sample * 3;
      if (field !== this.contactField) {
        for (let channel = 0; channel < 3; channel++) field[offset + channel] += strength * rgb[channel];
        continue;
      }

      // Blend across the source's centre so interpolation between texels has no hard seam.
      const fromLeft = clamp(0.5 + (stop * step - x) / (0.5 * this.pitch), 0, 1);
      this.accumulateContact(sample, strength * fromLeft, x, rgb);
      this.accumulateContact(sample + CONTACT_SIDE_SAMPLES, strength * (1 - fromLeft), x, rgb);
    }
  }

  private accumulateContact(sample: number, strength: number, x: number, rgb: Rgb): void {
    this.contactMoment[sample] += strength * x;
    this.contactWeight[sample] += strength;
    for (let channel = 0; channel < 3; channel++) {
      this.contactField[sample * 3 + channel] += strength * rgb[channel];
    }
  }

  /** The strike lights the ridge until the key returns to its resting pose. */
  private buildRidgeField(keys: Emitter[]): void {
    this.ridgeField.fill(0);
    this.ridgeFlashField.fill(0);
    this.ridgeRippleField.fill(0);
    const step = this.width / (CONTACT_LIGHT_STOPS - 1);
    for (const { age, light, onset, press, x, rgb, note } of keys) {
      if (press <= 0) continue;
      const power = press * (0.53 * light + 0.78 * onset);
      const spread = this.pitch * (1.12 + 0.72 * (1 - Math.exp(-age / 0.17)));
      this.addLightRow(this.ridgeField, 0, x, spread, power, rgb);
      if (onset > 0.015) {
        const core = this.pitch * (0.56 + 0.20 * press);
        this.addLightRow(this.ridgeFlashField, 0, x, core, 2.2 * press * onset, rgb);
      }
      const life = clamp(1 - age / .34, 0, 1);
      if (life > 0) {
        const travel = 8 * age;
        const reach = this.pitch * (travel + 1.25);
        const first = Math.max(0, Math.ceil((x - reach) / step));
        const last = Math.min(CONTACT_LIGHT_STOPS - 1, Math.floor((x + reach) / step));
        const energy = note.velocity * press * life * life * (1 - Math.exp(-age / .014));
        for (let stop = first; stop <= last; stop++) {
          const front = Math.abs(stop * step - x) / this.pitch - travel;
          const crest = Math.exp(-.5 * (front / .36) ** 2);
          const trough = Math.exp(-.5 * ((front + .48) / .54) ** 2);
          this.ridgeRippleField[stop] += energy * (crest - .52 * trough);
        }
      }
    }

    // One texture row carries strip reflections. Only the continuous neutral
    // strip contributes after a key has returned to rest.
    for (let stop = 0; stop < CONTACT_LIGHT_STOPS; stop++) {
      const index = stop * 3;
      const target = (2 * CONTACT_SIDE_SAMPLES + stop) * 4;
      const peak = Math.max(this.ridgeField[index], this.ridgeField[index + 1], this.ridgeField[index + 2]);
      const strike = Math.max(this.ridgeFlashField[index], this.ridgeFlashField[index + 1], this.ridgeFlashField[index + 2]);
      for (let channel = 0; channel < 3; channel++) {
        const idle = 0.12 * this.palette.crestIdle[channel];
        const colored = 106 * this.ridgeField[index + channel] / (1 + peak);
        this.contactPixels[target + channel] = Math.round(idle + colored);
      }
      this.contactPixels[target + 3] = Math.round(255 * (1 - Math.exp(-2.4 * strike)));
    }
  }

  /** Direct light from physically pressed keys, including the soft falloff past a black key's nose. */
  private buildContactField(keys: Emitter[]): void {
    this.contactField.fill(0);
    this.contactMoment.fill(0);
    this.contactWeight.fill(0);
    for (const key of keys) {
      if (key.press <= 0) continue;
      const power = key.press * (.96 * key.light + 1.03 * key.onset);
      const ageSpread = 0.72 * (1 - Math.exp(-key.age / 0.17));
      const footprint = 0.76 + 0.24 * Math.sqrt(key.press);
      const black = this.byMidi.get(key.note.pitch)?.black;
      for (let row = 0; row < CONTACT_LIGHT_ROWS; row++) {
        const depth = row / (CONTACT_LIGHT_ROWS - 1);
        const fade = black ? clamp((depth - 0.72) / 0.28, 0, 1) : 0;
        const reach = 1 - fade * fade * (3 - 2 * fade);
        if (reach === 0) continue;
        const spread = this.pitch * (1.30 + ageSpread + 0.92 * depth) * footprint;
        // The broad reflection softens towards the front more slowly than the rail's specular flash.
        const absorption = black ? 0.25 : 0.36;
        const diffuse = (0.86 + 0.38 * depth) * Math.exp(-absorption * depth);
        this.addLightRow(this.contactField, row, key.x, spread, power * reach * diffuse, key.rgb);
      }
    }
    for (let left = 0; left < CONTACT_SIDE_SAMPLES; left++) {
      const right = left + CONTACT_SIDE_SAMPLES;
      let peak = 0;
      for (let channel = 0; channel < 3; channel++) {
        peak = Math.max(peak, this.contactField[left * 3 + channel] + this.contactField[right * 3 + channel]);
      }
      const exposure = 255 / (1 + peak);
      this.packContact(left, exposure);
      this.packContact(right, exposure);
    }
  }

  /** A slow wave with a shorter ripple travelling back along it. Both use score time. */
  private railWave(x: number): number {
    return 0.57 * Math.sin(x / (5.8 * this.pitch) - 2.6 * this.time)
      + 0.25 * Math.sin(x / (1.25 * this.pitch) + 4.1 * this.time)
      + 0.19 * Math.sin(x / (0.42 * this.pitch) - 6.3 * this.time);
  }

  private packContact(sample: number, exposure: number): void {
    const target = sample * 4;
    for (let channel = 0; channel < 3; channel++) {
      this.contactPixels[target + channel] = Math.round(this.contactField[sample * 3 + channel] * exposure);
    }
    const weight = this.contactWeight[sample];
    const local = (sample % CONTACT_LIGHT_STOPS) / (CONTACT_LIGHT_STOPS - 1);
    const lightX = weight > 0 ? this.contactMoment[sample] / weight / this.width : local;
    // Directed rows carry the light's horizontal position in the fourth component.
    this.contactPixels[target + 3] = 255 * clamp(lightX, 0, 1);
  }

  /** What a strike leaves: the ridge along the keys, the footprints of the hot spots, the dust in the air. */
  private contact(hits: Hit[], lit: Emitter[]): CanvasGradient {
    const g = this.ctx;
    const scale = clamp(this.pitch / REFERENCE_PITCH, 0.78, 2.75);
    const rail = this.rail;
    const width = this.width;
    g.save();
    g.beginPath();
    g.rect(0, 0, width, rail);
    g.clip();
    g.globalCompositeOperation = 'screen';
    const samples = Math.ceil(width / (1.4 * scale));
    const crest: { x: number; y: number; heat: number; color: Rgb; attack: number }[] = [];
    const surface = this.keyboard;
    const stops = g.createLinearGradient(0, 0, width, 0);
    const seamFill = g.createLinearGradient(0, 0, width, 0);
    const coreStroke = surface.createLinearGradient(0, 0, width, 0);
    for (let sample = 0; sample <= samples; sample++) {
      const x = (sample / samples) * width;
      const at = (sample / samples) * (CONTACT_LIGHT_STOPS - 1);
      const left = Math.floor(at);
      const right = Math.min(CONTACT_LIGHT_STOPS - 1, left + 1);
      const mix = at - left;
      const light: Rgb = [0, 0, 0];
      let flash = 0;
      for (let channel = 0; channel < 3; channel++) {
        const from = left * 3 + channel;
        const to = right * 3 + channel;
        light[channel] = this.ridgeField[from] * (1 - mix) + this.ridgeField[to] * mix;
        flash = Math.max(flash, this.ridgeFlashField[from] * (1 - mix) + this.ridgeFlashField[to] * mix);
      }
      const peak = Math.max(...light);
      const heat = 1 - Math.exp(-peak * 1.65);
      const attack = 1 - Math.exp(-2.4 * flash);
      const ripple = this.ridgeRippleField[left] * (1 - mix) + this.ridgeRippleField[right] * mix;
      const rise = clamp(.56 * heat + 1.24 * attack + .98 * ripple, -.25, 2.15);
      const color = peak > 0.001 ? light.map(value => value * 255 / peak) as Rgb : this.palette.crestIdle;
      crest.push({ x, y: rail - scale * (0.78 + this.railWave(x) + rise), heat, color, attack });
      if (sample % 3 === 0 || sample === samples) {
        const u = sample / samples;
        stops.addColorStop(u, rgba(color, 0.30 + 0.69 * heat));
        const tint = 1 - Math.exp(-4.5 * peak);
        const core = this.palette.crestLine.map((base, channel) => base + (color[channel] - base) * tint);
        coreStroke.addColorStop(u, rgba(core, .69 + .23 * heat));
        const edge = this.palette.crestIdle.map((base, channel) => base + (color[channel] - base) * heat);
        seamFill.addColorStop(u, rgba(edge, 0.50 + 0.22 * heat + 0.23 * attack));
      }
    }
    const path = (context = g) => {
      context.beginPath();
      for (const [index, point] of crest.entries()) {
        if (index === 0) context.moveTo(point.x, point.y);
        else context.lineTo(point.x, point.y);
      }
    };
    // The haze above the ridge follows the ridge itself; it does not paint a white spot onto the keys.
    const rows = 48;
    if (!this.airSurface) this.airSurface = this.makeCanvas();
    if (this.airSurface.width !== AIR_COLUMNS || this.airSurface.height !== rows || !this.airPixels) {
      this.airSurface.width = AIR_COLUMNS;
      this.airSurface.height = rows;
      this.airContext = drawingContext(this.airSurface);
      this.airPixels = this.airContext ? this.airContext.createImageData(AIR_COLUMNS, rows) : null;
    }
    if (this.airContext && this.airPixels) {
      const out = this.airPixels.data;
      const hazeHeight = rows * scale * 1.25;
      for (let column = 0; column < AIR_COLUMNS; column++) {
        const point = crest[Math.round((column / (AIR_COLUMNS - 1)) * samples)];
        const above = (rail - point.y) * rows / hazeHeight;
        const distance = Math.max(0, rows - 1 - above);
        const heatDecay = 1 / (8.5 + 7.5 * point.heat);
        const heatStep = Math.exp(heatDecay);
        let idle = Math.exp(-distance / AIR_IDLE_DECAY);
        let wide = Math.exp(-distance * heatDecay);
        let core = Math.exp(-distance / 2.3);
        const brightness = 0.86 + 0.14 * point.attack;
        const [red, green, blue] = point.color;
        for (let row = 0; row < rows; row++) {
          const index = (row * AIR_COLUMNS + column) * 4;
          const haze = 0.32 * idle + point.heat * (0.59 * wide + 0.16 * core);
          out[index] = red * brightness;
          out[index + 1] = green * brightness;
          out[index + 2] = blue * brightness;
          out[index + 3] = 255 * haze * Math.min(1, row / 4);
          idle = Math.min(1, idle * AIR_IDLE_STEP);
          wide = Math.min(1, wide * heatStep);
          core = Math.min(1, core * AIR_CORE_STEP);
        }
      }
      this.airContext.putImageData(this.airPixels, 0, 0);
      g.drawImage(this.airSurface, 0, rail - hazeHeight, width, hazeHeight);
    }
    g.lineJoin = 'round';
    path();
    g.lineTo(width, rail);
    g.lineTo(0, rail);
    g.closePath();
    g.fillStyle = stops;
    g.fill();
    path();
    g.lineWidth = 2.25 * Math.sqrt(scale);
    g.strokeStyle = stops;
    g.stroke();
    surface.save();
    surface.globalCompositeOperation = 'source-over';
    path(surface);
    surface.lineJoin = 'round';
    surface.lineWidth = Math.max(0.91, Math.sqrt(scale) * 1.2);
    surface.strokeStyle = coreStroke;
    surface.stroke();
    surface.restore();
    // Each strike raises dust above the rail; its light spot lies on the pressed key's own surface (`KeyStage`).
    const root = Math.sqrt(scale);
    for (const light of lit) this.airDust(light, root);
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

    // The key mesh covers this strip wherever a cap reaches the back of the keyboard.
    // Its colour is visible only through the small reliefs between the caps.
    surface.save();
    const cover = 0.10 * this.pitch;
    surface.fillStyle = seamFill;
    surface.fillRect(0, rail, width, 0.58 * cover);
    surface.globalAlpha = 0.48;
    surface.fillRect(0, rail + 0.58 * cover, width, 0.42 * cover);
    surface.restore();
    return seamFill;
  }

  /** The cloud that hangs over a held key: a cached density mask per voice and variant, grown from the strike. */
  private airDust(light: Emitter, scale: number): void {
    const note = light.note;
    const release = Math.max(0, light.age - note.duration);
    if (light.age < 0.018 || release >= 0.28) return;
    const phase = 1 - Math.exp(-light.age / 0.088);
    const tail = 1 - clamp((release - 0.10) / 0.18, 0, 1);
    const power = note.velocity * (1 - Math.exp(-light.age / 0.045)) * Math.exp(-release / 0.16) * tail;
    const variant = (note.seed >>> 0) % 5;
    const key = `${variant}:${note.voice}`;
    let mask = this.densityMasks.get(key);
    if (!mask) {
      const maskWidth = 42;
      const maskHeight = 58;
      mask = this.makeCanvas();
      mask.width = maskWidth;
      mask.height = maskHeight;
      const g = drawingContext(mask);
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
    g.globalAlpha = Math.max(light.press, 0.22 * tail) * Math.min(1, 1.21 * power);
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
