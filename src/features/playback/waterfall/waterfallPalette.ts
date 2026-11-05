import { readCssToken } from '@/ui/cssToken';

export type Rgb = [number, number, number];

/** What one voice colour becomes in the waterfall: a note is a gradient from `near` (at the keys) to `far`; `glow` is the light the voice throws — the ridge, the pollen and the lit keys. */
export interface VoiceRamp {
  near: Rgb;
  far: Rgb;
  glow: Rgb;
}

const RGB_MAX = 255;
const FAR_HUE_SHIFT = 30;
/** Saturation is full for every stop, so every voice colour glows the same way; only the lightness differs. */
const NEAR_LIGHTNESS = 0.6;
const FAR_LIGHTNESS = 0.68;
const GLOW_LIGHTNESS = 0.695;

export const clamp = (value: number, low: number, high: number): number => Math.min(high, Math.max(low, value));

export const rgba = (color: readonly number[], alpha = 1): string =>
  `rgba(${color.map((channel) => Math.round(clamp(channel, 0, RGB_MAX))).join(',')},${clamp(alpha, 0, 1)})`;

/** a `#rrggbb` colour as its channels, 0–255 */
export const hexRgb = (hex: string): Rgb => [1, 3, 5].map((start) => parseInt(hex.slice(start, start + 2), 16)) as Rgb;

/** The waterfall's own paint, from the `--waterfall-*` tokens (styles/tokens.css). */
export interface WaterfallPalette {
  skyBlack: string;
  bed: string;
  stripDefault: Rgb;
  stripBase: Rgb;
  rail: [string, string, string, string];
  mist: Rgb;
  mistEdge: Rgb;
  guide: { far: Rgb; mid: Rgb; near: Rgb };
  barLine: Rgb;
  mark: Rgb;
  sheen: Rgb;
  shadow: Rgb;
  burn: [Rgb, Rgb, Rgb];
  coreLight: Rgb;
  crestIdle: Rgb;
  crestGlow: Rgb;
  crestLine: Rgb;
  footprint: [Rgb, Rgb];
  grain: [Rgb, Rgb, Rgb];
}

/** Reads the palette in `el`'s context, once: the waterfall is the same in both themes. */
export function readWaterfallPalette(el: Element): WaterfallPalette {
  const token = (name: string) => readCssToken(el, `--waterfall-${name}`);
  const rgb = (name: string) => hexRgb(token(name));
  return {
    skyBlack: token('sky-black'),
    bed: token('bed'),
    stripDefault: rgb('strip-default'),
    stripBase: rgb('strip-base'),
    rail: [token('rail-top'), token('rail-upper'), token('rail-lower'), token('rail-bottom')],
    mist: rgb('mist'),
    mistEdge: rgb('mist-edge'),
    guide: { far: rgb('guide-far'), mid: rgb('guide-mid'), near: rgb('guide-near') },
    barLine: rgb('bar-line'),
    mark: rgb('mark'),
    sheen: rgb('sheen'),
    shadow: rgb('shadow'),
    burn: [rgb('burn'), rgb('burn-hot'), rgb('burn-white')],
    coreLight: rgb('core-light'),
    crestIdle: rgb('crest-idle'),
    crestGlow: rgb('crest-glow'),
    crestLine: rgb('crest-line'),
    footprint: [rgb('footprint'), rgb('footprint-white')],
    grain: [rgb('grain'), rgb('grain-mid'), rgb('grain-edge')],
  };
}

function fromHsl(hue: number, lightness: number): Rgb {
  const wrapped = ((hue % 360) + 360) % 360;
  const chroma = 1 - Math.abs(2 * lightness - 1);
  const channel = (offset: number) => {
    const k = (offset + wrapped / 30) % 12;
    return RGB_MAX * (lightness - (chroma / 2) * Math.max(-1, Math.min(k - 3, 9 - k, 1)));
  };
  return [channel(0), channel(8), channel(4)];
}

/** The ramp of a voice colour given as `#rrggbb`; the hue is the voice's own, so the editor colour and the waterfall colour never drift apart. */
export function voiceRamp(hex: string): VoiceRamp {
  const [red, green, blue] = hexRgb(hex).map((channel) => channel / RGB_MAX);
  const high = Math.max(red, green, blue);
  const spread = high - Math.min(red, green, blue);
  let hue = 0;
  if (spread > 0) {
    if (high === red) hue = ((green - blue) / spread) % 6;
    else if (high === green) hue = (blue - red) / spread + 2;
    else hue = (red - green) / spread + 4;
  }
  const degrees = hue * 60;
  return {
    near: fromHsl(degrees, NEAR_LIGHTNESS),
    far: fromHsl(degrees + FAR_HUE_SHIFT, FAR_LIGHTNESS),
    glow: fromHsl(degrees, GLOW_LIGHTNESS),
  };
}
