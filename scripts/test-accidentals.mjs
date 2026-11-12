import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const ts = require('typescript');
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
function load(file, imports = {}) {
  const module = { exports: {} };
  const source = ts.transpileModule(fs.readFileSync(path.join(root, file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(source, {
    module, exports: module.exports, Response, JSON,
    require(name) { assert.ok(name in imports, 'Unexpected import: ' + name); return imports[name]; },
  });
  return module.exports;
}
const articulation = load('src/core/model/articulation.ts');
const { backendAccidental, parseTool } = load('src/core/model/insertItems.ts', { './articulation': articulation });
assert.equal(backendAccidental(null), null);
assert.equal(backendAccidental(parseTool('q').accidental), null);
assert.equal(backendAccidental(parseTool('triplet').accidental), null);
assert.equal(backendAccidental('n'), 'natural');
assert.equal(backendAccidental('#'), 'sharp');
assert.equal(backendAccidental('b'), 'flat');
const requests = [];
const { HttpGateway } = load('src/core/gateway/HttpGateway.ts', {
  '@/core/model/fromView': { fromView: (view, id) => ({ view, id }) },
  './apiBase': { API_BASE: '/api' },
  './measureSync': { DraftSync: class { apply() { return {}; } } },
  '@/core/playback/draftSounds': { draftSounds: { apply() {} } },
  '@/core/auth/authorizedFetch': { async authorizedFetch(url, options) {
    requests.push({ url, body: JSON.parse(options.body) });
    return new Response(JSON.stringify({ sync: {} }));
  } },
});
const gateway = new HttpGateway();
const placement = { measureId: 'm', staffId: 's', voiceId: 'v', position: { numerator: 1, denominator: 12 }, writtenValue: { value: 8, dots: 0 } };
for (const supplied of [{}, { accidental: null }, { accidental: 'natural' }, { accidental: 'flat' }, { accidental: 'sharp' }]) {
  await gateway.apply('d', { type: 'insertNote', ...placement, staffStep: 0, ...supplied });
  assert.equal(requests.at(-1).body.accidental, supplied.accidental ?? null);
  await gateway.apply('d', { type: 'createTuplet', ...placement, writtenSize: { value: { value: 8, dots: 0 }, count: 3 }, occupiedSize: { value: { value: 8, dots: 0 }, count: 2 }, note: { staffStep: 0, ...supplied } });
  assert.equal(requests.at(-1).body.note.accidental, supplied.accidental ?? null);
}
await gateway.apply('d', { type: 'setAccidental', noteId: 'n', accidental: 'natural' });
assert.equal(requests.at(-1).body.accidental, 'natural');
console.log('PASS plain/tuplet tools and HTTP preserve inference null versus explicit natural/flat/sharp');
