import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const ts = require('typescript');
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const cache = new Map();
let state;
const create = initialize => {
  const set = patch => { state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) }; };
  const store = { getState: () => state, setState: set };
  state = initialize(set, store.getState);
  return store;
};
class Gateway {}
class QueuedGateway { constructor(gateway) { this.gateway = gateway; } }
const stubs = {
  zustand: { create },
  '@/core/gateway/apiBase': { API_BASE: '/api' },
  '@/core/gateway/HttpGateway': { HttpGateway: Gateway },
  '@/core/gateway/QueuedGateway': { QueuedGateway },
  './measureSync': { DraftSync: class { apply(sync) { return sync.view; } } },
  '@/core/playback/draftSounds': { draftSounds: { apply() {} } },
  '@/core/auth/authorizedFetch': { AuthRequiredError: class extends Error {} },
  '@/core/auth/authPrompt': { useAuthPrompt: { getState: () => ({ open() {} }) } },
};
function load(file) {
  if (cache.has(file)) return cache.get(file).exports;
  const module = { exports: {} }; cache.set(file, module);
  const js = ts.transpileModule(fs.readFileSync(path.join(root, file), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(js, { module, exports: module.exports, console, window: { localStorage: { getItem: () => null, setItem() {} } },
    require(name) {
      if (name in stubs) return stubs[name];
      const resolved = name.startsWith('@/') ? 'src/' + name.slice(2) : name.startsWith('.') ? path.relative(root, path.resolve(path.dirname(path.join(root, file)), name)) : null;
      if (!resolved) throw new Error('Unexpected import: ' + name);
      if (resolved.endsWith('core/gateway/apiBase')) return { API_BASE: '/api' };
      return load(resolved + '.ts');
    },
  }, { filename: file });
  return module.exports;
}
const { contentSelection, measureContentSelection, relationContentSelection, contextContentSelection, staffContainsPoint, splitBeamTarget, orderedVoiceNavigationIds, orderedVoiceCarrierIds } = load('src/core/model/query.ts');
const { useEditor } = load('src/app/store.ts');
const realDispatch = state.dispatch;
const f = (numerator, denominator = 1) => ({ numerator, denominator });
const note = (id, refs, position = 0) => ({ id, kind: 'note', duration: '8', dots: 0, position, positionFraction: f(position, 4), articulations: [], notes: refs.map(([noteId, staffId]) => ({ noteId, staffId, staffStep: 0, accidental: null, fingering: 0 })) });
const rest = (id, staffId, position = 0) => ({ id, kind: 'rest', duration: '8', dots: 0, position, positionFraction: f(position, 4), staffId, articulations: [], notes: [] });
const doc = () => ({ id: 'd', title: '', staffOrder: ['upper', 'lower'], voices: [{ id: 'v', index: 0 }, { id: 'w', index: 1 }, { id: 'l', index: 2 }],
  measures: [
    { id: 'm', timeSignature: { beats: 4, beatValue: 4 }, voices: [
      { id: 'v', items: [note('a', [['a1', 'upper']]), rest('r', 'upper', 0.5), note('b', [['b1', 'upper'], ['b2', 'upper']], 1)] },
      { id: 'w', items: [note('c', [['c1', 'upper']], 2)] },
      { id: 'l', items: [note('d', [['d1', 'lower']])] },
    ] },
    { id: 'next', timeSignature: { beats: 4, beatValue: 4 }, voices: [{ id: 'v', items: [note('outside', [['out', 'upper']])] }] },
  ],
  beams: [{ id: 'beam', carrierIds: ['a', 'r', 'b'] }, { id: 'cross-bar', carrierIds: ['b', 'outside'] }],
  tuplets: [{ id: 'tuplet', carrierIds: ['a', 'r', 'b'] }],
  ties: [{ id: 'tie', startNoteId: 'a1', endNoteId: 'b1' }, { id: 'tie-out', startNoteId: 'b1', endNoteId: 'out' }],
  glissandos: [],
  contexts: [
    { id: 'clef-u', kind: 'clef', staffId: 'upper', measureId: 'm', position: f(0), clef: 'treble' },
    { id: 'clef-l', kind: 'clef', staffId: 'lower', measureId: 'm', position: f(0), clef: 'bass' },
    { id: 'dynamic-u', kind: 'dynamic', voiceIds: ['v'], measureId: 'm', position: f(0), dynamic: 'p' },
    { id: 'dynamic-l', kind: 'dynamic', voiceIds: ['l'], measureId: 'm', position: f(0), dynamic: 'f' },
    { id: 'tempo', kind: 'tempo', measureId: 'm', position: f(0), bpm: 90 },
  ], stemOverrides: {},
});
const plain = value => JSON.parse(JSON.stringify(value));
const equalSet = (actual, expected) => assert.deepEqual([...actual].sort(), [...expected].sort());
let count = 0;
async function test(name, fn) { await fn(); count++; console.log('PASS ' + name); }
await test('upper staff includes every voice, complete chords, rests and contained relations', () => {
  const g = measureContentSelection(doc(), 'm', 'upper');
  equalSet(g.noteIds, ['a1', 'r', 'b1', 'b2', 'c1']);
  equalSet(g.carrierIds, ['a', 'r', 'b', 'c']);
  equalSet(g.structureIds, ['beam', 'tuplet', 'tie', 'clef-u']);
});
await test('lower staff is independent of the active insertion voice/staff', () => {
  const g = measureContentSelection(doc(), 'm', 'lower');
  equalSet(g.noteIds, ['d1']); equalSet(g.structureIds, ['clef-l']);
});
await test('whole measure contains both staffs without selecting a cross-bar relation partly', () => {
  const g = measureContentSelection(doc(), 'm');
  assert.ok(g.noteIds.includes('d1')); assert.ok(!g.noteIds.includes('out'));
  assert.ok(!g.structureIds.includes('cross-bar')); assert.ok(!g.structureIds.includes('tie-out'));
  assert.ok(g.structureIds.includes('clef-l'));
});
await test('beam expands complete carriers including rests, without unrelated marks or notes', () => {
  const g = relationContentSelection(doc(), 'beam');
  equalSet(g.noteIds, ['a1', 'r', 'b1', 'b2']);
  equalSet(g.carrierIds, ['a', 'r', 'b']);
  equalSet(g.structureIds, ['beam', 'tuplet', 'tie']);
});
await test('beam expansion follows members across barlines', () => {
  equalSet(relationContentSelection(doc(), 'cross-bar').noteIds, ['b1', 'b2', 'out']);
});
await test('staff pick keeps the other half of a cross-staff chord unselected', () => {
  const d = doc(); d.measures[0].voices[0].items[2].notes[1].staffId = 'lower';
  const g = measureContentSelection(d, 'm', 'upper');
  assert.ok(g.noteIds.includes('b1')); assert.ok(!g.noteIds.includes('b2'));
  assert.ok(g.carrierIds.includes('b')); assert.ok(!g.structureIds.includes('beam'));
});
await test('partial chord selection cannot implicitly include a beam or tuplet', () => {
  const g = contentSelection(doc(), ['a1', 'r', 'b1']);
  assert.ok(!g.structureIds.includes('beam')); assert.ok(!g.structureIds.includes('tuplet'));
});
await test('missing/empty groups return empty selection and source documents remain unchanged', () => {
  const d = doc(), before = JSON.stringify(d);
  equalSet(measureContentSelection(d, 'missing').noteIds, []);
  equalSet(relationContentSelection(d, 'missing').structureIds, []);
  contentSelection(d, ['a1', 'a1']); assert.equal(JSON.stringify(d), before);
});
const reset = () => useEditor.setState({ document: doc(), selectedIds: [], carrierSelectedIds: [], selectedStructureIds: [], selectedMeasureIds: [], locked: false, loading: false, source: null });
await test('store replaces and Shift-unions notes, carriers and structures together', () => {
  reset(); const g = measureContentSelection(state.document, 'm', 'upper');
  state.selectMany(g.noteIds, false, g.carrierIds, g.structureIds);
  const l = measureContentSelection(state.document, 'm', 'lower');
  state.selectMany(l.noteIds, true, l.carrierIds, l.structureIds);
  assert.ok(state.selectedIds.includes('a1') && state.selectedIds.includes('d1'));
  assert.ok(state.selectedStructureIds.includes('beam') && state.selectedStructureIds.includes('clef-l'));
  state.selectMany(l.noteIds, false, l.carrierIds, l.structureIds);
  equalSet(state.selectedIds, ['d1']); equalSet(state.carrierSelectedIds, ['d']);
});
await test('Shift completing a cross-staff chord recomputes its now-complete beam and tuplet', () => {
  reset(); state.document.measures[0].voices[0].items[2].notes[1].staffId = 'lower';
  for (const staff of ['upper', 'lower']) {
    const g = measureContentSelection(state.document, 'm', staff);
    state.selectMany(g.noteIds, staff === 'lower', g.carrierIds, g.structureIds);
  }
  assert.ok(state.selectedStructureIds.includes('beam')); assert.ok(state.selectedStructureIds.includes('tuplet'));
});
await test('ordinary head selection drops group/carrier tint; clearing removes everything', () => {
  state.select('a1'); equalSet(state.selectedIds, ['a1']); equalSet(state.carrierSelectedIds, []); equalSet(state.selectedStructureIds, []);
  state.select(null); equalSet(state.selectedIds, []);
});
await test('barline measure selection marks complete carriers and relations, also with Shift', () => {
  reset(); state.selectMeasure('m', measureContentSelection(state.document, 'm').noteIds, false);
  assert.ok(state.carrierSelectedIds.includes('a')); assert.ok(state.selectedStructureIds.includes('beam'));
  state.selectMeasure('next', ['out'], true);
  equalSet(state.selectedMeasureIds, ['m', 'next']); assert.ok(state.carrierSelectedIds.includes('outside'));
});
await test('editing lock prevents every group and beam selection path', () => {
  reset(); state.locked = true;
  state.selectMany(['a1'], false, ['a'], ['beam']); state.selectMeasure('m', ['a1'], false); state.selectStructure('beam', false);
  equalSet(state.selectedIds, []); equalSet(state.selectedStructureIds, []); equalSet(state.selectedMeasureIds, []);
});
await test('mixed Delete submits selected carriers and relations while keeping opening contexts protected', async () => {
  reset(); const commands = [];
  useEditor.setState({ dispatch: async command => commands.push(plain(command)) });
  const g = measureContentSelection(state.document, 'm', 'upper'); state.selectMany(g.noteIds, false, g.carrierIds, g.structureIds);
  await state.deleteSelected();
  assert.equal(commands.length, 1); assert.equal(commands[0].type, 'deleteBatch');
  equalSet(commands[0].entityIds, ['beam', 'tuplet', 'tie', 'a', 'r', 'b', 'c']);
  equalSet(state.selectedIds, []); equalSet(state.selectedStructureIds, []);
});
await test('deleting a partial cross-staff chord contributes only the selected note id', async () => {
  reset(); const commands = []; state.document.measures[0].voices[0].items[2].notes[1].staffId = 'lower';
  useEditor.setState({ dispatch: async command => commands.push(plain(command)) });
  const g = measureContentSelection(state.document, 'm', 'upper'); state.selectMany(g.noteIds, false, g.carrierIds, g.structureIds);
  await state.deleteSelected(); assert.ok(commands[0].entityIds.includes('b1')); assert.ok(!commands[0].entityIds.includes('b'));
});
await test('successful beam removal prunes its stale pick while keeping selected notes and other marks', async () => {
  reset(); const g = relationContentSelection(state.document, 'beam'); state.selectMany(g.noteIds, false, g.carrierIds, g.structureIds);
  const next = doc(); next.beams = next.beams.filter(b => b.id !== 'beam');
  useEditor.setState({ gateway: { apply: async () => next } });
  await realDispatch({ type: 'deleteBatch', entityIds: ['beam'] });
  equalSet(state.selectedIds, g.noteIds); equalSet(state.selectedStructureIds, ['tuplet', 'tie']);
});
await test('rejected beam removal keeps the selection and document available for correction', async () => {
  reset(); state.selectStructure('beam', false); const before = state.document;
  useEditor.setState({ gateway: { apply: async () => { throw new Error('Rejected'); } } });
  await realDispatch({ type: 'deleteBatch', entityIds: ['beam'] });
  assert.equal(state.document, before); equalSet(state.selectedStructureIds, ['beam']); assert.ok(state.error.includes('Rejected'));
});
await test('staff gestures include both outer lines but exclude headers and the space between staffs', () => {
  const upper = { x0: 100, x1: 300, bottomLineY: 140, stepPx: 5 };
  const lower = { ...upper, bottomLineY: 240 };
  for (const y of [100, 120, 140]) assert.equal(staffContainsPoint(upper, 200, y), true);
  for (const y of [141, 160, 199]) {
    assert.equal(staffContainsPoint(upper, 200, y), false);
    assert.equal(staffContainsPoint(lower, 200, y), false);
  }
  for (const x of [99, 301]) assert.equal(staffContainsPoint(upper, x, 120), false);
  assert.equal(staffContainsPoint(upper, 200, 99), false);
});
await test('neither staff nor both-staff background picks include voice or score contexts', () => {
  const d = doc();
  d.contexts.push({ id: 'hairpin', kind: 'hairpin', voiceIds: ['v'], measureId: 'm', position: f(0), endMeasureId: 'm', endPosition: f(1, 2) });
  d.contexts.push({ id: 'octave', kind: 'octave', staffId: 'upper', measureId: 'm', position: f(0), endMeasureId: 'm', endPosition: f(1, 2) });
  for (const staff of ['upper', undefined]) {
    const g = measureContentSelection(d, 'm', staff);
    for (const id of ['tempo', 'dynamic-u', 'dynamic-l', 'hairpin']) assert.ok(!g.structureIds.includes(id));
    assert.ok(g.structureIds.includes('octave'));
  }
});
await test('beam split affordance includes notes and rests except the first member', () => {
  assert.equal(splitBeamTarget(doc(), 'a'), null);
  assert.deepEqual(plain(splitBeamTarget(doc(), 'r')), { beamId: 'beam', beforeCarrierId: 'r' });
  assert.deepEqual(plain(splitBeamTarget(doc(), 'b')), { beamId: 'beam', beforeCarrierId: 'b' });
  assert.equal(splitBeamTarget(doc(), 'missing'), null);
});
await test('HTTP gateway sends exactly one flat beam-split request', async () => {
  const requests = [];
  stubs['@/core/model/fromView'] = { fromView: view => view };
  stubs['./apiBase'] = { API_BASE: '/api' };
  stubs['@/core/auth/authorizedFetch'] = { authorizedFetch: async (url, options) => {
    requests.push({ url, ...options, body: JSON.parse(options.body) });
    return { ok: true, json: async () => ({ sync: { view: { id: 'next' } } }) };
  } };
  const { HttpGateway } = load('src/core/gateway/HttpGateway.ts');
  const result = await new HttpGateway().apply('d', { type: 'splitBeam', beamId: 'beam', beforeCarrierId: 'b' });
  assert.equal(result.id, 'next'); assert.equal(requests.length, 1);
  assert.equal(requests[0].url, '/api/drafts/d/edit/beams/split'); assert.equal(requests[0].method, 'POST');
  assert.deepEqual(plain(requests[0].body), { beam_id: 'beam', before_carrier_id: 'b' });
});
await test('HTTP gateway adds and removes a voice of a context through the two universal routes', async () => {
  const requests = [];
  stubs['@/core/model/fromView'] = { fromView: view => view };
  stubs['./apiBase'] = { API_BASE: '/api' };
  stubs['@/core/auth/authorizedFetch'] = { authorizedFetch: async (url, options) => {
    requests.push({ url, ...options, body: JSON.parse(options.body) });
    return { ok: true, json: async () => ({ sync: { view: { id: 'next' } } }) };
  } };
  cache.delete('src/core/gateway/HttpGateway.ts');
  const { HttpGateway } = load('src/core/gateway/HttpGateway.ts');
  await new HttpGateway().apply('d', { type: 'addContextVoice', contextId: 'c', voiceId: 'v' });
  await new HttpGateway().apply('d', { type: 'removeContextVoice', contextId: 'c', voiceId: 'v' });
  assert.deepEqual(requests.map(request => request.url), ['/api/drafts/d/edit/context-voices', '/api/drafts/d/edit/context-voice-removals']);
  assert.deepEqual(requests.map(request => plain(request.body)), [{ context_id: 'c', voice_id: 'v' }, { context_id: 'c', voice_id: 'v' }]);
});
await test('relative staff-step command includes selected notes across chords and ignores rests', async () => {
  reset(); const commands = [];
  useEditor.setState({ loading: false, pitchModeRequest: null, dispatch: async command => commands.push(plain(command)) });
  state.selectMany(['a1', 'b1', 'r', 'd1'], false);
  await state.shiftSelectedNotes(1); await state.shiftSelectedNotes(-1);
  assert.deepEqual(commands, [
    { type: 'shiftStaffSteps', noteIds: ['a1', 'b1', 'd1'], delta: 1 },
    { type: 'shiftStaffSteps', noteIds: ['a1', 'b1', 'd1'], delta: -1 },
  ]);
  equalSet(state.selectedIds, ['a1', 'b1', 'r', 'd1']);
  state.locked = true; await state.shiftSelectedNotes(1);
  state.locked = false; state.loading = true; await state.shiftSelectedNotes(1);
  state.loading = false; state.pitchModeRequest = {}; await state.shiftSelectedNotes(1);
  assert.equal(commands.length, 2);
});
await test('edit events report only successful commands and keep failures silent', async () => {
  reset(); state.pitchModeRequest = null; const events = [];
  const { subscribeEditorEdits } = load('src/app/store.ts');
  const unsubscribe = subscribeEditorEdits(event => events.push(event));
  const next = doc();
  useEditor.setState({ gateway: { apply: async () => next } });
  await realDispatch({ type: 'changePitch', noteId: 'a1', staffStep: 1 });
  assert.deepEqual(events.map(e => e.phase), ['start', 'success']);
  assert.equal(events[1].after, next);
  useEditor.setState({ gateway: { apply: async () => { throw new Error('Rejected'); } } });
  await realDispatch({ type: 'changePitch', noteId: 'a1', staffStep: 2 });
  assert.deepEqual(events.map(e => e.phase), ['start', 'success', 'start']);
  unsubscribe();
});
await test('HTTP gateway sends group staff-step changes as one relative request', async () => {
  const requests = [];
  stubs['@/core/auth/authorizedFetch'] = { authorizedFetch: async (url, options) => {
    requests.push({ url, ...options, body: JSON.parse(options.body) });
    return { ok: true, json: async () => ({ sync: { view: { id: 'next' } } }) };
  } };
  cache.delete('src/core/gateway/HttpGateway.ts');
  const { HttpGateway } = load('src/core/gateway/HttpGateway.ts');
  await new HttpGateway().apply('d', { type: 'shiftStaffSteps', noteIds: ['a1', 'b1'], delta: 1 });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, '/api/drafts/d/edit/pitches/shift');
  assert.deepEqual(plain(requests[0].body), { note_ids: ['a1', 'b1'], delta: 1 });
});
console.log(`PASS ${count} selection scenarios`);

await test('HTTP beam override persists two offsets and null resets automatic placement', async () => {
  const requests = [];
  stubs['@/core/auth/authorizedFetch'].authorizedFetch = async (url, init) => {
    requests.push({ url, method: init.method, body: JSON.parse(init.body) });
    return { ok: true, async json() { return { sync: { view: {} } }; } };
  };
  const { HttpGateway } = load('src/core/gateway/HttpGateway.ts');
  await new HttpGateway().apply('d', { type: 'setBeamOverride', beamId: 'beam', override: { leftFactor: 0.5, rightFactor: 2 } });
  await new HttpGateway().apply('d', { type: 'setBeamOverride', beamId: 'beam', override: null });
  assert.equal(requests[0].url, '/api/drafts/d/edit/presentation');
  assert.equal(requests[0].method, 'PUT');
  assert.deepEqual(plain(requests[0].body), { changes: [{ kind: 'endpoints', target: { entity_id: 'beam', reference: 'body' }, offsets: { left: 0.5, right: 2 } }] });
  assert.deepEqual(plain(requests[1].body), { changes: [{ kind: 'endpoints', target: { entity_id: 'beam', reference: 'body' }, offsets: null }] });
});

await test('a tuplet expands like a beam over the same carriers', () => {
  const g = relationContentSelection(doc(), 'tuplet');
  equalSet(g.noteIds, ['a1', 'r', 'b1', 'b2']);
  equalSet(g.carrierIds, ['a', 'r', 'b']);
  equalSet(g.structureIds, ['beam', 'tuplet', 'tie']);
});
await test('a tie expands to its two notes and only what they make whole', () => {
  const g = relationContentSelection(doc(), 'tie');
  equalSet(g.noteIds, ['a1', 'b1']);
  equalSet(g.carrierIds, ['a', 'b']);
  equalSet(g.structureIds, ['tie']);
});
await test('a context picks what the backend says it is applied to, rests included, and itself', () => {
  const g = contextContentSelection(doc(), 'dynamic-u', { carrierIds: ['a', 'r', 'b', 'c'], noteIds: ['a1', 'b1', 'b2', 'c1'] });
  equalSet(g.noteIds, ['a1', 'b1', 'b2', 'c1', 'r']);
  equalSet(g.carrierIds, ['a', 'r', 'b', 'c']);
  assert.ok(g.structureIds.includes('dynamic-u')); assert.ok(g.structureIds.includes('beam'));
  assert.ok(!g.structureIds.includes('dynamic-l'));
});
await test('a context that covers part of a chord picks only the covered notes', () => {
  const g = contextContentSelection(doc(), 'clef-u', { carrierIds: ['b'], noteIds: ['b1'] });
  equalSet(g.noteIds, ['b1']); equalSet(g.carrierIds, ['b']);
  assert.ok(g.structureIds.includes('clef-u')); assert.ok(!g.structureIds.includes('beam'));
});
await test('a measure picks only itself without content and with its content on request', () => {
  reset(); state.selectMeasure('m', [], false);
  assert.deepEqual(plain(state.selectedMeasureIds), ['m']); assert.deepEqual(plain(state.selectedIds), []); assert.deepEqual(plain(state.selectedStructureIds), []);
  state.selectMeasure('m', measureContentSelection(state.document, 'm').noteIds, false);
  assert.deepEqual(plain(state.selectedMeasureIds), ['m']); assert.ok(state.selectedIds.includes('a1')); assert.ok(state.selectedStructureIds.includes('clef-u'));
});
await test('double-clicking a context selects its coverage from the backend through the store', async () => {
  reset(); const asked = [];
  useEditor.setState({ gateway: { contextCoverage: async (draft, id) => { asked.push([draft, id]); return { carrierIds: ['a', 'd'], noteIds: ['a1', 'd1'] }; } } });
  await state.selectContextContent('tempo', false);
  assert.deepEqual(asked, [['default', 'tempo']]);
  equalSet(state.selectedIds, ['a1', 'd1']); assert.ok(state.selectedStructureIds.includes('tempo'));
});
await test('a failed coverage read leaves the selection as it was and reports the error', async () => {
  reset(); state.select('a1', false);
  useEditor.setState({ gateway: { contextCoverage: async () => { throw new Error('nope'); } } });
  await state.selectContextContent('tempo', false);
  assert.deepEqual(plain(state.selectedIds), ['a1']); assert.ok(state.error);
  useEditor.setState({ error: null });
});
await test('the locked editor does not read a context coverage', async () => {
  reset(); useEditor.setState({ locked: true, gateway: { contextCoverage: async () => { throw new Error('must not be called'); } } });
  await state.selectContextContent('tempo', false);
  assert.deepEqual(plain(state.selectedIds), []); useEditor.setState({ locked: false });
});
await test('the HTTP gateway reads a context coverage from the draft route', async () => {
  const requests = [];
  stubs['@/core/auth/authorizedFetch'].authorizedFetch = async url => {
    requests.push(url);
    return { ok: true, async json() { return { carrier_ids: ['c1'], note_ids: ['n1', 'n2'] }; } };
  };
  const { HttpGateway } = load('src/core/gateway/HttpGateway.ts');
  const coverage = await new HttpGateway().contextCoverage('d', 'ctx');
  assert.deepEqual(requests, ['/api/drafts/d/contexts/ctx/coverage']);
  assert.deepEqual(plain(coverage), { carrierIds: ['c1'], noteIds: ['n1', 'n2'] });
});

await test('a glissando is selected with its two notes and expands to them', () => {
  const d = { ...doc(), glissandos: [{ id: 'gliss', startNoteId: 'a1', endNoteId: 'b1', glissandoType: 'wavy' }] };
  assert.ok(contentSelection(d, ['a1', 'b1']).structureIds.includes('gliss'));
  assert.ok(!contentSelection(d, ['a1']).structureIds.includes('gliss'));
  equalSet(relationContentSelection(d, 'gliss').noteIds, ['a1', 'b1']);
});
await test('the HTTP gateway creates a glissando with its type', async () => {
  const requests = [];
  stubs['@/core/auth/authorizedFetch'].authorizedFetch = async (url, init) => {
    requests.push({ url, method: init.method, body: JSON.parse(init.body) });
    return { ok: true, async json() { return { sync: { view: {} } }; } };
  };
  const { HttpGateway } = load('src/core/gateway/HttpGateway.ts');
  await new HttpGateway().apply('d', { type: 'glissandoNotes', startNoteId: 'a1', endNoteId: 'b1', glissandoType: 'wavy' });
  assert.equal(requests[0].url, '/api/drafts/d/edit/glissandos');
  assert.equal(requests[0].method, 'POST');
  assert.deepEqual(plain(requests[0].body), { start_note_id: 'a1', end_note_id: 'b1', glissando_type: 'wavy' });
});


await test('navigation includes before/after grace carriers without changing metric order', () => {
  const d = doc();
  const host = d.measures[0].voices[0].items[0];
  host.graceBefore = { kind: 'acciaccatura', carriers: [note('g1', [['g1n', 'lower']]), note('g2', [['g2n', 'upper']])] };
  host.graceAfter = { kind: 'appoggiatura', carriers: [note('g3', [['g3n', 'upper']])] };
  assert.deepEqual(plain(orderedVoiceNavigationIds(d, 'v')), ['g1', 'g2', 'a', 'g3', 'r', 'b', 'outside']);
  assert.deepEqual(plain(orderedVoiceCarrierIds(d, 'v')), ['a', 'r', 'b', 'outside']);
  assert.deepEqual(plain(orderedVoiceNavigationIds(d, 'missing')), []);
});

// Exercise the actual keyboard handler too; all API calls stay inside this isolated stand.
if (process.env.PLAYWRIGHT_MODULE_PATH) {
  const playwright = require(process.env.PLAYWRIGHT_MODULE_PATH);
  const engine = process.env.ENGINE || 'webkit';
  const width = Number(process.env.TEST_WIDTH || 1440);
  const browser = await playwright[engine].launch({ headless: true, ...(engine === 'chromium' && process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });
  try {
    const page = await browser.newPage({ viewport: { width, height: 1000 }, reducedMotion: process.env.REDUCED ? 'reduce' : 'no-preference' });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.route('**/api/**', route => route.fulfill({ status: 401, contentType: 'application/json', body: '{"detail":"Isolated keyboard fixture"}' }));
    await page.goto(`${process.env.VITE_URL || 'http://localhost:5173'}/demo-editor.html?view=demo-graces&playing=0&theme=${process.env.TEST_THEME || 'light'}`);
    await page.waitForLoadState('networkidle');
    const voices = await page.evaluate(() => {
      const store = window.__editor;
      store.setState({ auditionSuppressed: true, locked: false, manualLocked: false, playbackLocked: false, tool: 'select' });
      const doc = store.getState().document;
      return doc.voices.map(voice => {
        const entries = [];
        for (const measure of doc.measures) {
          const row = measure.voices.find(row => row.id === voice.id);
          for (const host of row?.items ?? []) {
            for (const grace of host.graceBefore?.carriers ?? []) entries.push({ id: grace.id, notes: grace.notes.map(note => note.noteId), grace: true });
            entries.push({ id: host.id, notes: host.notes.length ? host.notes.map(note => note.noteId) : [host.id], grace: false });
            for (const grace of host.graceAfter?.carriers ?? []) entries.push({ id: grace.id, notes: grace.notes.map(note => note.noteId), grace: true });
          }
        }
        return entries;
      });
    });
    let cases = 0;
    const pick = async entry => page.evaluate(entry => {
      const s = window.__editor.getState(); s.selectMany(entry.notes, false, [entry.id]); document.activeElement?.blur();
    }, entry);
    const selected = () => page.evaluate(() => window.__editor.getState().carrierSelectedIds);
    for (const entries of voices) {
      for (let index = 0; index < entries.length; index++) {
        const entry = entries[index];
        for (const [key, delta] of [['ArrowRight', 1], ['ArrowLeft', -1]]) {
          await pick(entry); await page.keyboard.press(key);
          assert.deepEqual(await selected(), [entries[index + delta]?.id ?? entry.id], `${key} follows reading order from ${entry.id}`);
          cases++;
        }
        if (index + 1 < entries.length) {
          await pick(entry); await page.keyboard.press('Shift+ArrowRight');
          assert.deepEqual(await selected(), [entry.id, entries[index + 1].id], 'Shift includes the adjacent grace/host/rest');
          await page.keyboard.press('Shift+ArrowLeft');
          assert.deepEqual(await selected(), [entry.id], 'opposite Shift shrinks to its anchor');
          cases += 2;
        }
      }
    }
    const firstGrace = voices.flat().find(entry => entry.grace);
    assert.ok(firstGrace); await pick(firstGrace);
    await page.screenshot({ path: `/private/tmp/grace-navigation-${engine}-${width}.png` });
    await page.evaluate(async () => {
      const { playback } = await import('/src/core/playback/PlaybackController.ts');
      playback.unlock = () => {}; playback.previewCarrier = async () => {};
      const doc = structuredClone(window.__editor.getState().document);
      const template = doc.measures.flatMap(m => m.voices.flatMap(v => v.items)).find(item => item.kind === 'note');
      doc.voices = [{ id: 'pick-voice-0', index: 0 }, { id: 'pick-voice-1', index: 1 }];
      doc.contexts = []; doc.ties = []; doc.beams = []; doc.tuplets = []; doc.glissandos = [];
      doc.measures = [{ id: 'pick-measure', timeSignature: { beats: 4, beatValue: 4 }, voices: doc.voices.map((voice, vi) => ({ id: voice.id,
        items: Array.from({ length: 4 }, (_, i) => ({ ...template, id: `pick-${vi}-${i}`, kind: 'note', position: i,
          positionFraction: { numerator: i, denominator: 4 }, duration: 'q', dots: 0, writtenSize: undefined, occupiedSize: undefined,
          graceBefore: null, graceAfter: null, articulations: [], ornament: 'none',
          notes: [{ ...template.notes[0], noteId: `pick-head-${vi}-${i}`, staffId: doc.staffOrder[0], staffStep: vi * 2, accidental: null, fingering: 0 }],
        })),
      })) }];
      window.pickFixture = doc;
      window.__editor.setState({ document: doc, tool: 'select', selectedIds: [], carrierSelectedIds: [], selectedStructureIds: [], selectedMeasureIds: [], stemOverrides: {} });
    });
    const menu = page.getByRole('menu', { name: 'Select overlapping element', exact: true });
    const clearPick = async () => {
      await page.mouse.move(0, 0); await page.keyboard.press('Escape');
      await page.evaluate(() => window.__editor.setState({ selectedIds: [], carrierSelectedIds: [], selectedStructureIds: [], selectedMeasureIds: [] }));
    };
    const headPoint = id => page.locator(`[data-individual-note-id="${id}"]`).evaluate(element => {
      const box = element.getBoundingClientRect();
      return { x: box.x + box.width * (element.dataset.individualNoteId === 'pick-head-0-0' ? .25 : .75), y: box.y + box.height / 2 };
    });
    const chosen = () => page.evaluate(() => window.__editor.getState().selectedIds);
    let directCases = 0;
    for (const zoom of [.8, 1, 1.5]) {
      await clearPick();
      await page.evaluate(zoom => window.__editor.getState().setZoom(zoom), zoom);
      // The page carries its zoom continuously; sample after that motion has settled.
      await page.waitForTimeout(550);
      for (const id of ['pick-head-0-0', 'pick-head-1-0']) {
        await clearPick();
        const point = await headPoint(id);
        const rawTargets = await page.evaluate(point => [...new Set(document.elementsFromPoint(point.x, point.y)
          .filter(element => element.dataset.pickKind === 'note').map(element => element.dataset.pickId))], point);
        assert.equal(rawTargets.length, 2, 'fixture hits two padded note regions at a visible head');
        await page.mouse.move(point.x, point.y);
        await page.waitForFunction(id => document.querySelector(`[data-individual-note-id="${id}"]`)?.classList.contains('hovered'), id);
        const other = id === 'pick-head-0-0' ? 'pick-head-1-0' : 'pick-head-0-0';
        assert.equal(await page.locator(`[data-individual-note-id="${other}"]`).evaluate(element => element.classList.contains('hovered')), false);
        await page.mouse.click(point.x, point.y);
        assert.deepEqual(await chosen(), [id], `clear head click at zoom ${zoom} chooses the visible note`);
        assert.equal(await menu.count(), 0, 'padding overlap does not open the chooser');
        directCases++;
      }
    }
    let gapCases = 0;
    for (const zoom of [.8, 1, 1.5]) {
      await clearPick(); await page.evaluate(zoom => window.__editor.getState().setZoom(zoom), zoom); await page.waitForTimeout(550);
      const gap = await page.evaluate(() => {
        const first = document.querySelector('[data-individual-note-id="pick-head-0-0"]').getBoundingClientRect();
        const second = document.querySelector('[data-individual-note-id="pick-head-1-0"]').getBoundingClientRect();
        const left = first.left < second.left ? first : second, right = left === first ? second : first;
        const x = (left.right + right.left) / 2, y = (first.top + first.height / 2 + second.top + second.height / 2) / 2;
        const contains = r => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
        return { x, y, outsideHeads: !contains(first) && !contains(second),
          paddedNotes: [...new Set(document.elementsFromPoint(x, y).filter(el => el.dataset.pickKind === 'note').map(el => el.dataset.pickId))].length };
      });
      assert.equal(gap.outsideHeads, true, 'the cursor tip is between visible heads');
      assert.equal(gap.paddedNotes, 2, 'only expanded rectangles reach the cursor tip');
      await page.mouse.move(gap.x, gap.y);
      await page.waitForFunction(() => document.querySelectorAll('[data-individual-note-id].hovered').length === 0);
      assert.deepEqual(await page.locator('[data-individual-note-id].hovered').evaluateAll(elements => elements.map(el => el.dataset.individualNoteId)), [], 'empty tip does not hover a padded neighbor');
      await page.mouse.click(gap.x, gap.y);
      assert.equal(await menu.count(), 0, 'the cursor body near notes cannot open the overlap chooser');
      assert.equal((await chosen()).length, 8, 'empty tip follows the existing background staff selection instead of an arbitrary padded note');
      gapCases++;
    }
    await clearPick(); await page.evaluate(() => window.__editor.getState().setZoom(1)); await page.waitForTimeout(550);
    const first = await headPoint('pick-head-0-0'), second = await headPoint('pick-head-1-0');
    await page.mouse.move(first.x, first.y); await page.mouse.click(first.x, first.y);
    await page.keyboard.down('Shift'); await page.mouse.move(second.x, second.y); await page.mouse.click(second.x, second.y); await page.keyboard.up('Shift');
    assert.deepEqual((await chosen()).sort(), ['pick-head-0-0', 'pick-head-1-0']);
    assert.equal(await menu.count(), 0);
    await clearPick(); await page.waitForTimeout(450);
    await page.mouse.move(first.x, first.y); await page.mouse.dblclick(first.x, first.y, { delay: 50 });
    assert.deepEqual(await chosen(), ['pick-head-0-0']);
    assert.deepEqual(await page.evaluate(() => window.__editor.getState().carrierSelectedIds), ['pick-0-0'], 'double-click keeps carrier intent');
    await clearPick(); await page.waitForTimeout(450);
    await page.keyboard.down('Alt'); await page.mouse.move(first.x, first.y); await page.mouse.click(first.x, first.y); await page.keyboard.up('Alt');
    assert.equal((await chosen()).length, 8, 'Alt-click still selects the staff across voices');
    await clearPick(); await page.waitForTimeout(450);
    await page.keyboard.down('Alt'); await page.mouse.move(first.x, first.y); await page.mouse.dblclick(first.x, first.y, { delay: 50 }); await page.keyboard.up('Alt');
    assert.deepEqual((await chosen()).sort(), ['pick-head-0-0', 'pick-head-0-1', 'pick-head-0-2', 'pick-head-0-3'], 'Alt-double-click uses the resolved head voice');
    // A selected neighbor reached only through padding must not steal this clearly hit head.
    await clearPick(); await page.evaluate(() => window.__editor.setState({ selectedIds: ['pick-head-1-0'] }));
    await page.mouse.move(first.x, first.y); await page.mouse.click(first.x, first.y);
    assert.deepEqual(await chosen(), ['pick-head-0-0']); assert.equal(await menu.count(), 0);
    await page.screenshot({ path: `/private/tmp/clear-head-selection-${engine}-${width}-${process.env.TEST_THEME || 'light'}.png` });
    // Two voices at the same pitch share the actual head geometry: this remains ambiguous.
    await clearPick();
    await page.evaluate(() => {
      const document = structuredClone(window.pickFixture);
      for (const voice of document.measures[0].voices) for (const item of voice.items) item.notes[0].staffStep = 0;
      window.__editor.setState({ document });
    });
    const overlapPoint = await page.locator('[data-individual-note-id="pick-head-0-0"]').evaluate(element => { const r = element.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
    await page.mouse.move(overlapPoint.x, overlapPoint.y); await page.mouse.click(overlapPoint.x, overlapPoint.y);
    await menu.waitFor(); assert.equal(await menu.getByRole('menuitem').count(), 2);
    await page.screenshot({ path: `/private/tmp/true-head-overlap-${engine}-${width}-${process.env.TEST_THEME || 'light'}.png` });
    const items = await menu.getByRole('menuitem').allTextContents();
    await menu.getByRole('menuitem').first().focus(); await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter');
    assert.equal(await menu.count(), 0);
    assert.deepEqual(await chosen(), [items[1].includes('Voice 1') ? 'pick-head-0-0' : 'pick-head-1-0']);
    await clearPick(); await page.mouse.move(overlapPoint.x, overlapPoint.y); await page.mouse.click(overlapPoint.x, overlapPoint.y);
    await menu.waitFor(); await page.keyboard.press('Escape'); assert.equal(await menu.count(), 0); assert.deepEqual(await chosen(), []);
    await page.evaluate(() => window.__editor.setState({ selectedIds: ['pick-head-0-0'] }));
    await page.mouse.click(overlapPoint.x, overlapPoint.y); assert.equal(await menu.count(), 0); assert.deepEqual(await chosen(), ['pick-head-0-0'], 'selected target still wins a genuine overlap');
    // Place the two padded rectangles over a real selected beam handle to isolate its underlay
    // priority. The rendered heads and beam are untouched; the pointer lies outside their ink.
    await clearPick();
    await page.evaluate(() => {
      const document = structuredClone(window.pickFixture);
      const voice = document.measures[0].voices[0];
      for (const [i, item] of voice.items.entries()) {
        item.duration = '8'; item.position = i / 2; item.positionFraction = { numerator: i, denominator: 8 };
      }
      document.beams = [{ id: 'pick-beam', carrierIds: voice.items.map(item => item.id), override: null }];
      window.pickCommands = [];
      window.__editor.setState({ document, selectedIds: [], carrierSelectedIds: [], selectedStructureIds: ['pick-beam'],
        dispatch: async command => { window.pickCommands.push(command); } });
    });
    const handle = page.getByRole('button', { name: 'Move beam center', exact: true });
    await handle.waitFor();
    const beamPoint = await handle.evaluate(element => {
      const circle = element.querySelector('circle'), cx = Number(circle.getAttribute('cx')), cy = Number(circle.getAttribute('cy')), r = Number(circle.getAttribute('r'));
      for (const id of ['pick-head-0-0', 'pick-head-1-0']) {
        const hit = document.querySelector(`.overlay [data-pick-kind="note"][data-pick-id="${id}"]`);
        for (const [name, value] of Object.entries({ x: cx - r / 2, y: cy - r, width: r, height: r / 2 })) hit.setAttribute(name, String(value));
      }
      const rect = circle.getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height * .1 };
    });
    const beamTargets = await page.evaluate(point => document.elementsFromPoint(point.x, point.y).map(el => el.closest('[data-pick-kind]')).filter(Boolean).map(el => el.dataset.pickKind), beamPoint);
    assert.equal(beamTargets.filter(kind => kind === 'note').length, 2, 'two padded notes cover the selected beam handle');
    assert.ok(beamTargets.includes('beamHandle'));
    assert.deepEqual([...new Set(beamTargets.filter(kind => kind !== 'note'))], ['beamHandle'], 'filtering the padding leaves only the selected handle');
    assert.equal(await page.evaluate(point => ['pick-head-0-0', 'pick-head-1-0'].some(id => {
      const rect = document.querySelector(`[data-individual-note-id="${id}"]`).getBoundingClientRect();
      return point.x >= rect.left && point.x <= rect.right && point.y >= rect.top && point.y <= rect.bottom;
    }), beamPoint), false, 'the tip is outside both real noteheads');
    await page.mouse.move(beamPoint.x, beamPoint.y); await page.mouse.down();
    await page.mouse.move(beamPoint.x, beamPoint.y - 12, { steps: 4 }); await page.mouse.up();
    await page.waitForFunction(() => window.pickCommands.some(command => command.type === 'setBeamOverride'));
    assert.equal(await menu.count(), 0);
    const beamChanges = await page.evaluate(() => window.pickCommands.filter(command => command.type === 'setBeamOverride'));
    assert.equal(beamChanges.length, 1); assert.equal(beamChanges[0].beamId, 'pick-beam');
    await clearPick(); await page.waitForTimeout(450);
    const shapePoint = await page.locator('.overlay [data-pick-kind="beam"][data-pick-id="pick-beam"]').first().evaluate(element => {
      const box = element.getBBox(), x = box.x + box.width * .18, y = box.y + box.height / 2;
      const pad = box.height;
      for (const id of ['pick-head-0-0', 'pick-head-1-0']) {
        const hit = document.querySelector(`.overlay [data-pick-kind="note"][data-pick-id="${id}"]`);
        for (const [name, value] of Object.entries({ x: x - pad, y: y - pad, width: pad * 2, height: pad * 2 })) hit.setAttribute(name, String(value));
      }
      const svg = element.closest('svg'), rect = svg.getBoundingClientRect();
      return { x: rect.x + x * rect.width / Number(svg.getAttribute('width')), y: rect.y + y * rect.height / Number(svg.getAttribute('height')) };
    });
    const shapeTargets = await page.evaluate(point => document.elementsFromPoint(point.x, point.y).map(el => el.closest('[data-pick-kind]')).filter(Boolean).map(el => el.dataset.pickKind), shapePoint);
    assert.equal(shapeTargets.filter(kind => kind === 'note').length, 2);
    assert.deepEqual([...new Set(shapeTargets.filter(kind => kind !== 'note'))], ['beam']);
    await page.mouse.move(shapePoint.x, shapePoint.y); await page.mouse.click(shapePoint.x, shapePoint.y);
    assert.deepEqual(await page.evaluate(() => window.__editor.getState().selectedStructureIds), ['pick-beam']);
    assert.equal(await menu.count(), 0, 'single beam under padding selects directly');
    await page.mouse.click(shapePoint.x, shapePoint.y);
    assert.deepEqual((await chosen()).sort(), ['pick-head-0-0', 'pick-head-0-1', 'pick-head-0-2', 'pick-head-0-3'], 'covered beam retains double-click group selection');

    console.log(`PASS ${engine}: ${directCases} direct head clicks and ${gapCases} empty-tip cases at three zooms; hover, Shift, double-click, Alt, true-overlap picker/keyboard/Escape and selected-target priority`);
    assert.deepEqual(errors, []);
    console.log(`PASS ${engine}: ${cases} real arrow/Shift transitions, grace groups, chords, rests, voices and measure edges`);
  } finally { await browser.close(); }
}
