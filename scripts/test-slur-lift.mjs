import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url), ts = require('typescript');
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const js = ts.transpileModule(fs.readFileSync(path.join(root, 'src/rendering/vexflow/collisionLayout.ts'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const module = { exports: {} };
vm.runInNewContext(js, { module, exports: module.exports, SVGGraphicsElement: class {}, DOMPoint: class {} });
const { CollisionLayout } = module.exports;

// a slur from x 0 to 100 on staff "s", its chord flat at y 0; the arch starts 20 below (or above) it
const layout = (items) => { const l = new CollisionLayout(10); l.items.push(...items.map((it) => ({ staffId: 's', kind: 'rhythm', ...it }))); return l; };
const box = (x, y, width = 10, height = 10) => ({ x, y, width, height });
const system = new Set(['m1', 'm2']);
const lift = (l, initial = 20, cap = 100) => l.curveLift(0, 0, 100, 0, initial, 's', system, cap);

// nothing in the way: the arch stays as it was asked
assert.equal(lift(layout([])), 20);
// engraving inside the slur's span, on its side, raises the arch to clear it
const raised = lift(layout([{ measureId: 'm1', box: box(40, 15) }]));
assert.ok(raised > 20 && raised <= 100, `raised to ${raised}`);
// the same engraving in a measure of another system is not in its way (it is a page away)
assert.equal(lift(layout([{ measureId: 'far', box: box(40, 1286) }])), 20);
assert.equal(lift(layout([{ measureId: 'm1', box: box(40, 15) }, { measureId: 'far', box: box(40, 1286) }])), raised);
// another staff, a staff line, an item over an end of the slur: none of them is in the way
assert.equal(lift(layout([{ measureId: 'm1', staffId: 'other', box: box(40, 15) }])), 20);
assert.equal(lift(layout([{ measureId: 'm1', kind: 'staff', box: box(40, 15) }])), 20);
assert.equal(lift(layout([{ measureId: 'm1', box: box(-5, 15) }])), 20);
// an arch above its chord is raised the other way, and engraving on the other side does not matter
const above = lift(layout([{ measureId: 'm1', box: box(40, -25) }]), -20);
assert.ok(above < -20 && above >= -100, `raised to ${above}`);
assert.equal(lift(layout([{ measureId: 'm1', box: box(40, 15) }]), -20), -20);
// whatever it finds, the arch is held to the ceiling, on either side
assert.equal(lift(layout([{ measureId: 'm1', box: box(40, 5000) }])), 100);
assert.equal(lift(layout([{ measureId: 'm1', box: box(40, -5000) }]), -20), -100);
console.log('PASS slur lift: only the slur\'s own system is in its way, the arch is held to the ceiling');
