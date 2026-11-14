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
 await page.route('**/__playback_regression__',r=>r.fulfill({contentType:'text/html',body:
   '<button id="run">Run audio regression</button><button id="prepared-play" hidden>Play prepared recording</button>'}));
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
   // A held note and its release end without a step: the voice filter follows the modulation envelope continuously.
   const {FluidSynthEngine}=await import('/src/core/playback/FluidSynthEngine.ts');
   const synth=new FluidSynthEngine(48000);await synth.prepare();
   for(const pitch of [47,61,66]){
    synth.noteOn(0,pitch,86);const parts=[synth.render(48000*5)];synth.noteOff(0,pitch);parts.push(synth.render(48000));
    const left=parts.flatMap(p=>Array.from({length:p.length/2},(_,i)=>p[2*i]));
    const peaks=[];for(let i=2;i<left.length;i++){const block=i>>6;peaks[block]=Math.max(peaks[block]??0,Math.abs(left[i]-2*left[i-1]+left[i-2]))}
    for(let block=78;block<peaks.length;block++){const local=peaks.slice(block-48,block-2).sort((a,b)=>a-b)[23];check(peaks[block]<6*Math.max(local,2e-5),`note ${pitch} steps at ${(block*64/48000).toFixed(2)} s`)}
    synth.silence();
   }
   synth.close();
   let mapReads=0;
   const previewStub={async prepare(){},async unlock(){},close(){},release(){},bindDraft(){},invalidate(){},async preview(){}};
   const controller=new ServerPlaybackController({async map(){mapReads++;return map},async previewCarrier(){throw Error('not used')}},previewStub);
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
   check(mapReads===1,'seek/replay must reuse the resolved plan');
   controller.pause();
   check(controller.getState().playing,'Pause was published before the audible boundary');
   await until(()=>controller.getState().paused,'Pause never reached the audible boundary');
   const paused=controller.getTimeMs();
   const silenceFrom=context.currentTime;
   await wait(100);
   const held=records.filter(row=>row.time>=silenceFrom);
   check(held.length>0&&held.every(row=>row.rms<1e-7),'the output produced sound after the acknowledged Pause');
   check(controller.getTimeMs()===paused&&context.state==='running','Pause did not hold the PCM position in a running graph');
   const resume=controller.play();
   const afterResume=[];const watch=frameTime=>{afterResume.push([frameTime,controller.getTimeMs()]);if(afterResume.length<30)requestAnimationFrame(watch)};requestAnimationFrame(watch);
   check(controller.getState().paused,'Resume was published before the audible boundary');
   await resume;
   await until(()=>controller.getTimeMs()>paused+30,'resume did not advance');
   // After Resume the picture waits for the sound and then runs evenly: no step back, no change of speed.
   await until(()=>afterResume.length>=30,'the frames after Resume were not recorded');
   const resumeSteps=afterResume.slice(1).map((row,index)=>[row[0]-afterResume[index][0],row[1]-afterResume[index][1]]);
   check(resumeSteps.every(([,moved])=>moved>=0),'the picture ran backwards after Resume');
   check(resumeSteps.filter(([,moved])=>moved>0).slice(1).every(([elapsed,moved])=>Math.abs(moved/elapsed-1)<=.15),
     `the picture changed speed after Resume (${resumeSteps.map(([elapsed,moved])=>(moved/elapsed).toFixed(2)).join(' ')})`);
   // Stop fades the sound out over its whole ramp instead of cutting it, even when the fade message arrives late.
   const post=MessagePort.prototype.postMessage;
   MessagePort.prototype.postMessage=function(data,...rest){if(data?.type==='envelope')setTimeout(()=>post.call(this,data,...rest),30);else post.call(this,data,...rest)};
   const stopAt=context.currentTime;controller.stop();await completed;await wait(100);MessagePort.prototype.postMessage=post;
   const beforeStop=records.filter(row=>row.time<stopAt&&row.time>=stopAt-.05).map(row=>row.rms).sort((a,b)=>a-b);
   const stopLevel=beforeStop[beforeStop.length>>1]??0;check(stopLevel>.0001,'the output was silent before Stop');
   // A released output stops sending blocks, which counts as silence.
   const afterStop=records.filter(row=>row.time>=stopAt);const silent=afterStop.findIndex(row=>row.rms<1e-7);
   const silentAt=silent<0?afterStop.length:silent;
   const fading=afterStop.slice(0,silentAt).filter(row=>row.rms<.9*stopLevel&&row.rms>.05*stopLevel).length;
   check(fading*128/context.sampleRate>=.008,`Stop cut the sound: ${fading} fading blocks (${afterStop.slice(0,silentAt+1).map(row=>(row.rms/stopLevel).toFixed(2)).join(' ')})`);
   controller.bindDraft(null);meter.disconnect();
   let previewReads=0,finished=0;
   const preview=new LocalPreview({async previewCarrier(){previewReads++;return {version:1,carrierId:'c',notes:[{sourceId:'n',pitch:60,velocity:80,durationMs:650}]}}});
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
     last = 0;
     process(inputs) {
       const samples = inputs[0]?.[0];
       if (samples) {
         let step = 0;
         for (const sample of samples) { step = Math.max(step, Math.abs(sample - this.last)); this.last = sample; }
         this.port.postMessage({ time: currentTime, min: Math.min(...samples), max: Math.max(...samples), step });
       }
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
   const pauseRequested = audioContext.currentTime;
   const pausePosition = await output.pause();
   const heldClock = output.clock.anchors.at(-1);
   check(!heldClock.advancing && Math.abs(pausePosition - heldClock.frames / audioContext.sampleRate * 1000) < 0.05,
     'Pause did not settle at its PCM source frame');
   check(audioContext.currentTime - heldClock.contextTime >= 0.159, 'Pause settled before the delayed output device heard silence');
   await wait(70);
   check(output.positionMs() === pausePosition && output.clock.anchors.at(-1).frames === heldClock.frames,
     'the paused worklet discarded queued PCM');
   check(levels.filter(row => row.time > heldClock.contextTime + 0.01).every(row => row.min === 0 && row.max === 0),
     'the master output was not silent while held');
   const resumed = await output.resume();
   const resumeClock = output.clock.anchors.find(row => row.contextTime > heldClock.contextTime && row.advancing);
   check(resumeClock && resumeClock.frames === heldClock.frames, 'Resume skipped or repeated a source frame');
   check(resumed >= pausePosition && audioContext.currentTime - resumeClock.contextTime >= 0.159,
     'Resume settled before delayed audio reached the device');
   await wait(40);
   const maximumPauseStep = Math.max(...levels.filter(row => row.time >= pauseRequested).map(row => row.step));
   check(maximumPauseStep < 0.003, `transport introduced a discontinuity of ${maximumPauseStep}`);
   const superseded = output.pause().then(() => false, error => error.name === 'AbortError');
   await output.resume();
   check(await superseded, 'rapid Resume published an obsolete Pause');
   const coincident = { anchors: [{ frames: 768, queued: 256, contextTime: .03, advancing: true }],
     startFrame: 0, rate: 25600, lastMs: 30 };
   output.recordClock(coincident, { frames: 768, queued: 256, contextTime: .03, advancing: false, held: true });
   check(output.clockPosition(coincident, .05) === 30, 'block progress overwrote the sample-exact Pause boundary');

   const interruptedPause = output.pause();
   await audioContext.suspend();
   await interruptedPause;
   check(!output.transport && !output.transportRunning, 'device interruption left the user Pause pending');
   const deviceResumedAt = audioContext.currentTime;
   await audioContext.resume();
   await wait(210);
   const restored = levels.filter(row => row.time > deviceResumedAt + 0.02);
   check(restored.length > 0 && restored.every(row => row.min === 0 && row.max === 0),
     'the device restarted PCM on its own after the interrupted Pause');
   const restoredPosition = output.positionMs();
   await output.resume();
   await until(() => output.positionMs() > restoredPosition, 'explicit Resume did not restore the held queue');
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
   // The preceding transport checks can outlive the initial browser gesture.
   const preparedPlay = document.querySelector('#prepared-play');
   const firstPlay = await new Promise(resolve => {
     preparedPlay.addEventListener('click', () => {
       const at = performance.now();
       resolve({ at, playing: longController.play() });
     }, { once: true });
     preparedPlay.hidden = false;
   });
   let requestedAt = firstPlay.at;
   const longPlaying = firstPlay.playing;
   await until(() => primedAt !== null, 'prepared Play did not prime');
   const preparedPlayMs = primedAt - requestedAt;
   check(preparedPlayMs < 150, `prepared Play took ${preparedPlayMs}ms`);
   await until(() => longController.getState().playing && longController.cache.entry.chunks.size > 0, 'long cache did not start');
   const seekMs = [];
   for (const beat of [2, 600, 1100, 2]) {
     primedAt = null; requestedAt = performance.now(); longController.seek(beat);
     await until(() => primedAt !== null, 'seek did not prime');
     seekMs.push(primedAt - requestedAt);
     check(seekMs.at(-1) < 150, `seek at beat ${beat} took ${seekMs.at(-1)}ms (a window render started at the target)`);
     await until(() => longController.getState().seekBeats === null, 'audible seek never completed');
   }
   longController.stop(); await longPlaying; longController.bindDraft(null);
   return {rateHashes,mapReads,previewReads,maxSilenceMs:maxSilence*1000,tailRms,
     transitionMin,transitionMax,maximumRetiring,maximumPauseStep,preparedPlayMs,seekMs};
  };
  document.querySelector('#run').onclick=()=>run().then(result=>window.result=result,error=>window.result={error:error.message,stack:error.stack});
 }, Number(process.env.AUDIO_RATE || 0));
 await page.click('#run');
 await page.waitForFunction(() => window.result || !document.querySelector('#prepared-play').hidden, {}, { timeout: 60000 });
 if (!(await page.evaluate(() => Boolean(window.result)))) await page.click('#prepared-play');
 await page.waitForFunction(()=>window.result,{},{timeout:60000});
 const result=await page.evaluate(()=>window.result);assert.equal(result.error,undefined,JSON.stringify(result));assert.deepEqual(errors,[]);
 console.log(`PASS ${engine}: ${JSON.stringify(result)}`);
} finally {await browser.close()}
