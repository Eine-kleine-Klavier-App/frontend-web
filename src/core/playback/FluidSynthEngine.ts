import { Synthesizer } from 'js-synthesizer';
import type { SynthEngine } from './SynthEngine';
import { SYNTH_CHANNELS } from './SynthEngine';

const assets = `${import.meta.env.BASE_URL}audio/`;
let moduleReady: Promise<void> | null = null;
let bank: Promise<ArrayBuffer> | null = null;

function prepareModule(): Promise<void> {
  if (!moduleReady) {
    const attempt = (async () => {
      const moduleUrl = new URL(`${assets}libfluidsynth-2.4.6.mjs`, globalThis.location.origin).href;
      const { default: module } = await import(/* @vite-ignore */ moduleUrl);
      Synthesizer.initializeWithFluidSynthModule(module);
      await Synthesizer.waitForWasmInitialized();
    })();
    moduleReady = attempt;
    void attempt.catch(() => {
      if (moduleReady === attempt) moduleReady = null;
    });
  }
  return moduleReady;
}

function loadBank(): Promise<ArrayBuffer> {
  if (!bank) {
    const attempt = fetch(`${assets}GeneralUser-GS.sf2`).then((response) => {
      if (!response.ok) throw new Error(`The piano instrument could not load (${response.status}).`);
      return response.arrayBuffer();
    });
    bank = attempt;
    void attempt.catch(() => {
      if (bank === attempt) bank = null;
    });
  }
  return bank;
}

export class FluidSynthEngine implements SynthEngine {
  private synth: Synthesizer | null = null;
  constructor(readonly sampleRate: number) {}

  async prepare(): Promise<void> {
    const [, data] = await Promise.all([prepareModule(), loadBank()]);
    this.close();
    const synth = new Synthesizer();
    synth.init(this.sampleRate, { initialGain: 0.8, midiChannelCount: SYNTH_CHANNELS, polyphony: 256 });
    this.synth = synth;
    try {
      const font = await synth.loadSFont(data);
      for (let channel = 0; channel < SYNTH_CHANNELS; channel++) {
        synth.setChannelType(channel, false);
        synth.midiProgramSelect(channel, font, 0, 0);
      }
    } catch (error) {
      this.close();
      throw error;
    }
  }
  noteOn(channel: number, pitch: number, velocity: number): void {
    this.synth!.midiNoteOn(channel, pitch, velocity);
  }
  noteOff(channel: number, pitch: number): void {
    this.synth!.midiNoteOff(channel, pitch);
  }
  sustain(down: boolean): void {
    for (let channel = 0; channel < SYNTH_CHANNELS; channel++) this.synth!.midiControl(channel, 64, down ? 127 : 0);
  }
  render(frames: number): Float32Array {
    const left = new Float32Array(frames);
    const right = new Float32Array(frames);
    this.synth!.render([left, right]);
    const samples = new Float32Array(frames * 2);
    for (let i = 0; i < frames; i++) {
      samples[i * 2] = left[i];
      samples[i * 2 + 1] = right[i];
    }
    return samples;
  }
  close(): void {
    this.synth?.close();
    this.synth = null;
  }
}
