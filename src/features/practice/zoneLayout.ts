/** A strip of notes with less room than this, as a fraction of the width, is not shown. The keys are shown whole or not at all, never squeezed or cut. */
const STRIP_HIDDEN_BELOW = 0.07;
/** The keyboard's height as a fraction of the width, until the real one is measured. */
export const KEYS_HEIGHT_OF_WIDTH = 0.17;
/** The keys zone is this much taller than the keyboard drawing: the keyboard stands at the bottom and the sky shows above it. */
const KEYS_ZONE_OF_KEYS = 1.1;

export interface ZoneInput {
  width: number;
  height: number;
  /** The height of the keyboard drawing at this width. */
  keysHeight: number;
}

export interface Zones {
  /** The notes zone on top, the keys zone below it: together they fill the height. */
  keysZone: number;
  notesZone: number;
  keysShown: boolean;
  notesShown: boolean;
}

/** The keys zone has its own height and the strip of notes the rest. Each has its smallest form and then goes: its room is given to the other one. */
export function zoneLayout({ width, height, keysHeight }: ZoneInput): Zones {
  const keysWhole: number = keysHeight * KEYS_ZONE_OF_KEYS;
  const keysShown: boolean = height >= keysWhole;
  let keys: number = keysShown ? keysWhole : 0;
  const notesShown: boolean = height - keys >= STRIP_HIDDEN_BELOW * width;
  if (keysShown && !notesShown) keys = height;
  return { keysZone: keys, notesZone: height - keys, keysShown: keys > 0, notesShown };
}
