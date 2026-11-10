import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url), ts = require('typescript');
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
function load(file) {
  const module = { exports: {} };
  const js = ts.transpileModule(fs.readFileSync(path.join(root, file), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  vm.runInNewContext(js, { module, exports: module.exports, require(name) {
    const target = name.startsWith('@/') ? 'src/' + name.slice(2) : path.relative(root, path.resolve(root, path.dirname(file), name));
    return load(target + '.ts');
  } });
  return module.exports;
}
const plain = (value) => JSON.parse(JSON.stringify(value));
const { withMark, validMarks, ARTICULATION_GROUPS, ARTICULATION_CATEGORY, ARTICULATION_MARKS } = load('src/core/model/articulation.ts');
const { parseTool, toolId, toolLabel } = load('src/core/model/insertItems.ts');

// every mark is in exactly one group, and the groups follow the backend's three categories
assert.deepEqual(plain(ARTICULATION_GROUPS.flatMap((g) => g.marks)).sort(), [...ARTICULATION_MARKS].sort());
for (const g of ARTICULATION_GROUPS) for (const m of g.marks) assert.equal(ARTICULATION_CATEGORY[m], g.category);

// a new mark replaces the mark of its category and keeps the others
assert.deepEqual(plain(withMark(['staccato', 'accent'], 'length', 'tenuto')), ['tenuto', 'accent']);
assert.deepEqual(plain(withMark(['staccato', 'accent'], 'loudness', 'marcato')), ['staccato', 'marcato']);
assert.deepEqual(plain(withMark(['staccato', 'accent'], 'length', null)), ['accent']);
assert.deepEqual(plain(withMark([], 'arpeggio', 'arpeggio_down')), ['arpeggio_down']);
// the list keeps the backend's enum order
assert.deepEqual(plain(withMark(['arpeggio_up'], 'length', 'fermata')), ['fermata', 'arpeggio_up']);

// sets with two marks of one category are not valid; unknown marks are not valid
assert.equal(validMarks(['staccato', 'accent', 'arpeggio_up']), true);
assert.equal(validMarks(['staccato', 'tenuto']), false);
assert.equal(validMarks(['accent', 'marcato']), false);
assert.equal(validMarks(['trill']), false);
assert.equal(validMarks([]), true);

// tool ids: a plain note keeps its historic id; marks go after the dots, joined by '+'; round trip
const spec = (articulations, extra = {}) => ({ kind: 'note', value: 'q', dots: 1, articulations, accidental: '#', ...extra });
assert.equal(toolId(spec(['staccato'])), 'note:q:1:staccato:#');
assert.equal(toolId(spec(['staccato', 'accent'])), 'note:q:1:staccato+accent:#');
assert.equal(toolId(spec([])), 'note:q:1:none:#');
assert.deepEqual(plain(parseTool('note:q:1:staccato+accent:#')), spec(['staccato', 'accent']));
assert.deepEqual(plain(parseTool('note:q:1:none:#')), spec([]));
assert.deepEqual(plain(parseTool('note:q:1:accent:')), spec(['accent'], { accidental: null }));
assert.equal(parseTool('note:q:1:staccato+tenuto:#'), null);
assert.equal(parseTool('note:q:1:trill:#'), null);
assert.equal(toolId({ kind: 'note', value: 'q', dots: 0, articulations: [], accidental: null }), 'q');
assert.equal(toolLabel('note:q:0:staccato+accent:'), 'Quarter note, staccato, accent');

// a stored id from before the marks were a set (one `articulation`) still reads
const old = 'insert:' + encodeURIComponent(JSON.stringify({ kind: 'note', value: 'q', dots: 0, articulation: 'accent', accidental: null, fingering: 2 }));
assert.deepEqual(plain(parseTool(old)), { kind: 'note', value: 'q', dots: 0, accidental: null, fingering: 2, articulations: ['accent'] });
const oldNone = 'insert:' + encodeURIComponent(JSON.stringify({ kind: 'note', value: 'q', dots: 0, articulation: 'none', accidental: null, fingering: 2 }));
assert.deepEqual(plain(parseTool(oldNone)).articulations, []);
console.log('articulations ok');
