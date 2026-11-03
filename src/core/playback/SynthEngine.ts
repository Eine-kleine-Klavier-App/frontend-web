/** A sample renderer. Musical interpretation is supplied by the server. */
export interface SynthEngine {
  readonly sampleRate: number;
  prepare(): Promise<void>;
  noteOn(channel: number, pitch: number, velocity: number): void;
  noteOff(channel: number, pitch: number): void;
  sustain(down: boolean): void;
  render(frames: number): Float32Array;
  close(): void;
}

export const SYNTH_CHANNELS = 256;
export const RELEASE_SECONDS = 1.5;
