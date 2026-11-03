/** Local PCM delivery and credit stay off the UI thread; the cache owns the source. */
import { errorMessage } from '@/core/errorMessage';
const host = self as unknown as {
  onmessage: ((event: MessageEvent) => void) | null;
  postMessage(message: unknown): void;
  close(): void;
};
let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
let port: MessagePort | null = null;
let stopped = false;
let wake: (() => void) | undefined;
const notify = () => {
  wake?.();
  wake = undefined;
};
function stop(): void {
  if (stopped) return;
  stopped = true;
  if (reader) void reader.cancel().catch(() => {});
  port?.close();
  notify();
  host.postMessage({ type: 'stopped' });
  host.close();
}
async function feed(stream: ReadableStream<Uint8Array>, source: MessagePort, rate: number, startFrame: number, live: boolean, format: 's16le' | 'f32le'): Promise<void> {
  reader = stream.getReader();
  port = source;
  let posted = 0;
  let consumed = 0;
  const sampleBytes = format === 'f32le' ? 4 : 2;
  const frameBytes = sampleBytes * 2;
  let skipBytes = startFrame * frameBytes;
  let remainder = new Uint8Array(0);
  const capacity = Math.ceil(rate * (live ? 0.04 : 1));
  source.onmessage = ({ data }) => {
    if (data.type !== 'progress' && data.type !== 'done') return;
    consumed = Math.min(posted, data.frames);
    notify();
  };
  source.start();
  source.postMessage({ type: 'configure', sampleRate: rate, primeFrames: Math.ceil(rate * (live ? 0.02 : 0.75)) });
  try {
    while (!stopped) {
      const { value, done } = await reader.read();
      if (stopped) return;
      if (done) break;
      if (!value.length) {
        if (live) source.postMessage({ type: 'drain' });
        continue;
      }
      let bytes = value;
      if (remainder.length) {
        bytes = new Uint8Array(remainder.length + value.length);
        bytes.set(remainder);
        bytes.set(value, remainder.length);
      }
      const complete = bytes.length - bytes.length % frameBytes;
      const skipped = Math.min(skipBytes, complete);
      skipBytes -= skipped;
      for (let offset = skipped; offset < complete;) {
        while (!stopped && posted - consumed >= capacity) await new Promise<void>((resolve) => {
          wake = resolve;
        });
        if (stopped) return;
        const frames = Math.min(2048, capacity - (posted - consumed), (complete - offset) / frameBytes);
        const view = new DataView(bytes.buffer, bytes.byteOffset + offset, frames * frameBytes);
        const samples = new Float32Array(frames * 2);
        for (let i = 0; i < samples.length; i++) samples[i] = format === 'f32le' ? view.getFloat32(i * 4, true) : view.getInt16(i * 2, true) / 32768;
        posted += frames;
        source.postMessage({ type: 'chunk', samples }, [samples.buffer]);
        offset += frames * frameBytes;
      }
      remainder = bytes.slice(complete);
    }
    if (stopped) return;
    if (remainder.length) throw new Error('The audio stream ended with an incomplete sample.');
    source.postMessage({ type: 'end' });
  } finally {
    reader?.releaseLock();
    reader = null;
  }
}
host.onmessage = ({ data }) => {
  if (data.type === 'stop') {
    stop();
    return;
  }
  if (data.type !== 'start') return;
  void feed(data.stream, data.port, data.sampleRate, data.startFrame, data.live, data.format).catch((error: unknown) => {
    if (stopped) return;
    host.postMessage({ type: 'failed', message: errorMessage(error, 'Audio delivery failed.') });
    stop();
  });
};
export {};
