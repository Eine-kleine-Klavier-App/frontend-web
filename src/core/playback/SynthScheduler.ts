import type { PlaybackMap, PlaybackNote } from './PlaybackGateway';
import type { SynthEngine } from './SynthEngine';
import { RELEASE_SECONDS, SYNTH_CHANNELS } from './SynthEngine';

type Event = { frame: number; order: number; kind: 'on' | 'off'; id: number; note: PlaybackNote }
  | { frame: number; order: number; kind: 'pedal'; down: boolean };

/** The synthesis worker renders and the cache keeps audio in chunks of this many frames. */
export const CHUNK_FRAMES = 4096;
/** Rendering starts this long before the first note that still sounds, so the reverb and chorus tails are in place. */
const WARMUP_SECONDS = 3;
/** Silence rendered and thrown away before a new start, so the tails of the previous position are gone. */
const FLUSH_SECONDS = 4;
/** A note counts as still sounding this long after its end (its release and the pedal-free decay of the instrument). */
const TAIL_SECONDS = 8;

/**
 * The frame to start rendering at, so that the audio from `targetFrame` on is the audio of a render from the beginning:
 * the earliest note that still sounds at the target (its tail ends 1.5 s after it is released), and a warm-up before it.
 * Aligned down to a chunk.
 */
export function renderStartFrame(map: PlaybackMap, targetFrame: number, sampleRate: number): number {
  const targetMs = targetFrame * 1000 / sampleRate;
  let startMs = targetMs;
  for (const note of map.notes) {
    if (note.startMs < startMs && note.endMs + TAIL_SECONDS * 1000 > targetMs) startMs = note.startMs;
  }
  const frame = Math.max(0, Math.round((startMs / 1000 - WARMUP_SECONDS) * sampleRate));
  return Math.floor(frame / CHUNK_FRAMES) * CHUNK_FRAMES;
}

/** Exact frame events; releasing a target preserves its existing release voices. */
export class SynthScheduler {
  private events: Event[] = [];
  private next = 0;
  private frame = 0;
  private serial = 0;
  private active = new Map<number, { channel: number; pitch: number; until: number }>();
  private releasing = new Map<string, number>();
  private endFrame = 0;
  private used = false;
  constructor(private engine: SynthEngine) {}
  get remaining(): number {
    return Math.max(0, this.endFrame - this.frame);
  }
  private at(ms: number): number {
    return Math.round(ms * this.engine.sampleRate / 1000);
  }

  replace(map: PlaybackMap): void {
    this.release();
    const origin = this.frame;
    this.events = [];
    for (const note of map.notes) {
      const id = ++this.serial;
      this.events.push({ kind: 'on', id, note, frame: origin + this.at(note.startMs), order: 3 });
      this.events.push({ kind: 'off', id, note, frame: origin + this.at(note.keyReleaseMs), order: 1 });
    }
    for (const pedal of map.pedals) {
      this.events.push({ kind: 'pedal', down: true, frame: origin + this.at(pedal.downMs), order: 2 });
      this.events.push({ kind: 'pedal', down: false, frame: origin + this.at(pedal.upMs), order: 0 });
    }
    this.events.sort((a, b) => a.frame - b.frame || a.order - b.order);
    this.next = 0;
    this.endFrame = origin + this.at(map.extentMs) + Math.round(RELEASE_SECONDS * this.engine.sampleRate);
  }

  /** Start the map at `startFrame` (a frame of the whole piece) with the pedal as it is there; notes begun earlier are not played. */
  replaceFrom(map: PlaybackMap, startFrame: number): void {
    this.release();
    this.releasing.clear();
    this.engine.silence?.();
    // Silence first, so the tails of the previous position die out (only when there is one).
    if (this.used) {
      const flush = Math.round(FLUSH_SECONDS * this.engine.sampleRate);
      for (let left = flush; left > 0; left -= CHUNK_FRAMES) this.engine.render(Math.min(CHUNK_FRAMES, left));
    }
    this.events = [];
    for (const note of map.notes) {
      const on = this.at(note.startMs);
      if (on < startFrame) continue;
      const id = ++this.serial;
      this.events.push({ kind: 'on', id, note, frame: on, order: 3 });
      this.events.push({ kind: 'off', id, note, frame: this.at(note.keyReleaseMs), order: 1 });
    }
    for (const pedal of map.pedals) {
      const down = this.at(pedal.downMs);
      const up = this.at(pedal.upMs);
      if (up <= startFrame) continue;
      this.events.push({ kind: 'pedal', down: true, frame: Math.max(down, startFrame), order: 2 });
      this.events.push({ kind: 'pedal', down: false, frame: up, order: 0 });
    }
    this.events.sort((a, b) => a.frame - b.frame || a.order - b.order);
    this.next = 0;
    this.frame = startFrame;
    this.endFrame = this.at(map.extentMs) + Math.round(RELEASE_SECONDS * this.engine.sampleRate);
  }

  release(): void {
    this.engine.sustain(false);
    for (const voice of this.active.values()) {
      this.engine.noteOff(voice.channel, voice.pitch);
      this.releasing.set(`${voice.pitch}:${voice.channel}`, this.frame + Math.round(RELEASE_SECONDS * this.engine.sampleRate));
    }
    this.active.clear();
    this.events = [];
    this.next = 0;
    this.endFrame = this.frame + Math.round(RELEASE_SECONDS * this.engine.sampleRate);
  }

  private event(event: Event): void {
    if (event.kind === 'pedal') {
      this.engine.sustain(event.down);
      return;
    }
    if (event.kind === 'off') {
      const voice = this.active.get(event.id);
      if (voice) {
        this.engine.noteOff(voice.channel, voice.pitch);
        this.releasing.set(`${voice.pitch}:${voice.channel}`, voice.until);
        this.active.delete(event.id);
      }
      return;
    }
    const used = new Set([...this.active.values()].filter((v) => v.pitch === event.note.pitch).map((v) => v.channel));
    let channel = 0;
    while (channel < SYNTH_CHANNELS && (used.has(channel) || (this.releasing.get(`${event.note.pitch}:${channel}`) ?? 0) > this.frame)) channel++;
    if (channel === SYNTH_CHANNELS) throw new Error('Too many overlapping attacks of the same piano key.');
    this.engine.noteOn(channel, event.note.pitch, event.note.velocity);
    this.active.set(event.id, { channel, pitch: event.note.pitch, until: this.frame + this.at(event.note.endMs - event.note.startMs) + Math.round(RELEASE_SECONDS * this.engine.sampleRate) });
  }

  render(frames: number): Float32Array {
    this.used = true;
    const count = Math.min(frames, this.remaining);
    const result = new Float32Array(count * 2);
    let offset = 0;
    while (offset < count) {
      while (this.next < this.events.length && this.events[this.next].frame <= this.frame) this.event(this.events[this.next++]);
      const nextFrame = this.events[this.next]?.frame ?? Infinity;
      const length = Math.min(count - offset, nextFrame - this.frame);
      result.set(this.engine.render(length), offset * 2);
      offset += length;
      this.frame += length;
    }
    return result;
  }
}
