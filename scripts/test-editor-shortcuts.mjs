import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url), ts = require('typescript');
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
function load(file, shallow = false) {
  const module = { exports: {} };
  const js = ts.transpileModule(fs.readFileSync(path.join(root, file), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  vm.runInNewContext(js, { module, exports: module.exports, require(name) {
    if (shallow) return {};
    const target = name.startsWith('@/') ? 'src/' + name.slice(2) : path.relative(root, path.resolve(root, path.dirname(file), name));
    return load(target + '.ts');
  } });
  return module.exports;
}
const plain = value => JSON.parse(JSON.stringify(value));
const { selectionInsertTool } = load('src/features/editor/selectionInsertTool.ts');
const { parseTool } = load('src/core/model/insertItems.ts');
const { parseMark } = load('src/core/model/markTools.ts');
const item = { id: 'chord', kind: 'note', duration: '8', dots: 2, articulations: ['accent'], notes: [
  { noteId: 'a', staffId: 'upper', staffStep: 7, accidental: '#', fingering: 3 },
  { noteId: 'b', staffId: 'lower', staffStep: 1, accidental: 'b', fingering: 0 },
] };
const rest = { id: 'rest', kind: 'rest', duration: '16', dots: 1, articulations: [], notes: [] };
const document = { measures: [{ id: 'm', voices: [{ id: 'v', items: [item, rest] }] }], contexts: [
  { id: 'clef', kind: 'clef', clef: 'bass', octaveTransposition: -1 },
  { id: 'key', kind: 'keySignature', alterations: ['sharp', 'natural', 'flat', 'natural', 'natural', 'natural', 'sharp'] },
  { id: 'dynamic', kind: 'dynamic', dynamic: 'ff', voiceIds: ['v'] },
  { id: 'tempo', kind: 'tempo', bpm: 120, beat: { value: 8, dots: 1 }, label: 'allegro', showLabel: true },
  { id: 'word', kind: 'tempo', bpm: null, beat: null, label: 'adagio', showLabel: true },
  { id: 'span', kind: 'slur' },
] };
const selection = (ids = [], structures = [], measures = []) => ({ selectedIds: ids, selectedStructureIds: structures, selectedMeasureIds: measures });
const before = JSON.stringify(document);
assert.deepEqual(plain(parseTool(selectionInsertTool(document, selection(['a'])))), { kind: 'note', value: '8', dots: 2, articulations: ['accent'], accidental: '#', fingering: 3 });
const second = parseTool(selectionInsertTool(document, selection(['b'])));
assert.equal(second.accidental, 'b'); assert.equal(second.dots, 2);
assert.deepEqual(plain(parseTool(selectionInsertTool(document, selection(['rest'])))), { kind: 'rest', value: '16', dots: 1, articulations: [], accidental: null });
assert.deepEqual(plain(parseMark(selectionInsertTool(document, selection([], ['clef'])))), { kind: 'clef', clef: 'bass', octaveTransposition: -1 });
assert.deepEqual(plain(parseMark(selectionInsertTool(document, selection([], ['key'])))).alterations, document.contexts[1].alterations);
assert.equal(parseMark(selectionInsertTool(document, selection([], ['dynamic']))).dynamic, 'ff');
const tempo = parseMark(selectionInsertTool(document, selection([], ['tempo'])));
assert.deepEqual(plain(tempo.beat), { value: 8, dots: 1 }); assert.equal(tempo.bpm, 120); assert.equal(tempo.label, 'allegro'); assert.equal(tempo.showLabel, true);
assert.equal(parseMark(selectionInsertTool(document, selection([], ['word']))).word, 'adagio');
for (const selected of [selection(), selection(['a', 'b']), selection(['missing']), selection([], ['missing']), selection([], ['span']), selection(['a'], ['dynamic']), selection([], ['clef', 'key']), selection(['a'], [], ['m'])]) assert.equal(selectionInsertTool(document, selected), null);
assert.equal(JSON.stringify(document), before);
console.log('PASS insertion templates preserve note/rest values, dots, signs, markings, point contexts; reject groups/missing targets without mutation');
const { createHoverFeedback } = load('src/features/editor/EditorView.tsx', true);
const shown = [], feedback = createHoverFeedback(ids => shown.push([...ids]));
feedback.hover(['old']); assert.deepEqual(shown.at(-1), ['old']);
feedback.keyboardMove(); assert.deepEqual(shown.at(-1), []);
feedback.hover(['old']); assert.deepEqual(shown.at(-1), []);
feedback.keyboardMove(); feedback.hover(['new-layout-old-pointer']); assert.deepEqual(shown.at(-1), []);
feedback.pointerMove(); feedback.hover(['new']); assert.deepEqual(shown.at(-1), ['new']);
feedback.hover([]); assert.deepEqual(shown.at(-1), []);
console.log('PASS arrows clear hover and suppress layout-generated hover until an actual pointer move');

// Exercise the actual mounted component's handler, not a duplicate key-matching implementation.
const screenText = fs.readFileSync(path.join(root, 'src/features/editor/EditorScreen.tsx'), 'utf8');
const screenAst = ts.createSourceFile('EditorScreen.tsx', screenText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let onKey;
function find(node) { if (ts.isVariableDeclaration(node) && node.name.getText(screenAst) === 'onKey') onKey = node.initializer.getText(screenAst); ts.forEachChild(node, find); }
find(screenAst); assert.ok(onKey);
const keyModule = { exports: {} }, tools = [];
const pinned = [];
let keyboardState = { document, ...selection(['a']), loading: false, locked: false, pitchModeRequest: null, hotbarSlots: Array(10).fill(null), tool: 'select', setTool(tool) { tools.push(tool); }, setHotbarSlot(index, tool) { pinned.push([index, tool]); } };
vm.runInNewContext(ts.transpileModule('exports.handle = ' + onKey, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText,
  { exports: keyModule.exports, useEditor: { getState: () => keyboardState }, selectionInsertTool, parseTool, parseMark, HOTBAR_SLOT_COUNT: 10, hotbarSlotKey: (i) => (i === 9 ? '0' : String(i + 1)) });
const keyEvent = overrides => ({ code: 'KeyC', key: 'c', ctrlKey: true, metaKey: false, altKey: false, shiftKey: false, target: { tagName: 'BODY' }, prevented: false, preventDefault() { this.prevented = true; }, ...overrides });
for (const flags of [{}, { ctrlKey: false, metaKey: true }, { key: 'с' }]) {
  const e = keyEvent(flags), count = tools.length; keyModule.exports.handle(e);
  assert.equal(tools.length, count + 1); assert.equal(e.prevented, true);
  assert.equal(parseTool(tools.at(-1)).fingering, 3);
}
for (const target of [{ tagName: 'INPUT' }, { tagName: 'TEXTAREA' }, { tagName: 'SELECT' }, { isContentEditable: true }]) {
  const e = keyEvent({ target }), count = tools.length; keyModule.exports.handle(e);
  assert.equal(tools.length, count); assert.equal(e.prevented, false);
}
for (const guard of [{ locked: true }, { loading: true }, { pitchModeRequest: {} }, { ...selection(['a', 'b']) }]) {
  const previous = keyboardState; keyboardState = { ...previous, ...guard };
  const e = keyEvent({}), count = tools.length; keyModule.exports.handle(e);
  assert.equal(tools.length, count); assert.equal(e.prevented, false); keyboardState = previous;
}
console.log('PASS actual Ctrl+C/Cmd+C handler, Cyrillic layout, text input preservation, lock/loading/dialog and group guards');

// Alt + digit pins the armed element to that slot, by physical key (Alt + digit types a symbol on a Mac)
{
  const previous = keyboardState;
  keyboardState = { ...previous, tool: 'q' };
  const nine = keyEvent({ code: 'Digit9', key: 'ª', ctrlKey: false, altKey: true }); keyModule.exports.handle(nine);
  assert.deepEqual(pinned.at(-1), [8, 'q']); assert.equal(nine.prevented, true);
  const zero = keyEvent({ code: 'Digit0', key: 'º', ctrlKey: false, altKey: true }); keyModule.exports.handle(zero);
  assert.deepEqual(pinned.at(-1), [9, 'q']);
  const count = pinned.length;
  keyboardState = { ...previous, tool: 'select' };
  const none = keyEvent({ code: 'Digit1', key: '¡', ctrlKey: false, altKey: true }); keyModule.exports.handle(none);
  assert.equal(pinned.length, count); assert.equal(none.prevented, false);
  keyboardState = { ...previous, tool: 'q' };
  const plainDigit = keyEvent({ code: 'Digit1', key: '1', ctrlKey: false }); keyModule.exports.handle(plainDigit);
  assert.equal(pinned.length, count);
  keyboardState = previous;
  console.log('PASS Alt + digit pins the armed element to that slot, nothing armed pins nothing');
}
