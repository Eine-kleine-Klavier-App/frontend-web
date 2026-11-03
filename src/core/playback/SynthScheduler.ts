import type { PlaybackMap, PlaybackNote } from './PlaybackGateway';
import type { SynthEngine } from './SynthEngine';
import { RELEASE_SECONDS, SYNTH_CHANNELS } from './SynthEngine';

type Event = { frame: number; order: number; kind: 'on' | 'off'; id: number; note: PlaybackNote }
  | { frame: number; order: number; kind: 'pedal'; down: boolean };

/** Exact frame events; releasing a target preserves its existing release voices. */
export class SynthScheduler {
  private events: Event[] = [];
  private next = 0;
  private frame = 0;
  private serial = 0;
  private active = new Map<number, { channel: number; pitch: number; until: number }>();
  private releasing = new Map<string, number>();
  private endFrame = 0;
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
