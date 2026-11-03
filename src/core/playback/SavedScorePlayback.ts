import { HttpPlaybackGateway } from './HttpPlaybackGateway';
import { PlaybackCache } from './PlaybackCache';
import { PcmStreamPlayer } from './PcmStreamPlayer';
import type { PlaybackMap, SavedScorePlaybackGateway } from './PlaybackGateway';
import { errorMessage } from '@/core/errorMessage';

export interface ScorePlaybackTrack {
  id: string;
  parentScoreId?: string;
  title: string;
  composer: string | null;
}
export type ScorePlaybackPhase = 'idle' | 'loading' | 'playing' | 'paused' | 'replay' | 'error';
export interface ScorePlaybackState {
  track: ScorePlaybackTrack | null;
  phase: ScorePlaybackPhase;
  timeMs: number;
  extentMs: number;
  error: string | null;
}
export interface ScorePlayback {
  prepare(): Promise<void>;
  play(track: ScorePlaybackTrack): Promise<void>;
  pause(): void;
  stop(): void;
  stopPlayback(): void;
  dispose(): void;
  clearReplayForSelection(scoreId: string): void;
  getState(): ScorePlaybackState;
  subscribe(listener: () => void): () => void;
}
const initial = (): ScorePlaybackState => ({ track: null, phase: 'idle', timeMs: 0, extentMs: 0, error: null });

/** A browse session shared by the score panel and its collapsed Now Playing controls. */
class SavedScorePlayback implements ScorePlayback {
  private state = initial();
  private listeners = new Set<() => void>();
  private request: AbortController | null = null;
  private generation = 0;
  private cache = new PlaybackCache();
  private cachedScore: string | null = null;
  private cachedMap: PlaybackMap | null = null;
  private player = new PcmStreamPlayer(6, (running) => {
    if (!this.request) return;
    if (running && this.state.phase === 'paused') this.set({ phase: 'playing' });
    else if (!running && this.state.phase === 'playing') this.set({ phase: 'paused' });
  });

  constructor(private gateway: SavedScorePlaybackGateway) {}
  async prepare(): Promise<void> {
    await Promise.all([this.player.prepare(), this.cache.prepare(this.player.sampleRate)]);
  }
  getState = (): ScorePlaybackState => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private set(patch: Partial<ScorePlaybackState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
  private cancel(): void {
    this.generation++;
    this.request?.abort();
    this.request = null;
    this.player.stop();
  }
  stop(): void {
    this.cancel();
    this.set(initial());
  }
  stopPlayback(): void {
    this.cancel();
    this.set({ phase: 'idle', timeMs: 0, error: null });
  }
  dispose(): void {
    this.stop();
    this.cache.clear();
    this.player.dispose();
  }
  clearReplayForSelection(scoreId: string): void {
    const { phase, track } = this.state;
    if (phase === 'replay' && track?.id !== scoreId && track?.parentScoreId !== scoreId) this.stop();
  }
  pause(): void {
    if (this.state.phase !== 'playing') return;
    const generation = this.generation;
    this.set({ phase: 'paused', timeMs: this.player.positionMs() ?? this.state.timeMs });
    void this.player.pause().catch((error) => {
      if (!(error instanceof DOMException && error.name === 'AbortError')) this.fail(error, generation);
    });
  }
  async play(track: ScorePlaybackTrack): Promise<void> {
    if (this.state.track?.id === track.id) {
      if (this.state.phase === 'playing') {
        this.pause();
        return;
      }
      if (this.state.phase === 'loading') {
        this.stop();
        return;
      }
      if (this.state.phase === 'paused') {
        const generation = this.generation;
        this.set({ phase: 'playing', error: null });
        try {
          await this.player.unlock();
        }
        catch (error) {
          if (!(error instanceof DOMException && error.name === 'AbortError')) this.fail(error, generation);
        }
        return;
      }
    }
    this.cancel();
    const generation = this.generation;
    const request = new AbortController();
    this.request = request;
    this.set({ ...initial(), track: { id: track.id, title: track.title, composer: track.composer, ...(track.parentScoreId ? { parentScoreId: track.parentScoreId } : {}) }, phase: 'loading' });
    try {
      await this.player.unlock();
      if (request.signal.aborted) return;
      if (this.cachedScore !== null && this.cachedScore !== track.id) {
        this.cache.clear();
        this.cachedMap = null;
        this.cachedScore = track.id;
      }
      this.cachedScore = track.id;
      const map = await this.gateway.mapScore(track.id, request.signal);
      if (request.signal.aborted) return;
      if (!this.cachedMap || this.cachedMap.version !== map.version) {
        if (this.cachedMap) this.cache.clear();
        this.cachedMap = map;
      }
      const audio = await this.cache.open(this.cachedMap, this.player.sampleRate);
      if (request.signal.aborted) {
        void audio?.body.cancel().catch(() => {});
        return;
      }
      if (audio) {
        this.set({ extentMs: audio.extentMs });
        await this.player.play(audio, request.signal,
          () => {
            if (generation === this.generation) this.set({ phase: 'playing' });
          }, 0,
          (timeMs) => {
            if (generation === this.generation && this.state.phase === 'playing') this.set({ timeMs });
          });
      }
      if (generation === this.generation) {
        this.request = null;
        this.set({ phase: 'replay' });
      }
    } catch (error) {
      if (!request.signal.aborted) this.fail(error, generation);
    }
  }
  private fail(error: unknown, generation: number): void {
    if (generation !== this.generation) return;
    this.cancel();
    this.set({ phase: 'error', error: errorMessage(error, 'Playback could not start.') });
  }
}
export function createSavedScorePlayback(gateway: SavedScorePlaybackGateway = new HttpPlaybackGateway()): ScorePlayback {
  return new SavedScorePlayback(gateway);
}
