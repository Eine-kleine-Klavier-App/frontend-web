import * as Tone from 'tone';
import { useSyncExternalStore } from 'react';
import type { ScoreDocument } from '@/core/model/score';
import type { PlaybackEvent } from './scoreToEvents';

const BPM = 100;
const SECONDS_PER_BEAT = 60 / BPM;

/** The display identity of the preview currently owning the global player. Keeping it beside the
 *  transport state makes background playback immediately renderable without a second catalog
 *  request (and without the Now Playing surface depending on whichever card started it). */
export interface PreviewTrack {
  id: string;
  /** A branch keeps its canonical/root score as the panel context even when playback is collapsed. */
  parentScoreId?: string;
  title: string;
  composer?: string | null;
  coverImageUrl: string | null;
  previewDocument: ScoreDocument | null;
}

export type PreviewPlaybackPhase = 'idle' | 'playing' | 'paused' | 'replay';

/** The one public playback truth. Track identity and transport phase change atomically, so every
 *  card, panel and dock observes the same render snapshot rather than combining separate hooks. */
export type PreviewPlaybackSnapshot =
  | { track: null; phase: 'idle' }
  | { track: PreviewTrack; phase: 'playing' | 'paused' | 'replay' };

const EMPTY_SNAPSHOT: PreviewPlaybackSnapshot = { track: null, phase: 'idle' };

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
  /** Replaced as one immutable object on every public transition — required by
   *  `useSyncExternalStore` and prevents track/phase tearing between consumers. */
  private snapshot: PreviewPlaybackSnapshot = EMPTY_SNAPSHOT;
  private events: PlaybackEvent[] = [];
  private elapsedMs = 0;
  private totalMs = 0;
  private startedAtMs: number | null = null;
  /** Invalidates an async `Tone.start()` continuation when another play/stop wins first. */
  private generation = 0;
  private listeners = new Set<() => void>();

  private ensureSynth(): Tone.PolySynth {
    if (!this.synth) this.synth = new Tone.PolySynth(Tone.Synth).toDestination();
    return this.synth;
  }

  /** Starts `track`'s preview, replacing whatever was already playing. Toggling the SAME id
   *  pauses/resumes from the current position; only dismissing the player discards the timeline. Requires
   *  a user gesture (`Tone.start()`'s browser-autoplay-policy requirement), so this must be
   *  called from a click/hover handler, never on mount/effect. */
  async play(track: PreviewTrack, events: PlaybackEvent[]): Promise<void> {
    const sameTrack = this.snapshot.track?.id === track.id;
    if (sameTrack && this.snapshot.phase === 'playing') {
      this.pause();
      return;
    }
    if (!sameTrack || this.snapshot.phase === 'replay') {
      this.cancelScheduledAudio();
      this.events = events;
      this.elapsedMs = 0;
      this.totalMs = events.length
        ? Math.max(...events.map((event) => (event.startBeat + event.durationBeats) * SECONDS_PER_BEAT * 1000))
        : 0;
    }

    // Playback intent is UI state and lands in the input frame; audio initialization catches up
    // asynchronously. This makes the button and Now Playing dock respond immediately even on the
    // first browser gesture, while `generation` prevents an older start from stealing a newer one.
    const generation = this.generation;
    this.snapshot = { track, phase: 'playing' };
    this.notify();
    try {
      await Tone.start();
    } catch {
      if (this.generation === generation) this.finish();
      return;
    }
    if (this.generation !== generation || this.snapshot.track?.id !== track.id) return;

    const synth = this.ensureSynth();
    this.startedAtMs = performance.now();

    for (const event of this.events) {
      const startMs = event.startBeat * SECONDS_PER_BEAT * 1000;
      const endMs = (event.startBeat + event.durationBeats) * SECONDS_PER_BEAT * 1000;
      if (endMs <= this.elapsedMs) continue;
      const audibleStartMs = Math.max(startMs, this.elapsedMs);
      const delayMs = audibleStartMs - this.elapsedMs;
      const durationSec = (endMs - audibleStartMs) / 1000;
      this.timeouts.push(
        setTimeout(() => {
          if (this.generation === generation) synth.triggerAttackRelease(event.note, durationSec);
        }, delayMs),
      );
    }

    this.timeouts.push(
      setTimeout(() => {
        if (
          this.generation === generation &&
          this.snapshot.phase === 'playing' &&
          this.snapshot.track?.id === track.id
        ) {
          this.finish();
        }
      }, Math.max(0, this.totalMs - this.elapsedMs) + 60),
    );
  }

  /** Suspends the active schedule while retaining its exact elapsed position for resume. */
  pause(): void {
    if (this.snapshot.phase !== 'playing') return;
    const track = this.snapshot.track;
    if (this.startedAtMs !== null) {
      this.elapsedMs = Math.min(this.totalMs, this.elapsedMs + performance.now() - this.startedAtMs);
    }
    this.cancelScheduledAudio();
    this.snapshot = { track, phase: 'paused' };
    this.notify();
  }

  /** Closes both playback and its retained Now Playing context — the only full-stop action. */
  dismiss(): void {
    const hadContext = this.snapshot.track !== null;
    this.cancelScheduledAudio();
    this.resetTimeline();
    if (hadContext) {
      this.snapshot = EMPTY_SNAPSHOT;
      this.notify();
    }
  }

  /** A completed preview is only useful while that same piece remains the selected context.
   *  Choosing a different piece clears the stale Replay affordance, but deliberately leaves an
   *  actively playing preview alone — background playback is a separate, established behavior. */
  clearReplayForSelection(scoreId: string): void {
    if (this.snapshot.phase !== 'replay') return;
    const { track } = this.snapshot;
    if (track.id !== scoreId && track.parentScoreId !== scoreId) this.dismiss();
  }

  private finish(): void {
    const track = this.snapshot.track;
    this.cancelScheduledAudio();
    this.resetTimeline();
    if (track) {
      this.snapshot = { track, phase: 'replay' };
      this.notify();
    }
  }

  private cancelScheduledAudio(): void {
    this.generation += 1;
    for (const t of this.timeouts) clearTimeout(t);
    this.timeouts = [];
    this.startedAtMs = null;
    this.synth?.releaseAll();
  }

  private resetTimeline(): void {
    this.events = [];
    this.elapsedMs = 0;
    this.totalMs = 0;
    this.startedAtMs = null;
  }

  getSnapshot(): PreviewPlaybackSnapshot {
    return this.snapshot;
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

/** The only React subscription to preview playback. Consumers derive their local presentation
 *  from this exact object, so Now Playing and every transport control update in one notification. */
export function usePreviewPlayback(): PreviewPlaybackSnapshot {
  return useSyncExternalStore(
    (cb) => previewPlayer.subscribe(cb),
    () => previewPlayer.getSnapshot(),
  );
}

/** Maps the global snapshot to the transport phase for one score. A different selected track is
 *  simply idle for this control; the retained selected track consistently exposes Replay. */
export function previewControlPhase(
  snapshot: PreviewPlaybackSnapshot,
  scoreId: string,
): PreviewPlaybackPhase {
  return snapshot.track?.id === scoreId ? snapshot.phase : 'idle';
}
