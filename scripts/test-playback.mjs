import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url), ts = require('typescript');
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
// The controller writes the playing time to its state every 50 ms; the test moves this clock between ticks.
let fakeNow = 0;
function load(file, stubs = {}, cache = new Map()) {
  const full = path.join(root, file);
  if (cache.has(full)) return cache.get(full).exports;
  const module = { exports: {} }; cache.set(full, module);
  const js = ts.transpileModule(fs.readFileSync(full, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(js, { module, exports: module.exports, console, AbortController, DOMException, ReadableStream, Response, Uint8Array, Float32Array, DataView, setTimeout, clearTimeout, performance: { now: () => fakeNow },
    require(name) {
      if (name in stubs) return stubs[name];
      if (name.startsWith('@/')) return load('src/' + name.slice(2) + '.ts', stubs, cache);
      if (name.startsWith('.')) return load(path.relative(root, path.resolve(path.dirname(full), name + '.ts')), stubs, cache);
      throw new Error('Unexpected import: ' + name);
    },
  }, { filename: full });
  return module.exports;
}
const flush = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
const fraction = (numerator, denominator = 1) => ({ numerator, denominator });
const plain = () => ({ id: 'd', title: '', staffOrder: ['s'], voices: [{ id: 'v', index: 0 }], measures: [0, 1].map(n => ({ id: 'm' + n, timeSignature: { beats: 4, beatValue: 4 }, voices: [{ id: 'v', items: [] }] })), contexts: [], beams: [], ties: [], glissandos: [], tuplets: [], stemOverrides: {} });
const { insertionPosition } = load('src/features/editor/insertionPosition.ts');
const doc = plain();
doc.voices.push({ id: 'other', index: 1 });
doc.insertionSpaces = [
  { id: 'outer', parentId: null, voiceId: 'v', start: fraction(0), extent: fraction(3, 8), scale: fraction(2, 3) },
  { id: 'inner', parentId: 'outer', voiceId: 'v', start: fraction(1, 12), extent: fraction(3, 16), scale: fraction(4, 9) },
];
doc.measures[0].voices[0].items = [{ positionFraction: fraction(1, 24) }, { positionFraction: fraction(1, 9) }];
let result = insertionPosition(doc, 'm0', 'v', 4 / 9);
assert.equal(result.position.numerator, 1); assert.equal(result.position.denominator, 9);
result = insertionPosition(doc, 'm0', 'v', 1 / 6);
assert.equal(result.position.numerator, 1); assert.equal(result.position.denominator, 24);
result = insertionPosition(doc, 'm0', 'other', .34);
assert.equal(result.position.numerator, 0);
assert.equal(result.position.denominator, 1);
assert.equal(insertionPosition(doc, 'm0', 'v', 1).beat, 4 / 9);
doc.insertionSpaces = [{ id: 'cross', parentId: null, voiceId: 'v', start: fraction(3, 4), extent: fraction(3, 2), scale: fraction(2, 3) }];
result = insertionPosition(doc, 'm1', 'v', 1 / 3);
assert.equal(result.position.numerator, 0); assert.equal(result.position.denominator, 1);
console.log('PASS exact existing onsets, voice isolation and measure starts');
const map = { version: 4, extentMs: 1500, pedals: [],
  notes: [{ sourceId: 'n', pitch: 60, startMs: 0, keyReleaseMs: 500, endMs: 500, velocity: 80 }],
  anchors: [{ carrierId: 'a', startMs: 0, endMs: 500 }, { carrierId: 'b', startMs: 500, endMs: 1500 }],
  segments: [{ startBeats: 0, endBeats: 2, startMs: 0, endMs: 1500, moments: [{ beats: 0, timeMs: 0 }, { beats: 1, timeMs: 500 }, { beats: 2, timeMs: 1500 }] }],
};
const { SynthScheduler } = load('src/core/playback/SynthScheduler.ts');
class Engine {
  sampleRate = 1000; frame = 0; events = [];
  noteOn(channel, pitch, velocity) { this.events.push(['on',this.frame,channel,pitch,velocity]); }
  noteOff(channel, pitch) { this.events.push(['off',this.frame,channel,pitch]); }
  sustain(down) { this.events.push(['pedal',this.frame,down]); }
  render(frames) { assert.ok(frames > 0); this.frame += frames; return new Float32Array(frames*2); }
}
const e = new Engine(), schedule = new SynthScheduler(e);
schedule.replace({ ...map, extentMs: 1000, pedals: [{downMs:0,upMs:800}], notes: [
  {...map.notes[0],keyReleaseMs:150,endMs:800},
  {...map.notes[0],startMs:200,keyReleaseMs:350,endMs:800},
] });
while (schedule.remaining) schedule.render(37);
assert.equal(e.frame,2500);
assert.deepEqual(e.events.filter(x=>x[0]==='on').map(x=>x.slice(1,4)),[[0,0,60],[200,1,60]]);
assert.deepEqual(e.events.filter(x=>x[0]==='off').map(x=>x.slice(1,3)),[[150,0],[350,1]]);
assert.ok(e.events.some(x=>x[0]==='pedal'&&x[1]===800&&x[2]===false));
const live = new Engine(), repeated = new SynthScheduler(live);
repeated.replace(map); repeated.render(100); repeated.replace(map); repeated.render(100);
assert.deepEqual(live.events.filter(x=>x[0]==='on').map(x=>x[2]),[0,1]);
assert.ok(live.events.some(x=>x[0]==='off'&&x[1]===100&&x[2]===0));
const boundary = new Engine(), ordered = new SynthScheduler(boundary);
ordered.replace({...map,pedals:[{downMs:500,upMs:1000}]}); ordered.render(600);
assert.ok(boundary.events.findIndex(x=>x[0]==='off'&&x[1]===500)<boundary.events.findIndex(x=>x[0]==='pedal'&&x[1]===500&&x[2]));
console.log('PASS frame-exact key release, pedal boundaries and overlapping same-pitch voices');

const { renderStartFrame, CHUNK_FRAMES } = load('src/core/playback/SynthScheduler.ts');
const longMap = { ...map, extentMs: 40000, pedals: [{ downMs: 500, upMs: 20000 }], notes: [
  { sourceId: 'held', pitch: 60, startMs: 1000, keyReleaseMs: 3000, endMs: 20000, velocity: 80 },
  { sourceId: 'late', pitch: 62, startMs: 30000, keyReleaseMs: 31000, endMs: 31500, velocity: 80 },
] };
assert.equal(CHUNK_FRAMES, 4096);
assert.equal(renderStartFrame(longMap, 30000, 1000), 24576, 'a target after everything has faded starts three seconds early, on a chunk');
assert.equal(renderStartFrame(longMap, 25000, 1000), 0, 'a note that still sounds at the target is played from its start');
assert.equal(renderStartFrame(longMap, 0, 1000), 0);
class Silent extends Engine { silences = 0; silence() { this.silences++; this.events.push(['silence', this.frame]); } }
const cut = new Silent(), startScheduler = new SynthScheduler(cut);
startScheduler.replaceFrom(longMap, 24576);
assert.equal(cut.frame, 0, 'the first start renders no silence');
while (startScheduler.remaining) startScheduler.render(512);
assert.deepEqual(cut.events.filter(x => x[0] === 'on').map(x => x[1]), [30000 - 24576], 'only notes that begin after the start are played, at their distance from it');
assert.ok(!cut.events.some(x => x[0] === 'pedal' && x[2] === true), 'a pedal that ended before the start is not played');
cut.events.length = 0;
const before = cut.frame;
startScheduler.replaceFrom({ ...longMap, pedals: [{ downMs: 20000, upMs: 35000 }] }, 24576);
assert.equal(cut.silences, 2, 'every start cuts the sounding voices');
assert.equal(cut.frame - before, 4000, 'a later start first renders four seconds of silence');
cut.events.length = 0;
startScheduler.render(4096);
const down = cut.events.find(x => x[0] === 'pedal' && x[2] === true);
assert.ok(down, 'a pedal that is down at the start is down from the first frame');
while (startScheduler.remaining) startScheduler.render(1024);
assert.ok(cut.events.some(x => x[0] === 'pedal' && x[2] === false), 'and comes up when it did');
console.log('PASS windowed synthesis start: audible-note search, chunk alignment, notes and pedal from the start, silence between starts');

class Worker {
  static instances=[]; sent=[]; terminated=false;
  constructor(){Worker.instances.push(this);}
  postMessage(message){this.sent.push(message);if(message.type==='init')queueMicrotask(()=>this.emit({type:'ready'}));}
  emit(data){this.onmessage?.({data});}
  terminate(){this.terminated=true;}
}
const { PlaybackCache }=load('src/core/playback/PlaybackCache.ts',{'./Synthesis.worker?worker':{default:Worker}});
const cache=new PlaybackCache(), audio=await cache.open(map,48000), worker=Worker.instances.at(-1);
await flush();
const renders=()=>worker.sent.filter(x=>x.type==='render');
assert.equal(renders().length,1);assert.equal(renders()[0].targetFrame,0);assert.equal(renders()[0].token,1);
const aheadChunks=Math.ceil(40*48000/4096);
assert.equal(renders()[0].untilChunk,aheadChunks,'the render is asked for the window ahead only');
worker.emit({type:'started',token:1,firstChunk:0});
const a=audio.body.getReader(), b=(await cache.open(map,48000)).body.getReader();
assert.equal(renders().length,1,'a second open at the same place carries on the same render');
const first=a.read(), second=b.read();
const samples=Float32Array.from([.1,-.1,.2,-.2]);worker.emit({type:'chunk',token:1,index:0,samples});
assert.deepEqual(Array.from((await first).value),Array.from((await second).value));
let prepared=false;const seekAbort=new AbortController();
const waiting=cache.prepareAt(1400,seekAbort.signal).then(()=>prepared=true);
await flush();assert.equal(prepared,false,'a seek waits for the chunk after the prime buffer');
worker.emit({type:'done',token:1,endChunk:25});await waiting;assert.equal(prepared,true,'a seek target at the end of the piece does not wait for more');
await a.cancel();await b.cancel();
assert.equal(Worker.instances.length,1);
// A target far ahead of the render starts a new render there instead of rendering the gap; the old reader ends, the new one follows.
const windowed=new PlaybackCache(), start=await windowed.open(map,48000), windowWorker=Worker.instances.at(-1);
await flush();windowWorker.emit({type:'started',token:1,firstChunk:0});
const oldReader=start.body.getReader();
const farMs=100000, farChunk=Math.floor(Math.round(farMs*48000/1000)/4096);
const far=await windowed.open(map,48000,farMs);
const farRenders=windowWorker.sent.filter(x=>x.type==='render');
assert.equal(farRenders.length,2,'a far seek restarts the render');assert.equal(farRenders[1].token,2);assert.equal(farRenders[1].targetFrame,farChunk*4096);
windowWorker.emit({type:'started',token:2,firstChunk:farChunk-100});
const farReader=far.body.getReader(), farRead=farReader.read();
const farData=Float32Array.from({length:4096*2},(_,i)=>i);
windowWorker.emit({type:'chunk',token:2,index:farChunk,samples:farData});
assert.deepEqual(Array.from((await farRead).value),Array.from(new Uint8Array(farData.buffer)).slice(Math.round(farMs*48000/1000)%4096*8),'the stream starts inside the chunk at the target frame');
assert.equal((await oldReader.read()).done,true,'the reader of the replaced render ends instead of waiting forever');
assert.ok(windowWorker.sent.some(x=>x.type==='extend'&&x.token===2&&x.untilChunk>farChunk+aheadChunks),'reading moves the render limit ahead');
for(let index=farChunk-100;index<farChunk+1100;index++)windowWorker.emit({type:'chunk',token:2,index,samples:Float32Array.from([index,index])});
assert.ok(windowed.entry.chunks.size<=Math.ceil(20*48000/4096)+aheadChunks+4+1,`the window is bounded (${windowed.entry.chunks.size} chunks)`);
await farReader.cancel();windowed.clear();
cache.clear();await cache.open(map,48000);const obsolete=Worker.instances.at(-1);
const blocked=(await cache.open(map,48000)).body.getReader().read();const rejected=assert.rejects(blocked,{name:'AbortError'});cache.clear();await rejected;assert.equal(obsolete.terminated,true);
await cache.open(map,48000);const broken=Worker.instances.at(-1);broken.emit({type:'failed',message:'instrument unavailable'});await cache.open(map,48000);assert.notEqual(Worker.instances.at(-1),broken);cache.clear();
const indexed = new PlaybackCache(); await indexed.prepare(1000); const preparedWorker=Worker.instances.at(-1);
await indexed.open(map,1000); await flush(); assert.equal(Worker.instances.at(-1),preparedWorker,'open must reuse the warmed synth');
preparedWorker.emit({type:'started',token:1,firstChunk:0});
const chunk=Float32Array.from({length:4096*2},(_,i)=>i);preparedWorker.emit({type:'chunk',token:1,index:0,samples:chunk});preparedWorker.emit({type:'chunk',token:1,index:1,samples:chunk.map(x=>x+8192)});preparedWorker.emit({type:'done',token:1,endChunk:2});
const fragment=await indexed.open(map,1000,4100);assert.equal(fragment.startFrame,4100);const fragmentSamples=new Float32Array(await new Response(fragment.body).arrayBuffer());assert.equal(fragmentSamples[0],8200);assert.equal(fragmentSamples.length,(8192-4100)*2);indexed.clear();
console.log('PASS windowed audio cache: render on demand, far seek restart, bounded window, warmed engine reuse, prepared seek, cancellation and retry');

let player;
class Player {
  sampleRate=48000; calls=[]; clock=0;
  constructor(){player=this;}
  async prepare(){} async unlock(){if(this.unlockGate)await this.unlockGate;} async pause(){} async resume(){} stop(){} dispose(){}
  positionMs(){return this.clock;}
  async play(audio,signal,started,start,tick,live,ready){
    const call={signal,start,tick:(ms)=>{fakeNow+=100;tick(ms);},ready:()=>{ready();this.clock=start;started();}};this.calls.push(call);
    await new Promise((resolve,reject)=>{call.fail=reject;signal.addEventListener('abort',resolve,{once:true});});
  }
}
class Cache {
  static latest; gate=null;
  constructor(){Cache.latest=this;}
  clear(){}
  async prepare(){}
  async open(plan,rate){return {map:plan,body:new ReadableStream({start(c){c.close();}}),sampleRate:rate,format:'f32le',channels:2,extentMs:plan.extentMs};}
  async prepareAt(){if(this.gate)await this.gate;}
}
class Preview { releases=0;invalidations=0; async prepare(){} async unlock(){} release(){this.releases++;}close(){}bindSource(source){this.source=source;}invalidate(){this.invalidations++;}async preview(d,c,n,finish,error,settings){this.finish=finish;this.settings=settings;} }
class AuthRequiredError extends Error {}
const { ServerPlaybackController,timeAtBeat,beatAtTime }=load('src/core/playback/PlaybackController.ts',{
  react:{useSyncExternalStore(){}},'@/core/auth/authorizedFetch':{AuthRequiredError},'@/core/auth/authPrompt':{useAuthPrompt:{getState:()=>({open(){}})}},
  './HttpPlaybackGateway':{HttpPlaybackGateway:class {}},'./PcmStreamPlayer':{PcmStreamPlayer:Player},'./PlaybackCache':{PlaybackCache:Cache},'./LocalPreview':{LocalPreview:Preview},
});
const preview=new Preview(),controller=new ServerPlaybackController({map:async()=>map},preview);
controller.bindDraft('d');controller.setTotalBeats(2);const started=controller.play();await flush();
const firstCall=player.calls[0];firstCall.ready();assert.equal(controller.getState().playing,true);
firstCall.tick(250);assert.equal(controller.getState().timeBeats,.5);
let releaseSeek;Cache.latest.gate=new Promise(resolve=>releaseSeek=resolve);
controller.seek(1.5);await flush();assert.equal(firstCall.signal.aborted,false);assert.equal(controller.getState().playing,true);
firstCall.tick(400);assert.equal(controller.getState().seekBeats,1.5,'slider retains the requested target');assert.equal(controller.getState().timeBeats,.8,'score line follows the old sound until the handoff');
releaseSeek();await flush();const replacement=player.calls.at(-1);assert.equal(firstCall.signal.aborted,false,'old source waits for output priming');
replacement.ready();replacement.tick(1000);await flush();assert.equal(firstCall.signal.aborted,true);assert.equal(controller.getState().playing,true);assert.equal(replacement.start,1000);
firstCall.tick(50);assert.equal(controller.getState().timeBeats,1.5,'late old ticks cannot rewind new source');
controller.pause();await flush();replacement.tick(1200);assert.equal(controller.getState().paused,true);
let resumeReady;player.unlockGate=new Promise(resolve=>resumeReady=resolve);
const resuming=controller.play();assert.equal(controller.getState().paused,true);
controller.seek(1);await flush();assert.equal(replacement.signal.aborted,false,'resume+seek must keep the old source until context readiness');
resumeReady();await resuming;await flush();const rapidResumeSeek=player.calls.at(-1);rapidResumeSeek.ready();assert.equal(replacement.signal.aborted,true);
controller.stop();await started;assert.equal(replacement.signal.aborted,true);
const failurePlayback=controller.play();await flush();const healthy=player.calls.at(-1);healthy.ready();
controller.seek(1);await flush();player.calls.at(-1).fail(new Error('candidate output failed'));await flush();
assert.equal(controller.getState().playing,true,'a failed candidate must preserve the old output');assert.equal(healthy.signal.aborted,false);
controller.seek(1);await flush();const failedActive=player.calls.at(-1);failedActive.ready();failedActive.fail(new Error('active output failed'));await flush();
assert.equal(controller.getState().playing,false,'a failed active output must not leave a playing ghost');assert.ok(controller.getState().error);await failurePlayback;controller.stop();
await controller.previewCarrier('a','d');const obsoleteFinish=preview.finish;controller.documentChanged();obsoleteFinish();assert.equal(controller.getState().previewing,false);assert.equal(preview.invalidations,1);
assert.equal(timeAtBeat(map,1.5),1000);assert.equal(beatAtTime(map,1000),1.5);
console.log('PASS uninterrupted seek handoff, stale tick isolation, pause/resume and document invalidation');

const buffered = new ServerPlaybackController({ map: async () => map }, new Preview());
buffered.bindDraft('buffered');
buffered.setTotalBeats(2);
const readyFrames = new Set();
const frameRequests = [];
const detachFrameBuffer = buffered.setFrameBuffer({
  active: () => true,
  prepare(_, time, signal) {
    if (readyFrames.has(time)) return;
    return new Promise(resolve => {
      frameRequests.push({ time, signal, ready() { readyFrames.add(time); resolve(); } });
      signal.addEventListener('abort', resolve, { once: true });
    });
  },
});
const bufferedStart = buffered.play();
await flush();
assert.equal(buffered.getState().loading, true);
assert.equal(player.calls.length, 0, 'cold play waits for visuals before handing audio to the player');
assert.equal(frameRequests[0].time, 0);
frameRequests[0].ready();
await flush();
const outgoing = player.calls[0];
outgoing.ready();
player.clock = 240;
outgoing.tick(240);
buffered.seek(1.5);
await flush();
const cancelled = frameRequests.at(-1);
assert.equal(cancelled.time, 1000);
assert.equal(outgoing.signal.aborted, true, 'a cold seek stops the previous audio');
assert.equal(buffered.getTimeMs(), 240, 'the visible clock holds its previous position');
assert.equal(buffered.getState().seekBeats, 1.5);
assert.equal(buffered.getState().loading, true);
assert.equal(player.calls.length, 1, 'no replacement audio before frame readiness');
buffered.seek(1);
await flush();
const latest = frameRequests.at(-1);
assert.equal(cancelled.signal.aborted, true, 'a newer seek cancels old frame preparation');
assert.equal(buffered.getState().seekBeats, 1);
assert.equal(buffered.getTimeMs(), 240);
cancelled.ready();
await flush();
assert.equal(player.calls.length, 1, 'a late frame window cannot start superseded audio');
latest.ready();
await flush();
const incoming = player.calls.at(-1);
assert.equal(incoming.start, timeAtBeat(map, 1));
incoming.ready();
assert.equal(buffered.getState().loading, false);
assert.equal(buffered.getState().seekBeats, null);
buffered.seek(1.5);
await flush();
assert.equal(incoming.signal.aborted, false, 'an already buffered seek keeps the smooth handoff');
player.calls.at(-1).ready();
await flush();
assert.equal(incoming.signal.aborted, true);
buffered.seek(0.25);
await flush();
const stopped = frameRequests.at(-1);
buffered.stop();
await bufferedStart;
assert.equal(stopped.signal.aborted, true, 'stop cancels buffering');
const stoppedOutputs = player.calls.length;
stopped.ready();
await flush();
assert.equal(player.calls.length, stoppedOutputs);
assert.equal(buffered.getState().loading, false);
const ending = buffered.play();
await flush();
player.calls.at(-1).ready();
readyFrames.delete(timeAtBeat(map, 1));
buffered.seek(1);
await flush();
assert.equal(buffered.getState().loading, true);
const beforeEnd = frameRequests.at(-1);
buffered.seek(2);
await flush();
await ending;
assert.equal(beforeEnd.signal.aborted, true);
assert.equal(buffered.getTimeMs(), map.extentMs, 'seeking to the end clears a pending hold at the requested endpoint');
assert.equal(buffered.getState().timeBeats, 2);
assert.equal(buffered.getState().loading, false);
detachFrameBuffer();
console.log('PASS cold play and seek preparation, frozen clock, latest-seek wins, hot handoff and stop');

let payload={version:4,extent_ms:1500,notes:[{source_id:'n',pitch:60,start_ms:0,key_release_ms:200,end_ms:900,velocity:80}],pedals:[{down_ms:0,up_ms:900}],anchors:[],segments:[]};
const requests=[];
const fetcher=async(url,options)=>{requests.push(url);return new Response(JSON.stringify(payload),{headers:{'content-type':'application/json'}})};
const {HttpPlaybackGateway}=load('src/core/playback/HttpPlaybackGateway.ts',{'@/core/auth/authorizedFetch':{authorizedFetch:fetcher,optionalAuthFetch:fetcher},'@/core/gateway/apiBase':{API_BASE:'/api'}});
const http=new HttpPlaybackGateway(),signal=new AbortController().signal;
const parsed=await http.mapScore('s',signal);assert.equal(parsed.notes[0].keyReleaseMs,200);assert.equal(parsed.pedals[0].upMs,900);assert.ok(requests.includes('/api/scores/s/playback/map'));
payload.notes[0].key_release_ms=901;await assert.rejects(http.mapScore('s',signal),/Invalid playback note/);
payload={version:4,carrier_id:'c',notes:[{source_id:'n',pitch:60,velocity:80,duration_ms:650}]};
const savedChord=await http.previewCarrierScore('saved/a','c',signal);assert.equal(savedChord.notes[0].durationMs,650);assert.equal(savedChord.notes[0].pitch,60);
assert.ok(requests.includes('/api/scores/saved%2Fa/playback/preview/carriers/c'));
console.log('PASS JSON-only gateways, physical release vs sustain and invalid metadata rejection');

// Equal raw ids still name distinct resources; saved reading never asks for a draft plan.
let draftMaps=0,savedMaps=0;
const savedPreview=new Preview();
const reader=new ServerPlaybackController({map:async()=>{draftMaps++;return map;}},savedPreview,
  {mapScore:async()=>{savedMaps++;return map;}});
reader.bindScore('same');reader.setTotalBeats(2);await reader.prepareMap();
assert.equal(savedMaps,1);assert.equal(draftMaps,0);
const savedRun=reader.play();await flush();const savedOutput=player.calls.at(-1);savedOutput.ready();savedOutput.tick(500);
assert.equal(reader.getState().timeBeats,1);reader.pause();await flush();assert.equal(reader.getState().paused,true);
await reader.play();assert.equal(reader.getState().playing,true);
assert.equal(savedPreview.source.kind,'saved');
reader.pause();await reader.previewCarrier('a','same');assert.equal(typeof savedPreview.finish,'function','saved selection uses the same short preview');
assert.equal(draftMaps,0);assert.equal(savedPreview.settings.transpose,0);savedPreview.finish();assert.equal(reader.getState().previewing,false);
reader.stop();await savedRun;reader.bindDraft('same');await reader.prepareMap();
assert.equal(draftMaps,1);assert.equal(savedMaps,1);
let staleMap;const staleReader=new ServerPlaybackController({map:async()=>map},new Preview(),{mapScore:()=>new Promise(resolve=>staleMap=resolve)});
staleReader.bindScore('old');const stalePreparation=staleReader.prepareMap();staleReader.bindDraft('new');staleMap({...map,version:99});await stalePreparation;
assert.equal(staleReader.getState().map,null,'late saved map cannot overwrite new draft');reader.bindDraft(null);staleReader.bindDraft(null);
console.log('PASS saved reading transport, pause/resume, source-kind isolation and stale map cancellation');

const { withPlaybackSettings, validateTransposition }=load('src/core/playback/PlaybackSettings.ts');
const originalPlan={...map,pedals:[{downMs:100,upMs:1200}]},originalSnapshot=JSON.stringify(originalPlan);
const configured=withPlaybackSettings(originalPlan,{speed:2,transpose:2});
assert.equal(configured.notes[0].pitch,62);assert.equal(configured.notes[0].keyReleaseMs,250);
assert.equal(configured.extentMs,750);assert.equal(configured.pedals[0].upMs,600);
assert.equal(configured.anchors[1].startMs,250);assert.equal(configured.segments[0].moments[2].timeMs,750);
assert.equal(configured.segments[0].moments[2].beats,2);assert.equal(JSON.stringify(originalPlan),originalSnapshot);
assert.equal(withPlaybackSettings(map,{speed:1,transpose:0}),map,'default settings reuse the original recording key');
const piano={min:21,max:108},edges={...map,notes:[{...map.notes[0],pitch:21},{...map.notes[0],pitch:108}]};
validateTransposition(edges,0,piano);
for(const offset of [-1,1])assert.throws(()=>validateTransposition(edges,offset,piano),/at least one note/);
for(const speed of [0,0.49,2.01,NaN])assert.throws(()=>withPlaybackSettings(map,{speed,transpose:0}),{name:'RangeError'});
assert.throws(()=>withPlaybackSettings(map,{speed:1,transpose:.5}),{name:'RangeError'});
const listening=new ServerPlaybackController({map:async()=>map},new Preview(),{mapScore:async()=>map});
listening.bindScore('listening');listening.setTotalBeats(2);await listening.prepareMap();
const runListening=listening.play();await flush();let output=player.calls.at(-1);output.ready();player.clock=500;output.tick(500);
listening.setListeningSettings({speed:2,transpose:2},piano);assert.equal(output.signal.aborted,true);await flush();
output=player.calls.at(-1);assert.equal(output.start,250,'speed replacement preserves musical place');output.ready();
assert.equal(listening.getState().map.notes[0].pitch,62);assert.equal(listening.getState().timeBeats,1);
player.clock=500;output.tick(500);listening.pause();await flush();
listening.setListeningSettings({speed:.5,transpose:-2},piano);assert.equal(listening.getState().paused,true);
assert.equal(listening.getState().timeBeats,1.5);const resumedListening=listening.play();await flush();
output=player.calls.at(-1);assert.equal(output.start,2000,'resume after paused configuration starts from the retained beat');output.ready();
assert.equal(listening.getState().playing,true);listening.stop();await runListening;await resumedListening;
listening.bindDraft('editing');assert.equal(listening.getState().listening.speed,1);assert.equal(listening.getState().listening.transpose,0);listening.bindDraft(null);
const strict=new ServerPlaybackController({map:async()=>map},new Preview(),{mapScore:async()=>edges});
strict.bindScore('edges');strict.setTotalBeats(2);await strict.prepareMap();const strictRun=strict.play();await flush();
const strictOutput=player.calls.at(-1);strictOutput.ready();const priorMap=strict.getState().map;
assert.throws(()=>strict.setListeningSettings({speed:1.5,transpose:1},piano),/at least one note/);
assert.equal(strict.getState().map,priorMap);assert.equal(strict.getState().listening.speed,1);assert.equal(strict.getState().listening.transpose,0);
assert.equal(strictOutput.signal.aborted,false,'reject entire invalid setting before cancelling sound');assert.equal(strict.getState().playing,true);
strict.stop();await strictRun;strict.bindDraft(null);
console.log('PASS non-mutating speed/pitch plan, pedal/anchor timing, strict whole-score A0–C8 rejection, live musical-position preservation, paused reconfiguration and editor reset');
