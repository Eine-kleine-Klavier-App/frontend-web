// One resampler across chunk boundaries, with an explicit handoff for prepared seeks.
declare const sampleRate: number;
declare const currentTime: number;
declare class AudioWorkletProcessor { readonly port: MessagePort; }
declare function registerProcessor(name: string, processor: typeof AudioWorkletProcessor): void;

interface GainEnvelope { from: number; to: number; startFrame: number; endFrame: number }

class PcmOutput extends AudioWorkletProcessor {
  private source: MessagePort | null = null;
  private reportControl = false;
  private awaitingBegin = false;
  private beginFrame = 0;
  private envelopes: GainEnvelope[] = [];
  private envelope: GainEnvelope | null = null;
  private announced = false;
  private chunks: Float32Array[] = [];
  private head = 0;
  private offset = 0;
  private phase = 0;
  private inputRate = 44100;
  private consumed = 0;
  private reported = 0;
  private queued = 0;
  private ended = false;
  private primed = false;
  private primeFrames = 1;
  private target = 0;
  private stopped = false;
  private stopping = false;
  private stopFrame = 0;
  private lastLeft = 0;
  private lastRight = 0;
  private fadeLeft = 0;
  private fadeRight = 0;
  private fadeRemaining = 0;
  private readonly edge = Math.max(1, Math.round(sampleRate * 0.01));
  private fadeIn = 0;
  private fadeOut = 0;

  constructor() {
    super();
    this.port.onmessage = ({ data }) => {
      if (data.type === 'source') {
        this.source = data.port;
        this.reportControl = data.reportControl === true;
        this.awaitingBegin = this.reportControl;
        this.source!.onmessage = this.port.onmessage;
        this.source!.start();
      } else if (data.type === 'begin') {
        this.beginFrame = data.frame ?? Math.round(currentTime * sampleRate);
        this.awaitingBegin = false;
      }
      else if (data.type === 'envelope') {
        this.envelopes = this.envelopes.filter((envelope) => envelope.startFrame < data.startFrame);
        this.envelopes.push(data);
      }
      else if (data.type === 'configure') {
        this.inputRate = data.sampleRate;
        this.primeFrames = data.primeFrames;
      }
      else if (data.type === 'packet' && data.target < this.target) this.consumed += data.samples.length / 2;
      else if (data.type === 'packet' || data.type === 'chunk') {
        if (data.type === 'packet' && data.target > this.target) {
          this.target = data.target;
          this.consumed += this.queued;
          this.chunks = [];
          this.head = 0;
          this.offset = 0;
          this.queued = 0;
          this.phase = 0;
          this.fadeLeft = this.lastLeft;
          this.fadeRight = this.lastRight;
          this.fadeRemaining = this.edge;
        }
        this.chunks.push(data.samples);
        this.queued += data.samples.length / 2;
      } else if (data.type === 'drain') this.primed = true;
      else if (data.type === 'end') this.ended = true;
      else if (data.type === 'stop' && !this.stopping) {
        this.stopping = true;
        this.stopFrame = data.frame ?? 0;
        this.fadeOut = this.edge;
      }
    };
  }
  private value(channel: number, next = false): number | undefined {
    const chunk = this.chunks[this.head];
    if (!chunk) return undefined;
    const index = this.offset + (next ? 2 : 0) + channel;
    return index < chunk.length ? chunk[index] : this.chunks[this.head + 1]?.[channel];
  }
  private advance(): void {
    this.offset += 2;
    this.queued--;
    this.consumed++;
    if (this.offset === this.chunks[this.head].length) {
      this.head++;
      this.offset = 0;
    }
  }
  private finish(): boolean {
    this.stopped = true;
    this.source?.close();
    this.port.postMessage({ type: 'stopped' });
    return false;
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    if (this.stopped) return false;
    const output = outputs[0];
    if (!output?.length) return true;
    if (this.stopping && (!this.primed || this.awaitingBegin)) return this.finish();
    if (!this.primed && (this.queued >= this.primeFrames || this.ended)) this.primed = true;
    if (this.primed && this.awaitingBegin) {
      if (!this.announced) {
        this.announced = true;
        this.port.postMessage({ type: 'primed' });
      }
      return true;
    }
    if (this.reportControl && Math.round(currentTime * sampleRate) < this.beginFrame) return true;
    const step = this.inputRate / sampleRate;
    for (let i = 0; i < output[0].length; i++) {
      if (!this.primed) continue;
      while (this.phase >= 1 && this.queued) {
        this.phase -= 1;
        this.advance();
      }
      if (!this.queued) continue;
      const left = this.value(0)!;
      const right = this.value(1)!;
      const mix = this.fadeRemaining ? 1 - this.fadeRemaining / this.edge : 1;
      this.lastLeft = output[0][i] = this.fadeLeft * (1 - mix) + (left + ((this.value(0, true) ?? left) - left) * this.phase) * mix;
      if (output[1]) this.lastRight = output[1][i] = this.fadeRight * (1 - mix) + (right + ((this.value(1, true) ?? right) - right) * this.phase) * mix;
      if (this.fadeRemaining) this.fadeRemaining--;
      this.phase += step;
      while (this.phase >= 1 && this.queued) {
        this.phase -= 1;
        this.advance();
      }
    }
    if (this.primed && !this.reportControl && (this.fadeIn < this.edge || this.stopping)) {
      for (let i = 0; i < output[0].length; i++) {
        let gain = Math.min(1, this.fadeIn / this.edge);
        if (this.fadeIn < this.edge) this.fadeIn++;
        if (this.stopping) {
          gain *= this.fadeOut / this.edge;
          if (this.fadeOut) this.fadeOut--;
        }
        for (const channel of output) channel[i] *= gain;
      }
    }
    if (this.reportControl) {
      const firstFrame = Math.round(currentTime * sampleRate);
      for (let i = 0; i < output[0].length; i++) {
        const frame = firstFrame + i;
        while (this.envelopes.length && this.envelopes[0].startFrame <= frame) this.envelope = this.envelopes.shift()!;
        const envelope = this.envelope;
        const mix = envelope ? Math.max(0, Math.min(1, (frame - envelope.startFrame) / Math.max(1, envelope.endFrame - envelope.startFrame))) : 1;
        const gain = envelope ? envelope.from + (envelope.to - envelope.from) * mix : 1;
        for (const channel of output) channel[i] *= gain;
      }
    }
    if (this.stopping && (this.reportControl ? Math.round(currentTime * sampleRate) >= this.stopFrame : !this.fadeOut)) return this.finish();
    if (this.head > 64) {
      this.chunks = this.chunks.slice(this.head);
      this.head = 0;
    }
    const done = this.ended && this.queued === 0;
    const report = this.consumed - this.reported >= 256 || done || (!this.queued && this.consumed !== this.reported);
    if (report) {
      this.reported = this.consumed;
      const message = { type: done ? 'done' : 'progress', frames: this.consumed, queued: this.queued, contextTime: currentTime + output[0].length / sampleRate, advancing: this.primed && this.queued > 0 };
      (this.source ?? this.port).postMessage(message);
      if (this.source && this.reportControl) this.port.postMessage(message);
    }
    return !done;
  }
}
registerProcessor('piano-pcm-output', PcmOutput);
export {};
