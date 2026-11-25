import { useSyncExternalStore } from 'react';

/** A key going down or up on the keyboard. */
export interface MidiNoteEvent {
  kind: 'on' | 'off';
  /** MIDI pitch, 60 = middle C. */
  pitch: number;
  velocity: number;
  /** The time of the event in milliseconds on the page's clock (`performance.now()`). */
  at: number;
}

export type MidiStatus =
  /** The browser has no Web MIDI (Safari, Firefox without the add-on). */
  | 'unsupported'
  /** The player refused the browser's question. */
  | 'denied'
  /** Access is granted, but no keyboard is seen. */
  | 'searching'
  /** Keyboards are seen, but none is chosen: the first key pressed on one chooses it. */
  | 'waiting'
  | 'connected'
  /** The chosen keyboard is not there (it went away, or is not switched on yet); it is expected back. */
  | 'lost';

export interface MidiPortInfo {
  id: string;
  name: string;
}

export interface MidiState {
  status: MidiStatus;
  inputs: MidiPortInfo[];
  active: MidiPortInfo | null;
}

/** The keyboard the practice listens to. A port: the browser's Web MIDI is the first implementation. */
export interface MidiInput {
  getState(): MidiState;
  subscribe(listener: (state: MidiState) => void): () => void;
  onNote(listener: (event: MidiNoteEvent) => void): () => void;
  start(): Promise<void>;
  stop(): void;
}

/** What is used of a Web MIDI input port. */
export interface MidiPortLike {
  id: string;
  name?: string | null;
  state?: string;
  onmidimessage: ((event: { data?: Uint8Array | number[] | null; timeStamp?: number }) => void) | null;
}

/** What is used of a Web MIDI access object. */
export interface MidiAccessLike {
  inputs: { values(): Iterable<MidiPortLike> };
  onstatechange: ((event: unknown) => void) | null;
}

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface WebMidiDeps {
  /** Asks the browser for MIDI access; null where the browser has none. */
  request: (() => Promise<MidiAccessLike>) | null;
  storage: StorageLike | null;
  now: () => number;
}

const STORAGE_KEY = 'piano.midiInput';
const NOTE_ON = 0x90;
const NOTE_OFF = 0x80;

function defaultDeps(): WebMidiDeps {
  const nav = typeof navigator === 'undefined' ? undefined : (navigator as unknown as { requestMIDIAccess?: () => Promise<MidiAccessLike> });
  let storage: StorageLike | null = null;
  try {
    storage = typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    storage = null;
  }
  return {
    request: nav?.requestMIDIAccess ? () => nav.requestMIDIAccess!.call(navigator) : null,
    storage,
    now: () => performance.now(),
  };
}

function remembered(storage: StorageLike | null): MidiPortInfo | null {
  try {
    const raw = storage?.getItem(STORAGE_KEY);
    const value = raw ? JSON.parse(raw) as Partial<MidiPortInfo> : null;
    return value && typeof value.id === 'string' ? { id: value.id, name: String(value.name ?? '') } : null;
  } catch {
    return null;
  }
}

/**
 * Web MIDI. It listens to every keyboard at once; the first key pressed on one makes it the chosen
 * keyboard, and the choice is remembered for the next visit, when a keyboard that is already there is
 * chosen without a press. Only the chosen keyboard sends notes on.
 */
export class WebMidiInput implements MidiInput {
  private state: MidiState = { status: 'searching', inputs: [], active: null };
  private listeners = new Set<(state: MidiState) => void>();
  private noteListeners = new Set<(event: MidiNoteEvent) => void>();
  private access: MidiAccessLike | null = null;
  private deps: WebMidiDeps | null = null;
  private attached = new Set<MidiPortLike>();

  constructor(private readonly makeDeps: () => WebMidiDeps = defaultDeps) {}

  getState(): MidiState {
    return this.state;
  }

  subscribe(listener: (state: MidiState) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  onNote(listener: (event: MidiNoteEvent) => void): () => void {
    this.noteListeners.add(listener);
    return () => {
      this.noteListeners.delete(listener);
    };
  }

  async start(): Promise<void> {
    if (this.access) return;
    const deps = (this.deps = this.makeDeps());
    if (!deps.request) {
      this.set({ status: 'unsupported' });
      return;
    }
    try {
      this.access = await deps.request();
    } catch {
      this.set({ status: 'denied' });
      return;
    }
    this.access.onstatechange = () => this.refresh();
    const saved = remembered(deps.storage);
    if (saved) this.state = { ...this.state, active: saved };
    this.refresh();
  }

  stop(): void {
    for (const port of this.attached) port.onmidimessage = null;
    this.attached.clear();
    if (this.access) this.access.onstatechange = null;
    this.access = null;
    this.set({ status: 'searching', inputs: [], active: null });
  }

  private present(): MidiPortLike[] {
    if (!this.access) return [];
    return [...this.access.inputs.values()].filter((port) => port.state === undefined || port.state === 'connected');
  }

  /** Reads the ports again: who is there, who is chosen, what the state is. */
  private refresh(): void {
    const ports = this.present();
    for (const port of ports) {
      if (this.attached.has(port)) continue;
      this.attached.add(port);
      port.onmidimessage = (event) => this.message(port, event);
    }
    const inputs = ports.map((port) => ({ id: port.id, name: port.name || port.id }));
    const active = this.state.active;
    const activePresent = active !== null && inputs.some((input) => input.id === active.id);
    const status: MidiStatus = active ? (activePresent ? 'connected' : 'lost') : inputs.length ? 'waiting' : 'searching';
    this.set({ inputs, status });
  }

  private message(port: MidiPortLike, event: { data?: Uint8Array | number[] | null; timeStamp?: number }): void {
    const data = event.data;
    if (!data || data.length < 3) return;
    const type = data[0] & 0xf0;
    if (type !== NOTE_ON && type !== NOTE_OFF) return;
    const on = type === NOTE_ON && data[2] > 0;
    const { active, status } = this.state;
    if (active && status === 'connected') {
      // Only the chosen keyboard plays; another port that sends notes is ignored.
      if (active.id !== port.id) return;
    } else {
      // The first key pressed on a keyboard chooses it; the press itself is not a note of the music.
      if (on) this.choose({ id: port.id, name: port.name || port.id });
      return;
    }
    const note: MidiNoteEvent = { kind: on ? 'on' : 'off', pitch: data[1], velocity: data[2], at: event.timeStamp ?? this.deps?.now() ?? 0 };
    for (const listener of this.noteListeners) listener(note);
  }

  private choose(port: MidiPortInfo): void {
    try {
      this.deps?.storage?.setItem(STORAGE_KEY, JSON.stringify(port));
    } catch {
      // The choice still holds for this visit.
    }
    this.state = { ...this.state, active: port };
    this.refresh();
  }

  private set(patch: Partial<MidiState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener(this.state);
  }
}

export const midiInput: MidiInput = new WebMidiInput();

export function useMidiState(): MidiState {
  return useSyncExternalStore(
    (cb) => midiInput.subscribe(() => cb()),
    () => midiInput.getState(),
  );
}
