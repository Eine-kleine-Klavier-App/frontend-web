import * as Tone from 'tone';
import { useSyncExternalStore } from 'react';
import type { PlaybackEvent } from './scoreToEvents';

const BPM = 100;
const SECONDS_PER_BEAT = 60 / BPM;

/**
 * One global preview player, independent of the editor's own `PlaybackController`
 * (`src/core/playback/`) — hovering/tapping a card's play button never touches the Editor or
 * Practice transport, and vice versa. Exactly one preview plays at a time: starting a second
 * card's preview stops whichever one is currently playing (the Spotify pattern).
 *
 * Deliberately NOT built on `Tone.Transport` (the one global transport Tone.js exposes) — a
 * plain `setTimeout` schedule is precise enough for a few seconds of preview audio, is trivially
 * cancellable (`clearTimeout`, no `Transport.cancel()`/position bookkeeping), and leaves the
 * shared Transport untouched for whatever the Editor/Practice's own future Tone.js-backed
 * transport (see `PlaybackController.ts`'s "Tone.js later" comment) ends up needing it for.
 */
class PreviewPlayerImpl {
  private synth: Tone.PolySynth | null = null;
  private timeouts: ReturnType<typeof setTimeout>[] = [];
  private currentId: string | null = null;
  private listeners = new Set<() => void>();

  private ensureSynth(): Tone.PolySynth {
    if (!this.synth) this.synth = new Tone.PolySynth(Tone.Synth).toDestination();
    return this.synth;
  }

  /** Starts `id`'s preview, replacing whatever was already playing. Toggling the SAME id (a
   *  second click on the card that's already playing) stops it instead — a plain pause. Requires
   *  a user gesture (`Tone.start()`'s browser-autoplay-policy requirement), so this must be
   *  called from a click/hover handler, never on mount/effect. */
  async play(id: string, events: PlaybackEvent[]): Promise<void> {
    const wasPlaying = this.currentId === id;
    this.stop();
    if (wasPlaying) return;

    await Tone.start();
    const synth = this.ensureSynth();
    this.currentId = id;
    this.notify();

    for (const event of events) {
      const delayMs = event.startBeat * SECONDS_PER_BEAT * 1000;
      const durationSec = event.durationBeats * SECONDS_PER_BEAT;
      this.timeouts.push(setTimeout(() => synth.triggerAttackRelease(event.note, durationSec), delayMs));
    }

    const totalMs = events.length
      ? Math.max(...events.map((e) => (e.startBeat + e.durationBeats) * SECONDS_PER_BEAT * 1000))
      : 0;
    this.timeouts.push(
      setTimeout(() => {
        if (this.currentId === id) this.stop();
      }, totalMs + 60),
    );
  }

  stop(): void {
    for (const t of this.timeouts) clearTimeout(t);
    this.timeouts = [];
    this.synth?.releaseAll();
    if (this.currentId !== null) {
      this.currentId = null;
      this.notify();
    }
  }

  getCurrentId(): string | null {
    return this.currentId;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const l of this.listeners) l();
  }
}

export const previewPlayer = new PreviewPlayerImpl();

/** The id of the card currently playing (or null) — re-renders whichever card's play button
 *  needs to flip icon when this changes, without every card polling. */
export function usePreviewPlayingId(): string | null {
  return useSyncExternalStore(
    (cb) => previewPlayer.subscribe(cb),
    () => previewPlayer.getCurrentId(),
  );
}
