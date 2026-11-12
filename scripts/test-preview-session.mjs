import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const ts = require('typescript');
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
function load(file, stubs = {}, globals = {}) {
  const module = { exports: {} };
  const js = ts.transpileModule(fs.readFileSync(path.join(root, file), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const context = { module, exports: module.exports, require(name) { assert.ok(name in stubs, 'unexpected import: ' + name); return stubs[name]; }, console, AbortController, DOMException, ArrayBuffer, Uint8Array, Float32Array, ReadableStream, URL, setTimeout, clearTimeout, ...globals };
  vm.runInNewContext(js, context); globals.capture?.(context);
  return module.exports;
}
const flush = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
function worklet(outputRate = 48000, inputRate = 44100) {
  let Processor, context;
  class Base {
    port = { onmessage: null, messages: [], postMessage(message) { this.messages.push(message); } };
  }
  load('src/core/playback/pcm-output.worklet.ts', {}, { sampleRate: outputRate, currentTime: 0, AudioWorkletProcessor: Base, capture(value) { context = value; }, registerProcessor(name, ctor) { assert.equal(name, 'piano-pcm-output'); Processor = ctor; } });
  const processor = new Processor();
  const send = data => processor.port.onmessage({ data });
  send({ type: 'configure', sampleRate: inputRate, primeFrames: 1 });
  const step = () => { const output = [new Float32Array(128), new Float32Array(128)]; const running = processor.process([], [output]); context.currentTime += 128 / outputRate; return { output, running }; };
  return { processor, send, step, setTime(seconds) { context.currentTime = seconds; } };
}
for (const [inputRate, outputRate] of [[44100, 48000], [48000, 44100], [96000, 44100], [44100, 44100]]) {
  const frames = 1003;
  const samples = Float32Array.from({ length: frames * 2 }, (_, i) => Math.sin(Math.floor(i / 2) * .071) * (i % 2 ? -.4 : .4));
  function render(split) {
    const w = worklet(outputRate, inputRate);
    if (split) for (let f = 0; f < frames; f += 17) w.send({ type: 'chunk', samples: samples.slice(f * 2, Math.min(frames, f + 17) * 2) });
    else w.send({ type: 'chunk', samples });
    w.send({ type: 'end' });
    const rendered = [];
    for (let n = 0; n < 100; n++) { const result = w.step(); rendered.push(...result.output[0]); if (!result.running) break; }
    assert.equal(w.processor.port.messages.find(m=>m.type==='done').frames,frames);
    return rendered;
  }
  assert.deepEqual(render(true),render(false),`${inputRate} -> ${outputRate}: chunks must not alter waveform`);
}
const quiet=worklet();for(let i=0;i<5;i++)assert.ok(quiet.step().output[0].every(v=>v===0));
let progress=[];
const gated=worklet(48000,48000),source={onmessage:null,start(){},close(){},postMessage(m){progress.push(m)}};
gated.send({type:'source',port:source,reportControl:true});gated.send({type:'chunk',samples:new Float32Array(2048).fill(.3)});
assert.ok(gated.step().output[0].every(v=>v===0));assert.ok(gated.processor.port.messages.some(m=>m.type==='primed'));assert.equal(progress.length,0);
gated.send({type:'begin'});assert.ok(gated.step().output[0].every(v=>Math.abs(v-.3)<1e-6),'full playback must not apply a second input fade');
const live=worklet(48000,48000);live.send({type:'packet',target:1,samples:new Float32Array(8000).fill(.2)});live.step();live.send({type:'packet',target:2,samples:new Float32Array(4000).fill(.4)});live.send({type:'packet',target:1,samples:new Float32Array(1000).fill(-.8)});for(let i=0;i<5;i++)live.step();assert.ok(live.step().output[0].every(v=>v>0));
for (const rate of [44100, 48000]) {
  const outgoing = worklet(rate, rate), incoming = worklet(rate, rate);
  for (const w of [outgoing, incoming]) {
    w.send({ type: 'source', reportControl: true, port: { onmessage: null, start() {}, close() {}, postMessage() {} } });
    w.send({ type: 'chunk', samples: new Float32Array(16384).fill(0.2) });
    w.step();
  }
  const startFrame = 15 * 128, endFrame = startFrame + Math.round(rate * 0.01);
  outgoing.send({ type: 'begin', frame: 0 });
  outgoing.send({ type: 'envelope', from: 1, to: 0, startFrame, endFrame });
  incoming.send({ type: 'envelope', from: 0, to: 1, startFrame, endFrame });
  incoming.send({ type: 'begin', frame: startFrame });
  outgoing.setTime(14 * 128 / rate); incoming.setTime(14 * 128 / rate);
  for (let block = 0; block < 7; block++) {
    const a = outgoing.step().output[0], b = incoming.step().output[0];
    for (let sample = 0; sample < a.length; sample++) assert.ok(Math.abs(a[sample] + b[sample] - 0.2) < 1e-7, `${rate}: crossfade must preserve the constant signal`);
  }
}
console.log('PASS continuous resampling, frame-scheduled crossfade at 44.1/48kHz, primed handoff and stale packets');

class Player {
 sampleRate=48000; async prepare(){}async unlock(){}async connectLive(){return {close(){}};}dispose(){}
}
class Worker {
 static instances=[];sent=[];terminated=false;
 constructor(){Worker.instances.push(this);}
 postMessage(message){this.sent.push(message);if(message.type==='init')queueMicrotask(()=>this.onmessage({data:{type:'ready'}}));}
 terminate(){this.terminated=true;}
 emit(data){this.onmessage?.({data});}
}
const settings=load('src/core/playback/PlaybackSettings.ts');
const {LocalPreview}=load('src/core/playback/LocalPreview.ts',{'./PcmStreamPlayer':{PcmStreamPlayer:Player},'./Synthesis.worker?worker':{default:Worker},'./PlaybackSettings':settings},{queueMicrotask});
let calls=0;const resolveMaps=[];
const data={version:4,carrierId:'c',notes:[{sourceId:'n',pitch:60,velocity:80,durationMs:650}]};
const gateway={previewCarrier:async()=>{calls++;return data;}};
const preview=new LocalPreview(gateway);preview.bindDraft('d');await preview.prepare();let finishes=0;
await preview.preview('d','c',undefined,()=>finishes++,()=>{});const worker=Worker.instances.at(-1),first=worker.sent.at(-1);
await preview.preview('d','c',['n'],()=>finishes++,()=>{});const second=worker.sent.at(-1);
assert.equal(calls,1);assert.equal(first.map.notes[0].keyReleaseMs,650);assert.equal(second.map.notes[0].pitch,60);
worker.emit({type:'finished',sequence:first.sequence});assert.equal(finishes,0);
worker.emit({type:'finished',sequence:second.sequence});assert.equal(finishes,1);
preview.invalidate();await flush();assert.equal(calls,1,'a changed document must not fetch before a note is played');
await preview.preview('d','c',undefined,()=>finishes++,()=>{});assert.equal(calls,2);
await assert.rejects(preview.preview('d','c',['missing'],()=>{},()=>{}),/selected notes/);
preview.close();assert.equal(worker.terminated,true);
const slow=new LocalPreview({previewCarrier:()=>new Promise(resolve=>resolveMaps.push(resolve))});slow.bindDraft('d');const loading=slow.preview('d','c',undefined,()=>{},()=>{});await flush();slow.invalidate();const rejected=assert.rejects(loading,{name:'AbortError'});resolveMaps[0](data);await rejected;slow.close();
console.log('PASS preview-chord reuse, selected chord notes, stale completion and revision cancellation');

let draftReads=0,savedReads=0;
const shared=new LocalPreview({previewCarrier:async()=>{draftReads++;return data;}},
  {previewCarrierScore:async()=>{savedReads++;return {...data,version:8};}});
shared.bindSource({kind:'saved',id:'same'});await shared.prepare();
await shared.preview('same','c',['n'],()=>{},()=>{}, {speed:2,transpose:2});
let savedWorker=Worker.instances.at(-1),savedPacket=savedWorker.sent.at(-1);
assert.equal(savedReads,1);assert.equal(draftReads,0);assert.equal(savedPacket.map.version,8);
assert.equal(savedPacket.map.notes[0].pitch,62);assert.equal(savedPacket.map.notes[0].keyReleaseMs,325);
shared.bindDraft('same');await shared.prepare();await shared.preview('same','c',undefined,()=>{},()=>{});
assert.equal(draftReads,1);assert.equal(savedWorker.terminated,true,'equal raw id cannot retain saved preview when binding draft');
assert.equal(Worker.instances.at(-1).sent.at(-1).map.notes[0].pitch,60);
shared.close();
let resolveSaved;const sourceRace=new LocalPreview(gateway,{previewCarrierScore:()=>new Promise(resolve=>resolveSaved=resolve)});
sourceRace.bindSource({kind:'saved',id:'old'});
const oldPreview=sourceRace.preview('old','c',undefined,()=>{},()=>{});await flush();
const oldRejected=assert.rejects(oldPreview,{name:'AbortError'});
sourceRace.bindDraft('new');resolveSaved(data);await oldRejected;
await sourceRace.preview('new','c',undefined,()=>{},()=>{});
assert.equal(Worker.instances.at(-1).sent.at(-1).type,'preview');sourceRace.close();
console.log('PASS saved/draft preview source isolation, real server version, listening settings and obsolete saved preview cancellation');
