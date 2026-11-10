import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const ts = require('typescript');
const root = new URL('../', import.meta.url);
const renderer = fs.readFileSync(new URL('src/rendering/vexflow/VexflowRenderer.tsx', root), 'utf8');
const overlay = fs.readFileSync(new URL('src/features/editor/Overlay.tsx', root), 'utf8');
// Execute the real map append block and the real cursor query, without mounting React/VexFlow.
const append = renderer.slice(renderer.indexOf('const previous = timeMap.at(-1);'), renderer.indexOf('          measures.push({ id: b.measure.id'));
assert.ok(append.includes('segments.forEach'), 'renderer map append block must be found');
const source = ts.createSourceFile('Overlay.tsx', overlay, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const cursor = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'cursorAt');
assert.ok(cursor);
const js = ts.transpileModule(cursor.getText(source), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const ctx = {}; vm.createContext(ctx); vm.runInContext(js, ctx);
const map = [];
const add = (cumBeat, y, segments) => vm.runInNewContext(append, { timeMap: map, cumBeat, bandY0: y, bandY1: y + 100, segments });
add(0, 0, [{ beat: 0, x: 100 }, { beat: 2, x: 200 }, { beat: 4, x: 300 }]);
add(4, 0, [{ beat: 0, x: 340 }, { beat: 1, x: 380 }, { beat: 4, x: 500 }]);
assert.equal(map.filter(p => p.timeBeats === 4).length, 1);
assert.equal(map.find(p => p.timeBeats === 4).x, 340);
const at = beat => ctx.cursorAt({ timeMap: map }, beat);
assert.equal(at(2).x, 200); assert.equal(at(3).x, 270); assert.equal(at(4).x, 340); assert.equal(at(5).x, 380);
assert.ok(Math.abs(at(4 - 1e-8).x - at(4).x) < 1e-5);
let previous = -Infinity;
for (let beat = 0; beat < 8; beat += 0.001) { const x = at(beat).x; assert.ok(x >= previous); previous = x; }
// Only a system boundary keeps two positions at the same time.
add(8, 200, [{ beat: 0, x: 80 }, { beat: 2, x: 180 }, { beat: 4, x: 300 }]);
assert.equal(map.filter(p => p.timeBeats === 8).length, 2);
assert.ok(at(8 - 1e-8).x > 499.99); assert.equal(at(8).x, 80); assert.equal(at(8).y0, 200);
assert.equal(at(12).x, 300); assert.equal(at(14).x, 300);
assert.equal(ctx.cursorAt({ timeMap: [] }, 0), null);
console.log('PASS anchor accuracy, continuous bar boundaries, monotonic sweep, system wrapping, score end and empty map');
