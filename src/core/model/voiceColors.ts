// Per-voice colours (MuseScore-style), mirroring the voice tokens in styles/tokens.css
// (--color-voice-1..4: blue / teal / indigo / sienna — kept clear of the plum accent). A
// voice's color is used for its identity swatch (left panel), its selection highlight on the
// score, and its insert-ghost preview — all three read from the SAME resolved color so they
// never drift out of sync. Defaults cycle through this palette by voice index; the user can
// override any voice with an arbitrary custom color (stored separately, checked first).
export const DEFAULT_VOICE_COLORS = ['#4a6fb3', '#2f8579', '#6a5cb8', '#b3683a'];

export const defaultVoiceColor = (index: number): string =>
  DEFAULT_VOICE_COLORS[index % DEFAULT_VOICE_COLORS.length];

/** custom overrides (keyed by voice id) win; otherwise cycle the default palette by index. */
export const resolveVoiceColor = (
  voiceId: string,
  index: number,
  overrides: Record<string, string>,
): string => overrides[voiceId] ?? defaultVoiceColor(index);

const HEX_COLOR = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i;

/** A colour typed as `#rrggbb`, `rrggbb`, `#rgb` or `rgb` (any case), as `#rrggbb` in lower case; `null` for anything else. */
export const parseHexColor = (text: string): string | null => {
  const match = HEX_COLOR.exec(text.trim());
  if (!match) return null;
  const digits = match[1].toLowerCase();
  return '#' + (digits.length === 3 ? [...digits].map((digit) => digit + digit).join('') : digits);
};


export interface HsvColor {
  hue: number;
  saturation: number;
  value: number;
}

/** Convert a normalized #rrggbb colour to degrees and percentages. */
export function hexToHsv(color: string): HsvColor {
  const [red, green, blue] = [1, 3, 5].map((start) => parseInt(color.slice(start, start + 2), 16) / 255);
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const chroma = max - min;
  let sector = 0;
  if (chroma > 0) {
    if (max === red) sector = (green - blue) / chroma;
    else if (max === green) sector = (blue - red) / chroma + 2;
    else sector = (red - green) / chroma + 4;
  }
  return {
    hue: (sector * 60 + 360) % 360,
    saturation: max === 0 ? 0 : (chroma / max) * 100,
    value: max * 100,
  };
}

/** Convert degrees in [0, 360) and percentages to a normalized #rrggbb colour. */
export function hsvToHex({ hue, saturation, value }: HsvColor): string {
  const brightness = value / 100;
  const chroma = brightness * (saturation / 100);
  const sector = hue / 60;
  const middle = chroma * (1 - Math.abs((sector % 2) - 1));
  const channels = [
    [chroma, middle, 0],
    [middle, chroma, 0],
    [0, chroma, middle],
    [0, middle, chroma],
    [middle, 0, chroma],
    [chroma, 0, middle],
  ][Math.floor(sector)];
  const offset = brightness - chroma;
  return '#' + channels.map((channel) => Math.round((channel + offset) * 255).toString(16).padStart(2, '0')).join('');
}
