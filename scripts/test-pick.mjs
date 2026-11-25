import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url), ts = require('typescript');
const module = { exports: {} };
const js = ts.transpileModule(fs.readFileSync(new URL('../src/features/editor/pick.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
vm.runInNewContext(js, { module, exports: module.exports });
const { nearest: pickNearest, distanceToBox, distanceToUprightLine } = module.exports;
const nearest = (candidates) => JSON.parse(JSON.stringify(pickNearest(candidates)));

// a rest's ink with a stem 3 units beside it: a pointer on the rest is on the rest, not on the stem's hit column
const rest = { x: 100, y: 50, width: 12, height: 6 };
assert.equal(distanceToBox(rest, { x: 106, y: 53 }), 0);
assert.equal(distanceToUprightLine(115, 10, 80, { x: 106, y: 53 }), 9);
assert.deepEqual(nearest([{ target: 'stem', distance: 3 }, { target: 'rest', distance: 0 }]), ['rest']);
// beside the stem on bare paper (a note's padding is the only other thing there): the stem is nearer
assert.deepEqual(nearest([{ target: 'note', distance: 4.5 }, { target: 'stem', distance: 1.5 }]), ['stem']);
// two inks under the pointer are a real overlap: both stay, in the order given
assert.deepEqual(nearest([{ target: 'a', distance: 0 }, { target: 'b', distance: 0 }, { target: 'padding', distance: 2 }]), ['a', 'b']);
// the same distance to within the tolerance is the same distance
// midway between two noteheads, on neither's ink: no one is picked
assert.deepEqual(nearest([{ target: 'a', distance: 3 }, { target: 'b', distance: 3.2 }]), []);
assert.deepEqual(nearest([{ target: 'a', distance: 3 }, { target: 'b', distance: 5 }]), ['a']);
assert.deepEqual(nearest([]), []);
// the line stops at its ends: past the top the distance grows
assert.equal(distanceToUprightLine(10, 20, 40, { x: 10, y: 15 }), 5);
assert.equal(distanceToUprightLine(10, 20, 40, { x: 13, y: 24 }), 3);
console.log('PASS pick: the nearest drawing is the one picked, a tie stays a tie');
