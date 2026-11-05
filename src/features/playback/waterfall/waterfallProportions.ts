/** The scene is drawn on a plane of this width and scaled to the canvas, so every length in the waterfall is a fraction of the canvas width (÷ this), never a device pixel. */
export const PLANE_WIDTH = 464;
/** The height the plane is framed for; the real plane height follows the canvas aspect ratio. */
export const PLANE_HEIGHT = 480;

/** The lowest and highest key of a full piano, as MIDI pitches. */
export const KEY_RANGE = { min: 21, max: 108 } as const;
/** The pitch classes of the white keys, from C. */
export const NATURAL_PITCH_CLASSES: readonly number[] = [0, 2, 4, 5, 7, 9, 11];

/** A black key's width relative to a white key's. */
export const BLACK_KEY_WIDTH = 0.59;

