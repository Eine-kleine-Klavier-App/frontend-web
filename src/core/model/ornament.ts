import type { OrnamentMark } from './score';

// The ornaments of a carrier as the backend holds them: one value, `none` or one of eight (five signs above the note and the three tremolos on its stem). How an
// ornament sounds is the backend's (the projection expands it into notes); the editor only sets it
// and draws its sign.

export type OrnamentSign = Exclude<OrnamentMark, 'none'>;

/** `glyphs` are the SMuFL glyphs of the chip, stacked when there are several (the font has one stroke of a tremolo: two or three strokes are that glyph twice or three times). */
export const ORNAMENT_SIGNS: { value: OrnamentSign; label: string; glyphs: string[] }[] = [
  { value: 'trill', label: 'Trill', glyphs: ['ornamentTrill'] },
  { value: 'upper_mordent', label: 'Upper mordent', glyphs: ['ornamentShortTrill'] },
  { value: 'lower_mordent', label: 'Lower mordent', glyphs: ['ornamentMordent'] },
  { value: 'turn', label: 'Turn', glyphs: ['ornamentTurn'] },
  // the glyph VexFlow itself draws for it in the score (its font has no `ornamentTurnInverted`)
  { value: 'inverted_turn', label: 'Inverted turn', glyphs: ['ornamentTurnSlash'] },
  { value: 'tremolo_1', label: 'Tremolo, one stroke', glyphs: ['tremolo1'] },
  { value: 'tremolo_2', label: 'Tremolo, two strokes', glyphs: ['tremolo1', 'tremolo1'] },
  { value: 'tremolo_3', label: 'Tremolo, three strokes', glyphs: ['tremolo1', 'tremolo1', 'tremolo1'] },
];

/** The ornaments drawn as strokes across the stem, with their number of strokes. */
export const TREMOLO_STROKES: Partial<Record<OrnamentSign, number>> = { tremolo_1: 1, tremolo_2: 2, tremolo_3: 3 };
