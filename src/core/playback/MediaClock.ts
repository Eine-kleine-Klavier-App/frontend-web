/** A difference from the sound is made up over this long by running a little faster or slower. */
const CORRECTION_MS = 1000;
/** The picture never runs more than this share faster or slower than the frame time. */
const MAX_SLEW = 0.1;
/** A difference larger than this is a jump of the sound itself (a seek, a device change), followed at once. */
const JUMP_MS = 250;
const OFFSET_STORAGE_KEY = 'piano.audioDelayMs';

/** The delay between the clock's sound and the speaker, set by the listener for a device the browser reports wrongly. */
function readStoredOffset(): number {
  try {
    const stored = Number(globalThis.localStorage?.getItem(OFFSET_STORAGE_KEY));
    return Number.isFinite(stored) ? stored : 0;
  } catch {
    return 0;
  }
}

/** The time of the animation frame being drawn: the same for every reader inside one frame. */
export function frameTimeMs(): number {
  const frame = typeof document === 'undefined' ? null : document.timeline?.currentTime;
  return frame === null || frame === undefined ? performance.now() : Number(frame);
}

/**
 * The one clock the picture reads. The audio output reports its position in render quanta, so the
 * clock runs on the frame time and the sound only steers its rate, so the picture cannot jump or run
 * backwards. After a start or a reset it waits while the sound stands and starts in the frame the
 * sound moves; a jump of the sound (seek, device change) is followed at once.
 */
export class MediaClock {
  private last: { at: number; position: number; rate: number; heard: number; running: boolean } | null = null;
  private offsetMs = readStoredOffset();

  /**
   * `heard` is the position of the sound reaching the output, in milliseconds. `from` is where the picture
   * stood when the transport was held: a reading that has no running position before it starts there, not at
   * the sound.
   */
  at(heard: number, from?: number): number {
    const now = frameTimeMs();
    const target = heard - this.offsetMs;
    const last = this.last;
    if (!last || (last.running && Math.abs(target - last.position) > JUMP_MS)) {
      const position = !last && from !== undefined ? from : target;
      this.last = { at: now, position, rate: 1, heard: target, running: false };
      return position;
    }
    if (!last.running) {
      // The picture waits with the sound: it starts in the frame the sound moves, from where it stood.
      last.at = now;
      if (target !== last.heard) last.running = true;
      return last.position;
    }
    const elapsed = now - last.at;
    if (elapsed <= 0) return last.position;
    const position = last.position + elapsed * last.rate;
    // The picture runs at the frame time; the sound only steers its rate, so it never jumps or runs backwards.
    const rate = 1 + Math.max(-MAX_SLEW, Math.min(MAX_SLEW, (target - position) / CORRECTION_MS));
    this.last = { at: now, position, rate, heard: target, running: true };
    return position;
  }

  /** The transport is held: the position the picture showed last, which is where it must stand, or null when nothing was shown. */
  hold(): number | null {
    const shown = this.last ? this.last.position : null;
    this.last = null;
    return shown;
  }

  /** Forget the running position: the transport is not playing, the next reading starts from the sound. */
  reset(): void {
    this.last = null;
  }

  get outputDelayMs(): number {
    return this.offsetMs;
  }

  /** Positive when the sound is heard later than the output reports. */
  setOutputDelay(milliseconds: number): void {
    this.offsetMs = Number.isFinite(milliseconds) ? milliseconds : 0;
    this.last = null;
    try {
      globalThis.localStorage?.setItem(OFFSET_STORAGE_KEY, String(this.offsetMs));
    } catch {
      // The delay still holds for this session.
    }
  }
}

const frameListeners = new Set<(frameTime: number) => void>();
let frameHandle = 0;

function runFrame(frameTime: number): void {
  frameHandle = 0;
  for (const listener of [...frameListeners]) listener(frameTime);
  if (frameListeners.size) frameHandle = requestAnimationFrame(runFrame);
}

/** One animation-frame loop for everything that follows the clock; `listener` gets the frame time. */
export function onAnimationFrame(listener: (frameTime: number) => void): () => void {
  frameListeners.add(listener);
  if (!frameHandle) frameHandle = requestAnimationFrame(runFrame);
  return () => {
    frameListeners.delete(listener);
    if (!frameListeners.size && frameHandle) {
      cancelAnimationFrame(frameHandle);
      frameHandle = 0;
    }
  };
}
