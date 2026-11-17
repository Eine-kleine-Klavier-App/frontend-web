import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const ts = require('typescript');
const root = new URL('../', import.meta.url);
const text = fs.readFileSync(new URL('src/rendering/vexflow/VexflowRenderer.tsx', root), 'utf8');
const source = ts.createSourceFile('VexflowRenderer.tsx', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

// The real zone helpers, taken out of the renderer and run against stubbed geometry: no React or VexFlow is mounted.
const wanted = new Set(['sameBreaks', 'scrollerOf', 'systemTop', 'screenOf', 'systemsNearScreen', 'anchorOf']);
const constants = new Set(['ZONE_MARGIN', 'SYSTEM_ROOM']);
const parts = [];
for (const node of source.statements) {
  if (ts.isFunctionDeclaration(node) && wanted.has(node.name?.text)) parts.push(node.getText(source));
  if (ts.isVariableStatement(node) && node.declarationList.declarations.some(d => constants.has(d.name.text))) parts.push(node.getText(source));
}
assert.equal(parts.length, wanted.size + constants.size, 'every zone helper and constant must be found in the renderer');
const js = ts.transpileModule(parts.join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
  + '\nthis.exported = { sameBreaks, scrollerOf, systemsNearScreen, anchorOf, ZONE_MARGIN, SYSTEM_ROOM };';
const ctx = { window: { innerHeight: 600 }, getComputedStyle: node => ({ overflowY: node.overflowY ?? 'visible' }) };
vm.createContext(ctx); vm.runInContext(js, ctx);
const { sameBreaks, scrollerOf, systemsNearScreen, anchorOf, ZONE_MARGIN, SYSTEM_ROOM } = ctx.exported;

// 20 systems, each 100 drawing units high; `unit` pixels per drawing unit (the zoom); the page is scrolled by `scroll` pixels
const SYSTEMS = 20, BAND = 100;
function drawingAt({ scroll, unit, state }) {
  const height = SYSTEMS * BAND;
  const lines = Array.from({ length: SYSTEMS }, (_, si) => `m${si * 3}:a m${si * 3 + 1}:b m${si * 3 + 2}:c`);
  return {
    svg: { getBoundingClientRect: () => ({ top: -scroll, bottom: -scroll + height * unit, height: height * unit }) },
    height,
    tops: Array.from({ length: SYSTEMS }, (_, si) => si * BAND + SYSTEM_ROOM),
    applied: Array.from({ length: SYSTEMS }, () => 0),
    shiftY: 0,
    state: state ?? Array.from({ length: SYSTEMS }, () => 'blank'),
    signature: lines.join('\n'),
  };
}
const screen = { getBoundingClientRect: () => ({ top: 0, bottom: 600 }) };
const near = (drawing, scroller = screen) => [...systemsNearScreen(drawing, scroller)].sort((a, b) => a - b);
const range = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

// a screen of 600 with a margin of 0.75 of it on both sides: the systems whose band meets [-450, 1050]
assert.equal(ZONE_MARGIN, 0.75);
assert.deepEqual(near(drawingAt({ scroll: 0, unit: 2 })), range(0, 5), 'the top of the score: the systems down to one screen and a half');
assert.deepEqual(near(drawingAt({ scroll: 2000, unit: 2 })), range(7, 15), 'the middle: systems above and below the screen, not the ends');
assert.deepEqual(near(drawingAt({ scroll: 3400, unit: 2 })), range(14, 19), 'the bottom: the last systems, none past the end');
// the same screen at another zoom meets other systems: bands are read in screen pixels, not drawing units
assert.deepEqual(near(drawingAt({ scroll: 0, unit: 4 })), range(0, 2), 'zoomed in, fewer systems fit the same screen');
assert.deepEqual(near(drawingAt({ scroll: 0, unit: 1 })), range(0, 10), 'zoomed out, more systems fit');
// a page that scrolls by itself is measured against the window
assert.deepEqual(near(drawingAt({ scroll: 0, unit: 2 }), null), range(0, 5), 'without a scroller the window is the screen');

// the scroller is the nearest ancestor that scrolls
const page = { overflowY: 'visible', parentElement: null };
const panel = { overflowY: 'auto', parentElement: page };
const inner = { overflowY: 'hidden', parentElement: panel };
assert.equal(scrollerOf({ parentElement: inner }), panel, 'overflow hidden does not scroll; the next ancestor that does is the scroller');
assert.equal(scrollerOf({ parentElement: page }), null, 'no scrolling ancestor: the page itself scrolls');

// the anchor is the first measure of the first system whose band ends below the top of the screen, and where that band starts
assert.deepEqual({ ...anchorOf(drawingAt({ scroll: 0, unit: 2 }), screen) }, { measureId: 'm0', top: 0 });
assert.deepEqual({ ...anchorOf(drawingAt({ scroll: 2100, unit: 2 }), screen) }, { measureId: 'm30', top: -100 });
assert.equal(anchorOf({ ...drawingAt({ scroll: 0, unit: 2 }), tops: [] }, screen), null, 'no systems, no anchor');

// a layout keeps the breaks of a drawing when no system that stays on screen changes: blank systems and those drawn again may change
const drawn = drawingAt({ scroll: 0, unit: 2, state: Array.from({ length: SYSTEMS }, (_, si) => (si < 3 ? 'drawn' : si < 5 ? 'stale' : 'blank')) });
const lines = drawn.signature.split('\n');
const edited = (si) => lines.map((line, i) => (i === si ? line.replace('m' + si * 3 + ':a', 'm' + si * 3 + ':z') : line)).join('\n');
assert.equal(sameBreaks(drawn.signature, drawn, new Set()), true, 'nothing changed');
assert.equal(sameBreaks(edited(1), drawn, new Set()), false, 'a drawn system that is not drawn again must keep its breaks');
assert.equal(sameBreaks(edited(1), drawn, new Set([1])), true, 'a system drawn again may change');
assert.equal(sameBreaks(edited(3), drawn, new Set()), false, 'a stale system is still shown, so its breaks hold');
assert.equal(sameBreaks(edited(12), drawn, new Set()), true, 'a system not drawn yet may change as it likes');
console.log('PASS zone: systems near the screen at every zoom and scroll, the scroller, the scroll anchor, and when breaks must hold');
