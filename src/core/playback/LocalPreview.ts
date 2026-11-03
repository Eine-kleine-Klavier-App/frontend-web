import { PcmStreamPlayer } from './PcmStreamPlayer';
import SynthesisWorker from './Synthesis.worker?worker';
import type { ScoreSource } from '@/core/model/scoreSource';
import { DEFAULT_PLAYBACK_SETTINGS, withPlaybackSettings, type PlaybackSettings } from './PlaybackSettings';
import type { PlaybackGateway, PlaybackMap, PreviewMap, SavedScorePlaybackGateway } from './PlaybackGateway';

export interface PreviewTransport {
  bindSource?(source: ScoreSource | null): void;
  invalidate?(): void;
  prepare?(): Promise<void>;
  unlock(): Promise<void>;
  preview(sourceId: string, carrierId: string, noteIds: string[] | undefined, onFinished: () => void, onError: (error: unknown) => void, settings?: PlaybackSettings): Promise<void>;
  release(): void;
  close(): void;
}

/** A persistent local synth. A new target releases keys without killing release voices. */
export class LocalPreview implements PreviewTransport {
  private player = new PcmStreamPlayer(0);
  private worker: Worker | null = null;
  private ready: Promise<void> | null = null;
  private rejectReady: ((error: unknown) => void) | null = null;
  private opening: Promise<void> | null = null;
  private connected = false;
  private source: ScoreSource | null = null;
  private map: Promise<PreviewMap> | null = null;
  private request: AbortController | null = null;
  private sequence = 0;
  private finish: (() => void) | null = null;
  private error: ((error: unknown) => void) | null = null;
  constructor(private gateway: PlaybackGateway, private savedGateway: SavedScorePlaybackGateway) {}

  bindDraft(draftId: string | null): void {
    this.bindSource(draftId ? { kind: 'draft', id: draftId } : null);
  }
  bindSource(source: ScoreSource | null): void {
    if (this.source?.kind === source?.kind && this.source?.id === source?.id) return;
    this.close();
    this.source = source;
  }
  invalidate(): void {
    this.release();
    this.request?.abort();
    this.request = null;
    this.map = null;
    if (this.source) void this.loadMap().catch(() => {});
  }
  private loadMap(): Promise<PreviewMap> {
    if (this.map) return this.map;
    const source = this.source;
    if (!source) return Promise.reject(new DOMException('Preview closed.', 'AbortError'));
    const request = new AbortController();
    this.request = request;
    const plan = source.kind === 'saved' ? this.savedGateway.previewMapScore(source.id, request.signal) : this.gateway.previewMap(source.id, request.signal);
    const attempt = plan.then((map) => {
      if (request.signal.aborted || this.source !== source) throw new DOMException('Obsolete preview map.', 'AbortError');
      return map;
    });
    this.map = attempt;
    void attempt.catch(() => {
      if (this.map === attempt) this.map = null;
    });
    return attempt;
  }
  async prepare(): Promise<void> {
    await this.player.prepare();
    await Promise.all([this.prepareWorker(), ...(this.source ? [this.loadMap()] : [])]);
  }
  private prepareWorker(): Promise<void> {
    if (this.ready) return this.ready;
    const worker = new SynthesisWorker();
    this.worker = worker;
    this.ready = new Promise<void>((resolve, reject) => {
      this.rejectReady = reject;
      worker.onmessage = ({ data }) => {
        if (this.worker !== worker) return;
        if (data.type === 'ready') {
          this.rejectReady = null;
          resolve();
        }
        else if (data.type === 'finished' && data.sequence === this.sequence) {
          const finish = this.finish;
          this.finish = null;
          finish?.();
        }
        else if (data.type === 'failed') this.fail(new Error(data.message));
      };
      worker.onerror = () => this.fail(new Error('Piano preview worker failed.'));
      worker.postMessage({ type: 'init', sampleRate: this.player.sampleRate });
    });
    return this.ready;
  }
  async unlock(): Promise<void> {
    await this.player.unlock();
  }
  private async ensureLive(): Promise<void> {
    await this.prepareWorker();
    if (this.connected) return;
    if (!this.opening) {
      const worker = this.worker!;
      const attempt = (async () => {
        const port = await this.player.connectLive((error) => this.fail(error));
        if (this.worker !== worker) {
          port.close();
          throw new DOMException('Preview closed.', 'AbortError');
        }
        worker.postMessage({ type: 'live', port }, [port]);
        this.connected = true;
      })();
      this.opening = attempt;
      void attempt.then(() => {
        if (this.opening === attempt) this.opening = null;
      }, () => {
        if (this.opening === attempt) this.opening = null;
      });
    }
    await this.opening;
  }
  async preview(sourceId: string, carrierId: string, noteIds: string[] | undefined, onFinished: () => void, onError: (error: unknown) => void, settings: PlaybackSettings = DEFAULT_PLAYBACK_SETTINGS): Promise<void> {
    const source = this.source;
    if (!source || source.id !== sourceId) throw new DOMException('Preview belongs to another score.', 'AbortError');
    const sequence = ++this.sequence;
    this.finish = onFinished;
    this.error = onError;
    await this.player.unlock();
    const [preview] = await Promise.all([this.loadMap(), this.ensureLive()]);
    if (this.sequence !== sequence || this.source !== source) throw new DOMException('Obsolete preview.', 'AbortError');
    const carrier = preview.carriers.find((c) => c.carrierId === carrierId);
    if (!carrier) throw new Error('This note is not available for preview.');
    const wanted = noteIds ? new Set(noteIds) : null;
    const notes = carrier.notes.filter((note) => !wanted || wanted.has(note.sourceId));
    if (!notes.length || (wanted && notes.length !== wanted.size)) throw new Error('The selected notes are not in this chord.');
    const map: PlaybackMap = {
      version: preview.version, extentMs: Math.max(...notes.map((note) => note.durationMs)), pedals: [], anchors: [], segments: [],
      notes: notes.map((note) => ({ sourceId: note.sourceId, pitch: note.pitch, velocity: note.velocity, startMs: 0, keyReleaseMs: note.durationMs, endMs: note.durationMs })),
    };
    this.worker!.postMessage({ type: 'preview', sequence, map: withPlaybackSettings(map, settings) });
  }
  release(): void {
    this.sequence++;
    this.finish = null;
    this.error = null;
    if (this.connected) this.worker?.postMessage({ type: 'release', sequence: this.sequence });
  }
  close(): void {
    this.release();
    this.request?.abort();
    this.request = null;
    this.map = null;
    this.source = null;
    this.rejectReady?.(new DOMException('Preview closed.', 'AbortError'));
    this.rejectReady = null;
    this.worker?.terminate();
    this.worker = null;
    this.ready = null;
    this.opening = null;
    this.connected = false;
    this.player.dispose();
  }
  private fail(error: unknown): void {
    const report = this.error;
    const source = this.source;
    this.close();
    this.source = source;
    report?.(error);
  }
}
