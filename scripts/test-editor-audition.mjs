import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const ts = require('typescript');
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
let player;
class FakePlayer {
  constructor() { player = this; }
  async unlock() {}
  async pause() {}
  stop() { this.finish?.(); }
  dispose() { this.stop(); }
  async play(audio, signal, onStarted, start, onTime) { this.start = start; this.tick = onTime; onStarted(); await new Promise(resolve => { this.finish = resolve; signal.addEventListener('abort', resolve, { once: true }); }); }
}
function load(file, stubs = {}, cache = new Map()) {
  const full = path.join(root, file);
  if (cache.has(full)) return cache.get(full).exports;
  const module = { exports: {} }; cache.set(full, module);
  const js = ts.transpileModule(fs.readFileSync(full, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const context = { module, exports: module.exports, console, crypto: webcrypto, AbortController, DOMException, ReadableStream, Uint8Array, DataView, TextEncoder, TextDecoder, setTimeout, clearTimeout, ...(stubs.__globals ?? {}),
    require(name) {
      if (name in stubs) return stubs[name];
      if (name.startsWith('@/')) return load('src/' + name.slice(2) + '.ts', stubs, cache);
      if (name.startsWith('.')) return load(path.relative(root, path.resolve(path.dirname(full), name + '.ts')), stubs, cache);
      throw new Error('Unexpected import: ' + name);
    },
  };
  vm.runInNewContext(js, context, { filename: full });
  return module.exports;
}

const clone = value => JSON.parse(JSON.stringify(value));
const base = { musicRevision: 'music-0', id: 'd', measures: [{ voices: [{ items: [
  { id: 'c', kind: 'note', notes: [0, 2, 4].map((staffStep, i) => ({ noteId: 'n' + i, staffId: 'upper', staffStep, accidental: 'n', midiNote: 64 + i * 3 })) },
  { id: 'd', kind: 'note', notes: [{ noteId: 'other', staffId: 'lower', staffStep: 0, accidental: 'n', midiNote: 43 }] },
  { id: 'r', kind: 'rest', notes: [] },
] }] }], contexts: [], beams: [], tuplets: [], ties: [], glissandos: [] };
let state = { document: clone(base), selectedIds: [], carrierSelectedIds: [], selectedMeasureIds: [], selectedStructureIds: [], scoreId: 'd', locked: false, loading: false };
const subscribers = new Set(), edits = new Set(), heard = [];
const editor = { getState: () => state, subscribe(listener) { subscribers.add(listener); return () => subscribers.delete(listener); } };
const subscribeEdits = listener => { edits.add(listener); return () => edits.delete(listener); };
const transport = { cancelPreview() { heard.push('cancel'); }, documentChanged(snapshot) { heard.push(['invalidate', snapshot]); }, unlock() { heard.push('unlock'); }, async previewCarrier(...args) { heard.push(args); } };
const { selectionPreview, editPreview, bindEditorAudition } = load('src/features/editor/EditorAudition.ts', { '@/app/store': { useEditor: editor, subscribeEditorEdits: subscribeEdits }, '@/core/playback/PlaybackController': { playback: transport } });
const pick = (ids, carriers = [], extra = {}) => selectionPreview({ ...state, selectedIds: ids, carrierSelectedIds: carriers, selectedMeasureIds: [], selectedStructureIds: [], ...extra });
assert.deepEqual(clone(pick(['n1'])), { carrierId: 'c', noteIds: ['n1'] });
assert.deepEqual(clone(pick(['n0', 'n1', 'n2'], ['c'])), { carrierId: 'c' });
assert.deepEqual(clone(pick(['other'])), { carrierId: 'd' });
for (const [ids, carriers, extra] of [
  [[], [], {}], [['n0', 'other'], [], {}], [['n0', 'n1'], [], {}], [['r'], ['r'], {}],
  [['n0', 'r'], ['c', 'r'], {}], [['n0'], [], { selectedMeasureIds: ['m'] }],
  [['n0'], [], { selectedStructureIds: ['beam'] }], [['n0'], ['c', 'd'], {}],
]) assert.equal(pick(ids, carriers, extra), null);
console.log('PASS individual-note/carrier granularity; ranges, partial groups, rests and structures stay silent');
const event = (command, ids = ['n1']) => {
  const before = clone(base), after = clone(base);
  for (const item of after.measures[0].voices[0].items) for (const n of item.notes) if (ids.includes(n.noteId)) { n.staffStep++; n.midiNote++; }
  if (ids.length) after.musicRevision = before.musicRevision + '-edit';
  return { phase: 'success', draftId: 'd', command, before, after };
};
for (const command of [{ type: 'changePitch', noteId: 'n1' }, { type: 'setAccidental', noteId: 'n1' }, { type: 'moveNoteToStaff', noteId: 'n1' }, { type: 'shiftStaffSteps', noteIds: ['n0', 'n1'], delta: 1 }]) {
  assert.deepEqual(clone(editPreview(event(command, ['n0', 'n1']))), { carrierId: 'c' });
}
assert.equal(editPreview(event({ type: 'shiftStaffSteps', noteIds: ['n0', 'other'], delta: 1 }, ['n0', 'other'])), null);
assert.deepEqual(clone(editPreview(event({ type: 'changePitch', noteId: 'n0' }, ['n0', 'other']))), { carrierId: 'c' });
assert.equal(editPreview(event({ type: 'changePitch', noteId: 'n0' }, [])), null);
assert.equal(editPreview({ ...event({ type: 'changePitch', noteId: 'n0' }), after: undefined }), null);
assert.deepEqual(clone(editPreview(event({ type: 'setClef' }))), { carrierId: 'c' });
assert.equal(editPreview(event({ type: 'setClef' }, ['n0', 'other'])), null);
const inserted = event({ type: 'insertNote' }); inserted.after.measures[0].voices[0].items[0].notes.push({ noteId: 'new' });
assert.deepEqual(clone(editPreview(inserted)), { carrierId: 'c' });
console.log('PASS successful pitch edits audition the complete source chord, including tie propagation; multi-chord/no-op/rejected edits are silent');
const patch = values => { const previous = state; state = { ...state, ...values }; for (const listener of subscribers) listener(state, previous); };
const publish = e => { for (const listener of edits) listener(e); };
const unbind = bindEditorAudition(editor, transport, subscribeEdits);
patch({ selectedIds: ['n0'] }); assert.equal(JSON.stringify(heard.at(-1)), JSON.stringify(['c', 'd', ['n0']]));
patch({ selectedIds: ['n0'] }); assert.equal(JSON.stringify(heard.at(-1)), JSON.stringify(['c', 'd', ['n0']]));
patch({ selectedIds: ['n0', 'other'] }); assert.equal(heard.at(-1), 'cancel');
patch({ selectedIds: ['n1'] });
const success = event({ type: 'changePitch', noteId: 'n1' });
publish({ ...success, phase: 'start' }); assert.equal(heard.at(-1), 'unlock');
patch({ document: success.after, selectedStructureIds: [] }); assert.equal(heard.at(-1)[0], 'invalidate');
publish(success); assert.equal(JSON.stringify(heard.at(-1)), JSON.stringify(['c', 'd', undefined]));
const waiting = event({ type: 'changePitch', noteId: 'n1' });
publish({ ...waiting, phase: 'start' }); patch({ selectedIds: ['other'] });
const beforeLate = heard.length; publish(waiting); assert.equal(heard.length, beforeLate);
const countInvalidations = heard.filter(call => Array.isArray(call) && call[0] === 'invalidate').length;
patch({ document: clone(state.document) });
assert.equal(heard.filter(call => Array.isArray(call) && call[0] === 'invalidate').length, countInvalidations);
patch({ locked: true }); assert.equal(heard.at(-1), 'cancel');
unbind(); assert.equal(subscribers.size, 0); assert.equal(edits.size, 0);
console.log('PASS shared selection/edit events, repeated individual selection, invalidation-before-preview, stale-edit suppression, lock and cleanup');

const editedChord = event({ type: 'shiftStaffSteps', noteIds: ['n1'], delta: 1 });
const rebound = bindEditorAudition(editor, transport, listener => { edits.add(listener); return () => edits.delete(listener); });
patch({ locked: false, selectedIds: ['n1'] });
publish({ ...editedChord, phase: 'start' });
patch({ document: editedChord.after });
publish(editedChord);
assert.equal(JSON.stringify(heard.at(-1)), JSON.stringify(['c', 'd', undefined]));
rebound();
console.log('PASS document replacement after height edit auditions the complete updated chord');

const visualUnbind = bindEditorAudition(editor, transport, subscribeEdits);
heard.length = 0;
const visualBefore = state.document;
const visualAfter = clone(visualBefore); visualAfter.presentation = { vertical: [{ entity_id: 'c', offset: 1 }] };
const visual = { phase: 'start', draftId: 'd', command: { type: 'editPresentation', changes: [] }, before: visualBefore, after: visualAfter };
publish(visual); patch({ document: visualAfter }); publish({ ...visual, phase: 'success' });
assert.equal(heard.length, 0, 'visual changes must not invalidate, release, unlock or audition');
patch({ document: clone(visualBefore) });
assert.equal(heard.length, 0, 'visual undo must preserve audio');
patch({ auditionSuppressed: true }); patch({ selectedIds: ['n0', 'n1', 'n2'], carrierSelectedIds: ['c'] });
patch({ auditionSuppressed: false });
assert.equal(heard.length, 0, 'drag selection must remain silent');
patch({ selectedIds: ['n0', 'n1', 'n2'] });
assert.equal(heard.length, 1, 'a completed stationary stem click auditions once');
visualUnbind();
console.log('PASS presentation edits and undo preserve audio/cache; visual drag selection stays silent; click auditions once');
