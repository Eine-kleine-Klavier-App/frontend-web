/** A frame that arrives later than this after the previous one (a hidden tab, a stall) moves the line by this much only, so the line never leaps; a slow device whose frames take a few tenths of a second still keeps the pace. */
const MAX_STEP_MS = 250;

/**
 * The position of the line in wait mode: it runs at the pace of the playback (one millisecond of the
 * map per millisecond of the frame time) and stops at a limit, the start of the point that is waited
 * for. Reading it twice in one frame gives the same number.
 */
export class PracticeClock {
  private position = 0;
  private limit = 0;
  private lastFrame: number | null = null;
  private running = false;

  /** Put the line at `positionMs` and stop it there. */
  reset(positionMs: number): void {
    this.position = positionMs;
    this.lastFrame = null;
  }

  setLimit(limitMs: number): void {
    this.limit = limitMs;
  }

  /** Let the line run (from the next frame) or hold it where it is. */
  setRunning(running: boolean): void {
    if (this.running === running) return;
    this.running = running;
    this.lastFrame = null;
  }

  /** The position at the frame time `frameMs`. */
  at(frameMs: number): number {
    if (this.running && this.lastFrame !== null && frameMs > this.lastFrame) {
      this.position = Math.min(this.limit, this.position + Math.min(MAX_STEP_MS, frameMs - this.lastFrame));
    }
    if (this.running) this.lastFrame = frameMs;
    return this.position;
  }

  /** Where the line stands, without moving it. */
  get positionMs(): number {
    return this.position;
  }

  /** True when the line stands at its limit: it waits for a press. */
  get waiting(): boolean {
    return this.position >= this.limit;
  }
}
