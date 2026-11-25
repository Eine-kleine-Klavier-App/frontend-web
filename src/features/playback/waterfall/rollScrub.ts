import { navigation } from '@/core/navigation/ScoreNavigation';
import type { TransportScrub } from '../Transport';

/** Counted in the height of the roll, so the same gesture is the same share of it on any screen: a shift smaller than this is a touch, not a scroll. */
const DEAD_ZONE_OF_HEIGHT = 0.015;
/** A wheel gesture ends when the wheel has been still this long. */
export const WHEEL_IDLE_MS = 150;
/** A wheel that counts lines: a line is this many pixels of text. */
export const WHEEL_LINE_PX = 16;

export interface RollScrubSource {
  /** What moves the position by hand; none while the screen has no position to move. */
  scrub: () => TransportScrub | undefined;
  /** How many pixels of the roll one second of the music is, at the keys. */
  pixelsPerSecond: () => number;
  /** Where the keys begin, in pixels from the top of the roll: nothing below it is the roll. */
  keysTop: () => number;
  /** The length of the music in milliseconds. */
  totalMs: () => number;
}

/**
 * The roll of a waterfall is scrolled like a page: the wheel, two fingers on a trackpad, or a finger (or the pressed mouse) dragged along it carry the notes with them, and the music is where they stand.
 * Down moves the notes toward the keys, the music forward. The sound is held while it moves and goes on from where it is left, as with the lines of the timeline.
 * It is made not to go off by chance: a shift smaller than a dead zone is nothing, a gesture ends when the wheel has been still, a click without a move does nothing,
 * and the keys and everything laid over the roll (the timeline, the controls) are not the roll. (A wheel is a gesture made on purpose: it is not held back until the pointer has stood still, which lost the first scroll of every visit.)
 * Returns what takes it off.
 */
export function attachRollScrub(roll: HTMLElement, source: RollScrubSource): () => void {
  /** The scrub in progress, by the wheel or by the pointer, and the time it has come to. */
  let held: { scrub: TransportScrub; ms: number } | null = null;
  let press: { id: number; y: number } | null = null;
  let wheelIdle = 0;
  let wheelShift = 0;

  const begin = (): boolean => {
    const scrub = source.scrub();
    if (!scrub) return false;
    scrub.begin();
    held = { scrub, ms: navigation.getTimeMs() };
    return true;
  };
  /** The notes moved this many pixels down the roll. */
  const carry = (pixels: number) => {
    const speed = source.pixelsPerSecond();
    if (!held || !(speed > 0)) return;
    held.ms = Math.max(0, Math.min(source.totalMs(), held.ms + pixels / speed * 1000));
    held.scrub.to(held.ms);
  };
  const end = () => {
    if (!held) return;
    held.scrub.end(held.ms);
    held = null;
  };
  const onRoll = (clientY: number) => clientY - roll.getBoundingClientRect().top < source.keysTop();

  const onWheel = (event: WheelEvent) => {
    if (event.ctrlKey || !source.scrub() || !onRoll(event.clientY) || press) return;
    event.preventDefault();
    const height = roll.clientHeight;
    // a page scrolled down moves up under the pointer: here the notes move up, the music goes back
    const pixels = -event.deltaY * (event.deltaMode === 1 ? WHEEL_LINE_PX : event.deltaMode === 2 ? height : 1);
    window.clearTimeout(wheelIdle);
    wheelIdle = window.setTimeout(() => {
      wheelShift = 0;
      end();
    }, WHEEL_IDLE_MS);
    if (held) {
      carry(pixels);
      return;
    }
    wheelShift += pixels;
    // what came in while it was still a touch is carried when it turns into a scroll, so one notch of a wheel (one big event) moves
    if (Math.abs(wheelShift) >= DEAD_ZONE_OF_HEIGHT * height && begin()) carry(wheelShift);
  };
  const onDown = (event: PointerEvent) => {
    if ((event.pointerType === 'mouse' && event.button !== 0) || !source.scrub() || !onRoll(event.clientY) || held) return;
    press = { id: event.pointerId, y: event.clientY };
    roll.setPointerCapture(event.pointerId);
  };
  const onMove = (event: PointerEvent) => {
    if (!press || event.pointerId !== press.id) return;
    const shift = event.clientY - press.y;
    if (!held) {
      if (Math.abs(shift) < DEAD_ZONE_OF_HEIGHT * roll.clientHeight || !begin()) return;
      // what lay inside the dead zone is not carried
      press.y = event.clientY;
      return;
    }
    press.y = event.clientY;
    carry(shift);
  };
  const onUp = (event: PointerEvent) => {
    if (!press || event.pointerId !== press.id) return;
    press = null;
    end();
  };

  const touchAction = roll.style.touchAction;
  roll.style.touchAction = 'none';
  roll.addEventListener('wheel', onWheel, { passive: false });
  roll.addEventListener('pointerdown', onDown);
  roll.addEventListener('pointermove', onMove);
  roll.addEventListener('pointerup', onUp);
  roll.addEventListener('pointercancel', onUp);
  return () => {
    window.clearTimeout(wheelIdle);
    end();
    roll.style.touchAction = touchAction;
    roll.removeEventListener('wheel', onWheel);
    roll.removeEventListener('pointerdown', onDown);
    roll.removeEventListener('pointermove', onMove);
    roll.removeEventListener('pointerup', onUp);
    roll.removeEventListener('pointercancel', onUp);
  };
}
