import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const ts = require('typescript');
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const js = ts.transpileModule(fs.readFileSync(path.join(root, 'src/core/model/slurHandles.ts'), 'utf8'),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const module = { exports: {} };
vm.runInNewContext(js, { module, exports: module.exports }, { filename: 'slurHandles.ts' });
const plain = value => JSON.parse(JSON.stringify(value));
const { slurOffsets, framed, handlePoints, dragSlur, slurChanges, fitted, frameSize, automaticArch } = module.exports;
const noSlurOffsets = plain(module.exports.noSlurOffsets);

const sp = 10;
// a slur hanging below a flat chord: chord ends at y 0, control points 20 px below
const below = { p0: { x: 0, y: 0 }, p3: { x: 100, y: 0 }, c1: { x: 25, y: 20 }, c2: { x: 75, y: 20 } };
// the same slur arching above its chord
const above = { p0: { x: 0, y: 0 }, p3: { x: 100, y: 0 }, c1: { x: 25, y: -20 }, c2: { x: 75, y: -20 } };
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-3, `${actual} is not near ${expected}`);
const drag = (handle, base, dx, dy, from = noSlurOffsets) => dragSlur(handle, from, base, { x: dx, y: dy });

// reading the nine numbers out of the presentation
const target = (reference) => ({ entity_id: 's', reference });
const presentation = {
  vertical: [{ ...target('body'), offset: 1 }, { ...target('lower_edge'), offset: 2 }, { entity_id: 'other', reference: 'body', offset: 9 }],
  endpoints: [{ ...target('body'), left: 0.5, right: -0.5 }, { ...target('lower_edge'), left: 1, right: 2 }],
  directions: [],
  horizontal: [{ ...target('lower_edge'), offset: 0.25 }],
  horizontal_endpoints: [{ ...target('lower_edge'), left: -0.1, right: 0.1 }],
};
assert.deepEqual(plain(slurOffsets(presentation, 's')), {
  bodyVertical: 1, bodyLeft: 0.5, bodyRight: -0.5, edgeVertical: 2, edgeLeft: 1, edgeRight: 2,
  horizontal: 0.25, horizontalLeft: -0.1, horizontalRight: 0.1,
});
assert.deepEqual(plain(slurOffsets({ vertical: [], endpoints: [], directions: [], horizontal: [], horizontal_endpoints: [] }, 's')), noSlurOffsets);

// no offsets: the frame is the default one; the lift moves all four points, each side only its own
assert.deepEqual(plain(framed(below, noSlurOffsets)), below);
// the offsets are fractions of the frame: its arch height here is 20, so 1 is 20 px and 0.5 is 10 px
const lifted = framed(below, { ...noSlurOffsets, bodyVertical: 1, bodyLeft: 0.5 });
assert.deepEqual(plain([lifted.p0.y, lifted.p3.y, lifted.c1.y, lifted.c2.y]), [30, 20, 40, 40]);
assert.deepEqual(plain(frameSize(below)), { w: 100, h: 20 });
// the arch a slur has of itself depends on its width only, between 1.4 and 4 staff spaces
assert.equal(automaticArch(100, sp), 16); assert.equal(automaticArch(20, sp), 14); assert.equal(automaticArch(500, sp), 40);

// the six handles: middle of the chord edge, its two corners, then the control edge's corners and middle
const points = handlePoints(below);
assert.deepEqual(plain(points.top), { x: 50, y: 0 });
assert.deepEqual(plain(points.topLeft), below.p0);
assert.deepEqual(plain(points.edgeMiddle), { x: 50, y: 20 });
assert.deepEqual(plain(points.edgeRight), below.c2);

// each handle changes only its own numbers
assert.deepEqual(plain(drag('top', below, 40, 10)), { ...noSlurOffsets, bodyVertical: 0.5 });
assert.deepEqual(plain(drag('topLeft', below, 40, -10)), { ...noSlurOffsets, bodyLeft: -0.5 });
assert.deepEqual(plain(drag('topRight', below, 0, 10)), { ...noSlurOffsets, bodyRight: 0.5 });
assert.deepEqual(plain(drag('edgeLeft', below, -10, 10)), { ...noSlurOffsets, edgeLeft: 0.5, horizontalLeft: -0.1 });
assert.deepEqual(plain(drag('edgeMiddle', below, 10, 10)), { ...noSlurOffsets, edgeVertical: 0.5, horizontal: 0.1 });
assert.deepEqual(plain(drag('edgeRight', below, 10, -10)), { ...noSlurOffsets, edgeRight: -0.5, horizontalRight: 0.1 });

// the control points stay inside the chord's width: far left stops at the chord's left end
const farLeft = drag('edgeLeft', below, -500, 0);
near(framed(below, farLeft).c1.x, 0);
// ... and the left one never passes the right one
const pastRight = drag('edgeLeft', below, 500, 0);
assert.ok(framed(below, pastRight).c1.x <= framed(below, pastRight).c2.x);
assert.ok(framed(below, pastRight).c1.x >= 74.99);
// the middle handle moves both points until the nearer one meets the chord's end
const middleLeft = framed(below, drag('edgeMiddle', below, -500, 0));
near(middleLeft.c1.x, 0); near(middleLeft.c2.x, 50);

// the control edge never crosses the chord edge, whichever side it hangs on
near(framed(below, drag('edgeMiddle', below, 0, -500)).c1.y, 0);
near(framed(above, drag('edgeMiddle', above, 0, 500)).c1.y, 0);
// ... and a corner cannot be dragged through the control edge either: the chord's height at the left
// control point (a quarter of the way from the right end) reaches 20 when the left corner is at 20 / 0.75
near(framed(below, drag('topLeft', below, 0, 500)).p0.y, 20 / 0.75);
// a wall is slid along, not stuck to: pushing into the left end still follows the vertical move
const slid = drag('edgeLeft', below, -500, 10);
near(framed(below, slid).c1.x, 0);
near(framed(below, slid).c1.y, 30);
// a drag that starts from existing offsets continues from them
assert.equal(drag('top', below, 0, 10, { ...noSlurOffsets, bodyVertical: 2 }).bodyVertical, 2.5);

// committing: only the groups that changed, a group back at zero is cleared
assert.deepEqual(plain(slurChanges('s', noSlurOffsets, noSlurOffsets)), []);
assert.deepEqual(plain(slurChanges('s', noSlurOffsets, { ...noSlurOffsets, bodyVertical: 1, edgeRight: 2, horizontal: 0.5 })), [
  { kind: 'vertical', target: target('body'), offset: 1 },
  { kind: 'endpoints', target: target('lower_edge'), offsets: { left: 0, right: 2 } },
  { kind: 'horizontal', target: target('lower_edge'), offset: 0.5 },
]);
const reset = slurChanges('s', { ...noSlurOffsets, bodyLeft: 1, horizontalLeft: 1 }, noSlurOffsets);
assert.deepEqual(plain(reset), [
  { kind: 'endpoints', target: target('body'), offsets: null },
  { kind: 'horizontal_endpoints', target: target('lower_edge'), offsets: null },
]);

// a slur that became shorter than its stored offsets: the lower corners are outside the chord and swapped
const broken = { ...noSlurOffsets, horizontalLeft: 9, horizontalRight: -9, edgeLeft: -5 };
const repaired = fitted(below, broken);
const mended = framed(below, repaired);
assert.ok(mended.c1.x >= below.p0.x && mended.c2.x <= below.p3.x && mended.c1.x <= mended.c2.x);
assert.ok(mended.c1.y >= 0 && mended.c2.y >= 0, 'the control edge is back on its side of the chord');
// a valid shape is left alone
assert.deepEqual(plain(fitted(below, { ...noSlurOffsets, edgeVertical: 1 })), { ...noSlurOffsets, edgeVertical: 1 });
// dragging from the repaired shape is not stuck: the handle follows the pointer again
const freed = drag('edgeLeft', below, 0, 10, repaired);
assert.ok(framed(below, freed).c1.y > mended.c1.y);
// a handle resting exactly on a wall can be dragged away from it
const onWall = drag('edgeLeft', below, -500, 0);
assert.ok(framed(below, drag('edgeLeft', below, 10, 0, onWall)).c1.x > framed(below, onWall).c1.x);
console.log('slur handle checks passed');
