import { useSyncExternalStore } from 'react';
import { AuthRequiredError } from '@/core/auth/authorizedFetch';
import { useAuthPrompt } from '@/core/auth/authPrompt';
import { errorMessage } from '@/core/errorMessage';
import type { ScoreSource } from '@/core/model/scoreSource';
import { navigation as sharedNavigation, beatAtTime, timeAtBeat, type ScoreNavigation } from '@/core/navigation/ScoreNavigation';
import { draftSounds } from './draftSounds';
import { HttpPlaybackGateway } from './HttpPlaybackGateway';
import type { PlaybackAudio, PlaybackGateway, PlaybackMap, PlaybackSegment, SavedScorePlaybackGateway } from './PlaybackGateway';
import { MediaClock } from './MediaClock';
import { PcmStreamPlayer } from './PcmStreamPlayer';
import {
  DEFAULT_PLAYBACK_SETTINGS,
  validatePlaybackSettings,
  validateTransposition,
  withPlaybackSettings,
  type PitchRange,
  type PlaybackSettings,
} from './PlaybackSettings';
import { PlaybackCache } from './PlaybackCache';
import { LocalPreview, type PreviewTransport } from './LocalPreview';

export interface PlaybackState {
  listening: PlaybackSettings;
  playing: boolean;
  loading: boolean;
  paused: boolean;
  previewing: boolean;
  ready: boolean;
  mapLoading: boolean;
  seekBeats: number | null;
  /** The time a seek in flight goes to, for a seek made by the time of the route. */
  seekMs: number | null;
  error: string | null;
}
export type PlaybackListener = (state: PlaybackState) => void;

export interface PlaybackFrameBuffer {
  active(): boolean;
  prepare(map: PlaybackMap, timeMs: number, signal: AbortSignal): Promise<void> | undefined;
}

export interface PlaybackController {
  bindDraft(draftId: string | null): void;
  bindScore(scoreId: string | null): void;
  setListeningSettings(settings: PlaybackSettings, range: PitchRange): void;
  unlock(): void;
  documentChanged(snapshot?: string): void;
  prepareMap(): Promise<void>;
  cancelPreview(): void;
  play(): Promise<void>;
  previewCarrier(carrierId: string, sourceId: string, noteIds?: string[]): Promise<void>;
  pause(): void;
  stop(): void;
  seek(beats: number): void;
  /** A seek by the time of the route, which tells apart the passes of a repeated part that a place of the score cannot. */
  seekMs(ms: number): void;
  /** The sound is held while the position is moved by hand; `endScrub` puts it where it was left and goes on if it was playing. */
  beginScrub(): void;
  scrubTo(ms: number): void;
  endScrub(ms: number): void;
  setFrameBuffer(buffer: PlaybackFrameBuffer): () => void;
  getState(): PlaybackState;
  getOutputDelayMs(): number;
  /** Positive when the sound is heard later than the output reports. */
  setOutputDelayMs(milliseconds: number): void;
  subscribe(listener: PlaybackListener): () => void;
}

/** The state's time follows the playing sound at this interval; whoever needs every frame reads `getTimeMs()`. */
const TIME_STORE_INTERVAL_MS = 50;

const isAbort = (error: unknown) => error instanceof DOMException && error.name === 'AbortError';

/** The server supplies the musical plan; local synthesis follows its clock and anchors. */
export class ServerPlaybackController implements PlaybackController {
  private state: PlaybackState = {
    listening: { ...DEFAULT_PLAYBACK_SETTINGS },
    playing: false,
    loading: false,
    paused: false,
    previewing: false,
    ready: false,
    mapLoading: false,
    seekBeats: null, seekMs: null,
    error: null,
  };
  private source: ScoreSource | null = null;
  private rawMap: PlaybackMap | null = null;
  private listeners = new Set<PlaybackListener>();
  private request: AbortController | null = null;
  private seekRequest: AbortController | null = null;
  private mapRequest: AbortController | null = null;
  private mapPromise: Promise<PlaybackMap> | null = null;
  private generation = 0;
  private transportIntent: { running: boolean } | null = null;
  private clock = new MediaClock();
  private timeWrittenAt = 0;
  private player = new PcmStreamPlayer(0, (running) => this.audioState(running));
  private cache = new PlaybackCache();
  private frameBuffer: PlaybackFrameBuffer | undefined;
  private previews: PreviewTransport;
  private scrubResume = false;

  constructor(
    private gateway: PlaybackGateway = draftSounds,
    previews: PreviewTransport | undefined = undefined,
    private savedGateway: SavedScorePlaybackGateway = new HttpPlaybackGateway(),
    private navigation: ScoreNavigation = sharedNavigation,
  ) {
    this.previews = previews ?? new LocalPreview(gateway, savedGateway);
    this.navigation.attach(this.positionSource);
  }

  /** The position of the sound being heard now, read on the animation frame; null while no sound is running, when the navigation keeps the held position. */
  private positionSource = (): number | null => {
    if (!this.state.playing && !(this.state.paused && this.transportIntent?.running)) {
      this.clock.reset();
      return null;
    }
    const { timeMs } = this.navigation.getState();
    // Starting again from a pause, the picture goes on from where it was held, not from the sound.
    return this.clock.at(this.player.positionMs() ?? timeMs, this.state.paused ? timeMs : undefined);
  };

  bindDraft(draftId: string | null): void {
    this.bindSource(draftId ? { kind: 'draft', id: draftId } : null);
  }

  bindScore(scoreId: string | null): void {
    this.bindSource(scoreId ? { kind: 'saved', id: scoreId } : null);
  }

  private bindSource(source: ScoreSource | null): void {
    if (this.source?.kind === source?.kind && this.source?.id === source?.id) return;
    this.cancel();
    this.player.dispose();
    this.cache.clear();
    this.clearMap();
    this.previews.close();
    this.source = source;
    this.previews.bindSource?.(source);
    if (source) {
      void Promise.all([this.player.prepare(), this.cache.prepare(this.player.sampleRate)]).catch(() => {});
      void this.previews.prepare?.().catch(() => {});
    }
    this.navigation.update({ timeBeats: 0, timeMs: 0, totalBeats: 0 });
    this.set({ listening: { ...DEFAULT_PLAYBACK_SETTINGS }, ready: source !== null, error: null });
  }

  documentChanged(_snapshot = ''): void {
    this.cancel(false);
    this.cache.clear();
    this.clearMap();
    this.previews.invalidate?.();
    if (this.source) void this.cache.prepare(this.player.sampleRate).catch(() => {});
  }

  private clearMap(): void {
    this.mapRequest?.abort();
    this.mapRequest = null;
    this.mapPromise = null;
    this.rawMap = null;
    this.navigation.update({ map: null });
    this.set({ mapLoading: false });
  }

  private loadMap(): Promise<PlaybackMap> {
    const loaded = this.navigation.getState().map;
    if (loaded) return Promise.resolve(loaded);
    if (this.mapPromise) return this.mapPromise;
    const source = this.source;
    if (!source) return Promise.reject(new DOMException('No score is open.', 'AbortError'));
    const request = new AbortController();
    this.mapRequest = request;
    this.set({ mapLoading: true });
    const plan = source.kind === 'saved' ? this.savedGateway.mapScore(source.id, request.signal) : this.gateway.map(source.id, request.signal);
    const attempt = plan.then((map) => {
      if (this.mapRequest !== request || request.signal.aborted) throw new DOMException('Obsolete map.', 'AbortError');
      this.rawMap = map;
      const configured = withPlaybackSettings(map, this.state.listening);
      this.navigation.update({ map: configured });
      this.set({ mapLoading: false });
      return configured;
    });
    this.mapPromise = attempt;
    void attempt.catch(() => {
      if (this.mapPromise !== attempt) return;
      this.mapPromise = null;
      this.set({ mapLoading: false });
    });
    return attempt;
  }

  async prepareMap(): Promise<void> {
    const source = this.source;
    if (!source) return;
    try {
      await this.loadMap();
    } catch (error) {
      if (this.source !== source || isAbort(error)) return;
      if (error instanceof AuthRequiredError) {
        useAuthPrompt.getState().open(() => {
          if (this.source === source) void this.prepareMap();
        });
      } else {
        this.set({ error: errorMessage(error, 'Playback map could not load.') });
      }
    }
  }

  setListeningSettings(settings: PlaybackSettings, range: PitchRange): void {
    validatePlaybackSettings(settings);
    if (settings.speed === this.state.listening.speed && settings.transpose === this.state.listening.transpose) return;
    if (this.source?.kind !== 'saved' || !this.rawMap) throw new Error('Wait for the playback plan to load.');
    if (settings.transpose !== this.state.listening.transpose) validateTransposition(this.rawMap, settings.transpose, range);
    const map = withPlaybackSettings(this.rawMap, settings);
    const resume = this.state.playing || this.state.loading;
    const paused = this.state.paused;
    const current = this.navigation.getState();
    const beat = current.map ? beatAtTime(current.map, this.navigation.getTimeMs()) : current.timeBeats;
    this.cancel();
    this.cache.clear();
    this.navigation.update({ map, timeBeats: beat, timeMs: timeAtBeat(map, beat) });
    this.set({ listening: { ...settings }, paused, error: null });
    if (resume) void this.play();
    else void this.cache.prepare(this.player.sampleRate).catch(() => {});
  }

  unlock(): void {
    void this.previews.unlock().catch(() => {});
  }

  cancelPreview(): void {
    if (!this.state.previewing) return;
    this.generation++;
    this.previews.release();
    this.set({ previewing: false });
  }

  async previewCarrier(carrierId: string, sourceId: string, noteIds?: string[]): Promise<void> {
    if (!this.source || this.source.id !== sourceId) return;
    this.cancel(false);
    const generation = this.generation;
    this.set({ error: null, previewing: true });
    try {
      await this.previews.preview(
        sourceId,
        carrierId,
        noteIds,
        () => {
          if (generation === this.generation) this.set({ previewing: false });
        },
        (error) => {
          if (generation === this.generation) this.fail(error);
        },
        this.state.listening,
      );
    } catch (error) {
      if (generation === this.generation) this.fail(error, () => void this.previewCarrier(carrierId, sourceId, noteIds));
    }
  }

  async play(): Promise<void> {
    if (!this.source) return;
    if ((this.state.playing || this.state.paused) && this.request) {
      if (this.transportIntent?.running || (this.state.playing && !this.transportIntent)) return;
      const request = this.request;
      const intent = { running: true };
      this.transportIntent = intent;
      const current = () => this.request === request && this.transportIntent === intent;
      try {
        const { paused } = this.state;
        const { map, timeMs } = this.navigation.getState();
        const frames = paused && map ? this.frameBuffer?.prepare(map, timeMs, request.signal) : undefined;
        // Acquire audio permission within the gesture if the device interrupted the context.
        const ready = this.player.unlock();
        void ready.catch(() => {});
        if (frames) {
          this.set({ loading: true });
          await frames;
          if (!current()) return;
          if (map) await this.frameBuffer?.prepare(map, timeMs, request.signal);
        }
        await ready;
        if (!current()) return;
        const position = await this.player.resume();
        if (!current()) return;
        this.navigation.setTime(position ?? timeMs);
        this.set({ loading: false, playing: true, paused: false });
      } catch (error) {
        if (current()) {
          if (isAbort(error)) this.set({ loading: false });
          else this.fail(error);
        }
      } finally {
        if (this.transportIntent === intent) this.transportIntent = null;
      }
      return;
    }
    const { timeBeats, timeMs } = this.navigation.getState();
    await this.startAt(timeBeats, false, timeMs);
  }

  /** `ms` is where the sound starts when the place is known by its time (a pass of a repeated part); without it the first time the place of the score is reached. */
  private async startAt(beats: number, hold = false, ms: number | null = null): Promise<void> {
    this.cancel();
    const request = new AbortController();
    this.request = request;
    this.set({ loading: true, error: null, seekBeats: hold ? beats : null, seekMs: hold ? ms : null });
    try {
      await this.player.unlock();
      const map = await this.loadMap();
      if (request.signal.aborted) return;
      const startMs = ms ?? timeAtBeat(map, beats);
      if (startMs >= map.extentMs) {
        this.request = null;
        this.navigation.update({ timeMs: startMs, timeBeats: beats });
        this.set({ loading: false, seekBeats: null, seekMs: null });
        return;
      }
      const frames = this.frameBuffer?.prepare(map, startMs, request.signal);
      const audio = await this.cache.open(map, this.player.sampleRate, startMs);
      if (frames) {
        await frames;
        if (!request.signal.aborted) await this.frameBuffer?.prepare(map, startMs, request.signal);
      }
      if (request.signal.aborted) {
        void audio?.body.cancel();
        return;
      }
      if (audio) {
        await this.playAudio(audio, request, startMs);
      } else if (this.request === request) {
        this.request = null;
        this.set({ loading: false, playing: false, paused: false, seekBeats: null, seekMs: null });
      }
    } catch (error) {
      if (!request.signal.aborted) this.fail(error, () => void this.startAt(beats, hold));
    }
  }

  private async playAudio(audio: PlaybackAudio, request: AbortController, startMs: number, switching = false): Promise<void> {
    await this.player.play(
      audio,
      request.signal,
      () => {
        if (this.request === request) {
          this.navigation.setTime(this.player.positionMs() ?? startMs);
          this.set({ loading: false, playing: true, paused: false, seekBeats: null, seekMs: null });
        }
      },
      startMs,
      (ms) => {
        if (this.request !== request || !this.state.playing) return;
        const now = performance.now();
        if (now - this.timeWrittenAt < TIME_STORE_INTERVAL_MS) return;
        this.timeWrittenAt = now;
        this.navigation.setTime(ms);
      },
      false,
      () => {
        if (switching) {
          const previous = this.request;
          this.request = request;
          this.seekRequest = null;
          previous?.abort();
        }
        this.set({ error: null });
      },
    );
    if (this.request === request) {
      this.request = null;
      this.transportIntent = null;
      this.navigation.update({ activeCarrierIds: [] });
      this.set({ loading: false, playing: false, paused: false });
    }
  }

  seek(beats: number): void {
    if (!Number.isFinite(beats)) return;
    this.seekTo(Math.max(0, Math.min(beats, this.navigation.getState().totalBeats)), null);
  }

  seekMs(ms: number): void {
    const { map } = this.navigation.getState();
    if (!map || !Number.isFinite(ms)) return;
    const at = Math.max(0, Math.min(ms, map.extentMs));
    this.seekTo(beatAtTime(map, at), at);
  }

  /** `at` is the place in beats; `ms` its time when that is known (a pass of a repeated part), otherwise the first time the place is reached. */
  private seekTo(at: number, ms: number | null): void {
    this.seekRequest?.abort();
    this.seekRequest = null;
    const resuming = this.state.paused && this.transportIntent?.running === true;
    if (!resuming && (!this.state.playing || this.transportIntent?.running === false)) {
      const restart = this.state.loading;
      if (restart && (this.state.seekBeats !== null || this.frameBuffer?.active())) {
        void this.startAt(at, true, ms);
        return;
      }
      this.cancel();
      const { map } = this.navigation.getState();
      this.navigation.update({ timeBeats: at, timeMs: ms ?? (map ? timeAtBeat(map, at) : 0) });
      this.set({ error: null });
      if (restart) void this.play();
      return;
    }
    const request = new AbortController();
    this.seekRequest = request;
    this.set({ seekBeats: at, seekMs: ms });
    void (async () => {
      try {
        await this.player.unlock();
        if (request.signal.aborted) return;
        const map = await this.loadMap();
        const startMs = ms ?? timeAtBeat(map, at);
        if (startMs >= map.extentMs) {
          if (!request.signal.aborted) {
            this.cancel();
            this.navigation.update({ timeBeats: at, timeMs: startMs });
          }
          return;
        }
        const frames = this.frameBuffer?.prepare(map, startMs, request.signal);
        if (frames) {
          const timeMs = this.navigation.getTimeMs();
          const previous = this.request;
          this.request = request;
          this.seekRequest = null;
          this.navigation.update({ timeMs, timeBeats: beatAtTime(map, timeMs), activeCarrierIds: [] });
          this.set({ playing: false, loading: true, paused: false });
          previous?.abort();
          this.player.stop();
          await this.player.unlock();
          if (request.signal.aborted) return;
        }
        await this.cache.prepareAt(startMs, request.signal);
        if (request.signal.aborted) return;
        const audio = await this.cache.open(map, this.player.sampleRate, startMs);
        if (frames) {
          await frames;
          if (!request.signal.aborted) await this.frameBuffer?.prepare(map, startMs, request.signal);
        }
        if (request.signal.aborted) {
          void audio?.body.cancel();
          return;
        }
        if (audio) await this.playAudio(audio, request, startMs, !frames);
        else if (this.request === request) {
          this.request = null;
          this.set({ loading: false, seekBeats: null, seekMs: null });
        }
      } catch (error) {
        if (request.signal.aborted) return;
        if (this.request === request) {
          this.fail(error);
          return;
        }
        if (this.seekRequest === request) this.seekRequest = null;
        this.set({ seekBeats: null, seekMs: null, error: errorMessage(error, 'Seek could not prepare.') });
      }
    })();
  }

  beginScrub(): void {
    this.scrubResume = this.state.playing || (this.state.loading && this.request !== null);
    this.navigation.update({ held: true });
    this.pause();
  }

  scrubTo(ms: number): void {
    const { map } = this.navigation.getState();
    if (!map || !Number.isFinite(ms)) return;
    const at = Math.max(0, Math.min(ms, map.extentMs));
    this.navigation.update({ timeMs: at, timeBeats: beatAtTime(map, at), activeCarrierIds: [] });
  }

  endScrub(ms: number): void {
    const resume = this.scrubResume;
    this.scrubResume = false;
    this.navigation.update({ held: false });
    this.seekMs(ms);
    if (resume) void this.play();
  }

  pause(): void {
    this.seekRequest?.abort();
    this.seekRequest = null;
    const request = this.request;
    if (!this.state.playing || !request) return;
    if (this.transportIntent?.running === false) {
      void this.play();
      return;
    }
    const intent = { running: false };
    this.transportIntent = intent;
    this.set({ seekBeats: null, seekMs: null });
    const current = () => this.request === request && this.transportIntent === intent;
    void this.player.pause().then((position) => {
      if (current()) {
        this.navigation.setTime(this.clock.hold() ?? position ?? this.navigation.getState().timeMs);
        this.set({ playing: false, paused: true });
      }
    }).catch((error) => {
      if (current()) this.fail(error);
    }).finally(() => {
      if (this.transportIntent === intent) this.transportIntent = null;
    });
  }

  stop(): void {
    this.cancel();
    this.navigation.update({ timeBeats: 0, timeMs: 0 });
    this.set({ error: null });
  }

  private cancel(releasePreview = true): void {
    this.generation++;
    this.seekRequest?.abort();
    this.seekRequest = null;
    this.request?.abort();
    this.request = null;
    this.transportIntent = null;
    this.player.stop();
    if (releasePreview) this.previews.release();
    this.navigation.update({ activeCarrierIds: [] });
    this.set({ playing: false, loading: false, paused: false, previewing: false, seekBeats: null, seekMs: null });
  }

  private audioState(running: boolean): void {
    if (!this.request || this.request.signal.aborted || (running && (this.state.loading || this.transportIntent))) return;
    if (running ? !this.state.paused : !this.state.playing) return;
    const timeMs = (running ? null : this.clock.hold()) ?? this.player.positionMs() ?? this.navigation.getState().timeMs;
    this.navigation.setTime(timeMs);
    this.set({ playing: running, paused: !running });
  }

  private fail(error: unknown, retry?: () => void): void {
    if (isAbort(error)) return;
    const source = this.source;
    this.cancel();
    if (error instanceof AuthRequiredError) {
      useAuthPrompt.getState().open(() => {
        if (this.source === source && retry) retry();
      });
    } else {
      this.set({ error: errorMessage(error, 'Playback failed.') });
    }
  }

  setFrameBuffer(buffer: PlaybackFrameBuffer): () => void {
    this.frameBuffer = buffer;
    return () => {
      if (this.frameBuffer === buffer) this.frameBuffer = undefined;
    };
  }

  getState(): PlaybackState {
    return this.state;
  }

  getOutputDelayMs(): number {
    return this.clock.outputDelayMs;
  }

  setOutputDelayMs(milliseconds: number): void {
    this.clock.setOutputDelay(milliseconds);
  }

  subscribe(listener: PlaybackListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private set(patch: Partial<PlaybackState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener(this.state);
  }
}

export const playback: PlaybackController = new ServerPlaybackController();

export function usePlayback(): PlaybackState {
  return useSyncExternalStore(
    (cb) => playback.subscribe(() => cb()),
    () => playback.getState(),
  );
}

/** One value of the state, read so that the component renders only when that value changes — not
 *  on every tick of the clock. `select` must return something comparable with `===`. */
export function usePlaybackValue<T>(select: (state: PlaybackState) => T): T {
  return useSyncExternalStore(
    (cb) => playback.subscribe(() => cb()),
    () => select(playback.getState()),
  );
}
