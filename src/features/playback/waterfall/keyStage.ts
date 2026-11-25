import { clamp, hexRgb, rgba, type Rgb } from './waterfallPalette';
import { BLACK_KEY_WIDTH } from './waterfallProportions';

export const CONTACT_LIGHT_STOPS = 105;
export const CONTACT_LIGHT_ROWS = 5;
export const CONTACT_LIGHT_TEXELS_HIGH = 2 * CONTACT_LIGHT_ROWS + 1;

const WHITE_LENGTH = 5;
const BLACK_LENGTH = 2.96;
const BLACK_TOP = 0.56;
const BLACK_FRONT = 0.26;
const BLACK_BACK = 0.5;
const HEIGHT_PER_DEPTH = 0.89;
const WHITE_HALF = 0.482;
const BLACK_HALF = BLACK_KEY_WIDTH / 2;
const WHITE_FRONT = -0.58;
/** The black key's front face reaches as deep as a fully pressed white head sinks in front of it; the white heads hide
 *  the part below their surface until they go down. Any deeper and it would show in the grooves between the heads. */
const BLACK_BED = -0.2;
/** A black key's top reaches almost to its sides: only this narrow dark edge, in pitches, slopes down beside it. */
const BLACK_EDGE = 0.035;
/** The top edge of a black key's front face spans this share of the key's width. */
const BLACK_NOSE_TOP = 0.65;
/** The share of the black front face that shows above the white heads at rest. */
const BLACK_FACE = (BLACK_TOP - BLACK_FRONT) / (BLACK_TOP - BLACK_BED);
/** The groove between a white key's neck and the black key beside it, as wide as the groove between white keys. */
const WHITE_GROOVE = 0.5 - WHITE_HALF;
/** A white key is narrow between the black keys and full width in front of them. */
const NECK_END = BLACK_BACK + BLACK_LENGTH;
const WHITE_TRAVEL = 0.051;
const BLACK_TRAVEL = 0.039;
/** White keys come in four shapes (a notch for a black key on the left, the right, both or none); the black key is the last variant. */
const BLACK_VARIANT = 4;
const PRESS_STEPS = 16;
const SPRITE_PADDING = 0.12;
const SPRITE_SUPERSAMPLE = 2;
const WASH_COLUMNS = 3 * CONTACT_LIGHT_STOPS;
const WASH_DEPTH = 40;
const ELEVATED_WASH_TOP = WASH_DEPTH + 2;
/**
 * The light of a pressed key hangs above its middle: `LIGHT_ALONG` from the strike rail along the key and `LIGHT_HEIGHT`
 * above the white surface (in pitches). The black keys throw their shadows from it onto the white keys around.
 */
const LIGHT_ALONG = 1.6;
/** The spot of that light on the key lies nearer the top edge: its place along the key from the strike rail, in pitches. */
const LIGHT_SPOT_ALONG = 0.8;
const LIGHT_HEIGHT = 2.2;
const WASH_ROWS = Array.from({ length: WASH_DEPTH }, (_, row) => {
  const depth = row / (WASH_DEPTH - 1);
  const sample = depth * (CONTACT_LIGHT_ROWS - 1);
  const low = Math.floor(sample);
  const stride = 4;
  return {
    low: low * stride,
    high: Math.min(CONTACT_LIGHT_ROWS - 1, low + 1) * stride,
    mix: sample - low,
    depth: depth * WHITE_LENGTH,
    reflection: Math.exp(-depth * 11),
  };
});

type DrawingSurface = HTMLCanvasElement | OffscreenCanvas;
type DrawingContext = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
type ProfilePoint = readonly [across: number, forward: number];

interface KeySprite {
  cover: Path2D;
  front: Path2D;
  y: number;
  length: number;
  toe: number;
  frontBottom: number;
  recess: number;
}

export interface StageKey {
  midi: number;
  black: boolean;
  /** Center measured along the keyboard in plane units. */
  x: number;
}

export interface KeyLight {
  midi: number;
  light: number;
  press: number;
  onset: number;
  rgb: Rgb;
  /** A key that stays up wears its lit finish at this strength (0..1); `press` keeps it down. */
  hint?: number;
}

interface KeyLightPaint {
  glow: DrawingSurface;
  emission: Rgb;
}

interface KeyPlacement {
  key: StageKey;
  variant: number;
  left?: StageKey;
  right?: StageKey;
  from: number;
  to: number;
}

interface IdleRow {
  surface: DrawingSurface;
  placements: KeyPlacement[];
}

export interface KeyStageFrame {
  width: number;
  rail: number;
  depth: number;
  pitch: number;
  keys: StageKey[];
  contactPixels: Float32Array;
}

function keyOutline(half: number, length: number, bevel: number): ProfilePoint[] {
  return [
    [-half, 0], [half, 0],
    [half, length - bevel], [half - bevel, length],
    [-half + bevel, length], [-half, length - bevel],
  ];
}

/** A white key seen from above: the neck between the black keys and the full-width head in front of them. */
function whiteOutline(half: number, neckLeft: number, neckRight: number): ProfilePoint[] {
  return [
    [neckLeft, 0], [neckRight, 0], [neckRight, NECK_END], [half, NECK_END],
    [half, WHITE_LENGTH], [-half, WHITE_LENGTH], [-half, NECK_END], [neckLeft, NECK_END],
  ];
}

function polygon(points: readonly ProfilePoint[], y: (forward: number) => number, pitch: number): Path2D {
  const path = new Path2D();
  points.forEach(([x, forward], index) => {
    if (index === 0) path.moveTo(x * pitch, y(forward));
    else path.lineTo(x * pitch, y(forward));
  });
  path.closePath();
  return path;
}

function face(points: readonly ProfilePoint[], y: (forward: number) => number, pitch: number): Path2D {
  const path = new Path2D();
  points.forEach(([x, depth], index) => {
    if (index === 0) path.moveTo(x * pitch, y(depth));
    else if (index === 3) path.quadraticCurveTo(points[2][0] * pitch, y(depth), x * pitch, y(depth));
    else if (index === 5) path.quadraticCurveTo(x * pitch, y(points[4][1]), x * pitch, y(depth));
    else path.lineTo(x * pitch, y(depth));
  });
  path.closePath();
  return path;
}

function sideFace(edge: number, shoulder: number, length: number, top: (y: number) => number,
  bottom: (y: number) => number, pitch: number): Path2D {
  const path = new Path2D();
  path.moveTo(edge * pitch, top(0));
  path.lineTo(edge * pitch, top(length));
  path.lineTo(shoulder * pitch, bottom(length));
  path.lineTo(shoulder * pitch, bottom(0));
  path.closePath();
  return path;
}

function traceToe(path: Path2D, edge: readonly ProfilePoint[], y: (forward: number) => number, pitch: number): void {
  const [start, near, far, end] = edge;
  path.quadraticCurveTo(start[0] * pitch, y(near[1]), near[0] * pitch, y(near[1]));
  path.lineTo(far[0] * pitch, y(far[1]));
  path.quadraticCurveTo(end[0] * pitch, y(far[1]), end[0] * pitch, y(end[1]));
}

function softEdge(distance: number, radius: number): number {
  const edge = clamp(0.5 + distance / (2 * radius), 0, 1);
  return edge * edge * (3 - 2 * edge);
}

/**
 * The finish of the key model's faces, given each face's colour at rest. At rest every face keeps it; lit, every face
 * takes the light's colour, so a lit key is the same model with the same faces and the same shading.
 */
interface KeyMaterial {
  /** A face of a black key. */
  black(idle: string): string;
  /** A face of a white key below its top: it takes `coat` of the light at `tone` of its strength and is shaded by `dim`. */
  white(idle: string, coat: number, tone?: number, dim?: number): string;
  /** The top of a key, `at` along it from the strike rail (0) to its front (1). */
  top(idle: string, at: number): string;
  /** The front of a white key: lit, the light at the key's front end, shaded by `shade`. */
  front(idle: string, shade: number): string;
  /** A highlight. */
  glint(idle: Rgb, alpha: number): string;
  /** The shadow where the black nose turns down: at rest a dark line under its lit edge; lit, the nose has no dark edge. */
  edge(alpha: number): string;
}

const IDLE_MATERIAL: KeyMaterial = {
  black: idle => idle,
  white: idle => idle,
  top: idle => idle,
  front: idle => idle,
  glint: (idle, alpha) => rgba(idle, alpha),
  edge: alpha => rgba([0, 0, 0], alpha),
};

/**
 * A lit key's top is the light itself: the voice's hue at `LIT_TOP_VALUE`, nearly white at the strike rail where the
 * light lies and deepening towards the front (saturation `LIT_TOP_SATURATION`, from the rail to the front).
 */
const LIT_TOP_VALUE = .98;
const LIT_TOP_SATURATION = [.2, .65] as const;
/**
 * A lit black face keeps its resting relation to the cap (softened by a power): a face lighter than the cap at rest is
 * paler, towards white, a darker one is deeper, so the sides and the nose still read at full brightness.
 */
const BLACK_CAP_VALUE = 0x1b / 255;
const BLACK_LIT_CONTRAST = .85;
/** A lit white front stands at this share of the light at the key's front end, at its brightest band. */
const LIT_FRONT_LEVEL = .9;
const WHITE_FRONT_VALUE = 0x73;
/** The black faces take the light at the middle of the key's length. */
const BLACK_FACE_AT = .5;
/** The side faces of a black key at rest: one colour on both sides. */
const BLACK_SIDE = '#2a2a31';
/** How the rail light falls off along a black top (share removed, from the rail to the nose). */
const BLACK_RAIL_FALLOFF = [[.1, 0], [.35, .34], [.5, .59], [.75, .79], [1, .8]] as const;
/** How strongly the lit keys' light lies on the keys around them: alpha per unit of light, and its ceiling. */
const WASH_GAIN = 3.2;
const WASH_ALPHA_MAX = 250;
/** The white core of the light at the top of a sounding key, as a share of its strength at the attack. */
const LIT_CORE_HELD = .3;
/** How strong the wide glow of a sounding key is, against the old circle. */
const LIT_SPOT_LEVEL = .55;

function litMaterial(light: Rgb, voice: Rgb): KeyMaterial {
  const pale = light.map(channel => 255 + (channel - 255) * .4) as Rgb;
  // The voice's colour at full value; its saturation is set by moving it towards white (exact at full value).
  const peak = Math.max(1, ...voice);
  const deep = voice.map(channel => channel * 255 / peak) as Rgb;
  const voiceSaturation = Math.max(1e-3, (peak - Math.min(...voice)) / peak);
  const topColor = (at: number): Rgb => {
    const saturation = LIT_TOP_SATURATION[0] + (LIT_TOP_SATURATION[1] - LIT_TOP_SATURATION[0]) * clamp(at, 0, 1);
    const share = Math.min(1, saturation / voiceSaturation);
    return deep.map(channel => (255 - (255 - channel) * share) * LIT_TOP_VALUE) as Rgb;
  };
  const face = topColor(BLACK_FACE_AT);
  return {
    black: idle => {
      const ratio = (Math.max(...hexRgb(idle)) / 255 / BLACK_CAP_VALUE) ** BLACK_LIT_CONTRAST;
      const color = ratio >= 1
        ? face.map(channel => channel + (255 - channel) * (1 - 1 / ratio))
        : face.map(channel => channel * ratio);
      return rgba(color as Rgb, 1);
    },
    white: (idle, coat, tone = 1, dim = 0) => rgba(hexRgb(idle).map((channel, index) =>
      (channel + (light[index] * tone - channel) * coat) * (1 - dim)) as Rgb, 1),
    top: (_, at) => rgba(topColor(at), 1),
    front: (_, shade) => rgba(topColor(1).map(channel => channel * shade) as Rgb, 1),
    glint: (_, alpha) => rgba(pale, alpha),
    edge: () => 'rgba(0, 0, 0, 0)',
  };
}

function capGradient(context: DrawingContext, top: number, bottom: number, black: boolean, material: KeyMaterial): CanvasGradient {
  const fill = context.createLinearGradient(0, top, 0, bottom);
  const stops = black
    ? [[0, '#111114'], [0.28, '#17171b'], [0.64, '#101012'], [0.92, '#0d0d0f'], [1, '#151518']] as const
    : [[0, '#96928e'], [0.24, '#96928e'], [0.68, '#97938f'], [1, '#9d9893']] as const;
  for (const [at, color] of stops) fill.addColorStop(at, material.top(color, at));
  return fill;
}

function capFinish(context: DrawingContext, pitch: number, black: boolean, press: number, material: KeyMaterial): CanvasGradient {
  // A black top's gloss stays centred when it sinks: both its edges are mirror images.
  const shift = pitch * (black ? 0 : .019) * press;
  const gloss = context.createLinearGradient(shift - pitch / 2, 0, shift + pitch / 2, 0);
  const stops = black
    ? [[0, .22], [.2, .22], [.23, .16], [.265, .06], [.33, .02], [.67, .02], [.735, .06], [.77, .16], [.8, .22], [1, .22]] as const
    : [[0, .29], [.028, .13], [.067, 0], [.16, .025], [.29, 0], [.76, .02], [.9, 0], [.965, .12], [1, .26]] as const;
  for (const [at, alpha] of stops) {
    const dark = at < (black ? .22 : .055) || at > (black ? .78 : .94);
    gloss.addColorStop(at, dark ? rgba([0, 0, 0], alpha) : material.glint([234, 239, 250], alpha));
  }
  return gloss;
}

/** The keyboard uses one atlas of physical poses and clips light to each cap. */
export class KeyStage {
  private readonly atlas: DrawingSurface;
  private readonly atlasContext: DrawingContext;
  private readonly sprites: KeySprite[] = [];
  private readonly idleRows: [IdleRow, IdleRow];
  private preparedKeys: StageKey[] | undefined;
  private readonly lights = new Map<number, KeyLight>();
  private readonly lightColors = new Map<number, KeyLightPaint>();
  private readonly wash: DrawingSurface;
  private readonly washContext: DrawingContext;
  private readonly washPixels: ImageData;
  private readonly washColumn = new Float32Array(CONTACT_LIGHT_ROWS * 8);
  private atlasWidth = 0;
  /** The same model in the finish of each light's colour, made when a key first lights in it. */
  private readonly litAtlases = new Map<number, DrawingSurface>();
  private atlasHeight = 0;
  private drawWidth = 0;
  private drawHeight = 0;
  private padTop = 0;
  private step = 0;
  private pitchUnit = 0;
  private layout = '';

  constructor(private readonly canvas: DrawingSurface, private readonly crestIdle: Rgb) {
    this.atlas = this.makeSurface();
    this.wash = this.makeSurface();
    this.wash.width = WASH_COLUMNS;
    this.wash.height = ELEVATED_WASH_TOP + WASH_DEPTH;
    this.idleRows = [
      { surface: this.makeSurface(), placements: [] },
      { surface: this.makeSurface(), placements: [] },
    ];
    const atlas = this.atlas.getContext('2d') as DrawingContext | null;
    const wash = this.wash.getContext('2d') as DrawingContext | null;
    if (!atlas || !wash) throw new Error('Could not prepare the keyboard sprites');
    this.atlasContext = atlas;
    this.washContext = wash;
    this.washPixels = wash.createImageData(this.wash.width, this.wash.height);
  }

  private makeSurface(): DrawingSurface {
    return 'ownerDocument' in this.canvas
      ? this.canvas.ownerDocument.createElement('canvas')
      : new OffscreenCanvas(1, 1);
  }

  setPalette(colors: readonly Rgb[]): void {
    const keys = new Set(colors.map(rgb => this.colorId(rgb)));
    for (const [key, { glow }] of this.lightColors) {
      if (keys.has(key)) continue;
      glow.width = glow.height = 1;
      this.lightColors.delete(key);
    }
    for (const rgb of colors) this.lightPaint(rgb);
  }

  invalidateRasters(): void {
    this.layout = '';
    this.preparedKeys = undefined;
    for (const { glow } of this.lightColors.values()) glow.width = glow.height = 1;
    this.lightColors.clear();
  }

  dispose(): void {
    this.atlas.width = this.atlas.height = 1;
    this.wash.width = this.wash.height = 1;
    for (const { surface, placements } of this.idleRows) {
      surface.width = surface.height = 1;
      placements.length = 0;
    }
    this.sprites.length = 0;
    for (const { glow } of this.lightColors.values()) glow.width = glow.height = 1;
    this.lightColors.clear();
  }

  private colorId([r, g, b]: Rgb): number {
    return (r << 16) | (g << 8) | b;
  }

  private lightPaint(rgb: Rgb): KeyLightPaint {
    const id = this.colorId(rgb);
    const existing = this.lightColors.get(id);
    if (existing) return existing;
    const sprite = this.makeSurface();
    sprite.width = sprite.height = 48;
    const context = sprite.getContext('2d') as DrawingContext | null;
    if (context) {
      const radial = context.createRadialGradient(24, 16, 1, 24, 16, 28);
      radial.addColorStop(0, rgba(rgb, 0.96));
      radial.addColorStop(0.38, rgba(rgb, 0.55));
      radial.addColorStop(0.74, rgba(rgb, 0.12));
      radial.addColorStop(1, rgba(rgb, 0));
      context.fillStyle = radial;
      context.fillRect(0, 0, 48, 48);
    }
    const exposure = .49 * Math.max(...rgb) / 255;
    const emission = rgb.map(channel => channel + (255 - channel) * exposure) as Rgb;
    const paint = { glow: sprite, emission };
    this.lightColors.set(id, paint);
    return paint;
  }

  private prepare(depth: number, pitch: number, ratio: number): void {
    const layout = [depth, pitch, ratio].join('/');
    if (layout === this.layout) return;
    this.layout = layout;
    this.preparedKeys = undefined;
    const step = depth / WHITE_LENGTH;
    this.step = step;
    this.pitchUnit = pitch;
    this.padTop = step * 0.42;
    this.drawWidth = pitch * (1 + 2 * SPRITE_PADDING);
    this.drawHeight = step * 6.35;
    // Each cell includes transparent padding, so resampling cannot borrow an adjacent pose.
    const spriteRatio = ratio * SPRITE_SUPERSAMPLE;
    this.atlasWidth = Math.max(1, Math.ceil(this.drawWidth * spriteRatio));
    this.atlasHeight = Math.max(1, Math.ceil(this.drawHeight * spriteRatio));
    this.atlas.width = this.atlasWidth * (BLACK_VARIANT + 1);
    this.atlas.height = this.atlasHeight * (PRESS_STEPS + 1);
    this.paintAtlas(this.atlasContext, IDLE_MATERIAL, true, step, pitch);
    this.litAtlases.clear();
  }

  /** Paints every shape and pose of the key model into `context` in one finish. */
  private paintAtlas(context: DrawingContext, material: KeyMaterial, record: boolean, step: number, pitch: number): void {
    const scaleX = this.atlasWidth / this.drawWidth;
    const scaleY = this.atlasHeight / this.drawHeight;
    for (let variant = 0; variant <= BLACK_VARIANT; variant++) {
      const black = variant === BLACK_VARIANT;
      const length = black ? BLACK_LENGTH : WHITE_LENGTH;
      const half = black ? BLACK_HALF : WHITE_HALF;
      const bevel = black ? BLACK_EDGE : 0;
      const neckLeft = !black && variant & 1 ? BLACK_HALF - 0.5 + WHITE_GROOVE : -half;
      const neckRight = !black && variant & 2 ? 0.5 - BLACK_HALF - WHITE_GROOVE : half;
      const outer = keyOutline(half, length, bevel);
      const inner = keyOutline(half - bevel, length - bevel, bevel);
      const shape = whiteOutline(half, neckLeft, neckRight);
      for (let frame = 0; frame <= PRESS_STEPS; frame++) {
        const press = frame / PRESS_STEPS;
        const angle = -press * (black ? BLACK_TRAVEL : WHITE_TRAVEL);
        const sin = Math.sin(angle);
        const cos = Math.cos(angle);
        const project = (z: number) => (y: number) => 0.04 + step * (
          y * cos - z * sin + (black ? BLACK_BACK : 0) - (y * sin + z * cos) * HEIGHT_PER_DEPTH
        );
        const surface = project(black ? BLACK_TOP : 0);
        const lipSurface = project(black ? BLACK_TOP - 0.034 : -0.018);
        // The rear heel stays hidden under the strike rail while the visible toe pivots.
        const top = black ? (y: number) => surface(y) - surface(0) * (1 - y / length) : surface;
        const upperLip = black ? (y: number) => lipSurface(y) - lipSurface(0) * (1 - y / length) : lipSurface;
        const bottom = project(black ? BLACK_BED : WHITE_FRONT);
        const cap = black ? face(inner, top, pitch) : polygon(shape, top, pitch);
        const lipHalf = black ? half - .02 : half;
        const lipOutline = keyOutline(lipHalf, length, bevel);
        const lip = black ? face(lipOutline, upperLip, pitch) : polygon(shape, upperLip, pitch);
        const body = black ? face(outer, bottom, pitch) : polygon(shape, bottom, pitch);
        const toe = upperLip(length);
        const frontBottom = bottom(length);
        const front = new Path2D();
        if (black) {
          // The front face is narrower at its top edge than at its foot, so the nose reads as a trapezoid.
          const upperEdge = keyOutline(BLACK_NOSE_TOP * half, length, bevel).slice(-4);
          const lowerEdge = outer.slice(-4).reverse();
          const [upperRight] = upperEdge;
          const [lowerLeft] = lowerEdge;
          front.moveTo(upperRight[0] * pitch, upperLip(upperRight[1]));
          traceToe(front, upperEdge, upperLip, pitch);
          // It reaches the full width where it meets the white surface and goes straight down from there.
          const surfaceLevel = project(0);
          front.lineTo(lowerLeft[0] * pitch, surfaceLevel(lowerLeft[1]));
          traceToe(front, lowerEdge, surfaceLevel, pitch);
          front.closePath();
          front.rect(-half * pitch, surfaceLevel(length) - 1 / scaleY, 2 * half * pitch, bottom(length) - surfaceLevel(length) + 1 / scaleY);
        } else {
          front.rect(-half * pitch, toe, 2 * half * pitch, frontBottom - toe);
        }
        // The centre of the white front recedes towards the hinge in depth.
        const recess = black ? 0 : (project(-.39)(length - .13) - toe) / (frontBottom - toe);
        context.setTransform(scaleX, 0, 0, scaleY,
          (variant + 0.5) * this.atlasWidth, frame * this.atlasHeight + this.padTop * scaleY);
        context.fillStyle = black ? material.black('#131319') : material.white('#3d3d44', .4, 1, .45);
        context.fill(body);
        if (black) {
          const shoulderLength = length - bevel;
          // Both sides are the same: a side face and a thin bright edge, mirror images of each other.
          context.fillStyle = material.black(BLACK_SIDE);
          context.fill(sideFace(-lipHalf, -half, shoulderLength, upperLip, bottom, pitch));
          context.fill(sideFace(lipHalf, half, shoulderLength, upperLip, bottom, pitch));
          context.strokeStyle = material.glint([225, 225, 235], .55);
          context.lineWidth = Math.max(1 / scaleX, pitch * 0.006);
          context.beginPath();
          for (const side of [-1, 1]) {
            context.moveTo(side * (half - 0.012) * pitch, upperLip(0));
            context.lineTo(side * (half - 0.012) * pitch, upperLip(shoulderLength));
          }
          context.stroke();
        }

        const frontFinish = context.createLinearGradient(0, toe, 0, frontBottom);
        if (black) {
          for (const [at, color] of [[0, '#302e33'], [0.70 * BLACK_FACE, '#2c2a2f'], [BLACK_FACE, '#29272c'], [1, '#0b0b0d']] as const) {
            frontFinish.addColorStop(at, material.black(color));
          }
        } else {
          // A lit white front takes the light at the key's front end, as much darker than it as the front is at rest,
          // so it glows and keeps its relief (the recessed middle stays the darkest).
          const whiteStops = [[0, '#736f6d'], [.17, '#65615e'], [recess - .08, '#424047'], [recess + .11, '#454349'],
            [.84, '#57545a'], [1, '#37363e']] as const;
          for (const [at, color] of whiteStops) {
            frontFinish.addColorStop(at, material.front(color, LIT_FRONT_LEVEL * Math.max(...hexRgb(color)) / WHITE_FRONT_VALUE));
          }
        }
        context.fillStyle = frontFinish;
        context.fill(front);

        context.fillStyle = black ? material.black('#242426') : material.top('#a29d97', 1);
        context.fill(lip);
        context.fillStyle = capGradient(context, top(0), top(length), black, material);
        context.fill(cap);
        context.fillStyle = capFinish(context, pitch, black, press, material);
        context.fill(cap);
        // The neutral rail reaches every cap, including the idle atlas.
        const railWash = context.createLinearGradient(0, top(0), 0, top(length * 0.42));
        railWash.addColorStop(0, material.glint(this.crestIdle, black ? 0.22 : 0.32));
        railWash.addColorStop(0.36, material.glint(this.crestIdle, black ? 0.055 : 0.12));
        railWash.addColorStop(1, material.glint(this.crestIdle, 0));
        context.fillStyle = railWash;
        context.fill(cap);
        if (black) {
          // The top edge of the front face catches the light in its middle.
          context.strokeStyle = material.glint([235, 232, 240], .38);
          context.lineWidth = Math.max(1 / scaleX, pitch * 0.012);
          context.beginPath();
          context.moveTo(-0.9 * BLACK_NOSE_TOP * half * pitch, toe);
          context.lineTo(0.9 * BLACK_NOSE_TOP * half * pitch, toe);
          context.stroke();
          // A narrow shadow right under the lit edge, where the face turns down.
          context.strokeStyle = material.edge(0.35);
          context.beginPath();
          context.moveTo(-0.9 * BLACK_NOSE_TOP * half * pitch, toe + 2 * context.lineWidth);
          context.lineTo(0.9 * BLACK_NOSE_TOP * half * pitch, toe + 2 * context.lineWidth);
          context.stroke();
        }
        if (record) this.sprites[variant * (PRESS_STEPS + 1) + frame] = { cover: lip, front,
          y: top(0), length: top(length) - top(0), toe, frontBottom, recess };
      }
    }
  }

  private prepareIdleRows(frame: KeyStageFrame, ratio: number): void {
    if (this.preparedKeys === frame.keys) return;
    this.preparedKeys = frame.keys;
    const width = Math.max(1, Math.round(frame.width * ratio));
    const height = Math.max(1, Math.ceil(this.drawHeight * ratio));
    const scale = width / frame.width;
    for (const { surface, placements } of this.idleRows) {
      surface.width = width;
      surface.height = height;
      placements.length = 0;
    }
    frame.keys.forEach((key, index) => {
      const row = this.idleRows[Number(key.black)];
      const left = key.black ? undefined : frame.keys[index - 1];
      const right = key.black ? undefined : frame.keys[index + 1];
      const variant = key.black ? BLACK_VARIANT : (left?.black ? 1 : 0) + (right?.black ? 2 : 0);
      const half = frame.pitch * (key.black ? 0.35 : 0.5);
      // Slice the idle row at the middle of the groove so a neighbor keeps its edge.
      row.placements.push({
        key, variant, left, right,
        from: Math.max(0, (key.x - half) * scale),
        to: Math.min(width, (key.x + half) * scale),
      });
    });
    for (const { surface, placements } of this.idleRows) {
      const context = surface.getContext('2d') as DrawingContext | null;
      if (!context) continue;
      context.setTransform(scale, 0, 0, height / this.drawHeight, 0, 0);
      context.imageSmoothingQuality = 'high';
      for (const { key, variant } of placements) this.drawSprite(context, key.x, 0, variant, 0);
    }
  }

  /** The model in the finish of a voice's light. */
  private litAtlas(voice: Rgb): DrawingSurface {
    const id = this.colorId(voice);
    let atlas = this.litAtlases.get(id);
    if (!atlas) {
      atlas = this.makeSurface();
      atlas.width = this.atlas.width;
      atlas.height = this.atlas.height;
      const context = atlas.getContext('2d') as DrawingContext | null;
      if (context) this.paintAtlas(context, litMaterial(this.lightPaint(voice).emission, voice), false, this.step, this.pitchUnit);
      this.litAtlases.set(id, atlas);
    }
    return atlas;
  }

  private drawSprite(context: DrawingContext, x: number, y: number, variant: number, pose: number, atlas = this.atlas): void {
    context.drawImage(atlas, variant * this.atlasWidth, pose * this.atlasHeight, this.atlasWidth, this.atlasHeight,
      x - this.drawWidth / 2, y, this.drawWidth, this.drawHeight);
  }

  private drawIdle(context: DrawingContext, frame: KeyStageFrame, row: IdleRow): void {
    const { surface, placements } = row;
    const scale = frame.width / surface.width;
    let from = 0;
    const drawSpan = (to: number) => {
      if (to <= from) return;
      const length = to - from;
      context.drawImage(surface, from, 0, length, surface.height,
        from * scale, frame.rail - this.padTop, length * scale, this.drawHeight);
    };
    for (const { key, from: left, to: right } of placements) {
      if (!(this.lights.get(key.midi)?.press)) continue;
      drawSpan(left);
      from = Math.max(from, right);
    }
    drawSpan(surface.width);
  }

  /**
   * How much of the light reaching a point of a white key the black key beside it holds back. The light is a point
   * above the pressed key (`distance` pitches away across the keyboard, `LIGHT_ALONG` along it, `LIGHT_HEIGHT` up); the
   * point is `depth` from the rail on the white surface; the black key stands `blocker` across from the point. The ray
   * between them is shadowed where it passes over the black key below its top. All positions along the ray are fractions
   * from the light (0) to the point (1).
   */
  private castShadow(distance: number, blocker: number, depth: number, blackSlope: number, whiteSlope: number): number {
    if (blackSlope < 0 || distance < 0.02) return 0;
    const toe = BLACK_BACK + BLACK_LENGTH;
    const center = (blocker + distance) / distance;
    const half = BLACK_HALF / distance;
    // Where along the ray it is above the black key: across it, and between its back and its toe.
    let first = Math.max(0, center - half);
    let last = Math.min(1, center + half);
    const run = depth - LIGHT_ALONG;
    if (Math.abs(run) > 1e-6) {
      const enter = (BLACK_BACK - LIGHT_ALONG) / run;
      const leave = (toe - LIGHT_ALONG) / run;
      first = Math.max(first, Math.min(enter, leave));
      last = Math.min(last, Math.max(enter, leave));
    } else if (LIGHT_ALONG < BLACK_BACK || LIGHT_ALONG > toe) return 0;
    if (last <= first) return 0;
    const length = Math.hypot(distance, run);
    const beyond = (1 - last) * length;
    const penumbra = 0.11 + 0.122 * beyond;
    const silhouette = softEdge((last - first) * length, penumbra);
    // The ray falls towards the point, so it is lowest where it leaves the black key.
    const pointHeight = -depth * whiteSlope;
    const rayHeight = LIGHT_HEIGHT + (pointHeight - LIGHT_HEIGHT) * last;
    const along = LIGHT_ALONG + run * last;
    const blockerHeight = BLACK_TOP - Math.max(0, along - BLACK_BACK) * blackSlope;
    const profile = softEdge(blockerHeight - rayHeight, 0.15 + 0.10 * beyond);
    return 0.62 * silhouette * profile / (1 + 0.16 * beyond * beyond);
  }

  private buildWash(frame: KeyStageFrame): void {
    const { width, pitch, contactPixels } = frame;
    const white = this.idleRows[0].placements;
    const data = this.washPixels.data;
    const rowStride = CONTACT_LIGHT_STOPS * 4;
    const sideStride = rowStride * CONTACT_LIGHT_ROWS;
    const ridgeOffset = sideStride * 2;
    const rightSide = CONTACT_LIGHT_ROWS * 4;
    const column = this.washColumn;
    const pack = (offset: number, r: number, g: number, b: number, fade = 1) => {
      const peak = Math.max(r, g, b);
      const normalize = peak > 0 ? 255 / peak : 0;
      data[offset] = r * normalize;
      data[offset + 1] = g * normalize;
      data[offset + 2] = b * normalize;
      data[offset + 3] = Math.min(WASH_ALPHA_MAX, peak * WASH_GAIN) * fade;
    };
    // The rail light falls off along an unpressed black top, which is dark well before its nose. The light itself fades
    // there, never the key under it (that would darken it below its resting level), and by the share of the key still up.
    const blacks = this.idleRows[1].placements;
    let nearest = 0;
    const blackRows = WASH_DEPTH * BLACK_LENGTH / WHITE_LENGTH;
    const blackFade = (row: number, up: number) => {
      const along = Math.min(1, row / blackRows);
      let from: readonly [number, number] = BLACK_RAIL_FALLOFF[0];
      if (along <= from[0]) return 1;
      for (const point of BLACK_RAIL_FALLOFF) {
        if (along <= point[0]) return 1 - (from[1] + (point[1] - from[1]) * (along - from[0]) / (point[0] - from[0])) * up;
        from = point;
      }
      return 1 - from[1] * up;
    };

    for (let col = 0; col < WASH_COLUMNS; col++) {
      const u = col / (WASH_COLUMNS - 1);
      const x = u * width;
      const key = white[Math.round((x - white[0].key.x) / pitch)];
      while (nearest < blacks.length - 1 && Math.abs(blacks[nearest + 1].key.x - x) < Math.abs(blacks[nearest].key.x - x)) nearest++;
      const up = blacks.length && Math.abs(blacks[nearest].key.x - x) <= pitch / 2
        ? 1 - clamp(this.lights.get(blacks[nearest].key.midi)?.press ?? 0, 0, 1) : 1;
      const leftTilt = key?.left?.black ? Math.sin(BLACK_TRAVEL * (this.lights.get(key.left.midi)?.press ?? 0)) : -1;
      const rightTilt = key?.right?.black ? Math.sin(BLACK_TRAVEL * (this.lights.get(key.right.midi)?.press ?? 0)) : -1;
      const receiverPress = key ? this.lights.get(key.key.midi)?.press ?? 0 : 0;
      const receiverTilt = Math.sin(WHITE_TRAVEL * receiverPress);
      // Only passive receivers carry the full projected shadow from a neighbouring key.
      const shadowStrength = 1 - softEdge(receiverPress - .125, .125);
      const localKeyX = x / pitch;
      const leftCaster = key?.left ? (key.left.x - x) / pitch : 0;
      const rightCaster = key?.right ? (x - key.right.x) / pitch : 0;
      const at = u * (CONTACT_LIGHT_STOPS - 1);
      const x0 = Math.floor(at);
      const x1 = Math.min(CONTACT_LIGHT_STOPS - 1, x0 + 1);
      const mix = at - x0;
      const sample = (offset: number, channel: number) => contactPixels[offset + 4 * x0 + channel] * (1 - mix) +
        contactPixels[offset + 4 * x1 + channel] * mix;
      const flash = sample(ridgeOffset, 3);
      const crest0 = Math.max(0, sample(ridgeOffset, 0) - Math.round(0.12 * this.crestIdle[0]));
      const crest1 = Math.max(0, sample(ridgeOffset, 1) - Math.round(0.12 * this.crestIdle[1]));
      const crest2 = Math.max(0, sample(ridgeOffset, 2) - Math.round(0.12 * this.crestIdle[2]));
      for (let stop = 0; stop < CONTACT_LIGHT_ROWS; stop++) {
        const offset = stop * rowStride;
        for (let channel = 0; channel < 4; channel++) {
          column[stop * 4 + channel] = sample(offset, channel);
          column[rightSide + stop * 4 + channel] = sample(sideStride + offset, channel);
        }
      }

      for (let row = 0; row < WASH_DEPTH; row++) {
        const { low, high, mix, depth, reflection } = WASH_ROWS[row];
        const diffuse = (side: number, channel: number) =>
          column[side + low + channel] * (1 - mix) + column[side + high + channel] * mix;
        const leftSource = localKeyX - diffuse(0, 3) * width / (255 * pitch);
        const rightSource = diffuse(rightSide, 3) * width / (255 * pitch) - localKeyX;
        const left = shadowStrength === 0 ? 1
          : 1 - shadowStrength * this.castShadow(leftSource, leftCaster, depth, leftTilt, receiverTilt);
        const right = shadowStrength === 0 ? 1
          : 1 - shadowStrength * this.castShadow(rightSource, rightCaster, depth, rightTilt, receiverTilt);
        const localFlash = flash * reflection * 0.85;
        const red = crest0 * reflection + localFlash;
        const green = crest1 * reflection + localFlash;
        const blue = crest2 * reflection + localFlash;
        const leftR = diffuse(0, 0), rightR = diffuse(rightSide, 0);
        const leftG = diffuse(0, 1), rightG = diffuse(rightSide, 1);
        const leftB = diffuse(0, 2), rightB = diffuse(rightSide, 2);
        const offset = (row * WASH_COLUMNS + col) * 4;
        pack(offset, leftR * left + rightR * right + red, leftG * left + rightG * right + green,
          leftB * left + rightB * right + blue);
        const bladeOffset = offset + ELEVATED_WASH_TOP * WASH_COLUMNS * 4;
        const fade = blackFade(row, up);
        pack(bladeOffset, leftR + rightR + red, leftG + rightG + green, leftB + rightB + blue, fade);
        if (row === 0) pack(bladeOffset - WASH_COLUMNS * 4, leftR + rightR + red,
          leftG + rightG + green, leftB + rightB + blue, fade);
        if (row === WASH_DEPTH - 1) pack(offset + WASH_COLUMNS * 4, leftR * left + rightR * right + red,
          leftG * left + rightG * right + green, leftB * left + rightB * right + blue);
      }
    }
    this.washContext.putImageData(this.washPixels, 0, 0);
  }

  private drawKey(context: DrawingContext, frame: KeyStageFrame, placement: KeyPlacement): void {
    const { key, variant } = placement;
    const own = this.lights.get(key.midi);
    const press = clamp(own?.press ?? 0, 0, 1);
    const pose = press > 0 ? Math.max(1, Math.round(press * PRESS_STEPS)) : 0;
    const sprite = this.sprites[variant * (PRESS_STEPS + 1) + pose];
    const { rail, depth, pitch, width, contactPixels } = frame;
    // How strongly the key is lit: the share of its lit finish over the unlit one.
    const lit = pose > 0 && own ? Math.min(1, press * (.63 + own.light * .24) / .88) : 0;
    if (pose > 0) {
      context.save();
      if (!key.black) {
        // A white front goes down behind the front rail: nothing of it shows below where the released key ends.
        context.beginPath();
        context.rect(key.x - pitch, rail - this.padTop, 2 * pitch, this.sprites[variant * (PRESS_STEPS + 1)].frontBottom + this.padTop);
        context.clip();
      }
      this.drawSprite(context, key.x, rail - this.padTop, variant, pose);
    }

    const stop = Math.round(clamp(key.x / width, 0, 1) * (CONTACT_LIGHT_STOPS - 1));
    const leftLight = stop * 4;
    const rightLight = (CONTACT_LIGHT_STOPS * CONTACT_LIGHT_ROWS + stop) * 4;
    const ridge = (2 * CONTACT_LIGHT_STOPS * CONTACT_LIGHT_ROWS + stop) * 4;
    const lightPower = (offset: number) => Math.max(contactPixels[offset], contactPixels[offset + 1], contactPixels[offset + 2]);
    const leftPower = lightPower(leftLight);
    const rightPower = lightPower(rightLight);
    const ridgePower = Math.max(
      contactPixels[ridge] - Math.round(0.12 * this.crestIdle[0]),
      contactPixels[ridge + 1] - Math.round(0.12 * this.crestIdle[1]),
      contactPixels[ridge + 2] - Math.round(0.12 * this.crestIdle[2]),
    );
    const hint = own?.hint ?? 0;
    if (!(leftPower > 1 || rightPower > 1 || ridgePower > 1 || own?.press || hint > 0)) return;

    context.save();
    context.translate(key.x, rail);
    if (key.black && (leftPower > 1 || rightPower > 1)) {
      const toeRow = Math.round((CONTACT_LIGHT_ROWS - 1) * BLACK_LENGTH / WHITE_LENGTH) * CONTACT_LIGHT_STOPS * 4;
      const fromLeft = lightPower(leftLight + toeRow);
      const fromRight = lightPower(rightLight + toeRow);
      const peak = fromLeft + fromRight;
      if (peak > 1) {
        const rgb: Rgb = [0, 0, 0];
        for (let channel = 0; channel < 3; channel++) {
          rgb[channel] = (contactPixels[leftLight + toeRow + channel] + contactPixels[rightLight + toeRow + channel]) * 255 / peak;
        }
        const edge = (fromRight - fromLeft) / peak * pitch * BLACK_HALF;
        const reflection = context.createLinearGradient(edge, sprite.toe, -edge, sprite.frontBottom);
        const level = 0.31 * (1 - Math.exp(-peak / 86));
        // The light from the neighbours lies evenly on the part of the front above the white heads.
        reflection.addColorStop(0, rgba(rgb, level));
        reflection.addColorStop(BLACK_FACE, rgba(rgb, 0.8 * level));
        reflection.addColorStop(1, rgba(rgb, 0.3 * level));
        context.save();
        context.globalCompositeOperation = 'screen';
        context.fillStyle = reflection;
        context.fill(sprite.front);
        context.restore();
      }
    }
    const paint = own && press > 0 ? this.lightPaint(own.rgb) : undefined;
    if (leftPower <= 1 && rightPower <= 1 && ridgePower <= 1 && press === 0 && hint === 0) {
      context.restore();
      return;
    }
    // The unlit key with the light that falls on it; a lit key's finish is laid over this below. The light the
    // neighbours throw is built only while a key is down, so a key that only stays lit has none.
    if (press > 0 || leftPower > 1 || rightPower > 1 || ridgePower > 1) {
      context.save();
      context.clip(sprite.cover);
      const x = Math.max(0, key.x - pitch / 2);
      const end = Math.min(width, key.x + pitch / 2);
      const depthRows = WASH_DEPTH * (key.black ? BLACK_LENGTH / WHITE_LENGTH : 1);
      const washTop = key.black ? ELEVATED_WASH_TOP : 0;
      context.globalCompositeOperation = 'screen';
      if (key.black) context.globalAlpha = 0.40 + 0.60 * press;
      context.drawImage(this.wash, x * WASH_COLUMNS / width, washTop, (end - x) * WASH_COLUMNS / width, depthRows,
        x - key.x, sprite.y, end - x, sprite.length);
      context.restore();
    }
    // The lit finish over the unlit key and its light: how much it shows is how strongly the key is lit, so a key on its
    // way up passes evenly from one to the other.
    if (own && Math.max(lit, hint) > 0) {
      context.globalAlpha = Math.max(lit, hint);
      this.drawSprite(context, 0, -this.padTop, variant, pose, this.litAtlas(own.rgb));
      context.globalAlpha = 1;
    }
    context.clip(sprite.cover);
    context.globalCompositeOperation = 'screen';
    if (own && paint) {
      // The light above the key lights its surface most right under it: a spot of the voice's light while the key
      // sounds and a white core, strongest at the attack.
      const core = own.rgb.map(channel => 255 + (channel - 255) * .25) as Rgb;
      // A soft, wide glow that reads as light rather than a circle.
      const spots = [
        [2.4, 1.4, own.rgb, press * LIT_SPOT_LEVEL * Math.min(.88, .57 * own.light + .43 * own.onset)],
        // The white core stays faintly while the key sounds and flares at the attack.
        [1, 1, core, press * (LIT_CORE_HELD + (1 - LIT_CORE_HELD) * own.onset)],
      ] as const;
      const along = key.black ? (LIGHT_SPOT_ALONG - BLACK_BACK) / BLACK_LENGTH : LIGHT_SPOT_ALONG / WHITE_LENGTH;
      for (const [across, alongRadius, color, alpha] of spots) {
        if (alpha < .003) continue;
        const spot = context.createRadialGradient(0, 0, 0, 0, 0, 1);
        for (const [at, share] of [[0, 1], [.18, .76], [.46, .27], [.72, .068], [1, 0]]) spot.addColorStop(at, rgba(color, share));
        context.save();
        // Near the key's top edge, under the light.
        context.translate(0, sprite.y + sprite.length * clamp(along, 0, 1));
        context.scale(pitch * across, pitch * alongRadius);
        context.globalAlpha = clamp(alpha, 0, 1);
        context.fillStyle = spot;
        context.fillRect(-1, -1, 2, 2);
        context.restore();
      }
    }
    if (paint) {
      context.globalCompositeOperation = 'source-over';
      context.globalAlpha = 1;
      if (!key.black) {
        // The neighbours now stand above the sunk key, and their sides shade its edges.
        const half = pitch * WHITE_HALF;
        const occlusion = context.createLinearGradient(-half, 0, half, 0);
        const reach = 0.25 * pitch / (2 * half);
        occlusion.addColorStop(0, rgba([0, 0, 0], .15 * press));
        occlusion.addColorStop(reach, rgba([0, 0, 0], 0));
        occlusion.addColorStop(1 - reach, rgba([0, 0, 0], 0));
        occlusion.addColorStop(1, rgba([0, 0, 0], .15 * press));
        context.fillStyle = occlusion;
        context.fill(sprite.cover);
      }
    }
    context.restore();
    if (pose > 0) context.restore();
  }

  draw(context: DrawingContext, frame: KeyStageFrame, lights: KeyLight[]): void {
    if (!frame.keys.length) return;
    const ratio = Math.abs(context.getTransform().a);
    this.prepare(frame.depth, frame.pitch, ratio);
    this.prepareIdleRows(frame, ratio);
    this.lights.clear();
    for (const light of lights) this.lights.set(light.midi, light);
    if (lights.some(light => light.press > 0)) this.buildWash(frame);
    // The black keys first: a white key has no surface beside them, and its head stands in front of their toes.
    for (const row of [this.idleRows[1], this.idleRows[0]]) {
      this.drawIdle(context, frame, row);
      for (const key of row.placements) this.drawKey(context, frame, key);
    }
  }
}
