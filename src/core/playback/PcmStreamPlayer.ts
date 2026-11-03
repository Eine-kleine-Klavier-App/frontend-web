import type { PlaybackAudio } from './PlaybackGateway';
import workletUrl from './pcm-output.worklet.ts?worker&url';
import PlaybackWorker from './PlaybackStream.worker?worker';

interface PlaybackClock {
  startFrame: number;
  rate: number;
  frames: number;
  queued: number;
  contextTime: number;
  advancing: boolean;
  lastMs: number;
  previous: PlaybackClock | null;
}

interface OutputGain {
  port: MessagePort;
  rate: number;
  retireAt: number | null;
  from: number;
  to: number;
  start: number;
  end: number;
}

/** Transport only: the server has resolved pitch, timing and dynamics. */
export class PcmStreamPlayer {
  private context: AudioContext | null = null;
  private gain: GainNode | null = null;
  private module: Promise<void> | null = null;
  private outputs = new Set<() => void>();
  private suspension: Promise<void> | null = null;
  private resumption: Promise<void> | null = null;
  private intent = 0;
  private wantsRunning = false;
  private lifecycle: (() => void) | null = null;
  private clock: PlaybackClock | null = null;
  private fadingOutputs = new Set<OutputGain>();

  get sampleRate(): number {
    this.initialize();
    return this.context!.sampleRate;
  }

  constructor(private gainDb = 6, private onState?: (running: boolean) => void) {}

  /** Load the output module before a gesture, keeping an idle context suspended. */
  async prepare(): Promise<void> {
    this.initialize();
    const context = this.context!;
    await this.module;
    if (this.context === context && !this.wantsRunning) await this.pause();
  }

  private initialize(): void {
    if (!this.context || this.context.state === 'closed') {
      const context = new AudioContext({ latencyHint: 'interactive' });
      this.context = context;
      this.gain = context.createGain();
      this.gain.gain.value = 10 ** (this.gainDb / 20);
      this.gain.connect(context.destination);
      this.module = context.audioWorklet.addModule(new URL(workletUrl, import.meta.url).href).catch((error: unknown) => {
        if (this.context === context) this.dispose();
        throw error;
      });
      const changed = () => {
        if (this.context === context) this.onState?.(context.state === 'running' && this.wantsRunning);
      };
      const wake = () => {
        if (globalThis.document?.visibilityState !== 'hidden' && this.wantsRunning && this.outputs.size && context.state !== 'running') {
          void this.unlock().catch(() => {
            if (this.context === context && context.state !== 'running') this.onState?.(false);
          });
        }
      };
      context.addEventListener('statechange', changed);
      globalThis.document?.addEventListener('visibilitychange', wake);
      globalThis.addEventListener?.('pageshow', wake);
      this.lifecycle = () => {
        context.removeEventListener('statechange', changed);
        globalThis.document?.removeEventListener('visibilitychange', wake);
        globalThis.removeEventListener?.('pageshow', wake);
      };
    }
  }

  async unlock(): Promise<void> {
    const intent = ++this.intent;
    this.wantsRunning = true;
    this.initialize();
    const context = this.context!;
    // Request permission in the gesture, then order the actual resume after any pending pause.
    let resumed = context.resume();
    this.resumption = resumed;
    try {
      await Promise.all([this.suspension, resumed]);
      if (this.context !== context || intent !== this.intent || !this.wantsRunning) throw new DOMException('Audio operation superseded.', 'AbortError');
      if (context.state !== 'running') {
        resumed = context.resume();
        this.resumption = resumed;
        await resumed;
      }
      await this.module;
      if (this.context !== context || intent !== this.intent || !this.wantsRunning) throw new DOMException('Audio operation superseded.', 'AbortError');
      if (context.state !== 'running') throw new Error('Audio could not resume. Press Play again.');
    } finally {
      if (this.resumption === resumed) this.resumption = null;
    }
  }

  /** Transfer this port to a synthesis worker; no PCM or credit needs the UI thread. */
  async connectLive(onError: (error: Error) => void): Promise<MessagePort> {
    await this.unlock();
    const context = this.context!;
    const node = new AudioWorkletNode(context, 'piano-pcm-output', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
    const channel = new MessageChannel();
    node.connect(this.gain!);
    node.port.postMessage({ type: 'source', port: channel.port1 }, [channel.port1]);
    const stop = () => {
      this.outputs.delete(stop);
      node.port.postMessage({ type: 'stop' });
      node.disconnect();
      node.port.close();
    };
    this.outputs.add(stop);
    node.onprocessorerror = () => {
      stop();
      onError(new Error('Live audio processor failed.'));
    };
    return channel.port2;
  }

  async pause(): Promise<void> {
    this.positionMs();
    const intent = ++this.intent;
    this.wantsRunning = false;
    const context = this.context;
    if (!context) return;
    const waiting = [this.suspension, this.resumption].filter((operation): operation is Promise<void> => operation !== null);
    const pending = waiting.length ? Promise.all(waiting).then(async () => {
      if (this.context === context && intent === this.intent && !this.wantsRunning && context.state === 'running') await context.suspend();
    }) : context.state === 'running' ? context.suspend() : Promise.resolve();
    this.suspension = pending;
    try {
      await pending;
    }
    finally {
      if (this.suspension === pending) this.suspension = null;
    }
  }

  /** The source position currently reaching the output device, bounded by known buffered PCM. */
  positionMs(): number | null {
    const clock = this.clock;
    const context = this.context;
    if (!clock || !context) return null;
    return this.audiblePosition(clock, context);
  }

  private audiblePosition(clock: PlaybackClock, context: AudioContext): number {
    const ms = this.clockPosition(clock, context);
    if (clock.previous && ms <= clock.startFrame / clock.rate * 1000) return this.audiblePosition(clock.previous, context);
    clock.previous = null;
    return ms;
  }

  private clockPosition(clock: PlaybackClock, context: AudioContext): number {
    if (!this.wantsRunning || context.state !== 'running') return clock.lastMs;
    const output = context.getOutputTimestamp?.();
    const rendered = Math.max(0, context.currentTime - (context.outputLatency || context.baseLatency || 0));
    // Some devices report a render-head timestamp. Never advance past their reported output delay.
    const time = output && typeof output.contextTime === 'number' && Number.isFinite(output.contextTime) && typeof output.performanceTime === 'number' && output.performanceTime > 0
      ? Math.max(0, Math.min(rendered, output.contextTime + Math.max(0, performance.now() - output.performanceTime) / 1000))
      : rendered;
    const delta = time - clock.contextTime;
    const frames = Math.max(0, Math.min(clock.frames + clock.queued, clock.frames + (clock.advancing ? delta : Math.min(0, delta)) * clock.rate));
    clock.lastMs = Math.max(clock.lastMs, (clock.startFrame + frames) / clock.rate * 1000);
    return clock.lastMs;
  }

  stop(): void {
    this.intent++;
    this.wantsRunning = false;
    for (const stop of [...this.outputs]) stop();
    this.clock = null;
  }

  dispose(): void {
    this.stop();
    this.fadingOutputs.clear();
    this.lifecycle?.();
    this.lifecycle = null;
    const context = this.context;
    this.gain?.disconnect();
    this.gain = null;
    this.context = null;
    this.module = null;
    this.suspension = null;
    this.resumption = null;
    if (context && context.state !== 'closed') void context.close().catch(() => {});
  }

  private fadeOutput(output: OutputGain, to: number, at: number, end: number): void {
    const fraction = output.end > output.start ? Math.max(0, Math.min(1, (at - output.start) / (output.end - output.start))) : 1;
    const from = output.from + (output.to - output.from) * fraction;
    const rate = output.rate;
    output.port.postMessage({ type: 'envelope', from, to, startFrame: Math.round(at * rate), endFrame: Math.round(end * rate) });
    output.from = from;
    output.to = to;
    output.start = at;
    output.end = end;
  }

  async play(audio: PlaybackAudio, signal: AbortSignal, onStarted: () => void, startMs = 0, onTime: (ms: number) => void = () => {}, live = false, onReady: () => void = () => {}): Promise<void> {
    const context = this.context;
    if (!context || context.state !== 'running') throw new Error('Audio is not ready. Press Play again.');
    await this.module;
    if (signal.aborted) throw new DOMException('Playback stopped.', 'AbortError');
    const node = new AudioWorkletNode(context, 'piano-pcm-output', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
    const worker = new PlaybackWorker();
    const channel = new MessageChannel();
    const firstFrame = Math.round(startMs * audio.sampleRate / 1000);
    const clock: PlaybackClock = { startFrame: firstFrame, rate: audio.sampleRate, frames: 0, queued: 0, contextTime: context.currentTime, advancing: false, lastMs: firstFrame / audio.sampleRate * 1000, previous: null };
    const outputGain = context.createGain();
    outputGain.gain.value = 1;
    const output: OutputGain = { port: node.port, rate: context.sampleRate, retireAt: null, from: 0, to: 0, start: 0, end: 0 };
    node.connect(outputGain).connect(this.gain!);
    node.port.postMessage({ type: 'source', port: channel.port1, reportControl: true }, [channel.port1]);
    let started = false;
    let ticking = false;
    let done = false;
    let transferred = false;
    let frame = 0;
    let resolve!: () => void, reject!: (error: unknown) => void;
    const completion = new Promise<void>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    const stop = () => reject(new DOMException('Playback stopped.', 'AbortError'));
    const tick = () => {
      const ms = this.clockPosition(clock, context);
      if (!started && ms !== null && (ms > firstFrame / clock.rate * 1000 || (done && clock.frames === 0))) {
        started = true;
        clock.previous = null;
        onStarted();
      }
      if (started) onTime(ms);
      else if (clock.previous) onTime(this.audiblePosition(clock, context));
      if (done && ms !== null && ms >= (firstFrame + clock.frames) / clock.rate * 1000 - 0.01) {
        resolve();
        return;
      }
      frame = requestAnimationFrame(tick);
    };
    this.outputs.add(stop);
    signal.addEventListener('abort', stop, { once: true });
    node.port.onmessage = ({ data }) => {
      if (data.type === 'primed') {
        if (signal.aborted) return;
        const beginFrame = Math.ceil((context.currentTime + 0.02) * context.sampleRate / 128) * 128;
        const at = beginFrame / context.sampleRate;
        const end = at + 0.01;
        for (const previous of this.fadingOutputs) {
          if (previous.to === 0 && (previous.end <= at || previous.from === 0)) continue;
          this.fadeOutput(previous, 0, at, end);
          previous.retireAt = end;
        }
        this.fadeOutput(output, 1, at, end);
        this.fadingOutputs.add(output);
        clock.previous = this.clock;
        this.clock = clock;
        node.port.postMessage({ type: 'begin', frame: beginFrame });
        onReady();
        return;
      }
      if (data.type !== 'progress' && data.type !== 'done') return;
      // A final drain message can repeat the last source frame after the output tail.
      if (data.frames !== clock.frames || clock.advancing || data.advancing) clock.contextTime = data.contextTime;
      clock.frames = data.frames;
      clock.queued = data.queued;
      clock.advancing = data.advancing;
      done = data.type === 'done';
      if (!ticking && (clock.frames > 0 || done)) {
        ticking = true;
        frame = requestAnimationFrame(tick);
      }
    };
    node.onprocessorerror = () => reject(new Error('Audio processor failed.'));
    worker.onmessage = ({ data }) => {
      if (data.type === 'failed') reject(new Error(data.message));
      else if (data.type === 'stopped') worker.terminate();
    };
    worker.onerror = () => {
      worker.terminate();
      reject(new Error('Audio delivery worker failed.'));
    };
    try {
      worker.postMessage({ type: 'start', stream: audio.body, port: channel.port2, sampleRate: audio.sampleRate, startFrame: Math.max(0, firstFrame - (audio.startFrame ?? 0)), live, format: audio.format }, [audio.body, channel.port2]);
      transferred = true;
      await completion;
    } finally {
      cancelAnimationFrame(frame);
      if (this.clock === clock) this.clock = null;
      this.outputs.delete(stop);
      signal.removeEventListener('abort', stop);
      node.onprocessorerror = null;
      worker.postMessage({ type: 'stop' });
      const release = () => {
        this.fadingOutputs.delete(output);
        node.port.onmessage = null;
        node.disconnect();
        outputGain.disconnect();
        node.port.close();
      };
      if (done || context.state !== 'running') release();
      else {
        if (output.retireAt === null) {
          const at = context.currentTime;
          this.fadeOutput(output, 0, at, at + 0.01);
          output.retireAt = at + 0.01;
        }
        node.port.onmessage = ({ data }) => {
          if (data.type === 'stopped') release();
        };
        const retire = () => {
          if (context.state !== 'running') {
            release();
            return;
          }
          const remaining = output.retireAt! + 256 / context.sampleRate - context.currentTime;
          if (remaining > 0) setTimeout(retire, Math.max(1, remaining * 1000));
          else node.port.postMessage({ type: 'stop', frame: Math.ceil(output.retireAt! * context.sampleRate) + 128 });
        };
        retire();
      }
      if (!transferred) {
        worker.terminate();
        await audio.body.cancel().catch(() => {});
      }
    }
  }
}
