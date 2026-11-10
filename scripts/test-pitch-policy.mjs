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
const { contentSelection, measureContentSelection, relationContentSelection, contextContentSelection, staffContainsPoint, splitBeamTarget } = load('src/core/model/query.ts');
const { useEditor } = load('src/app/store.ts');

const sent = [];
const move = { type: 'moveNoteToStaff', noteId: 'n', staffId: 's', mode: 'preserve_pitch' };
const prepare = policy => {
  sent.length = 0;
  useEditor.setState({ pitchPolicy: policy, pitchModeRequest: null, locked: false, loading: false,
    gateway: { apply: async (_id, command) => { sent.push(JSON.parse(JSON.stringify(command))); return useEditor.getState().document; } } });
};

// remembered by place: no question, the command carries that mode
prepare('preserve_step');
await useEditor.getState().dispatch(move);
assert.equal(useEditor.getState().pitchModeRequest, null);
assert.deepEqual(sent.map(command => command.mode), ['preserve_step']);

// remembered by sound
prepare('preserve_pitch');
await useEditor.getState().dispatch({ ...move, mode: 'preserve_step' });
assert.deepEqual(sent.map(command => command.mode), ['preserve_pitch']);

// not remembered: the question is asked, and the answer goes with the command
prepare('ask');
const pending = useEditor.getState().dispatch(move);
assert.ok(useEditor.getState().pitchModeRequest, 'the dialog is requested');
useEditor.getState().resolvePitchMode('preserve_step');
await pending;
assert.deepEqual(sent.map(command => command.mode), ['preserve_step']);

// cancelling the question sends nothing
prepare('ask');
const cancelled = useEditor.getState().dispatch(move);
useEditor.getState().resolvePitchMode(null);
await cancelled;
assert.deepEqual(sent, []);

// choosing it in the panel changes what later edits do
useEditor.getState().setPitchPolicy('preserve_step');
assert.equal(useEditor.getState().pitchPolicy, 'preserve_step');
console.log('pitch policy checks passed');
