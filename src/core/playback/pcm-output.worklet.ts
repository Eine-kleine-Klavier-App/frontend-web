// One resampler across chunk boundaries, with an explicit handoff for prepared seeks.
declare const sampleRate: number;
declare const currentTime: number;
declare class AudioWorkletProcessor { readonly port: MessagePort; }
declare function registerProcessor(name: string, processor: typeof AudioWorkletProcessor): void;

interface GainEnvelope { from: number; to: number; startFrame: number; endFrame: number }
interface TransportCommand { token: number; running: boolean; frame: number; immediate?: boolean }

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
  private transport: TransportCommand | null = null;
  private gate = 1;
  private held = false;
  private releaseGain = 0;
  private releaseRemaining = 0;

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
      else if (data.type === 'envelope' && !this.stopping) {
        // A message that arrives late still gets its whole ramp: it starts on arrival and is never cut short.
        const now = Math.round(currentTime * sampleRate);
        const envelope: GainEnvelope = { ...data };
        if (envelope.startFrame < now) {
          envelope.endFrame += now - envelope.startFrame;
          envelope.startFrame = now;
        }
        this.envelopes = this.envelopes.filter((queued) => queued.startFrame < envelope.startFrame);
        this.envelopes.push(envelope);
      }
      else if (data.type === 'transport' && this.reportControl) {
        if (data.immediate && !data.running) {
          // The position stops at once, the sound fades from its last sample instead of dropping to silence.
          this.releaseGain = this.gate;
          this.releaseRemaining = this.edge;
          this.gate = 0;
          this.held = true;
          this.acknowledgeTransport(data, Math.round(currentTime * sampleRate));
        } else this.transport = data;
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
        // The output ends only after a fade to silence has run to its end, starting one here if its message is late.
        const now = Math.round(currentTime * sampleRate);
        const last = this.envelopes.at(-1) ?? this.envelope;
        if (this.reportControl && (!last || last.to > 0)) {
          const current = this.envelope;
          const mix = current ? Math.max(0, Math.min(1, (now - current.startFrame) / Math.max(1, current.endFrame - current.startFrame))) : 1;
          const from = current ? current.from + (current.to - current.from) * mix : 1;
          this.envelopes = [{ from, to: 0, startFrame: now, endFrame: now + this.edge }];
        }
        const fades = [this.envelope, ...this.envelopes].map((envelope) => envelope?.endFrame ?? 0);
        this.stopFrame = Math.max(data.frame ?? 0, ...fades);
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

  private acknowledgeTransport(command: TransportCommand, frame: number): void {
    this.transport = null;
    this.port.postMessage({ type: 'transport', token: command.token, running: command.running,
      frames: this.consumed, phase: this.queued ? this.phase : 0, queued: this.queued, contextTime: frame / sampleRate });
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
        this.port.postMessage({ type: 'primed', queued: this.queued });
      }
      return true;
    }
    const firstFrame = Math.round(currentTime * sampleRate);
    if (this.reportControl && firstFrame < this.beginFrame) return true;
    if (this.held && !this.releaseRemaining && !this.stopping && !(this.ended && !this.queued) &&
        (!this.transport || this.transport.frame >= firstFrame + output[0].length)) return true;
    const step = this.inputRate / sampleRate;
    let lastSourceFrame = firstFrame;
    for (let i = 0; i < output[0].length; i++) {
      if (!this.primed) continue;
      const command = this.transport;
      if (command && firstFrame + i >= command.frame) {
        if (command.running && this.queued) {
          this.held = false;
          this.acknowledgeTransport(command, firstFrame + i);
        } else if (!command.running && this.gate <= 0) {
          this.held = true;
          this.acknowledgeTransport(command, firstFrame + i);
        } else if (!command.running) {
          this.gate = Math.max(0, this.gate - 1 / this.edge);
        }
      }
      if (this.held) {
        if (this.releaseRemaining) {
          const fade = this.releaseGain * this.releaseRemaining / this.edge;
          output[0][i] = this.lastLeft * fade;
          if (output[1]) output[1][i] = this.lastRight * fade;
          this.releaseRemaining--;
        }
        continue;
      }
      while (this.phase >= 1 && this.queued) {
        this.phase -= 1;
        this.advance();
      }
      if (!this.queued) continue;
      if (this.gate < 1 && (!this.transport || this.transport.running)) this.gate = Math.min(1, this.gate + 1 / this.edge);
      const left = this.value(0)!;
      const right = this.value(1)!;
      const mix = this.fadeRemaining ? 1 - this.fadeRemaining / this.edge : 1;
      this.lastLeft = this.fadeLeft * (1 - mix) + (left + ((this.value(0, true) ?? left) - left) * this.phase) * mix;
      output[0][i] = this.lastLeft * this.gate;
      if (output[1]) {
        this.lastRight = this.fadeRight * (1 - mix) + (right + ((this.value(1, true) ?? right) - right) * this.phase) * mix;
        output[1][i] = this.lastRight * this.gate;
      }
      if (this.fadeRemaining) this.fadeRemaining--;
      this.phase += step;
      while (this.phase >= 1 && this.queued) {
        this.phase -= 1;
        this.advance();
      }
      lastSourceFrame = firstFrame + i + 1;
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
      const message = { type: done ? 'done' : 'progress', frames: this.consumed,
        phase: this.queued ? this.phase : 0, queued: this.queued,
        contextTime: (this.held ? firstFrame + output[0].length : lastSourceFrame) / sampleRate,
        advancing: this.primed && !this.held && this.queued > 0 };
      (this.source ?? this.port).postMessage(message);
      if (this.source && this.reportControl) this.port.postMessage(message);
    }
    return !done;
  }
}
registerProcessor('piano-pcm-output', PcmOutput);
export {};
