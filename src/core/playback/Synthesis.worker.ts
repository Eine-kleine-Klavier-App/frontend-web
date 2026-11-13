import { FluidSynthEngine } from './FluidSynthEngine';
import { CHUNK_FRAMES, renderStartFrame, SynthScheduler } from './SynthScheduler';
import type { PlaybackMap } from './PlaybackGateway';
import { errorMessage } from '@/core/errorMessage';

const host = self as unknown as { onmessage: ((event: MessageEvent) => void) | null; postMessage(message: unknown, transfer?: Transferable[]): void };
let engine: FluidSynthEngine | null = null;
let scheduler: SynthScheduler | null = null;
let ready: Promise<void> | null = null;
let source: MessagePort | null = null;
let posted = 0;
let consumed = 0;
let target = 0;
let idle: { target: number; frames: number } | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let stopped = false;
const fail = (error: unknown) => host.postMessage({ type: 'failed', message: errorMessage(error, 'Piano synthesis failed.') });

function finish(): void {
  if (idle && consumed >= idle.frames) {
    host.postMessage({ type: 'finished', sequence: idle.target });
    idle = null;
  }
}
function pump(): void {
  if (timer !== null || stopped || !scheduler) return;
  timer = setTimeout(() => {
    timer = null;
    try {
      if (!source || !engine || !scheduler) return;
      const capacity = Math.ceil(engine.sampleRate * 0.04);
      while (scheduler.remaining && posted - consumed < capacity) {
        const samples = scheduler.render(Math.min(512, capacity - posted + consumed));
        posted += samples.length / 2;
        source.postMessage({ type: 'packet', target, samples }, [samples.buffer]);
      }
      if (!scheduler.remaining && !idle) {
        idle = { target, frames: posted };
        source.postMessage({ type: 'drain' });
        finish();
      }
    } catch (error) {
      fail(error);
    }
  }, 0);
}

/** The render for the cache: chunks of audio from a start before the target, produced up to a limit the cache moves ahead as it reads. */
interface Stream {
  token: number;
  next: number;
  limit: number;
  running: boolean;
}
let stream: Stream | null = null;

async function startStream(map: PlaybackMap, targetFrame: number, untilChunk: number, token: number): Promise<void> {
  await ready;
  if (stopped) return;
  const start = renderStartFrame(map, targetFrame, engine!.sampleRate);
  scheduler!.replaceFrom(map, start);
  const created: Stream = { token, next: start / CHUNK_FRAMES, limit: untilChunk, running: false };
  stream = created;
  host.postMessage({ type: 'started', token, firstChunk: created.next });
  await produce(created);
}

async function produce(current: Stream): Promise<void> {
  if (current.running) return;
  current.running = true;
  while (stream === current && !stopped && scheduler!.remaining && current.next < current.limit) {
    const deadline = performance.now() + 12;
    do {
      const samples = scheduler!.render(CHUNK_FRAMES);
      host.postMessage({ type: 'chunk', token: current.token, index: current.next++, samples }, [samples.buffer]);
    } while (stream === current && !stopped && scheduler!.remaining && current.next < current.limit && performance.now() < deadline);
    if (scheduler!.remaining && current.next < current.limit) await new Promise((resolve) => setTimeout(resolve, 0));
  }
  current.running = false;
  if (stream === current && !stopped && !scheduler!.remaining) host.postMessage({ type: 'done', token: current.token, endChunk: current.next });
}

host.onmessage = ({ data }) => {
  if (data.type === 'init') {
    engine = new FluidSynthEngine(data.sampleRate);
    ready = engine.prepare().then(() => {
      scheduler = new SynthScheduler(engine!);
      host.postMessage({ type: 'ready' });
    });
    void ready.catch(fail);
  } else if (data.type === 'render') void startStream(data.map, data.targetFrame, data.untilChunk, data.token).catch(fail);
  else if (data.type === 'extend') {
    if (stream && stream.token === data.token && data.untilChunk > stream.limit) {
      stream.limit = data.untilChunk;
      void produce(stream).catch(fail);
    }
  } else if (data.type === 'live') {
    source = data.port;
    source!.onmessage = ({ data: progress }) => {
      if (progress.type === 'progress' || progress.type === 'done') {
        consumed = progress.frames;
        finish();
        if (scheduler?.remaining) pump();
      }
    };
    source!.start();
    source!.postMessage({ type: 'configure', sampleRate: engine!.sampleRate, primeFrames: Math.ceil(engine!.sampleRate * 0.01) });
  } else if (data.type === 'preview') {
    target = data.sequence;
    idle = null;
    scheduler!.replace(data.map);
    pump();
    host.postMessage({ type: 'accepted', sequence: target });
  } else if (data.type === 'release') {
    target = data.sequence;
    idle = null;
    scheduler?.release();
    pump();
  } else if (data.type === 'close') {
    stopped = true;
    if (timer !== null) clearTimeout(timer);
    source?.close();
    engine?.close();
  }
};
