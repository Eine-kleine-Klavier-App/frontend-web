import { FluidSynthEngine } from './FluidSynthEngine';
import { SynthScheduler } from './SynthScheduler';
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

async function render(map: PlaybackMap): Promise<void> {
  await ready;
  scheduler!.replace(map);
  while (!stopped && scheduler!.remaining) {
    const deadline = performance.now() + 12;
    do {
      const samples = scheduler!.render(4096);
      host.postMessage({ type: 'chunk', samples }, [samples.buffer]);
    } while (!stopped && scheduler!.remaining && performance.now() < deadline);
    if (scheduler!.remaining) await new Promise((resolve) => setTimeout(resolve, 0));
  }
  if (!stopped) host.postMessage({ type: 'done' });
}

host.onmessage = ({ data }) => {
  if (data.type === 'init') {
    engine = new FluidSynthEngine(data.sampleRate);
    ready = engine.prepare().then(() => {
      scheduler = new SynthScheduler(engine!);
      host.postMessage({ type: 'ready' });
    });
    void ready.catch(fail);
  } else if (data.type === 'render') void render(data.map).catch(fail);
  else if (data.type === 'live') {
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
