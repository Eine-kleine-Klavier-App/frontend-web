export const WATERFALL_FRAME_MS = 1000 / 60;
const FRAME_PIXEL_BUDGET = 1_073_741;
const SURFACE_PIXEL_BUDGET = 1_280_000;
const KEYBOARD_PIXEL_BUDGET = 520_000;
const WINDOWS_BEHIND = 5;
const WINDOWS_AHEAD = 10;
const PREPARE_BATCH = 8;

/** Limit the backing store independently of the keyboard's on-screen geometry. */
export function waterfallRasterRatio(width: number, height: number, deviceRatio: number): number {
  return fitRasterRatio(width, height, deviceRatio, FRAME_PIXEL_BUDGET);
}

export function waterfallSurfaceRatios(width: number, rollHeight: number, keyboardHeight: number, deviceRatio: number) {
  const keyboard = fitRasterRatio(width, keyboardHeight, Math.min(deviceRatio, 2), KEYBOARD_PIXEL_BUDGET);
  const keyboardArea = rasterArea(width, keyboardHeight, keyboard);
  const roll = fitRasterRatio(width, rollHeight, Math.min(keyboard, 1.5),
    Math.min(FRAME_PIXEL_BUDGET, SURFACE_PIXEL_BUDGET - keyboardArea));
  return { roll, keyboard };
}

function rasterArea(width: number, height: number, scale: number): number {
  return Math.max(1, Math.round(width * scale)) * Math.max(1, Math.round(height * scale));
}

function fitRasterRatio(width: number, height: number, deviceRatio: number, budget: number): number {
  const ratio = Math.min(deviceRatio, Math.sqrt(budget / (width * height)));
  if (rasterArea(width, height, ratio) <= budget) return ratio;

  let fits = 0;
  let exceeds = ratio;
  for (let step = 0; step < 20; step++) {
    const middle = (fits + exceeds) / 2;
    if (rasterArea(width, height, middle) <= budget) fits = middle;
    else exceeds = middle;
  }
  return fits;
}

export interface WaterfallWindowSource {
  /** Sorted bar starts, including zero. All times are in seconds. */
  bars: readonly number[];
  extent: number;
  starts: Float64Array;
  latestExpiry: Float64Array;
  pedalStarts: Float64Array;
}

export interface WaterfallWindow {
  id: number;
  from: number;
  to: number;
  noteFrom: number;
  noteTo: number;
  pedalFrom: number;
  pedalTo: number;
}

function firstAfter(values: readonly number[] | Float64Array, time: number, inclusive = false): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (values[middle] < time || (inclusive && values[middle] === time)) low = middle + 1;
    else high = middle;
  }
  return low;
}

export function waterfallWindowId(source: WaterfallWindowSource, time: number): number {
  return Math.max(0, firstAfter(source.bars, time, true) - 1);
}

/** The conservative bounds cover any frame in the measure, including overlapping notes. */
export function prepareWaterfallWindow(source: WaterfallWindowSource, id: number, visibleAhead: number): WaterfallWindow {
  const from = source.bars[id];
  const to = source.bars[id + 1] ?? source.extent;
  return {
    id, from, to,
    noteFrom: firstAfter(source.latestExpiry, from),
    noteTo: firstAfter(source.starts, to + visibleAhead, true),
    pedalFrom: Math.max(0, firstAfter(source.pedalStarts, from, true) - 1),
    pedalTo: firstAfter(source.pedalStarts, to, true),
  };
}

export type WaterfallWorkerRequest =
  | { type: 'configure'; generation: number; source: WaterfallWindowSource }
  | { type: 'prepare'; generation: number; request: number; ids: number[]; visibleAhead: number };

export type WaterfallWorkerResponse = {
  generation: number;
  request: number;
  windows: WaterfallWindow[];
};

/** Data only. The 16 measures share the same immutable piece index. */
export class WaterfallWindowCache {
  private readonly windows = new Map<number, WaterfallWindow>();
  private first = 0;
  private last = -1;

  moveTo(id: number, end: number): void {
    this.first = Math.max(0, id - WINDOWS_BEHIND);
    this.last = Math.min(end, id + WINDOWS_AHEAD);
    for (const existing of this.windows.keys()) {
      if (existing < this.first || existing > this.last) this.windows.delete(existing);
    }
  }

  get(id: number): WaterfallWindow | undefined {
    return this.windows.get(id);
  }

  missing(current: number): number[] {
    const ids: number[] = [];
    // The requested bar and its immediate future take priority over speculative lookbehind.
    for (let id = current; id <= this.last && ids.length < PREPARE_BATCH; id++) {
      if (!this.windows.has(id)) ids.push(id);
    }
    for (let id = current - 1; id >= this.first && ids.length < PREPARE_BATCH; id--) {
      if (!this.windows.has(id)) ids.push(id);
    }
    return ids;
  }

  add(windows: readonly WaterfallWindow[]): void {
    for (const window of windows) {
      if (window.id >= this.first && window.id <= this.last) this.windows.set(window.id, window);
    }
  }

  clear(): void {
    this.windows.clear();
  }
}
