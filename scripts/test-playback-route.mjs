import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url), ts = require('typescript');
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
function load(file, stubs = {}, cache = new Map()) {
  const full = path.join(root, file);
  if (cache.has(full)) return cache.get(full).exports;
  const module = { exports: {} }; cache.set(full, module);
  const js = ts.transpileModule(fs.readFileSync(full, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(js, { module, exports: module.exports, console, Math, Number, Infinity, require(name) {
    if (name in stubs) return stubs[name];
    if (name.startsWith('@/')) return load('src/' + name.slice(2) + '.ts', stubs, cache);
    if (name.startsWith('.')) return load(path.relative(root, path.resolve(path.dirname(full), name + '.ts')), stubs, cache);
    throw new Error('Unexpected import: ' + name);
  } }, { filename: full });
  return module.exports;
}
const { buildRoute, indexAtMs, positionAtMs, positionAtBeat, msAtPosition, stepMs, ribbonTarget } = load('src/core/navigation/route.ts', { react: { useSyncExternalStore: () => undefined } });
const segment = (startBeats, endBeats, startMs, endMs, moments) => ({ startBeats, endBeats, startMs, endMs, moments: moments ?? [{ beats: startBeats, timeMs: startMs }, { beats: endBeats, timeMs: endMs }] });
const map = (segments) => ({ version: 1, extentMs: segments.at(-1)?.endMs ?? 0, pedals: [], notes: [], anchors: [], segments });
const four = [4, 4, 4, 4];
// the route is built in another realm, so its arrays are compared by value
const same = (actual, expected) => assert.deepEqual(JSON.parse(JSON.stringify(actual)), expected);

// A piece played once: one entry for each bar, each played the one time.
let route = buildRoute(map([segment(0, 16, 0, 8000)]), four);
same(route.bars.map((bar) => bar.measure), [0, 1, 2, 3]);
same(route.bars.map((bar) => [bar.startMs, bar.endMs]), [[0, 2000], [2000, 4000], [4000, 6000], [6000, 8000]]);
assert.ok(route.bars.every((bar) => bar.pass === 1 && bar.passes === 1));
assert.equal(route.totalMs, 8000);
console.log('PASS a piece played once');

// |: 1 2 :| 3 is played 1 2 1 2 3: a repeated bar sounds twice, each time with its pass, the third bar once.
route = buildRoute(map([segment(0, 8, 0, 4000), segment(0, 8, 4000, 8000), segment(8, 12, 8000, 10000)]), [4, 4, 4]);
same(route.bars.map((bar) => bar.measure), [0, 1, 0, 1, 2]);
same(route.bars.map((bar) => [bar.pass, bar.passes]), [[1, 2], [1, 2], [2, 2], [2, 2], [1, 1]]);
assert.equal(route.totalMs, 10000);
console.log('PASS a repeat gives each bar a pass of its own');

// A volta: 1 2 [3] then back to 1 2 then [4]: the endings sound once each.
route = buildRoute(map([segment(0, 12, 0, 6000), segment(0, 8, 6000, 10000), segment(12, 16, 10000, 12000)]), four);
same(route.bars.map((bar) => bar.measure), [0, 1, 2, 0, 1, 3]);
same(route.bars.map((bar) => bar.passes), [2, 2, 1, 2, 2, 1]);
console.log('PASS a volta');

// The time of a bar follows the moments of its stretch, so a tempo change inside a stretch moves the barline.
route = buildRoute(map([segment(0, 8, 0, 3000, [{ beats: 0, timeMs: 0 }, { beats: 4, timeMs: 1000 }, { beats: 8, timeMs: 3000 }])]), [4, 4]);
same(route.bars.map((bar) => [bar.startMs, bar.endMs]), [[0, 1000], [1000, 3000]]);
// A stretch that starts inside a bar gives that bar from the place it starts.
route = buildRoute(map([segment(2, 8, 500, 3500, [{ beats: 2, timeMs: 500 }, { beats: 8, timeMs: 3500 }])]), [4, 4]);
same(route.bars.map((bar) => [bar.measure, bar.startMs, bar.endMs]), [[0, 500, 1500], [1, 1500, 3500]]);
console.log('PASS tempo inside a stretch and a stretch that starts inside a bar');

route = buildRoute(map([]), four);
same(route.bars, []); assert.equal(route.totalMs, 0);
assert.equal(positionAtMs(route, 500), 0); assert.equal(msAtPosition(route, 3), 0); assert.equal(stepMs(route, 0, 1), 0);
console.log('PASS an empty map');

// Where a time stands, and back.
route = buildRoute(map([segment(0, 8, 0, 4000), segment(0, 8, 4000, 8000), segment(8, 12, 8000, 10000)]), [4, 4, 4]);
assert.equal(indexAtMs(route, -5), 0); assert.equal(indexAtMs(route, 0), 0); assert.equal(indexAtMs(route, 1999), 0); assert.equal(indexAtMs(route, 2000), 1);
assert.equal(indexAtMs(route, 4000), 2); assert.equal(indexAtMs(route, 9999), 4); assert.equal(indexAtMs(route, 50000), 4);
assert.equal(positionAtMs(route, 5000), 2.5); assert.equal(positionAtMs(route, 10000), 5); assert.equal(positionAtMs(route, 50000), 5);
for (let ms = 0; ms <= 10000; ms += 250) assert.ok(Math.abs(msAtPosition(route, positionAtMs(route, ms)) - ms) < 1e-9);
assert.equal(msAtPosition(route, 2.5), 5000); assert.equal(msAtPosition(route, 99), 10000); assert.equal(msAtPosition(route, -3), 0);
let previous = -Infinity;
for (let position = 0; position <= 5; position += 0.01) { const ms = msAtPosition(route, position); assert.ok(ms >= previous); previous = ms; }
console.log('PASS position and time, both ways, clamped and monotonic');

// Steps: the second pass of bar 1 is reached from the first pass of bar 2, not from the score.
assert.equal(stepMs(route, 3500, 1), 4000);            // from bar 2 (first pass): next is bar 1, second pass
assert.equal(stepMs(route, 4600, -1), 4000);           // past a quarter of the bar: back to its start
assert.equal(stepMs(route, 4100, -1), 2000);           // within the first quarter: to the bar before in the route
assert.equal(stepMs(route, 0, -1), 0); assert.equal(stepMs(route, 100, -1), 0);
assert.equal(stepMs(route, 9500, 1), 10000); assert.equal(stepMs(route, 10000, 1), 10000);
console.log('PASS steps follow the route');

// The ribbon keeps the position at the anchor and stops at the ends of the piece.
assert.equal(ribbonTarget(0, 12, 567, 0.75), 0); assert.equal(ribbonTarget(9, 12, 567, 0.75), 0); assert.equal(ribbonTarget(21, 12, 567, 0.75), 12);
assert.equal(ribbonTarget(566, 12, 567, 0.75), 555); assert.equal(ribbonTarget(5, 12, 8, 0.75), 0);
console.log('PASS the ribbon at the start, in the middle, at the end and in a piece shorter than the ribbon');

// A place of the score in the route: a repeated bar is taken in the pass asked for, or in its last when it sounds fewer times.
route = buildRoute(map([segment(0, 8, 0, 4000), segment(0, 8, 4000, 8000), segment(8, 12, 8000, 10000)]), [4, 4, 4]);
assert.equal(positionAtBeat(route, 5, 1), 1.25); assert.equal(positionAtBeat(route, 5, 2), 3.25); assert.equal(positionAtBeat(route, 5, 3), 3.25);
assert.equal(positionAtBeat(route, 9, 2), 4.25); assert.equal(positionAtBeat(route, 0, 2), 2);
assert.equal(positionAtBeat(route, -3, 1), 0); assert.equal(positionAtBeat(route, 12, 1), 5); assert.equal(positionAtBeat(route, 99, 1), 5);
assert.equal(positionAtBeat(buildRoute(map([]), [4]), 2, 1), 0);
console.log('PASS a place of the score in the route, by pass, and outside the score');
