import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url), ts = require('typescript');
function load(file, stubs = {}, globals = {}) {
  const module = { exports: {} };
  const js = ts.transpileModule(fs.readFileSync(new URL('../' + file, import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(js, { module, exports: module.exports, require: name => { assert.ok(name in stubs, name); return stubs[name]; }, ...globals });
  return module.exports;
}
const { beamDragFactors } = load('src/rendering/ScoreRenderer.ts');
const plain = value => JSON.parse(JSON.stringify(value));
const ends = direction => ({ leftLength: 40, rightLength: 50, direction });
for (const direction of [1, -1]) for (const delta of [-12, -2, 0, 7]) {
  const initial = { leftFactor: 1.5, rightFactor: 0.8 };
  const left = beamDragFactors(initial, 'left', delta, ends(direction), 20);
  const right = beamDragFactors(initial, 'right', delta, ends(direction), 20);
  // an end moving up lengthens a stem pointing up and shortens one pointing down, never under the minimum
  assert.equal(left.rightFactor, initial.rightFactor);
  assert.equal(right.leftFactor, initial.leftFactor);
  assert.ok(Math.abs(left.leftFactor * 40 - Math.max(20, 40 * 1.5 - direction * delta)) < 1e-9);
  assert.ok(Math.abs(right.rightFactor * 50 - Math.max(20, 50 * 0.8 - direction * delta)) < 1e-9);
  const center = beamDragFactors(initial, 'center', delta, ends(direction), 20);
  assert.ok(Math.abs(center.leftFactor * 40 - Math.max(20, 40 * 1.5 - direction * delta)) < 1e-9);
  assert.ok(Math.abs(center.rightFactor * 50 - Math.max(20, 50 * 0.8 - direction * delta)) < 1e-9);
  assert.deepEqual(initial, { leftFactor: 1.5, rightFactor: 0.8 });
}
console.log('PASS beam endpoint drags leave the opposite end fixed, the center moves both by the same distance, a stem is never under the minimum, no model mutation');
const { Beam, StaveNote, Stave, Formatter, Voice } = require('vexflow');
for (const direction of [1, -1]) {
  const stave = new Stave(0, 0, 400);
  const notes = ['c/4', 'e/4', 'g/4'].map(key => new StaveNote({ keys: [key], duration: '8', stem_direction: direction }).setStave(stave));
  const voice = new Voice({ num_beats: 3, beat_value: 8 }).addTickables(notes);
  const beam = new Beam(notes); new Formatter().joinVoices([voice]).format([voice], 300); beam.postFormat();
  const x0 = notes[0].getStemX(), x1 = notes.at(-1).getStemX(), baseY = beam.getBeamYToDraw(), slope = beam.slope;
  const oldTips = notes.map(note => note.getStemExtents().topY);
  const left = -10, right = 15;
  beam.slope += (right - left) / (x1 - x0);
  notes.forEach(note => { const dy = left + (right - left) * (note.getStemX() - x0) / (x1 - x0); const stem = note.getStem(); stem.setExtension(stem.getExtension() - dy * note.getStemDirection()); });
  assert.ok(Math.abs(beam.getBeamYToDraw() - baseY - left) < 1e-9);
  notes.forEach((note, i) => {
    const dx = note.getStemX() - x0, dy = left + (right - left) * dx / (x1 - x0);
    assert.ok(Math.abs(note.getStemExtents().topY - oldTips[i] - dy) < 1e-9);
    assert.ok(Math.abs((beam.getBeamYToDraw() + beam.slope * dx) - (baseY + slope * dx + dy)) < 1e-9);
  });
}
console.log('PASS real VexFlow up/down beam tips and stems follow the same adjusted line');

const overlaySource = fs.readFileSync(new URL('../src/features/editor/Overlay.tsx',import.meta.url),'utf8');
const overlayAst = ts.createSourceFile('Overlay.tsx',overlaySource,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
const hitNode = overlayAst.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text==='stemHitRange');
const hitCode = ts.transpileModule(hitNode.getText(overlayAst)+'\nexports.hit = stemHitRange;', {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
const hitModule = {exports:{}};
vm.runInNewContext(hitCode,{exports:hitModule.exports,STEM_GRAB_INSET_PX:18,STEM_DOT_RADIUS:5});
for(const direction of [1,-1]) for(const length of [5,10,17,35,90]) {
 const hit = hitModule.exports.hit({x:10,baseY:100,tipY:100+direction*length,draggable:false});
 assert.ok(hit.yMax > hit.yMin, 'a short beamed stem must retain a selection area');
 assert.ok(hit.yMin>=Math.min(100,100+direction*length)&&hit.yMax<=Math.max(100,100+direction*length));
 assert.ok(!(100>=hit.yMin&&100<=hit.yMax),'notehead keeps its individual selection area');
}
for(const direction of [1,-1]) {
 const free = hitModule.exports.hit({x:10,baseY:100,tipY:100+direction*40,draggable:true});
 const beamed = hitModule.exports.hit({x:10,baseY:100,tipY:100+direction*40,draggable:false});
 // a draggable stem is grabbed over the far half of its tip dot too; a beamed one has no dot
 assert.equal(direction>0 ? free.yMax-beamed.yMax : beamed.yMin-free.yMin, 5);
 assert.equal(direction>0 ? free.yMin-beamed.yMin : beamed.yMax-free.yMax, 0);
}
console.log('PASS actual stem hit testing keeps short up/down beamed stems selectable while clearing the notehead');

const hoverNode = overlayAst.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text==='preferredHoverTarget');
assert.ok(hoverNode, 'shared hover resolver exists');
const hoverCode = ts.transpileModule(hoverNode.getText(overlayAst)+'\nexports.hover = preferredHoverTarget;', {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
const hoverModule = {exports:{}};
vm.runInNewContext(hoverCode,{exports:hoverModule.exports});
const hover = hoverModule.exports.hover;
const note = {kind:'note',id:'note-1'}, beam = {kind:'beam',id:'beam-1'};
const handle = {kind:'beamHandle',id:'beam-1',side:'center'}, stem = {kind:'stem',id:'carrier-1'};
assert.equal(hover([note,handle,beam],target=>target.kind==='beamHandle',false),handle);
assert.equal(hover([beam,note],target=>target.kind==='note',true),note);
assert.equal(hover([note,stem],()=>false,false),stem);
assert.equal(hover([beam,stem],()=>false,true),beam);
assert.equal(hover([],()=>false,false),null);
console.log('PASS hover prioritizes selected handles/objects and resolves unselected overlap consistently');
