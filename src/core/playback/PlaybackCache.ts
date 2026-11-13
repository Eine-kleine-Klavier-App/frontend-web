import SynthesisWorker from './Synthesis.worker?worker';
import { CHUNK_FRAMES } from './SynthScheduler';
import type { PlaybackAudio, PlaybackMap } from './PlaybackGateway';

/** A reader of the audio: the stream handed to the player. It keeps the chunks around its place alive. */
interface Reader {
  index: number;
  token: number;
}
interface Entry {
  map: PlaybackMap;
  rate: number;
  worker: Worker;
  /** Rendered audio by chunk number of the whole piece; only the neighbourhood of the readers and of the latest target is kept. */
  chunks: Map<number, Uint8Array>;
  readers: Set<Reader>;
  /** The render in progress: its number, the next chunk it will deliver, the chunk it has been asked to reach, and whether it reached the end. */
  token: number;
  started: boolean;
  next: number;
  limit: number;
  endChunk: number | null;
  /** A start requested but not yet acknowledged by the worker, as a chunk number. */
  awaiting: number | null;
  /** The chunk the latest open or seek aims at. */
  target: number;
  /** A start to send as soon as the worker has loaded its instrument. */
  pending: { chunk: number } | null;
  failure: Error | DOMException | null;
  waiting: Set<() => void>;
}
interface Prepared {
  rate: number;
  worker: Worker;
  ready: Promise<void>;
  reject: (error: unknown) => void;
}
const AHEAD_SECONDS = 40;
const BEHIND_SECONDS = 20;
/** A target further ahead of the render than this starts a new render at the target instead of rendering the gap. */
const FORWARD_RESTART_SECONDS = 10;
const SLACK_CHUNKS = 4;
/** The player's prime buffer, waited for after a seek target. */
const PRIME_SECONDS = 0.8;

/** Local PCM for one document revision and instrument/sample-rate configuration: a window around the position, rendered on demand. */
export class PlaybackCache {
  private entry: Entry | null = null;
  private prepared: Prepared | null = null;
  private readyWorkers = new WeakSet<Worker>();

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
        this.readyWorkers.add(worker);
        resolve();
        const waiting = this.entry;
        if (waiting?.worker === worker && waiting.pending) this.sendRender(waiting, waiting.pending.chunk);
        return;
      }
      if (data.type === 'failed') {
        fail(new Error(data.message));
        return;
      }
      const entry = this.entry;
      if (!entry || entry.worker !== worker) return;
      if (data.type === 'started') {
        if (data.token === entry.token) {
          entry.started = true;
          entry.awaiting = null;
          entry.next = data.firstChunk;
        }
      } else if (data.type === 'chunk') {
        // A chunk is the same audio whichever render made it, so a late chunk of the previous render is kept too.
        const samples = data.samples as Float32Array;
        entry.chunks.set(data.index, new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength));
        if (data.token === entry.token) entry.next = data.index + 1;
        this.evict(entry);
      } else if (data.type === 'done') {
        if (data.token === entry.token) entry.endChunk = data.endChunk;
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
      void this.prepare(rate);
      entry = {
        map, rate, worker: this.prepared!.worker, chunks: new Map(), readers: new Set(), token: 0, started: false, next: 0, limit: 0,
        endChunk: null, awaiting: null, target: 0, pending: null, failure: null, waiting: new Set(),
      };
      this.entry = entry;
    }
    const startFrame = Math.max(0, Math.round(startMs * rate / 1000));
    this.ensureWindow(entry, startFrame);
    return { body: this.replay(entry, startFrame), startFrame, sampleRate: rate, channels: 2, format: 'f32le', version: map.version, extentMs: map.extentMs, map };
  }

  /** Wait for the target plus the player's prime buffer, without interrupting the old output. */
  async prepareAt(ms: number, signal: AbortSignal): Promise<void> {
    const entry = this.entry;
    if (!entry) return;
    const startFrame = Math.max(0, Math.round(ms * entry.rate / 1000));
    this.ensureWindow(entry, startFrame);
    const token = entry.token;
    const required = Math.floor((startFrame + PRIME_SECONDS * entry.rate) / CHUNK_FRAMES);
    const abort = () => this.notify(entry);
    signal.addEventListener('abort', abort, { once: true });
    try {
      while (!this.has(entry, required)) {
        if (signal.aborted) throw new DOMException('Seek superseded.', 'AbortError');
        if (entry.failure) throw entry.failure;
        if (entry.token !== token) throw new DOMException('Seek superseded.', 'AbortError');
        await new Promise<void>((resolve) => entry.waiting.add(resolve));
      }
      if (signal.aborted) throw new DOMException('Seek superseded.', 'AbortError');
      if (entry.failure) throw entry.failure;
    } finally {
      signal.removeEventListener('abort', abort);
    }
  }

  private chunksFor(entry: Entry, seconds: number): number {
    return Math.ceil(seconds * entry.rate / CHUNK_FRAMES);
  }

  /** The chunk is held, or the piece ends before it. */
  private has(entry: Entry, chunk: number): boolean {
    return entry.chunks.has(chunk) || (entry.endChunk !== null && chunk >= entry.endChunk);
  }

  /** Make sure the render covers the target: carry on when the target is in or just ahead of the render, otherwise start a new render at it. */
  private ensureWindow(entry: Entry, targetFrame: number): void {
    const chunk = Math.floor(targetFrame / CHUNK_FRAMES);
    entry.target = chunk;
    const forward = this.chunksFor(entry, FORWARD_RESTART_SECONDS);
    const ahead = this.chunksFor(entry, AHEAD_SECONDS);
    const carrying = entry.chunks.has(chunk)
      || (entry.endChunk !== null && chunk >= entry.endChunk)
      || (entry.started && chunk >= entry.next && chunk - entry.next <= forward)
      || (entry.awaiting !== null && Math.abs(chunk - entry.awaiting) <= forward);
    if (!carrying) {
      this.start(entry, chunk);
      return;
    }
    this.extend(entry, chunk + ahead);
  }

  private start(entry: Entry, chunk: number): void {
    entry.token++;
    entry.started = false;
    entry.endChunk = null;
    entry.awaiting = chunk;
    if (!this.readyWorkers.has(entry.worker)) {
      entry.pending = { chunk };
      return;
    }
    this.sendRender(entry, chunk);
  }

  private sendRender(entry: Entry, chunk: number): void {
    entry.pending = null;
    entry.limit = chunk + this.chunksFor(entry, AHEAD_SECONDS);
    entry.worker.postMessage({ type: 'render', map: entry.map, targetFrame: chunk * CHUNK_FRAMES, untilChunk: entry.limit, token: entry.token });
  }

  private extend(entry: Entry, until: number): void {
    if (until <= entry.limit || entry.endChunk !== null) return;
    entry.limit = until;
    if (this.readyWorkers.has(entry.worker) && !entry.pending) entry.worker.postMessage({ type: 'extend', token: entry.token, untilChunk: until });
  }

  /** Drop the chunks that no reader and no target is near. */
  private evict(entry: Entry): void {
    const behind = this.chunksFor(entry, BEHIND_SECONDS);
    const ahead = this.chunksFor(entry, AHEAD_SECONDS) + SLACK_CHUNKS;
    if (entry.chunks.size <= behind + ahead) return;
    const anchors = [entry.target, ...[...entry.readers].map((reader) => reader.index)];
    for (const index of [...entry.chunks.keys()]) {
      if (!anchors.some((anchor) => index >= anchor - behind && index <= anchor + ahead)) entry.chunks.delete(index);
    }
  }

  private replay(entry: Entry, startFrame: number): ReadableStream<Uint8Array> {
    const reader: Reader = { index: Math.floor(startFrame / CHUNK_FRAMES), token: entry.token };
    let offset = startFrame % CHUNK_FRAMES * 8;
    let cancelled = false;
    let wake: (() => void) | null = null;
    entry.readers.add(reader);
    const finish = () => entry.readers.delete(reader);
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const cache = this;
    return new ReadableStream({
      async pull(controller) {
        while (!cancelled) {
          if (entry.failure) {
            finish();
            controller.error(entry.failure);
            return;
          }
          const held = entry.chunks.get(reader.index);
          if (held) {
            const chunk = held.subarray(offset);
            offset = 0;
            reader.index++;
            if (reader.token === entry.token) cache.extend(entry, reader.index + cache.chunksFor(entry, AHEAD_SECONDS));
            if (chunk.length) {
              controller.enqueue(chunk);
              return;
            }
          } else if (reader.token !== entry.token || (entry.endChunk !== null && reader.index >= entry.endChunk)) {
            // The render this reader followed was replaced, or the piece ends here.
            finish();
            controller.close();
            return;
          } else {
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
        finish();
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
