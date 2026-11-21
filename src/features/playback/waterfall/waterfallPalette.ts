import { hexToHsv, hsvToHex } from '@/core/model/voiceColors';
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

/** The note and its light use the chosen colour. The far edge turns its hue while retaining saturation and value. */
export function voiceRamp(hex: string): VoiceRamp {
  const color = hexRgb(hex);
  const hsv = hexToHsv(hex);
  const far = hsvToHex({ ...hsv, hue: (hsv.hue + FAR_HUE_SHIFT) % 360 });
  return { near: color, far: hexRgb(far), glow: color };
}
