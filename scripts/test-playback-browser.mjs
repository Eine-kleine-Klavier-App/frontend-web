import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
if (process.argv.includes('--help')) { console.log('VITE_URL, ENGINE, PLAYWRIGHT_MODULE_PATH, PLAYWRIGHT_CHROMIUM_EXECUTABLE, PLAYWRIGHT_FIREFOX_EXECUTABLE'); process.exit(0); }
const playwright=process.env.PLAYWRIGHT_MODULE_PATH?require(process.env.PLAYWRIGHT_MODULE_PATH):await import('playwright');
const engine=process.env.ENGINE||'webkit';
const executablePath=engine==='chromium'?process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE:engine==='firefox'?process.env.PLAYWRIGHT_FIREFOX_EXECUTABLE:undefined;
const browser=await playwright[engine].launch({headless:true,...(executablePath?{executablePath}:{})});
try {
 const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/__playback_regression__',r=>r.fulfill({contentType:'text/html',body:'<button id="run">Run audio regression</button>'}));
 await page.goto(new URL('/__playback_regression__',process.env.VITE_URL||'http://localhost:5173').href);
 await page.evaluate(async forcedRate=>{
  if (forcedRate) {
   const OriginalContext = window.AudioContext;
   window.AudioContext = class extends OriginalContext { constructor(options = {}) { super({ ...options, sampleRate: forcedRate }); } };
  }
  const {PlaybackCache}=await import('/src/core/playback/PlaybackCache.ts');
  const {PcmStreamPlayer}=await import('/src/core/playback/PcmStreamPlayer.ts');
  const {ServerPlaybackController}=await import('/src/core/playback/PlaybackController.ts');
  const {LocalPreview}=await import('/src/core/playback/LocalPreview.ts');
  const check=(v,message)=>{if(!v)throw Error(message)};
  const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  const until=async(fn,message)=>{const end=performance.now()+15000;while(!fn()){if(performance.now()>end)throw Error(message);await wait(10)}};
  const map={version:1,extentMs:6000,anchors:[{carrierId:'c',startMs:0,endMs:6000}],segments:[{startBeats:0,endBeats:12,startMs:0,endMs:6000,moments:[{beats:0,timeMs:0},{beats:12,timeMs:6000}]}],pedals:[{downMs:0,upMs:5500}],notes:[{sourceId:'n',pitch:60,startMs:0,keyReleaseMs:200,endMs:5500,velocity:80}]};
  window.run=async()=>{
   const rateHashes=[];
   for(const rate of [44100,48000]){
    const cache=new PlaybackCache();const audio=await cache.open({...map,extentMs:1000,pedals:[],notes:[{...map.notes[0],keyReleaseMs:500,endMs:500}]},rate);
    const bytes=await new Response(audio.body).arrayBuffer(),samples=new Float32Array(bytes);
    check(samples.some(x=>Math.abs(x)>.001),'WASM must render nonzero PCM');check(bytes.byteLength===rate*2.5*8,'full cache must include release tail');
    const replay=await new Response((await cache.open(audio.map,rate)).body).arrayBuffer();
    const hash=async b=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',b))).map(x=>x.toString(16).padStart(2,'0')).join('');
    const fragment = await cache.open(audio.map, rate, 500.5);
    const fragmentBytes = await new Response(fragment.body).arrayBuffer();
    check(await hash(bytes.slice(fragment.startFrame * 8)) === await hash(fragmentBytes), 'nonzero fragment must match the exact original sample frames');
    check(await hash(bytes)===await hash(replay),'cached replay must preserve PCM exactly');rateHashes.push([rate,await hash(bytes)]);cache.clear();
   }
   let mapReads=0;
   const previewStub={async prepare(){},async unlock(){},close(){},release(){},bindDraft(){},invalidate(){},async preview(){}};
   const controller=new ServerPlaybackController({async map(){mapReads++;return map},async previewMap(){throw Error('not used')}},previewStub);
   controller.bindDraft('test');controller.setTotalBeats(12);const completed=controller.play();await until(()=>controller.getState().playing,'play did not start');
   const player=controller.player,context=player.context,records=[];
   const source=`class Meter extends AudioWorkletProcessor { process(inputs){const a=inputs[0]?.[0];if(a){let e=0;for(const x of a)e+=x*x;this.port.postMessage({time:currentTime,rms:Math.sqrt(e/a.length)})}return true;} } registerProcessor('local-synth-meter',Meter);`;
   const url=URL.createObjectURL(new Blob([source],{type:'text/javascript'}));await context.audioWorklet.addModule(url);URL.revokeObjectURL(url);
   const meter=new AudioWorkletNode(context,'local-synth-meter');player.gain.connect(meter);meter.connect(context.destination);meter.port.onmessage=({data})=>records.push(data);
   await wait(150);check(records.some(r=>r.rms>.0001),'output meter must hear the synthesizer');
   const blockUntil=performance.now()+300;while(performance.now()<blockUntil){}await wait(100);
   for(const beat of [7,2,8,3,6]){controller.seek(beat);await wait(20);check(controller.getState().playing,'seek must retain playing mode');}
   await until(()=>Math.abs(controller.getState().timeBeats-6)<.7,'last seek did not win');await wait(150);
   const first=records.findIndex(r=>r.rms>.0001),last=records.findLastIndex(r=>r.rms>.0001);let silence=0,maxSilence=0;
   for(const row of records.slice(first,last+1)){silence=row.rms<1e-7?silence+128/context.sampleRate:0;maxSilence=Math.max(maxSilence,silence)}
   check(maxSilence<.02,`seek/output gap ${maxSilence}s`);
   check(mapReads===1,'seek/replay must reuse the resolved plan');controller.pause();const paused=controller.getTimeMs();await wait(100);check(controller.getTimeMs()===paused,'paused clock moved');await controller.play();await until(()=>controller.getTimeMs()>paused+30,'resume did not advance');
   controller.stop();await completed;controller.bindDraft(null);meter.disconnect();
   let previewReads=0,finished=0;
   const preview=new LocalPreview({async previewMap(){previewReads++;return {version:1,carriers:[{carrierId:'c',notes:[{sourceId:'n',pitch:60,velocity:80,durationMs:650}]}]}}});
   preview.bindDraft('test');await preview.prepare();await preview.unlock();
   const analyzer=preview.player.context.createAnalyser();preview.player.gain.connect(analyzer);
   const rms=()=>{const a=new Float32Array(analyzer.fftSize);analyzer.getFloatTimeDomainData(a);return Math.sqrt(a.reduce((s,x)=>s+x*x,0)/a.length)};
   for(let i=0;i<12;i++){await preview.preview('test','c',undefined,()=>finished++,e=>{throw e});await wait(40)}
   check(rms()>.0001,'rapid same-key attacks lost their sound');preview.release();await wait(100);const tailRms=rms();check(tailRms>.00001,'release killed the existing tail');check(previewReads===1,'each click must not fetch a plan');preview.close();
   const output = new PcmStreamPlayer(0);
   await output.unlock();
   const audioContext = output.context;
   Object.defineProperty(audioContext, 'outputLatency', { get: () => 0.16 });
   audioContext.getOutputTimestamp = () => ({ contextTime: audioContext.currentTime, performanceTime: performance.now() });
   const levels = [], positions = [];
   const meterCode = `class HandoffMeter extends AudioWorkletProcessor {
     process(inputs) {
       const samples = inputs[0]?.[0];
       if (samples) this.port.postMessage({ time: currentTime, min: Math.min(...samples), max: Math.max(...samples) });
       return true;
     }
   } registerProcessor('handoff-meter', HandoffMeter);`;
   const meterUrl = URL.createObjectURL(new Blob([meterCode], { type: 'text/javascript' }));
   await audioContext.audioWorklet.addModule(meterUrl); URL.revokeObjectURL(meterUrl);
   const handoffMeter = new AudioWorkletNode(audioContext, 'handoff-meter');
   output.gain.connect(handoffMeter); handoffMeter.connect(audioContext.destination);
   handoffMeter.port.onmessage = ({ data }) => levels.push(data);
   const constantAudio = () => {
     const samples = new Float32Array(audioContext.sampleRate * 8).fill(0.1);
     return { sampleRate: audioContext.sampleRate, channels: 2, format: 'f32le', version: 1, extentMs: 4000,
       body: new ReadableStream({ start(stream) { stream.enqueue(new Uint8Array(samples.buffer)); stream.close(); } }) };
   };
   const original = new AbortController(), replacement = new AbortController();
   const ignoreAbort = error => { if (error.name !== 'AbortError') throw error; };
   const originalDone = output.play(constantAudio(), original.signal, () => {}).catch(ignoreAbort);
   await until(() => levels.some(level => level.min > 0.099) && output.positionMs() > 50, 'constant source did not become audible');
   let sampleClock = true, handoffAt;
   const samplePosition = () => {
     positions.push({ time: audioContext.currentTime, ms: output.positionMs() });
     if (sampleClock) requestAnimationFrame(samplePosition);
   };
   requestAnimationFrame(samplePosition);
   const replacementDone = output.play(constantAudio(), replacement.signal, () => {}, 2000, () => {}, false,
     () => { handoffAt = audioContext.currentTime; original.abort(); }).catch(ignoreAbort);
   await until(() => handoffAt !== undefined, 'handoff never primed');
   await wait(300); sampleClock = false;
   const transition = levels.filter(level => level.time >= handoffAt && level.time < handoffAt + 0.07);
   const transitionMin = Math.min(...transition.map(level => level.min));
   const transitionMax = Math.max(...transition.map(level => level.max));
   check(transitionMin > 0.098 && transitionMax < 0.102, `identical signals changed amplitude: ${transitionMin}..${transitionMax}`);
   check(positions.filter(row => row.time < handoffAt + 0.14).every(row => row.ms < 1000), 'cursor jumped before the new audio reached the device clock');
   check(positions.some(row => row.time > handoffAt + 0.16 && row.ms > 2000), 'cursor did not switch to the audible source');
   let active = replacement;
   const rapidDone = [], rapidAt = audioContext.currentTime;
   let maximumRetiring = 0;
   for (let i = 0; i < 100; i++) {
     const next = new AbortController(), previous = active;
     await new Promise(resolve => {
       rapidDone.push(output.play(constantAudio(), next.signal, () => {}, 0, () => {}, false,
         () => { previous.abort(); resolve(); }).catch(ignoreAbort));
     });
     active = next;
     maximumRetiring = Math.max(maximumRetiring, output.fadingOutputs.size);
     await wait(2);
   }
   const lastRapidAt = audioContext.currentTime;
   await wait(100);
   const rapidLevels = levels.filter(level => level.time >= rapidAt && level.time < lastRapidAt + 0.06);
   check(rapidLevels.every(level => level.min > 0.098 && level.max < 0.102), 'rapid handoffs caused an amplitude hole');
   check(output.fadingOutputs.size === 1, 'obsolete audio nodes survived after their fades');
   check(maximumRetiring < 12, `retiring audio nodes grew during rapid seeks: ${maximumRetiring}`);
   active.abort(); output.dispose(); await Promise.all([originalDone, replacementDone, ...rapidDone]); handoffMeter.disconnect();

   const longMap = { ...map, extentMs: 600000, pedals: [], anchors: [],
     segments: [{ startBeats: 0, endBeats: 1200, startMs: 0, endMs: 600000,
       moments: [{ beats: 0, timeMs: 0 }, { beats: 1200, timeMs: 600000 }] }],
     notes: Array.from({ length: 2400 }, (_, index) => ({ sourceId: String(index), pitch: 48 + index % 24, velocity: 80,
       startMs: index * 250, keyReleaseMs: index * 250 + 200, endMs: index * 250 + 200 })) };
   const longController = new ServerPlaybackController({ async map() { return longMap; } }, previewStub);
   longController.bindDraft('long'); longController.setTotalBeats(1200);
   await longController.cache.prepare(longController.player.sampleRate);
   let primedAt = null;
   const playOutput = longController.player.play.bind(longController.player);
   longController.player.play = (audio, signal, started, start, tick, live, ready) =>
     playOutput(audio, signal, started, start, tick, live, () => { primedAt = performance.now(); ready(); });
   let requestedAt = performance.now();
   const longPlaying = longController.play();
   await until(() => primedAt !== null, 'prepared Play did not prime');
   const preparedPlayMs = primedAt - requestedAt;
   check(preparedPlayMs < 150, `prepared Play took ${preparedPlayMs}ms`);
   await until(() => longController.getState().playing && longController.cache.entry.complete, 'long cache did not complete');
   const seekMs = [];
   for (const beat of [2, 600, 1100, 2]) {
     primedAt = null; requestedAt = performance.now(); longController.seek(beat);
     await until(() => primedAt !== null, 'cached seek did not prime');
     seekMs.push(primedAt - requestedAt);
     check(seekMs.at(-1) < 150, `cached seek at beat ${beat} took ${seekMs.at(-1)}ms`);
     await until(() => longController.getState().seekBeats === null, 'audible seek never completed');
   }
   longController.stop(); await longPlaying; longController.bindDraft(null);
   return {rateHashes,mapReads,previewReads,maxSilenceMs:maxSilence*1000,tailRms,
     transitionMin,transitionMax,maximumRetiring,preparedPlayMs,seekMs};
  };
  document.querySelector('#run').onclick=()=>run().then(result=>window.result=result,error=>window.result={error:error.message,stack:error.stack});
 }, Number(process.env.AUDIO_RATE || 0));
 await page.click('#run');await page.waitForFunction(()=>window.result,{},{timeout:60000});
 const result=await page.evaluate(()=>window.result);assert.equal(result.error,undefined,JSON.stringify(result));assert.deepEqual(errors,[]);
 console.log(`PASS ${engine}: ${JSON.stringify(result)}`);
} finally {await browser.close()}
