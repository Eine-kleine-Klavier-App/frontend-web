import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const ts = require('typescript');
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const cache = new Map();
function load(file) {
  if (cache.has(file)) return cache.get(file).exports;
  const module = { exports: {} }; cache.set(file, module);
  const js = ts.transpileModule(fs.readFileSync(path.join(root, file), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(js, { module, exports: module.exports, console, require(name) {
    const resolved = name.startsWith('@/') ? 'src/' + name.slice(2) : name.startsWith('.') ? path.relative(root, path.resolve(path.dirname(path.join(root, file)), name)) : null;
    if (!resolved) throw new Error('Unexpected import: ' + name);
    return load(resolved + '.ts');
  } }, { filename: file });
  return module.exports;
}
const plain = value => JSON.parse(JSON.stringify(value));
const { passesLabel, voltaParts, derivedEnding, repeatBarlines, refrainLabel } = load('src/core/model/repeats.ts');
const { spanCommand, endBoundary } = load('src/core/model/markTools.ts');

const f = (n, d) => ({ numerator: n, denominator: d });
const measure = id => ({ id, timeSignature: { beats: 4, beatValue: 4 } });
const ids = ['m1', 'm2', 'm3', 'm4', 'm5', 'm6'];
const doc = contexts => ({ measures: ids.map(measure), contexts });
const refrain = (id, from, to, times = 2) => ({ id, kind: 'refrain', measureId: from, position: f(0, 1), endMeasureId: to, endPosition: to === null ? null : f(0, 1), times });
const volta = (id, from, bodyEnd, endings, passCount) => ({
  id, kind: 'volta', measureId: from, position: f(0, 1), bodyEndMeasureId: bodyEnd, bodyEndPosition: f(0, 1), passCount,
  fragments: endings.map(([end, passes]) => ({ endMeasureId: end, endPosition: end === null ? null : f(0, 1), passes })),
});
const env = { voiceId: 'v', mode: 'preserve_pitch', bpmAtStart: null, measureAfter: id => ids[ids.indexOf(id) + 1] ?? null, measureIndex: id => ids.indexOf(id) };
const point = (measureId, beats = 0, late = false) => ({ measureId, beats, staffId: 's', late });

// passes are written as runs
assert.equal(passesLabel([1]), '1.');
assert.equal(passesLabel([1, 2, 3]), '1.–3.');
assert.equal(passesLabel([1, 3, 4]), '1., 3.–4.');
assert.equal(passesLabel([4, 2, 2]), '2., 4.');
console.log('PASS passes are written as runs');

assert.equal(refrainLabel(2), '');
assert.equal(refrainLabel(3), 'Play 3 times');
console.log('PASS only a refrain played more than twice carries words');

// a volta: body m2-m3, ending 1 = m4, derived last ending = m5
const v = volta('v1', 'm2', 'm4', [['m5', [1, 2]]], 4);
const parts = plain(voltaParts(v));
assert.equal(parts.length, 2);
assert.deepEqual(parts[0].passes, null);
assert.deepEqual(parts[1].passes, [1, 2]);
assert.equal(parts[1].start.measureId, 'm4');
const derived = plain(derivedEnding(doc([v]), v));
assert.equal(derived.start.measureId, 'm5');
assert.equal(derived.end.measureId, 'm6');
assert.deepEqual(derived.passes, [4]);
assert.equal(derivedEnding(doc([volta('v2', 'm1', 'm2', [['m6', [1]]], 2)]), volta('v2', 'm1', 'm2', [['m6', [1]]], 2)).end, null);
console.log('PASS a volta has its body, its stored endings and a worked-out last ending');

// barlines carry the signs
const marks = repeatBarlines(doc([refrain('r1', 'm1', 'm3'), v]));
assert.deepEqual([...marks.beginMeasureIds].sort(), ['m1', 'm2']);
assert.deepEqual([...marks.endMeasureIds].sort(), ['m2', 'm4']);
const toEnd = repeatBarlines(doc([refrain('r2', 'm2', null)]));
assert.deepEqual([...toEnd.endMeasureIds], ['m6']);
console.log('PASS repeat signs stand on the bars the contexts start and end at');

// the last click of a repeat: the left of a bar is its start barline, anywhere else is the end of that bar
assert.equal(endBoundary(point('m3', 0), env), 'm3');
assert.equal(endBoundary(point('m3', 2), env), 'm4');
assert.equal(endBoundary(point('m3', 0, true), env), 'm4');
assert.equal(endBoundary(point('m6', 1), env), null);
console.log('PASS the end click of a repeat picks the barline by where it lands in the bar');

// a repeat from the click in m2 to the click at the right of m3
let command = plain(spanCommand({ kind: 'refrain' }, point('m2'), point('m3', 0, true), env));
assert.equal(command.type, 'createRefrain');
assert.equal(command.start.measureId, 'm2');
assert.equal(command.end.measureId, 'm4');
command = plain(spanCommand({ kind: 'refrain' }, point('m2'), point('m4', 0), env));
assert.equal(command.end.measureId, 'm4');
command = plain(spanCommand({ kind: 'refrain' }, point('m2'), point('m6', 3), env));
assert.equal(command.end, null);
console.log('PASS a repeat is made of whole bars and can last to the end of the score');

// a volta needs its third click, and the ending ends after the body
assert.equal(spanCommand({ kind: 'volta' }, point('m1'), point('m2', 1), env, null), null);
command = plain(spanCommand({ kind: 'volta' }, point('m1'), point('m2', 1), env, point('m3', 1)));
assert.equal(command.type, 'createVolta');
assert.equal(command.bodyEnd.measureId, 'm3');
assert.equal(command.fragments[0].end.measureId, 'm4');
assert.deepEqual(command.fragments[0].passes, [1]);
assert.equal(spanCommand({ kind: 'volta' }, point('m1'), point('m3', 1), env, point('m2', 1)), null);
console.log('PASS a volta takes three clicks and its ending ends after its body');
