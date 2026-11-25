import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url), ts = require('typescript');
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

let fakeNow = 0;
function load(file, stubs = {}, cache = new Map()) {
  const full = path.join(root, file);
  if (cache.has(full)) return cache.get(full).exports;
  const module = { exports: {} }; cache.set(full, module);
  const js = ts.transpileModule(fs.readFileSync(full, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(js, {
    module, exports: module.exports, console, setTimeout, clearTimeout, Promise, Map, Set, Array, Math, Number, Date, Error, TypeError, DOMException,
    performance: { now: () => fakeNow },
    require(name) {
      if (name in stubs) return stubs[name];
      if (name.startsWith('@/')) return load('src/' + name.slice(2) + '.ts', stubs, cache);
      if (name.startsWith('.')) return load(path.relative(root, path.resolve(path.dirname(full), name + '.ts')), stubs, cache);
      throw new Error('Unexpected import: ' + name);
    },
  }, { filename: full });
  return module.exports;
}
const plain = (value) => JSON.parse(JSON.stringify(value));
const flush = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };

const note = (pitch, startMs, sourceId = 'n' + pitch + '@' + startMs) => ({ sourceId, pitch, startMs, keyReleaseMs: startMs + 200, endMs: startMs + 200, velocity: 80 });
const mapOf = (notes, extentMs = 5000) => ({ pedals: [], notes, anchors: [], segments: [], extentMs, version: 1 });

// ---- points ----
const { practicePoints, WaitMatcher, DEFAULT_CHORD_WINDOW_MS } = load('src/core/practice/waitMode.ts');
{
  const points = practicePoints(mapOf([
    note(67, 1000), note(60, 0), note(64, 500),                                  // out of order on purpose
    note(60, 1500), note(64, 1500), note(67, 1500), note(67, 1500, 'second voice'), // a chord, the same pitch in two voices
    note(60, 2000), note(64, 2080), note(67, 2160),                              // an arpeggio: three points
  ]));
  assert.deepEqual(plain(points.map(p => [p.startMs, p.pitches])), [
    [0, [60]], [500, [64]], [1000, [67]], [1500, [60, 64, 67]], [2000, [60]], [2080, [64]], [2160, [67]],
  ]);
  assert.deepEqual(plain(points.map(p => p.index)), [0, 1, 2, 3, 4, 5, 6]);
  assert.deepEqual(plain(practicePoints(mapOf([]))), []);
  console.log('PASS points: grouped by start, chords one point, arpeggio and ornament notes each their own, order by time');
}

// ---- matcher ----
{
  const points = practicePoints(mapOf([note(60, 0), note(64, 500), note(60, 1000), note(64, 1000), note(67, 1000)]));
  const matcher = new WaitMatcher(points, 200);
  assert.equal(DEFAULT_CHORD_WINDOW_MS, 200);
  assert.equal(matcher.completed, 0);
  // an extra note and a note of a later point do nothing
  assert.deepEqual(plain(matcher.press(61, 0)), { accepted: false, completed: false });
  assert.deepEqual(plain(matcher.press(64, 10)), { accepted: false, completed: false });
  assert.equal(matcher.completed, 0);
  assert.deepEqual(plain(matcher.press(60, 20)), { accepted: true, completed: true });
  assert.equal(matcher.completed, 1);
  // too fast does not matter, only the order: E follows at once
  assert.deepEqual(plain(matcher.press(64, 25)), { accepted: true, completed: true });
  assert.equal(matcher.completed, 2);
  // the chord: C and E, then a stranger, then G within the window
  assert.deepEqual(plain(matcher.press(60, 1000)), { accepted: true, completed: false });
  assert.deepEqual(plain(matcher.press(64, 1050)), { accepted: true, completed: false });
  assert.deepEqual(plain(matcher.press(70, 1060)), { accepted: false, completed: false });
  assert.equal(matcher.done, false);
  assert.deepEqual(plain(matcher.press(67, 1150)), { accepted: true, completed: true });
  assert.equal(matcher.done, true);
  assert.equal(matcher.current, null);
  assert.deepEqual(plain(matcher.press(60, 2000)), { accepted: false, completed: false });
  matcher.reset();
  assert.equal(matcher.completed, 0);
  console.log('PASS matcher: order only, extra and early notes ignored, fast presses pass, a lap ends at the last point, reset starts again');
}
{
  const points = practicePoints(mapOf([note(60, 0), note(64, 0), note(67, 0), note(60, 1000)]));
  const matcher = new WaitMatcher(points, 200);
  // the notes of a chord more than the window apart do not add up: the first one is forgotten
  matcher.press(60, 0);
  matcher.press(64, 1000);
  assert.deepEqual(plain(matcher.press(67, 1100)), { accepted: true, completed: false }, 'C was pressed a second ago, so the chord is not complete');
  assert.deepEqual(plain(matcher.press(60, 1150)), { accepted: true, completed: true }, 'pressed again near E and G, the chord is complete');
  // the window can change
  const wide = new WaitMatcher(points, 2000);
  wide.press(60, 0); wide.press(64, 1000);
  assert.equal(wide.press(67, 1100).completed, true);
  // the same key pressed twice is one note of the chord, not two
  const twice = new WaitMatcher(points, 200);
  twice.press(60, 0); twice.press(60, 10); twice.press(64, 20);
  assert.equal(twice.completed, 0);
  assert.equal(twice.press(67, 30).completed, true);
  console.log('PASS matcher: chord window, repeated key, widened window');
}
{
  // a key still held from the previous point sends no new note-on, so it cannot complete the next point
  const points = practicePoints(mapOf([note(60, 0), note(60, 1000), note(64, 2000)]));
  const matcher = new WaitMatcher(points, 200);
  matcher.press(60, 0);
  assert.equal(matcher.completed, 1);
  // C is still held down: nothing arrives. Then E, which is not the awaited point.
  assert.deepEqual(plain(matcher.press(64, 500)), { accepted: false, completed: false });
  assert.equal(matcher.completed, 1);
  assert.equal(matcher.press(60, 1500).completed, true);
  console.log('PASS matcher: a held key needs a new attack for the repeated note');
}

// ---- clock ----
const { PracticeClock } = load('src/core/practice/PracticeClock.ts');
{
  const clock = new PracticeClock();
  clock.reset(0); clock.setLimit(500);
  assert.equal(clock.at(1000), 0, 'it does not run until it is told to');
  clock.setRunning(true);
  assert.equal(clock.at(1000), 0, 'the first frame after a start only takes the frame time');
  assert.equal(clock.at(1016), 16);
  assert.equal(clock.at(1016), 16, 'the same frame gives the same position');
  assert.equal(clock.at(1032), 32);
  assert.equal(clock.at(1032 + 5000), 282, 'a stalled frame moves the line by a capped step');
  clock.setLimit(300);
  assert.equal(clock.at(1032 + 5000 + 16), 298);
  assert.equal(clock.at(1032 + 5000 + 400), 300, 'it stops at the limit');
  assert.equal(clock.waiting, true);
  clock.setLimit(400);
  assert.equal(clock.waiting, false);
  assert.equal(clock.at(1032 + 5000 + 416), 316, 'a new limit lets it run on from where it stood');
  clock.setRunning(false);
  assert.equal(clock.at(9999), 316, 'held');
  clock.setRunning(true);
  clock.at(10000);
  assert.equal(clock.at(10010), 326, 'after a hold it goes on from where it stood');
  clock.reset(0);
  assert.equal(clock.at(10020), 0);
  console.log('PASS clock: runs with the frames, stops at the limit, holds, never leaps, resets');
}

// ---- MIDI input ----
const { WebMidiInput } = load('src/core/midi/MidiInput.ts', { react: { useSyncExternalStore() {} } });
class FakeAccess {
  constructor() { this.ports = []; this.onstatechange = null; this.inputs = { values: () => this.ports.filter(Boolean)[Symbol.iterator]() }; }
  plug(id, name) { const port = { id, name, state: 'connected', onmidimessage: null }; this.ports.push(port); this.onstatechange?.({ port }); return port; }
  unplug(port) { port.state = 'disconnected'; this.onstatechange?.({ port }); }
  replug(port) { port.state = 'connected'; this.onstatechange?.({ port }); }
}
const storageOf = (initial = null) => { const data = new Map(initial ? [['piano.midiInput', initial]] : []); return { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => data.set(k, v), data }; };
const press = (port, pitch, velocity = 100, at = 1) => port.onmidimessage({ data: [0x90, pitch, velocity], timeStamp: at });
const release = (port, pitch, at = 1) => port.onmidimessage({ data: [0x80, pitch, 0], timeStamp: at });
{
  const none = new WebMidiInput(() => ({ request: null, storage: null, now: () => 0 }));
  await none.start();
  assert.equal(none.getState().status, 'unsupported');
  const refused = new WebMidiInput(() => ({ request: async () => { throw new Error('NotAllowedError'); }, storage: null, now: () => 0 }));
  await refused.start();
  assert.equal(refused.getState().status, 'denied');
  console.log('PASS midi: no Web MIDI and a refused permission are told apart');
}
{
  const access = new FakeAccess(), storage = storageOf();
  const midi = new WebMidiInput(() => ({ request: async () => access, storage, now: () => 0 }));
  const notes = [];
  midi.onNote((event) => notes.push(plain(event)));
  await midi.start();
  assert.equal(midi.getState().status, 'searching');
  const piano = access.plug('fp10', 'FP-10');
  const other = access.plug('iac', 'IAC Driver');
  assert.equal(midi.getState().status, 'waiting');
  assert.deepEqual(plain(midi.getState().inputs.map((i) => i.name)), ['FP-10', 'IAC Driver']);
  press(piano, 60, 100, 5);
  assert.equal(midi.getState().status, 'connected');
  assert.equal(midi.getState().active.id, 'fp10');
  assert.equal(notes.length, 0, 'the press that chooses the keyboard is not a note');
  assert.ok(storage.data.get('piano.midiInput').includes('fp10'), 'the choice is remembered');
  press(piano, 62, 90, 10); release(piano, 62, 40); press(piano, 64, 0, 50);
  press(other, 65, 80, 60);
  assert.deepEqual(notes, [
    { kind: 'on', pitch: 62, velocity: 90, at: 10 },
    { kind: 'off', pitch: 62, velocity: 0, at: 40 },
    { kind: 'off', pitch: 64, velocity: 0, at: 50 },
  ], 'a note-on with velocity 0 is a release, and another port is ignored');
  piano.onmidimessage({ data: [0xb0, 64, 127] });
  piano.onmidimessage({ data: [0x90, 60] });
  assert.equal(notes.length, 3, 'controllers and short messages are not notes');
  console.log('PASS midi: waiting, the first key chooses and is remembered, notes and releases, other ports ignored');

  access.unplug(piano);
  assert.equal(midi.getState().status, 'lost');
  assert.equal(midi.getState().active.id, 'fp10', 'the chosen keyboard is kept while it is away');
  access.replug(piano);
  assert.equal(midi.getState().status, 'connected');
  press(piano, 67, 70, 100);
  assert.equal(notes.at(-1).pitch, 67);
  console.log('PASS midi: a lost keyboard is expected back and plays again');
}
{
  const access = new FakeAccess();
  access.plug('fp10', 'FP-10');
  const storage = storageOf(JSON.stringify({ id: 'fp10', name: 'FP-10' }));
  const midi = new WebMidiInput(() => ({ request: async () => access, storage, now: () => 0 }));
  const notes = [];
  midi.onNote((event) => notes.push(event));
  await midi.start();
  assert.equal(midi.getState().status, 'connected', 'a remembered keyboard that is there needs no key press');
  press(access.ports[0], 60, 100, 1);
  assert.equal(notes.length, 1);
  const away = new FakeAccess();
  const later = new WebMidiInput(() => ({ request: async () => away, storage, now: () => 0 }));
  await later.start();
  assert.equal(later.getState().status, 'lost', 'a remembered keyboard that is not switched on yet is waited for');
  away.plug('fp10', 'FP-10');
  assert.equal(later.getState().status, 'connected');
  console.log('PASS midi: a remembered keyboard connects by itself, also when it is switched on later');
}

// ---- the practice session on the navigation ----
const reactStub = { useSyncExternalStore() {} };
let frameNow = 0, frameListener = null;
const { ScoreNavigation } = load('src/core/navigation/ScoreNavigation.ts', { react: reactStub });
const { PracticeSession } = load('src/core/practice/PracticeSession.ts', {
  react: reactStub,
  '@/core/playback/MediaClock': { frameTimeMs: () => frameNow, onAnimationFrame: () => () => {} },
  '@/core/playback/PlaybackController': { playback: null },
  '@/core/midi/MidiInput': { midiInput: null },
});
const practiceMap = (notes, extentMs = 3000) => ({
  pedals: [], notes, extentMs, version: 1,
  anchors: notes.map((n) => ({ carrierId: 'c' + n.startMs, startMs: n.startMs, endMs: n.startMs + 400 })),
  segments: [{ startBeats: 0, endBeats: extentMs / 500, startMs: 0, endMs: extentMs, moments: [{ beats: 0, timeMs: 0 }, { beats: extentMs / 500, timeMs: extentMs }] }],
});
function harness({ connected = true, notes = [note(60, 0), note(64, 500), note(67, 1000)] } = {}) {
  const navigation = new ScoreNavigation();
  navigation.update({ map: practiceMap(notes) });
  const midi = {
    status: connected ? 'connected' : 'lost', listeners: new Set(), noteListeners: new Set(),
    getState() { return { status: this.status, inputs: [], active: null }; },
    subscribe(l) { this.listeners.add(l); return () => this.listeners.delete(l); },
    onNote(l) { this.noteListeners.add(l); return () => this.noteListeners.delete(l); },
    setStatus(status) { this.status = status; for (const l of this.listeners) l(this.getState()); },
    key(kind, pitch, at) { for (const l of this.noteListeners) l({ kind, pitch, velocity: 90, at }); },
  };
  const playback = {
    state: { playing: false, loading: false, paused: false }, listeners: new Set(), plays: 0, stops: 0,
    getState() { return this.state; },
    subscribe(l) { this.listeners.add(l); return () => this.listeners.delete(l); },
    emit(patch) { this.state = { ...this.state, ...patch }; for (const l of this.listeners) l(this.state); },
    async play() { this.plays++; this.emit({ loading: true }); this.emit({ loading: false, playing: true }); },
    stop() { this.stops++; this.emit({ playing: false, loading: false, paused: false }); },
  };
  // the sound player's driver sits below the practice on the navigation, as it does in the app
  let soundMs = null;
  navigation.attach(() => soundMs);
  const timers = [];
  let fakeClock = 0;
  const session = new PracticeSession({
    navigation, midi, playback,
    frame: () => frameNow, onFrame: (l) => { frameListener = l; return () => { frameListener = null; }; },
    setTimeout: (cb, ms) => { const t = { cb, ms, live: true }; timers.push(t); return t; }, clearTimeout: (t) => { t.live = false; },
    now: () => fakeClock, countStepMs: 1000,
  });
  const frames = (from, to, step = 16) => { for (let t = from; t <= to; t += step) { frameNow = t; fakeClock = t; frameListener?.(t); } };
  const fireTimer = () => { const t = timers.find((x) => x.live); assert.ok(t, 'a timer is waiting'); t.live = false; t.cb(); };
  return { navigation, midi, playback, session, frames, fireTimer, setSound: (ms) => { soundMs = ms; } };
}
{
  const h = harness();
  h.frames(0, 0);
  h.session.start();
  assert.equal(h.session.getState().phase, 'running');
  assert.equal(h.session.getState().total, 3);
  assert.equal(h.navigation.getState().cursorShown, true);
  assert.deepEqual(plain(h.session.getState().expected), [60], 'the keys of the first point are the ones asked for');
  // the first point is at 0: the line stands there and waits
  h.frames(0, 400);
  assert.equal(h.navigation.getTimeMs(), 0);
  h.midi.key('on', 60, 100);
  assert.equal(h.session.getState().completed, 1);
  assert.deepEqual(plain(h.session.getState().expected), [64], 'and then those of the next point');
  h.frames(416, 2000);
  assert.equal(h.navigation.getTimeMs(), 500, 'the line ran at the pace of the frames to the next point and stopped');
  assert.equal(h.navigation.getState().timeMs, 500, 'the navigation record follows the line');
  assert.deepEqual(plain(h.navigation.getState().activeCarrierIds), ['c500'], 'the carrier to play is the active one');
  console.log('PASS session: the line runs to the next point and waits there; the cursor is shown');

  // wrong notes do nothing; the right one lets the line run on
  h.midi.key('on', 61, 2100); h.midi.key('on', 67, 2105);
  assert.equal(h.session.getState().completed, 1);
  h.frames(2016, 2500);
  assert.equal(h.navigation.getTimeMs(), 500);
  h.midi.key('on', 64, 2600);
  h.frames(2616, 4000);
  assert.equal(h.navigation.getTimeMs(), 1000);
  // the last point ends the lap: the line goes back to the start
  h.midi.key('on', 67, 4100);
  assert.equal(h.session.getState().lap, 1);
  assert.equal(h.session.getState().completed, 0);
  assert.equal(h.navigation.getTimeMs(), 0, 'a new lap starts at the beginning of the loop');
  h.midi.key('on', 60, 4200);
  assert.equal(h.session.getState().completed, 1);
  console.log('PASS session: wrong notes are ignored, a lap ends at the last point and starts again');

  // keys held down are tracked for the keyboard lights
  for (const held of plain(h.session.getState().pressed)) h.midi.key('off', held, 4250);
  assert.deepEqual(plain(h.session.getState().pressed), []);
  h.midi.key('on', 62, 4300); h.midi.key('on', 65, 4301);
  assert.deepEqual(plain(h.session.getState().pressed), [62, 65]);
  h.midi.key('off', 62, 4400);
  assert.deepEqual(plain(h.session.getState().pressed), [65]);

  h.session.stop();
  assert.equal(h.session.getState().phase, 'idle');
  assert.equal(h.navigation.getState().cursorShown, false);
  assert.equal(h.navigation.getTimeMs(), h.navigation.getState().timeMs, 'detached: the held position stays');
  console.log('PASS session: pressed keys, stop detaches and keeps the position');
}
{
  // the position slider and Stop: the line is put at a place of the score, the points before it count as played
  const h = harness();
  h.frames(0, 0);
  h.session.start();
  h.session.seek(1.2);
  assert.equal(h.navigation.getTimeMs(), 600);
  assert.equal(h.session.getState().completed, 2, 'the points before the place count as played');
  h.frames(16, 3000);
  assert.equal(h.navigation.getTimeMs(), 1000, 'the line runs on from the place and waits at the next point');
  h.midi.key('on', 64, 3100);
  assert.equal(h.session.getState().completed, 2, 'a key of a point already passed is not the one waited for');
  h.midi.key('on', 67, 3200);
  assert.equal(h.session.getState().lap, 1, 'playing the last point ends the lap');
  h.session.seek(0);
  assert.equal(h.session.getState().completed, 0);
  assert.equal(h.navigation.getTimeMs(), 0);
  h.session.seek(5);
  assert.equal(h.session.getState().completed, 2, 'a place beyond the last point waits at the last point');
  assert.equal(h.navigation.getTimeMs(), 1000);
  h.session.listen();
  h.session.seek(0);
  assert.equal(h.session.getState().completed, 2, 'while the playback plays the slider is the playback\'s');
  console.log('PASS session: seek puts the line at a place, the points before it count as played');
}
{
  // a keyboard lost in the middle of a lap: hold, then a count-in, then on from the same place
  const h = harness();
  h.frames(0, 0);
  h.session.start();
  h.midi.key('on', 60, 10);
  h.frames(16, 300);
  const at = h.navigation.getTimeMs();
  assert.ok(at > 0 && at < 500);
  h.midi.setStatus('lost');
  assert.equal(h.session.getState().phase, 'lost');
  h.frames(316, 2000);
  assert.equal(h.navigation.getTimeMs(), at, 'the line holds while the keyboard is away');
  h.midi.key('on', 64, 2100);
  assert.equal(h.session.getState().completed, 1, 'nothing counts while the keyboard is away');
  h.midi.setStatus('connected');
  assert.equal(h.session.getState().phase, 'counting');
  assert.equal(h.session.getState().countIn, 3);
  h.frames(2016, 2100);
  assert.equal(h.navigation.getTimeMs(), at, 'the line stays during the count-in');
  h.fireTimer(); assert.equal(h.session.getState().countIn, 2);
  h.fireTimer(); assert.equal(h.session.getState().countIn, 1);
  h.fireTimer(); assert.equal(h.session.getState().phase, 'running');
  assert.equal(h.session.getState().completed, 1, 'it goes on from the same point, not from the start');
  // lost again during the count-in cancels it
  h.midi.setStatus('lost'); h.midi.setStatus('connected');
  assert.equal(h.session.getState().countIn, 3);
  h.midi.setStatus('lost');
  assert.equal(h.session.getState().phase, 'lost');
  console.log('PASS session: a lost keyboard holds the line, a count-in 3 2 1 follows its return, a second loss starts over');
}
{
  // started with no keyboard: it waits, and when the keyboard comes the line just runs, with no count-in
  const h = harness({ connected: false });
  h.frames(0, 0);
  h.session.start();
  assert.equal(h.session.getState().phase, 'lost');
  h.midi.setStatus('connected');
  assert.equal(h.session.getState().phase, 'running');
  console.log('PASS session: the first connection needs no count-in');
}
{
  // listen: the playback takes the line, the practice holds its place and goes on when it stops
  const h = harness();
  h.frames(0, 0);
  h.session.start();
  h.midi.key('on', 60, 10);
  h.frames(16, 2000);
  assert.equal(h.navigation.getTimeMs(), 500);
  h.session.listen();
  assert.equal(h.session.getState().phase, 'listening');
  assert.equal(h.playback.plays, 1);
  h.setSound(1200);
  assert.equal(h.navigation.getTimeMs(), 1200, 'the sound player drives the line while it plays');
  h.midi.key('on', 64, 2100);
  assert.equal(h.session.getState().completed, 1, 'keys do not count while listening');
  h.session.stopListening();
  h.setSound(null);
  assert.equal(h.session.getState().phase, 'running');
  assert.equal(h.navigation.getTimeMs(), 500, 'the line is back where the practice held it');
  assert.equal(h.navigation.getState().timeMs, 500);
  h.midi.key('on', 64, 2200);
  assert.equal(h.session.getState().completed, 2, 'the practice goes on from the same point');
  console.log('PASS session: listen hands the line to the playback and gives it back at the same place');
}
{
  const empty = harness({ notes: [] });
  empty.session.start();
  assert.equal(empty.session.getState().phase, 'idle');
  assert.ok(empty.session.getState().problem);
  const noMap = harness();
  noMap.navigation.update({ map: null });
  noMap.session.start();
  assert.equal(noMap.session.getState().phase, 'idle');
  console.log('PASS session: no notes or no map: it does not start');
}

// ---- the zones: notes on top, keys below ----
const { zoneLayout } = load('src/features/practice/zoneLayout.ts');
{
  // the keys zone is a tenth taller than the keyboard drawing (170 -> 187)
  const at = (height) => plain(zoneLayout({ width: 1000, keysHeight: 170, height }));
  const round = (zones) => [zones.keysShown, zones.notesShown, Math.round(zones.keysZone), Math.round(zones.notesZone)];
  assert.deepEqual(round(at(330)), [true, true, 187, 143], 'the keys zone has its own height, the strip the rest');
  assert.deepEqual(round(at(800)), [true, true, 187, 613], 'a high window gives the rest to the strip, not to the keys');
  for (const height of [50, 100, 170, 200, 330, 800, 1200]) {
    const zones = at(height);
    assert.ok(Math.abs(zones.keysZone + zones.notesZone - height) < 1e-6, 'nothing is left empty');
  }
  assert.deepEqual(round(at(200)), [true, false, 200, 0], 'a strip with no room goes, and the keys zone has the height');
  assert.deepEqual(round(at(100)), [false, true, 0, 100], 'keys that cannot be whole are not shown, and their room goes to the strip');
  const nothing = at(50);
  assert.deepEqual([nothing.keysShown, nothing.notesShown], [false, false], 'a zone with no room disappears');
  console.log('PASS zones: keys zone whole below, the strip takes the rest, a zone without room goes');
}

// ---- the strip: the place under an x of the engraving ----
const { stripCursorAt, beatAtStripX } = load('src/features/practice/stripCursor.ts');
{
  const timeMap = [
    { timeBeats: 0, x: 40, y0: 10, y1: 90 },
    { timeBeats: 4, x: 240, y0: 10, y1: 90 },
    { timeBeats: 8, x: 640, y0: 10, y1: 90 },
    { timeBeats: 8, x: 40, y0: 200, y1: 280 },
    { timeBeats: 12, x: 300, y0: 200, y1: 280 },
  ];
  assert.equal(beatAtStripX(timeMap, 10, 140), 2, 'half way along the first bar');
  assert.equal(beatAtStripX(timeMap, 10, 440), 6, 'the second bar is wider: its x runs at another pace');
  assert.equal(beatAtStripX(timeMap, 10, -50), 0, 'before the system it is its first place');
  assert.equal(beatAtStripX(timeMap, 10, 9000), 8, 'after the system it is its last place');
  assert.equal(beatAtStripX(timeMap, 999, 100), null, 'no such system');
  for (const beat of [0, 1, 3.5, 4, 6.25]) assert.ok(Math.abs(beatAtStripX(timeMap, 10, stripCursorAt(timeMap, beat).x) - beat) < 1e-9, 'it is the inverse of the cursor');
  console.log('PASS strip: the place under an x is the inverse of the cursor');
}
