import { useSyncExternalStore } from 'react';
import { AuthRequiredError } from '@/core/auth/authorizedFetch';
import { useAuthPrompt } from '@/core/auth/authPrompt';
import { errorMessage } from '@/core/errorMessage';
import type { ScoreSource } from '@/core/model/scoreSource';
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
  map: PlaybackMap | null;
  timeMs: number;
  timeBeats: number;
  seekBeats: number | null;
  totalBeats: number;
  error: string | null;
  activeCarrierIds: string[];
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
  setTotalBeats(total: number): void;
  setFrameBuffer(buffer: PlaybackFrameBuffer): () => void;
  getState(): PlaybackState;
  /** The position of the sound being heard now, read on the animation frame; the state's time is written only on transport events and a few times a second. */
  getTimeMs(): number;
  getTimeBeats(): number;
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
    map: null,
    timeMs: 0,
    timeBeats: 0,
    seekBeats: null,
    totalBeats: 0,
    error: null,
    activeCarrierIds: [],
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

  constructor(
    private gateway: PlaybackGateway = draftSounds,
    previews: PreviewTransport | undefined = undefined,
    private savedGateway: SavedScorePlaybackGateway = new HttpPlaybackGateway(),
  ) {
    this.previews = previews ?? new LocalPreview(gateway, savedGateway);
  }

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
    this.set({ listening: { ...DEFAULT_PLAYBACK_SETTINGS }, ready: source !== null, timeBeats: 0, timeMs: 0, totalBeats: 0, error: null });
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
    this.set({ map: null, mapLoading: false });
  }

  private loadMap(): Promise<PlaybackMap> {
    if (this.state.map) return Promise.resolve(this.state.map);
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
      this.set({ map: configured, mapLoading: false });
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
    const beat = this.state.map ? beatAtTime(this.state.map, this.getTimeMs()) : this.state.timeBeats;
    this.cancel();
    this.cache.clear();
    this.set({ listening: { ...settings }, map, timeBeats: beat, timeMs: timeAtBeat(map, beat), paused, error: null });
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
        const { paused, map, timeMs } = this.state;
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
        this.set({ ...this.positionPatch(position ?? timeMs), loading: false, playing: true, paused: false });
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
    await this.startAt(this.state.timeBeats);
  }

  private async startAt(beats: number, hold = false): Promise<void> {
    this.cancel();
    const request = new AbortController();
    this.request = request;
    this.set({ loading: true, error: null, seekBeats: hold ? beats : null });
    try {
      await this.player.unlock();
      const map = await this.loadMap();
      if (request.signal.aborted) return;
      const startMs = timeAtBeat(map, beats);
      if (startMs >= map.extentMs) {
        this.request = null;
        this.set({ loading: false, seekBeats: null, timeMs: startMs, timeBeats: beats });
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
        this.set({ loading: false, playing: false, paused: false, seekBeats: null });
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
        if (this.request === request) this.set({ ...this.positionPatch(this.player.positionMs() ?? startMs),
          loading: false, playing: true, paused: false, seekBeats: null });
      },
      startMs,
      (ms) => {
        if (this.request !== request || !this.state.playing) return;
        const now = performance.now();
        if (now - this.timeWrittenAt < TIME_STORE_INTERVAL_MS) return;
        this.timeWrittenAt = now;
        this.set(this.positionPatch(ms));
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
      this.set({ loading: false, playing: false, paused: false, activeCarrierIds: [] });
    }
  }

  seek(beats: number): void {
    if (!Number.isFinite(beats)) return;
    const at = Math.max(0, Math.min(beats, this.state.totalBeats));
    this.seekRequest?.abort();
    this.seekRequest = null;
    if (!this.state.playing || this.transportIntent?.running === false) {
      const restart = this.state.loading;
      if (restart && (this.state.seekBeats !== null || this.frameBuffer?.active())) {
        void this.startAt(at, true);
        return;
      }
      this.cancel();
      this.set({ timeBeats: at, timeMs: this.state.map ? timeAtBeat(this.state.map, at) : 0, error: null });
      if (restart) void this.play();
      return;
    }
    const request = new AbortController();
    this.seekRequest = request;
    this.set({ seekBeats: at });
    void (async () => {
      try {
        await this.player.unlock();
        if (request.signal.aborted) return;
        const map = await this.loadMap();
        const startMs = timeAtBeat(map, at);
        if (startMs >= map.extentMs) {
          if (!request.signal.aborted) {
            this.cancel();
            this.set({ timeBeats: at, timeMs: startMs });
          }
          return;
        }
        const frames = this.frameBuffer?.prepare(map, startMs, request.signal);
        if (frames) {
          const timeMs = this.getTimeMs();
          const previous = this.request;
          this.request = request;
          this.seekRequest = null;
          this.set({
            playing: false, loading: true, paused: false,
            timeMs, timeBeats: beatAtTime(map, timeMs), activeCarrierIds: [],
          });
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
          this.set({ loading: false, seekBeats: null });
        }
      } catch (error) {
        if (request.signal.aborted) return;
        if (this.request === request) {
          this.fail(error);
          return;
        }
        if (this.seekRequest === request) this.seekRequest = null;
        this.set({ seekBeats: null, error: errorMessage(error, 'Seek could not prepare.') });
      }
    })();
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
    this.set({ seekBeats: null });
    const current = () => this.request === request && this.transportIntent === intent;
    void this.player.pause().then((position) => {
      if (current()) this.set({ ...this.positionPatch(this.clock.hold() ?? position ?? this.state.timeMs), playing: false, paused: true });
    }).catch((error) => {
      if (current()) this.fail(error);
    }).finally(() => {
      if (this.transportIntent === intent) this.transportIntent = null;
    });
  }

  stop(): void {
    this.cancel();
    this.set({ timeBeats: 0, timeMs: 0, error: null });
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
    this.set({ playing: false, loading: false, paused: false, previewing: false, seekBeats: null, activeCarrierIds: [] });
  }

  private audioState(running: boolean): void {
    if (!this.request || this.request.signal.aborted || (running && (this.state.loading || this.transportIntent))) return;
    if (running ? !this.state.paused : !this.state.playing) return;
    const timeMs = (running ? null : this.clock.hold()) ?? this.player.positionMs() ?? this.state.timeMs;
    this.set({ ...this.positionPatch(timeMs), playing: running, paused: !running });
  }

  private positionPatch(timeMs: number): Pick<PlaybackState, 'timeMs' | 'timeBeats' | 'activeCarrierIds'> {
    const { map, timeBeats, activeCarrierIds } = this.state;
    if (!map) return { timeMs, timeBeats, activeCarrierIds };
    const active = map.anchors.filter((anchor) => anchor.startMs <= timeMs && timeMs < anchor.endMs).map((anchor) => anchor.carrierId);
    const same = active.length === activeCarrierIds.length && active.every((id, index) => id === activeCarrierIds[index]);
    return { timeMs, timeBeats: beatAtTime(map, Math.min(timeMs, map.extentMs)), activeCarrierIds: same ? activeCarrierIds : active };
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

  setTotalBeats(total: number): void {
    if (Number.isFinite(total) && total >= 0) this.set({ totalBeats: total, timeBeats: Math.min(total, this.state.timeBeats) });
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

  getTimeMs(): number {
    if (!this.state.playing && !(this.state.paused && this.transportIntent?.running)) {
      this.clock.reset();
      return this.state.timeMs;
    }
    // Starting again from a pause, the picture goes on from where it was held, not from the sound.
    return this.clock.at(this.player.positionMs() ?? this.state.timeMs, this.state.paused ? this.state.timeMs : undefined);
  }

  getTimeBeats(): number {
    const { map, timeBeats } = this.state;
    return map ? beatAtTime(map, Math.min(this.getTimeMs(), map.extentMs)) : timeBeats;
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

/** The time at a place of one segment, read between its moments. */
export function timeInSegment(segment: PlaybackSegment, beats: number): number {
  const points = segment.moments;
  if (beats <= points[0].beats) return points[0].timeMs;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    if (beats <= b.beats) return a.timeMs + ((beats - a.beats) / (b.beats - a.beats)) * (b.timeMs - a.timeMs);
  }
  return points.at(-1)!.timeMs;
}

/** The time the playback first reaches a place of the score (a repeated part is reached again
 *  later, its first pass counts). A place that is never played gives the time of the next one
 *  played. */
export function timeAtBeat(map: PlaybackMap, beats: number): number {
  for (const segment of map.segments) {
    if (beats < segment.startBeats) return segment.startMs;
    if (beats <= segment.endBeats) return timeInSegment(segment, beats);
  }
  return map.extentMs;
}

/** The place of the score the playback is at when the time is `ms`: in the segment, so a repeated
 *  part gives its own pass. */
export function beatAtTime(map: PlaybackMap, ms: number): number {
  const segment = map.segments.find((candidate) => ms < candidate.endMs) ?? map.segments.at(-1);
  if (!segment) return 0;
  const points = segment.moments;
  if (ms <= points[0].timeMs) return points[0].beats;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    if (ms <= b.timeMs) return a.beats + ((ms - a.timeMs) / (b.timeMs - a.timeMs)) * (b.beats - a.beats);
  }
  return points.at(-1)!.beats;
}
