import SynthesisWorker from './Synthesis.worker?worker';
import type { PlaybackAudio, PlaybackMap } from './PlaybackGateway';

interface Entry {
  map: PlaybackMap;
  rate: number;
  worker: Worker;
  chunks: Uint8Array[];
  frames: number;
  complete: boolean;
  failure: Error | DOMException | null;
  waiting: Set<() => void>;
}
interface Prepared {
  rate: number;
  worker: Worker;
  ready: Promise<void>;
  reject: (error: unknown) => void;
}
const RENDER_FRAMES = 4096;

/** Full local PCM cache for one document revision and instrument/sample-rate configuration. */
export class PlaybackCache {
  private entry: Entry | null = null;
  private prepared: Prepared | null = null;

  clear(): void {
    const error = new DOMException('Obsolete audio.', 'AbortError');
    const entry = this.entry;
    this.entry = null;
    this.prepared?.reject(error);
    this.prepared?.worker.terminate();
    this.prepared = null;
    if (entry) {
      entry.failure = error;
      entry.worker.terminate();
      this.notify(entry);
    }
  }

  /** Load the instrument without rendering a score or starting audio. */
  prepare(rate: number): Promise<void> {
    if (this.prepared?.rate === rate) return this.prepared.ready;
    if (this.entry?.rate === rate && !this.entry.failure) return Promise.resolve();
    this.clear();
    const worker = new SynthesisWorker();
    let resolve!: () => void, reject!: (error: unknown) => void;
    const ready = new Promise<void>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    const prepared: Prepared = { rate, worker, ready, reject };
    this.prepared = prepared;
    const fail = (error: Error) => {
      reject(error);
      worker.terminate();
      if (this.prepared === prepared) this.prepared = null;
      const entry = this.entry;
      if (entry?.worker === worker) {
        entry.failure = error;
        this.notify(entry);
      }
    };
    worker.onmessage = ({ data }) => {
      if (data.type === 'ready') {
        resolve();
        return;
      }
      if (data.type === 'failed') {
        fail(new Error(data.message));
        return;
      }
      const entry = this.entry;
      if (!entry || entry.worker !== worker) return;
      if (data.type === 'chunk') {
        const samples = data.samples as Float32Array;
        entry.chunks.push(new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength));
        entry.frames += samples.length / 2;
      } else if (data.type === 'done') {
        entry.complete = true;
        worker.terminate();
        if (this.prepared === prepared) this.prepared = null;
      }
      this.notify(entry);
    };
    worker.onerror = () => fail(new Error('Piano synthesis worker failed.'));
    worker.postMessage({ type: 'init', sampleRate: rate });
    void ready.catch(() => {});
    return ready;
  }

  async open(map: PlaybackMap, rate: number, startMs = 0): Promise<PlaybackAudio | null> {
    if (!map.extentMs) {
      this.clear();
      return null;
    }
    let entry = this.entry;
    if (entry?.failure || (entry && (entry.map !== map || entry.rate !== rate))) {
      this.clear();
      entry = null;
    }
    if (!entry) {
      const ready = this.prepare(rate);
      const worker = this.prepared!.worker;
      entry = { map, rate, worker, chunks: [], frames: 0, complete: false, failure: null, waiting: new Set() };
      this.entry = entry;
      const current = entry;
      void ready.then(() => {
        if (this.entry === current) worker.postMessage({ type: 'render', map });
      }, () => {});
    }
    const startFrame = Math.max(0, Math.round(startMs * rate / 1000));
    return { body: this.replay(entry, startFrame), startFrame, sampleRate: rate, channels: 2, format: 'f32le', version: map.version, extentMs: map.extentMs, map };
  }

  /** Wait for the target plus the player's prime buffer, without interrupting the old output. */
  async prepareAt(ms: number, signal: AbortSignal): Promise<void> {
    const entry = this.entry;
    if (!entry) return;
    const required = Math.ceil((ms / 1000 + 0.8) * entry.rate);
    const abort = () => this.notify(entry);
    signal.addEventListener('abort', abort, { once: true });
    try {
      while (!entry.complete && entry.frames < required) {
        if (signal.aborted) throw new DOMException('Seek superseded.', 'AbortError');
        if (entry.failure) throw entry.failure;
        await new Promise<void>((resolve) => entry.waiting.add(resolve));
      }
      if (signal.aborted) throw new DOMException('Seek superseded.', 'AbortError');
      if (entry.failure) throw entry.failure;
    } finally {
      signal.removeEventListener('abort', abort);
    }
  }

  private replay(entry: Entry, startFrame: number): ReadableStream<Uint8Array> {
    // The synthesis worker emits 4096-frame chunks, with only its final chunk shorter.
    let index = Math.floor(startFrame / RENDER_FRAMES);
    let offset = startFrame % RENDER_FRAMES * 8;
    let cancelled = false;
    let wake: (() => void) | null = null;
    return new ReadableStream({
      async pull(controller) {
        while (!cancelled) {
          if (entry.failure) {
            controller.error(entry.failure);
            return;
          }
          if (index < entry.chunks.length) {
            const chunk = entry.chunks[index++].subarray(offset);
            offset = 0;
            if (chunk.length) {
              controller.enqueue(chunk);
              return;
            }
          } else {
            if (entry.complete) {
              controller.close();
              return;
            }
            await new Promise<void>((resolve) => {
              wake = resolve;
              entry.waiting.add(resolve);
            });
            if (wake) entry.waiting.delete(wake);
            wake = null;
          }
        }
      },
      cancel() {
        cancelled = true;
        if (wake) {
          entry.waiting.delete(wake);
          wake();
          wake = null;
        }
      },
    });
  }
  private notify(entry: Entry): void {
    for (const wake of entry.waiting) wake();
    entry.waiting.clear();
  }
}
