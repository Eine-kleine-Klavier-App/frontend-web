import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url), ts = require('typescript');
function load(file, stubs = {}) {
  const module = { exports: {} };
  const code = ts.transpileModule(fs.readFileSync(new URL('../' + file, import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(code, { module, exports: module.exports, require(name) { assert.ok(name in stubs, name); return stubs[name]; } });
  return module.exports;
}
const plain = value => JSON.parse(JSON.stringify(value));
const model = load('src/core/model/presentation.ts');
const presentation = { vertical: [{ entity_id: 'c', reference: 'stem_tip', offset: 1.5 }, { entity_id: 'p', reference: 'body', offset: 1.5 }], endpoints: [], directions: [{ entity_id: 'c', reference: 'stem_tip', direction: 'down' }] };
assert.deepEqual(plain(model.stemPlacements(presentation)), { c: { direction: -1, lengthFactor: 1.5 } });
assert.equal(model.bodyFactor(presentation, 'p'), 1.5);
assert.equal(model.bodyFraction(presentation, 'p'), 1.5);
assert.equal(model.bodyFactor(presentation, 'missing'), 1);
assert.equal(model.bodyFraction(presentation, 'missing'), 0);
console.log('PASS stored placements read as factors of the automatic size (1 = automatic) and fractions of a frame (0 = automatic)');


const rendererSource = fs.readFileSync(new URL('../src/rendering/vexflow/VexflowRenderer.tsx', import.meta.url), 'utf8');
const rendererAst = ts.createSourceFile('renderer.tsx', rendererSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const buildNode = rendererAst.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'buildStaveNote');
const rendererCode = ts.transpileModule(buildNode.getText(rendererAst) + '\nexports.build = buildStaveNote;', { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const vf = require('vexflow'); const rendererModule = { exports: {} };
vm.runInNewContext(rendererCode, { ...vf, exports: rendererModule.exports, STAFF_H: 40, VEXFLOW_STEM_HEIGHT: 35, MIN_STEM_LENGTH: 20, fixLedgerLineWidth: () => {} });
for (const direction of [1,-1]) for (const keys of [['c/4'],['c/4','e/4','g/4']]) for (const factor of [.4,1,1.5,2.5]) {
 const n = { kind:'note', keys, duration:'8', accidentals:[], dots:0, fingerings:[], staffSteps:keys.map((_,i)=>i*2) };
 const automatic = rendererModule.exports.build(n,'treble','#000',{direction,lengthFactor:1});
 const changed = rendererModule.exports.build(n,'treble','#000',{direction,lengthFactor:factor});
 const stave = new vf.Stave(0,0,400); automatic.setStave(stave); changed.setStave(stave);
 // a stem is the automatic length times the factor, never set shorter than the chord's span plus the minimum protrusion
 const natural = automatic.getStemLength(), floor = Math.max(0, natural - 35) + 20;
 const expected = factor === 1 ? natural : Math.max(floor, natural * factor);
 assert.ok(Math.abs(changed.getStemLength() - expected) < 1e-8);
}
assert.deepEqual(plain(model.stemPlacements({vertical:[{entity_id:'auto',reference:'stem_tip',offset:1}],directions:[],endpoints:[]})), {auto:{lengthFactor:1}});
console.log('PASS actual renderer function sets single/chord up/down stems to the automatic length times the factor; a stem is never set shorter than its chord span plus the minimum protrusion');

const naturalNode = rendererAst.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'naturalStemInkBox');
const naturalCode = ts.transpileModule(naturalNode.getText(rendererAst) + '\nexports.measure = naturalStemInkBox;', { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const naturalModule = { exports: {} };
vm.runInNewContext(naturalCode, { exports: naturalModule.exports, inkBox: probe => probe.box });
for (const direction of [1,-1]) {
  let length = 275, removed = false, closed = false;
  const probe = { box: null, remove() { removed = true; } };
  const sn = {
    getStemLength: () => length, getStemDirection: () => direction,
    getAttribute: () => '35', setStemLength(value) { length = value; },
    setStemDirection(value) { assert.equal(value, direction); },
    checkContext: () => ({ openGroup: () => probe, closeGroup() { closed = true; } }),
    draw() { probe.box = { x: 10, y: direction === 1 ? 200-length : 200, width: 12, height: length }; },
  };
  const spacing = naturalModule.exports.measure(sn);
  assert.equal(spacing.height, 35, 'manual extension must not expand staff spacing');
  assert.equal(length, 275, 'measurement must preserve the visible manual length');
  assert.ok(removed && closed, 'the temporary natural engraving is removed');
}
console.log('PASS natural stem measurement keeps staff spacing independent of long manual stems and restores visible geometry');

const { CollisionLayout } = load('src/rendering/vexflow/collisionLayout.ts');
const collisions = new CollisionLayout(6);
collisions.items.push({ kind: 'rhythm', staffId: 'upper', measureId: 'm',
  box: { x: 100, y: 100, width: 20, height: 280 },
  spacingBox: { x: 100, y: 100, width: 20, height: 55 },
});
assert.deepEqual(plain(collisions.outsideOffset({ x: 100, y: 200, width: 20, height: 15 }, 'upper', 1)), { dx: 0, dy: 0 },
  'manual extension must not push a label into the gap and indirectly separate staffs');
assert.ok(collisions.outsideOffset({ x: 100, y: 120, width: 20, height: 15 }, 'upper', 1).dy > 0,
  'automatic note ink still keeps ordinary label clearance');
assert.equal(collisions.items[0].box.height, 280, 'full manual ink remains available');
console.log('PASS labels use natural note ink for automatic clearance without losing full manual bounds');

