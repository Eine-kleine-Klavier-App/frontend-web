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
const constants = new Set(['SYSTEM_ROOM']);
const parts = [];
for (const node of source.statements) {
  if (ts.isFunctionDeclaration(node) && wanted.has(node.name?.text)) parts.push(node.getText(source));
  if (ts.isVariableStatement(node) && node.declarationList.declarations.some(d => constants.has(d.name.text))) parts.push(node.getText(source));
}
assert.equal(parts.length, wanted.size + constants.size, 'every zone helper and constant must be found in the renderer');
const js = ts.transpileModule(parts.join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
  + '\nthis.exported = { sameBreaks, scrollerOf, systemsNearScreen, anchorOf, SYSTEM_ROOM };';
const ctx = { window: { innerHeight: 600 }, getComputedStyle: node => ({ overflowY: node.overflowY ?? 'visible' }) };
vm.createContext(ctx); vm.runInContext(js, ctx);
const { sameBreaks, scrollerOf, systemsNearScreen, anchorOf, SYSTEM_ROOM } = ctx.exported;

// 20 systems, each 100 drawing units high; `unit` pixels per drawing unit (the zoom); the page is scrolled by `scroll` pixels
const SYSTEMS = 20, BAND = 100;
// `perSheet`: how many systems a sheet holds (the chunk of a system is its sheet); without it every system is its own chunk
function drawingAt({ scroll, unit, state, perSheet = 1 }) {
  const height = SYSTEMS * BAND;
  const lines = Array.from({ length: SYSTEMS }, (_, si) => `m${si * 3}:a m${si * 3 + 1}:b m${si * 3 + 2}:c`);
  return {
    svg: { getBoundingClientRect: () => ({ top: -scroll, bottom: -scroll + height * unit, height: height * unit }) },
    height,
    tops: Array.from({ length: SYSTEMS }, (_, si) => si * BAND + SYSTEM_ROOM),
    applied: Array.from({ length: SYSTEMS }, () => 0),
    sheetOf: Array.from({ length: SYSTEMS }, (_, si) => Math.floor(si / perSheet)),
    shiftY: 0,
    state: state ?? Array.from({ length: SYSTEMS }, () => 'blank'),
    signature: lines.join('\n'),
  };
}
const screen = { getBoundingClientRect: () => ({ top: 0, bottom: 600 }) };
const near = (drawing, scroller = screen) => [...systemsNearScreen(drawing, scroller)].sort((a, b) => a - b);
const range = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

// a screen of 600: the middle of it is at 300. The chunk (here a system) there is the current one; nothing else is asked for
// until the current one is drawn whole
assert.deepEqual(near(drawingAt({ scroll: 0, unit: 2 })), [1], 'the top of the score: the system at the middle of the screen');
assert.deepEqual(near(drawingAt({ scroll: 2000, unit: 2 })), [11], 'the middle of the score: only the system at the middle of the screen');
assert.deepEqual(near(drawingAt({ scroll: 3400, unit: 2 })), [18], 'the bottom: the system at the middle, none past the end');
// the same screen at another zoom has another system at its middle: bands are read in screen pixels, not drawing units
assert.deepEqual(near(drawingAt({ scroll: 0, unit: 4 })), [0], 'zoomed in, the first system fills the middle');
assert.deepEqual(near(drawingAt({ scroll: 0, unit: 1 })), [2], 'zoomed out, a system further down is at the middle');
// once the current chunk is drawn the ones above and below it are asked for, and no more
const drawnRange = (from, to) => Array.from({ length: SYSTEMS }, (_, si) => (si >= from && si <= to ? 'drawn' : 'blank'));
assert.deepEqual(near(drawingAt({ scroll: 0, unit: 2, state: drawnRange(1, 1) })), [0, 1, 2], 'the current one is drawn: its neighbours come next');
assert.deepEqual(near(drawingAt({ scroll: 0, unit: 2, state: drawnRange(0, 0) })), [1], 'a neighbour drawn is not the current one: the current one still comes first');
assert.deepEqual(near(drawingAt({ scroll: 3400, unit: 2, state: drawnRange(18, 18) })), [17, 18, 19], 'the neighbours of the one at the middle, below too');
// the chunk is a sheet (sheets of 5 systems here): the current sheet whole, the neighbours only when it is drawn
assert.deepEqual(near(drawingAt({ scroll: 0, unit: 2, perSheet: 5 })), range(0, 4), 'the first sheet, whole, and no other');
assert.deepEqual(near(drawingAt({ scroll: 0, unit: 2, perSheet: 5, state: drawnRange(0, 4) })), range(0, 9), 'the first sheet is drawn: the sheet below it comes next');
assert.deepEqual(near(drawingAt({ scroll: 2000, unit: 2, perSheet: 5 })), range(10, 14), 'a sheet in the middle of the score, alone');
assert.deepEqual(near(drawingAt({ scroll: 2000, unit: 2, perSheet: 5, state: drawnRange(10, 14) })), range(5, 19), 'drawn: the sheets above and below it come next');
assert.deepEqual(near(drawingAt({ scroll: 2000, unit: 2, perSheet: 5, state: drawnRange(10, 13) })), range(10, 14), 'one system of the sheet is not drawn: no neighbours yet');
assert.ok(!near(drawingAt({ scroll: 0, unit: 2, perSheet: 5, state: drawnRange(0, 4) })).includes(10), 'a sheet two away stays out of the zone');
// a page that scrolls by itself is measured against the window
assert.deepEqual(near(drawingAt({ scroll: 0, unit: 2 }), null), [1], 'without a scroller the window is the screen');

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
