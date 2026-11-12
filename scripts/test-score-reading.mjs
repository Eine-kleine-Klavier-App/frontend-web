import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';
const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const backend = process.env.PIANO_BACKEND || path.resolve(root, '../PianoAppBackend');
// Isolated real HTTP routes/use cases/domain; only the score repository and identity are fixtures.
// Every /api request is intercepted. No user session, live draft store or database participates.
const python = String.raw`
import asyncio,json,sys
from datetime import UTC,datetime
from fractions import Fraction
from fastapi import FastAPI,Request,HTTPException
from httpx import AsyncClient,ASGITransport
from tests.unit.domain.document_builders import note
from piano_app.domain.score import Score,ScoreMeta
from piano_app.domain.score.document import ScoreDocument
from piano_app.domain.score.document.services.mutation import build_compiler,build_engine
from piano_app.adapters.outbound.in_memory.draft_history import InMemoryDraftHistory
from piano_app.application.use_cases.score.draft.service import DraftService
from piano_app.application.use_cases.score.catalog.service import ScoreCatalogService
from piano_app.application.use_cases.score.edit.service import ScoreEditService
from piano_app.application.use_cases.score.playback.service import PlaybackService
from piano_app.application.use_cases.score.playback.saved_score import SavedScorePlaybackService
from piano_app.adapters.inbound.http.errors import register_exception_handlers
from piano_app.adapters.inbound.http.score.catalog.router import build_scores_router
from piano_app.adapters.inbound.http.score.draft.router import build_draft_router
from piano_app.adapters.inbound.http.score.edit.router import build_edit_router
from piano_app.adapters.inbound.http.score.playback.router import build_playback_router
from piano_app.adapters.inbound.http.score.playback.saved_router import build_saved_playback_router

document=ScoreDocument.create_fresh(voice_count=2,staff_count=2,measure_count=4)
for m in range(4):
 for v in range(2):
  for n in range(4): note(document,Fraction(m)+Fraction(n,4),voice=v,staff=v,step=n+v)
edge_document=ScoreDocument.create_fresh(voice_count=2,staff_count=2,measure_count=4)
for m in range(4):
 for n in range(4): note(edge_document,Fraction(m)+Fraction(n,4),step=26 if m==0 and n==0 else n)
now=datetime(2026,11,12,tzinfo=UTC)
scores={id:Score(meta=ScoreMeta(id=id,title=title,author_id='me',is_public=public,created_at=now,updated_at=now),document=document) for id,title,public in [('saved','Reading study',True),('other','Other study',True),('private','Private study',False)]}
scores['edge']=Score(meta=ScoreMeta(id='edge',title='Keyboard edge study',author_id='me',is_public=True,created_at=now,updated_at=now),document=edge_document)
class Repository:
 async def get(self,*,score_id):return scores.get(score_id)
 async def get_meta(self,*,score_id):return scores[score_id].meta if score_id in scores else None
 async def get_versioned(self,*,score_id):return (scores[score_id],3) if score_id in scores else None
class Authors:
 async def get(self,**kw):return None
class Uow:
 score_repository=Repository()
 author_repository=Authors()
 async def __aenter__(self):return self
 async def __aexit__(self,*args):pass
async def optional(request:Request):return 'me' if request.headers.get('authorization') else None
async def required(request:Request):
 actor=await optional(request)
 if actor is None:raise HTTPException(status_code=401,detail='Sign in')
 return actor
history=InMemoryDraftHistory()
app=FastAPI();register_exception_handlers(app=app)
app.include_router(build_scores_router(service=ScoreCatalogService(score_uow_factory=Uow),current_user=required,current_user_optional=optional))
app.include_router(build_draft_router(service=DraftService(storage=history,score_uow_factory=Uow),current_user=required))
app.include_router(build_edit_router(service=ScoreEditService(engine=build_engine(),compiler=build_compiler(),history=history),current_user=required))
app.include_router(build_playback_router(service=PlaybackService(storage=history,renderer=None),current_user=required))
app.include_router(build_saved_playback_router(service=SavedScorePlaybackService(score_uow_factory=Uow,renderer=None),current_user_optional=optional))
async def handle(value):
 async with AsyncClient(transport=ASGITransport(app=app),base_url='http://isolated') as client:
  response=await client.request(value['method'],value['path'],headers={'authorization':'Bearer isolated'} if value.get('authed') else {},json=value.get('body'))
  return {'status':response.status_code,'body':response.json() if response.content else None}
for line in sys.stdin:
 try: print(json.dumps(asyncio.run(handle(json.loads(line)))),flush=True)
 except Exception as error: print(json.dumps({'status':500,'body':{'detail':repr(error)}}),flush=True)
`;
const child=spawn(path.join(backend,'.venv/bin/python'),['-u','-c',python],{cwd:backend,stdio:['pipe','pipe','inherit']});
const queue=[];
createInterface({input:child.stdout}).on('line',line=>queue.shift()?.resolve(JSON.parse(line)));
child.on('exit',code=>{while(queue.length)queue.shift().reject(new Error(`Isolated API exited ${code}`));});
const api=value=>new Promise((resolve,reject)=>{queue.push({resolve,reject});child.stdin.write(JSON.stringify(value)+'\n');});
const pw=require(process.env.PLAYWRIGHT_MODULE_PATH || '/Users/admin/.npm/_npx/db89d7302a373f10/node_modules/playwright');
const engine=process.env.ENGINE || 'webkit',width=Number(process.env.TEST_WIDTH || 1440),theme=process.env.TEST_THEME || 'light';
const output=process.env.TEST_OUTPUT || '/private/tmp/piano-reading/qa';fs.mkdirSync(output,{recursive:true});
const browser=await pw[engine].launch({headless:true,...(engine==='chromium'&&process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE}:{})});
try {
 const page=await browser.newPage({viewport:{width,height:1000},reducedMotion:process.env.REDUCED?'reduce':'no-preference'});
 const errors=[],requests=[],unexpected=[];let holdReads=false,pendingReads=[],holdPost=false,pendingPost=null,rejectPost=false;
 page.on('pageerror',e=>{errors.push(e.message);console.log('PAGE ERROR',e.message);});
 const fulfill=(route,response)=>route.fulfill({status:response.status,contentType:'application/json',body:JSON.stringify(response.body)});
 await page.route('**/api/**',async route=>{
  const request=route.request(),url=new URL(request.url()),method=request.method(),p=url.pathname;
  requests.push({method,path:p});
  const json=(body,status=200)=>fulfill(route,{status,body});
  if(p==='/api/auth/refresh')return json({},401);
  if(p==='/api/scores'||p==='/api/scores/mine'||p.endsWith('/branches'))return json({items:[],next_cursor:null});
  if(!p.startsWith('/api/scores/')&&!p.startsWith('/api/drafts')){unexpected.push(`${method} ${p}`);return json({},404);}
  if(method==='POST'&&p.startsWith('/api/drafts/from-score/')&&rejectPost){rejectPost=false;return json({detail:'Opening rejected by isolated API'},503);}
  const response=await api({method,path:p.slice(4)+url.search,body:request.postData()?request.postDataJSON():undefined,authed:!!request.headers().authorization});
  if(response.status>=500)console.log('ISOLATED API ERROR',method,p,response);
  if(method==='GET'&&p==='/api/scores/saved'&&holdReads){pendingReads.push([route,response]);return;}
  if(method==='POST'&&p.startsWith('/api/drafts/from-score/')&&holdPost){pendingPost=[route,response];return;}
  return fulfill(route,response);
 });
 await page.route('**/__reading_test__',route=>route.fulfill({contentType:'text/html',body:'<link rel="stylesheet" href="/src/styles/tokens.css"><link rel="stylesheet" href="/src/index.css"><div id="root"></div>'}));
 await page.goto(`${process.env.VITE_URL || 'http://localhost:5173'}/__reading_test__`);
 await page.evaluate(async theme=>{
  document.documentElement.dataset.theme=theme;
  const Refresh=await import('/@react-refresh');Refresh.default.injectIntoGlobalHook(window);
  window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>t=>t;window.__vite_plugin_react_preamble_installed__=true;
  const source=await(await fetch('/src/app/AppRouter.tsx')).text();
  const reactUrl=source.match(/from ["']([^"']*\/react\.js[^"']*)["']/)[1];
  const reactModule=await import(reactUrl),React=reactModule.default??reactModule;
  const client=await import('/node_modules/.vite/deps/react-dom_client.js');
  const moduleUrl=pattern=>source.match(pattern)[1];
  const {useAuthStore}=await import(moduleUrl(/from ["']([^"']*\/auth\/authStore\.ts[^"']*)["']/));
  const {useAuthPrompt}=await import(moduleUrl(/from ["']([^"']*\/auth\/authPrompt\.ts[^"']*)["']/));
  const screenSource=await(await fetch('/src/features/editor/EditorScreen.tsx')).text();
  const {useEditor}=await import(screenSource.match(/from ["']([^"']*\/app\/store\.ts[^"']*)["']/)[1]);
  const playbackUrl=screenSource.match(/from ["']([^"']*PlaybackController\.ts[^"']*)["']/)[1];
  const {playback,beatAtTime}=await import(playbackUrl);
  const playbackSource=await(await fetch(playbackUrl)).text();
  const {PcmStreamPlayer}=await import(playbackSource.match(/from ["']([^"']*PcmStreamPlayer\.ts[^"']*)["']/)[1]);
  window.playerStops=0;window.audioStarts=[];window.beatAtTime=beatAtTime;
  const stop=PcmStreamPlayer.prototype.stop,play=PcmStreamPlayer.prototype.play;
  PcmStreamPlayer.prototype.stop=function(...args){window.playerStops++;return stop.apply(this,args);};
  PcmStreamPlayer.prototype.play=function(...args){window.audioStarts.push({map:args[0].map,startMs:args[3]});this.gain.gain.value=.0001;return play.apply(this,args);};
  window.editor=useEditor;window.playback=playback;
  window.auth=id=>useAuthStore.setState({status:id?'authed':'anonymous',userId:id,accessToken:id?'isolated-token':null,username:id?'QA pianist':null});
  window.signIn=()=>{window.auth('me');useAuthPrompt.getState().succeed();};
  window.go=target=>{history.pushState(null,'',target);window.dispatchEvent(new PopStateEvent('popstate'));};
  window.auth(null);history.replaceState(null,'','/scores/saved');
  const {default:AppRouter}=await import('/src/app/AppRouter.tsx');
  (client.default??client).createRoot(document.querySelector('#root')).render(React.createElement(AppRouter));
 },theme);
 const settle=()=>page.evaluate(async()=>{await Promise.allSettled(document.getAnimations().filter(a=>a.effect?.getTiming().iterations!==Infinity).map(a=>a.finished));await new Promise(requestAnimationFrame);});
 const ready=async id=>{await page.waitForFunction(id=>!window.editor.getState().loading&&window.editor.getState().document.id===id,id).catch(async error=>{console.log('READY DIAG',await page.evaluate(()=>({url:location.href,state:{source:window.editor.getState().source,error:window.editor.getState().error,loading:window.editor.getState().loading,doc:window.editor.getState().document.id},body:document.body.innerText.slice(0,1800)})),requests,errors);await page.screenshot({path:`${output}/failure-${engine}-${width}.png`});throw error;});await page.locator('.paper[data-ready="true"]').waitFor();await settle();};
 const shot=async label=>{await settle();await page.screenshot({path:`${output}/${label}-${engine}-${width}-${theme}.png`});};
 const writes=()=>requests.filter(r=>r.method!=='GET');
 const setSlider=async(name,value,commit=true)=>{
  const slider=page.getByRole('slider',{name,exact:true});
  await slider.evaluate((el,value)=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,String(value));el.dispatchEvent(new Event('input',{bubbles:true}));},value);
  await page.waitForFunction(({name,value})=>Array.from(document.querySelectorAll('input[type=range]')).some(el=>Array.from(document.querySelectorAll('label')).find(label=>label.htmlFor===el.id)?.textContent===name&&Number(el.value)===value),{name,value});
  if(commit)await slider.dispatchEvent('pointerup');
 };
 const panel=async open=>{
  const button=page.getByRole('button',{name:open?'Show panel':'Hide panel',exact:true});
  if(await button.count())await button.click();
  await page.waitForFunction(open=>{const r=document.querySelector('.editor-rail').getBoundingClientRect();return open?Math.abs(r.left)<.1:Math.abs(r.right)<.1;},open);
  await settle();
 };
 const assertMap=async(settings,original)=>{
  const actual=await page.evaluate(()=>window.playback.getState().map);
  const time=ms=>ms/settings.speed;
  assert.equal(actual.extentMs,time(original.extentMs));
  assert.deepEqual(actual.notes,original.notes.map(n=>({...n,pitch:n.pitch+settings.transpose,startMs:time(n.startMs),keyReleaseMs:time(n.keyReleaseMs),endMs:time(n.endMs)})));
  assert.deepEqual(actual.pedals,original.pedals.map(p=>({downMs:time(p.downMs),upMs:time(p.upMs)})));
  assert.deepEqual(actual.anchors,original.anchors.map(a=>({...a,startMs:time(a.startMs),endMs:time(a.endMs)})));
  assert.deepEqual(actual.segments,original.segments.map(g=>({...g,startMs:time(g.startMs),endMs:time(g.endMs),moments:g.moments.map(m=>({...m,timeMs:time(m.timeMs)}))})));
 };
 await ready('saved');
 assert.equal(await page.locator('.sheet-title h1').textContent(),'Reading study');
 assert.equal(await page.getByRole('radiogroup',{name:'Staff',exact:true}).count(),0);
 assert.equal(await page.getByRole('radiogroup',{name:'Document mode',exact:true}).count(),0);
 assert.equal(await page.getByRole('button',{name:'Save',exact:true}).count(),0);
 assert.equal(await page.getByRole('button',{name:'Undo',exact:true}).count(),0);
 assert.equal(await page.locator('.strip-policy').count(),0);
 assert.equal(await page.locator('.stem-handle-dot,.beam-handles,.slur-handles,.context-endpoint').count(),0);
 assert.equal(await page.getByRole('button',{name:'Open in editor',exact:true}).count(),1);
 assert.deepEqual(writes(),[]);
 await page.waitForFunction(()=>window.playback.getState().map!==null);
 const originalMap=await page.evaluate(()=>structuredClone(window.playback.getState().map));
 await page.evaluate(()=>{window.initialDocument=JSON.stringify(window.editor.getState().document);});
 await panel(true);
 assert.equal(await page.getByRole('slider',{name:'Speed',exact:true}).inputValue(),'1');
 assert.equal(await page.getByRole('slider',{name:'Transpose',exact:true}).inputValue(),'0');
 await setSlider('Speed',1.6,false);await page.getByRole('slider',{name:'Speed',exact:true}).dispatchEvent('pointercancel');
 assert.equal(await page.getByRole('slider',{name:'Speed',exact:true}).inputValue(),'1','a cancelled drag returns to the committed setting');
 assert.deepEqual(await page.evaluate(()=>window.playback.getState().listening),{speed:1,transpose:0});
 await setSlider('Speed',1.25,false);
 assert.deepEqual(await page.evaluate(()=>window.playback.getState().listening),{speed:1,transpose:0},'dragging edits only the local slider until the gesture finishes');
 await page.getByRole('slider',{name:'Speed',exact:true}).dispatchEvent('pointerup');
 await setSlider('Transpose',2);
 assert.deepEqual(await page.evaluate(()=>window.playback.getState().listening),{speed:1.25,transpose:2});
 await assertMap({speed:1.25,transpose:2},originalMap);
 assert.equal(await page.evaluate(()=>JSON.stringify(window.editor.getState().document)===window.initialDocument),true,'listening never rewrites source notation');
 await shot('reading-settings');await panel(false);
 const guard=await page.evaluate(async()=>{
  const s=window.editor.getState(),before=JSON.stringify(s.document),stem=JSON.stringify(s.stemOverrides);
  const item=s.document.measures[0].voices[0].items[0],id=item.notes[0].noteId;
  s.select(id);s.setTool('q');
  await s.dispatch({type:'deleteBatch',entityIds:[item.id]});await s.undo();await s.redo();
  s.previewStem(item.id,{direction:1,lengthFactor:2});await s.commitStems([item.id],{direction:1,lengthFactor:2});
  return{same:before===JSON.stringify(window.editor.getState().document),stem:stem===JSON.stringify(window.editor.getState().stemOverrides),tool:window.editor.getState().tool,id};
 });
 assert.deepEqual({same:guard.same,stem:guard.stem,tool:guard.tool},{same:true,stem:true,tool:'select'});
 await page.keyboard.press('Backspace');await page.keyboard.press('ArrowUp');await page.keyboard.press('Meta+z');
 assert.deepEqual(writes(),[],'all direct store and keyboard mutation attempts stay local/read-only');
 await page.getByRole('button',{name:'Voice options',exact:true}).click();
 const swatches=page.locator('.strip-voice-row .voice-swatch');await swatches.nth(2).click();
 const colour=await page.evaluate(()=>{const s=window.editor.getState();return s.voiceColors[s.document.voices[0].id];});
 assert.ok(colour);await page.getByRole('button',{name:'Zoom in',exact:true}).click();
 await shot('reading');
 await page.getByRole('radio',{name:'Waterfall',exact:true}).click();
 await page.waitForFunction(()=>window.playback.getState().map!==null);await settle();
 assert.equal(requests.some(r=>r.path==='/api/scores/saved/playback/map'),true);
 assert.equal(requests.some(r=>r.path.startsWith('/api/drafts/')),false);
 await page.getByRole('button',{name:'Play from line',exact:true}).click();
 await page.getByRole('button',{name:'Pause playback',exact:true}).waitFor({timeout:30000});
 await page.waitForFunction(()=>window.playback.getState().timeMs>100);
 assert.deepEqual(await page.evaluate(()=>window.audioStarts.at(-1).map),await page.evaluate(()=>window.playback.getState().map),'real PCM output follows the configured plan used by Waterfall');
 assert.equal(await page.evaluate(()=>{const s=window.playback.getState();return Math.abs(s.timeBeats-window.beatAtTime(s.map,s.timeMs))<1e-6;}),true,'audible output clock and musical cursor agree after retiming');
 const seek=page.getByRole('slider',{name:'Playback start position',exact:true});
 await seek.evaluate(el=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,'4');el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));});
 await page.getByRole('button',{name:'Pause playback',exact:true}).click();
 const pausedBeat=await page.evaluate(()=>window.playback.getState().timeBeats);
 await panel(true);await setSlider('Speed',.75);await setSlider('Transpose',-3);
 assert.equal(await page.evaluate(()=>window.playback.getState().paused),true,'configuration preserves pause');
 assert.equal(await page.evaluate(()=>window.playback.getState().playing),false);
 assert.ok(Math.abs(await page.evaluate(()=>window.playback.getState().timeBeats)-pausedBeat)<1e-6);
 await assertMap({speed:.75,transpose:-3},originalMap);await panel(false);
 await page.getByRole('button',{name:'Resume playback',exact:true}).click();await page.getByRole('button',{name:'Pause playback',exact:true}).waitFor();
 await page.waitForFunction(beat=>window.playback.getState().timeBeats>beat,pausedBeat);
 const rapidLoading=await page.evaluate(()=>{
  for(const settings of [{speed:.8,transpose:1},{speed:1.4,transpose:2},{speed:1.2,transpose:-2}])window.playback.setListeningSettings(settings,{min:21,max:108});
  return window.playback.getState().loading;
 });
 assert.equal(rapidLoading,true,'rapid commits exercise the asynchronous output preparation');
 await page.getByRole('button',{name:'Pause playback',exact:true}).waitFor();
 await page.waitForFunction(()=>!window.playback.getState().loading&&window.playback.getState().playing);
 await assertMap({speed:1.2,transpose:-2},originalMap);
 assert.deepEqual(await page.evaluate(()=>window.audioStarts.at(-1).map),await page.evaluate(()=>window.playback.getState().map),'only the latest configured output reaches playback');
 assert.equal(await page.evaluate(()=>JSON.stringify(window.editor.getState().document)===window.initialDocument),true);
 assert.deepEqual(writes(),[],'speed, transposition, pause and rapid replacement create no drafts or saved changes');
 await page.getByRole('button',{name:'Stop playback',exact:true}).click();
 assert.equal(await page.evaluate(()=>window.playback.getState().timeMs),0);
 await page.getByRole('button',{name:'Show panel',exact:true}).click();
 await page.getByRole('checkbox',{name:'Octave lines',exact:true}).uncheck();await page.getByRole('checkbox',{name:'Measure lines',exact:true}).uncheck();
 await page.getByRole('radio',{name:'Vertical',exact:true}).click();
 await page.getByRole('slider',{name:'Manual tilt',exact:true}).evaluate(el=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,'23');el.dispatchEvent(new Event('input',{bubbles:true}));});
 await page.getByLabel('Keyboard strip colour',{exact:true}).fill('#563277');
 await page.getByRole('radio',{name:'Grey',exact:true}).click();
 await shot('waterfall');
 await page.getByRole('button',{name:'Reset playback settings',exact:true}).click();
 await assertMap({speed:1,transpose:0},originalMap);
 await page.getByRole('button',{name:'Hide panel',exact:true}).click();await settle();
 assert.deepEqual(writes(),[],'every reading setting and playback operation avoids draft writes');
 // Signing in rereads metadata. Keep both that GET and the create response pending to expose races.
 holdReads=true;holdPost=true;
 await page.getByRole('button',{name:'Open in editor',exact:true}).click();await page.getByRole('dialog').filter({hasText:'Sign in'}).waitFor();
 assert.deepEqual(writes(),[]);
 await page.evaluate(()=>window.signIn());
 await page.waitForFunction(()=>document.querySelector('.document-open-editor')?.textContent==='Opening…');
 for(let i=0;i<30&&!pendingPost;i++)await new Promise(resolve=>setTimeout(resolve,20));
 assert.ok(pendingPost,'auth continuation creates a draft despite metadata re-read');
 await page.locator('.document-open-editor').evaluate(el=>{el.click();el.click();});
 assert.equal(writes().filter(r=>r.path==='/api/drafts/from-score/saved').length,1);
 const createdId=pendingPost[1].body.draft_id;await fulfill(...pendingPost);pendingPost=null;holdPost=false;
 await page.waitForURL(`**/edit/${createdId}`);await ready(createdId);
 holdReads=false;for(const pending of pendingReads.splice(0))await fulfill(...pending);
 await page.getByRole('button',{name:'Save',exact:true}).waitFor();await settle();
 assert.equal(await page.getByRole('radio',{name:'Score',exact:true}).getAttribute('aria-checked'),'true','explicit editing reveals the score and its tools');
 assert.equal(await page.getByRole('radiogroup',{name:'Staff',exact:true}).count(),1);
 assert.equal(await page.getByRole('button',{name:'Open in editor',exact:true}).count(),0);
 assert.deepEqual(await page.evaluate(()=>window.playback.getState().listening),{speed:1,transpose:0},'the explicit new draft starts with original playback settings');
 assert.equal(await page.getByRole('slider',{name:'Speed',exact:true}).count(),0,'listening multipliers belong only to saved reading');
 assert.equal(await page.evaluate(()=>{const s=window.editor.getState();return s.voiceColors[s.document.voices[0].id];}),colour);
 await shot('editor');
 await page.getByRole('radio',{name:'Waterfall',exact:true}).click();await page.getByRole('button',{name:'Show panel',exact:true}).click();
 assert.equal(await page.getByRole('checkbox',{name:'Octave lines',exact:true}).isChecked(),false);
 assert.equal(await page.getByRole('checkbox',{name:'Measure lines',exact:true}).isChecked(),false);
 assert.equal(await page.getByRole('slider',{name:'Manual tilt',exact:true}).inputValue(),'23');
 assert.equal(await page.getByLabel('Keyboard strip colour',{exact:true}).inputValue(),'#563277');
 assert.equal(await page.getByRole('radio',{name:'Grey',exact:true}).getAttribute('aria-checked'),'true');
 await page.getByRole('button',{name:'Hide panel',exact:true}).click();await settle();
 await page.getByRole('radio',{name:'Score',exact:true}).click();await settle();
 assert.equal(writes().filter(r=>r.path==='/api/drafts/from-score/saved').length,1,'view changes keep the same explicit working copy');
 const changed=await page.evaluate(async()=>{
  const s=window.editor.getState(),before=JSON.stringify(s.document.presentation),tempo=s.document.contexts.find(c=>c.kind==='tempo');
  await s.dispatch({type:'editPresentation',changes:[{kind:'vertical',target:{entity_id:tempo.id,reference:'body'},offset:1.4}]});
  const changed=JSON.stringify(window.editor.getState().document.presentation)!==before;
  await window.editor.getState().undo();return{changed,restored:JSON.stringify(window.editor.getState().document.presentation)===before};
 });
 assert.deepEqual(changed,{changed:true,restored:true},'draft edit and one backend Undo round-trip');
 // Failed explicit creation stays in the reader; a later successful response cannot hijack navigation.
 await page.evaluate(()=>window.go('/scores/saved'));await ready('saved');rejectPost=true;
 await page.getByRole('button',{name:'Open in editor',exact:true}).click();await page.getByRole('alert').filter({hasText:'Opening rejected'}).waitFor();
 assert.match(page.url(),/\/scores\/saved$/);holdPost=true;
 await page.getByRole('button',{name:'Open in editor',exact:true}).click();
 for(let i=0;i<30&&!pendingPost;i++)await new Promise(resolve=>setTimeout(resolve,20));assert.ok(pendingPost);
 await page.evaluate(()=>window.go('/scores/other'));await ready('other');await fulfill(...pendingPost);pendingPost=null;holdPost=false;await settle();
 assert.match(page.url(),/\/scores\/other$/,'late creation does not navigate away from a new score');
 assert.equal(await page.locator('.sheet-title h1').textContent(),'Other study');
 holdReads=true;await page.evaluate(()=>window.go('/scores/saved'));
 for(let i=0;i<30&&!pendingReads.length;i++)await new Promise(resolve=>setTimeout(resolve,20));assert.ok(pendingReads.length);
 await page.evaluate(()=>window.go('/scores/other'));await ready('other');holdReads=false;
 for(const pending of pendingReads.splice(0))await fulfill(...pending);await settle();
 assert.equal(await page.locator('.sheet-title h1').textContent(),'Other study','late saved read does not replace current document');
 const geometry=await page.locator('.editor-bar button,.editor-bar a,.editor-bar .choice').evaluateAll(els=>els.filter(el=>{const r=el.getBoundingClientRect(),style=getComputedStyle(el);return r.width&&r.height&&style.visibility!=='hidden'&&style.display!=='none';}).map(el=>{const r=el.getBoundingClientRect();return{label:el.getAttribute('aria-label')||el.textContent,left:r.left,right:r.right,top:r.top,bottom:r.bottom};}));
 assert.ok(geometry.every(r=>r.left>=-1&&r.right<=width+1),JSON.stringify(geometry));
 // One out-of-range note rejects the entire transposition before sound is cancelled.
 await page.evaluate(()=>window.go('/scores/edge'));await ready('edge');
 await page.waitForFunction(()=>window.playback.getState().map!==null);
 const edgeNotes=await page.evaluate(()=>window.playback.getState().map.notes.map(n=>n.pitch));
 assert.equal(Math.max(...edgeNotes),108);assert.ok(edgeNotes.length>1&&edgeNotes.filter(p=>p===108).length===1);
 await panel(false);await page.getByRole('button',{name:'Play from line',exact:true}).click();
 await page.getByRole('button',{name:'Pause playback',exact:true}).waitFor();await page.waitForFunction(()=>window.playback.getState().timeMs>100);
 const rejection=await page.evaluate(()=>{
  const p=window.playback,before=p.getState(),map=before.map,stops=window.playerStops;
  let rejected=false;try{p.setListeningSettings({speed:1.7,transpose:1},{min:21,max:108});}catch{rejected=true;}
  return{rejected,settings:p.getState().listening,sameMap:map===p.getState().map,stops:window.playerStops-stops,playing:p.getState().playing};
 });
 assert.deepEqual(rejection,{rejected:true,settings:{speed:1,transpose:0},sameMap:true,stops:0,playing:true},'an invalid member rejects all notes and both settings without interrupting sound');
 await panel(true);const beforeUiStops=await page.evaluate(()=>window.playerStops);
 await setSlider('Transpose',1);
 await page.locator('.listening-error').filter({hasText:'outside the keyboard range'}).waitFor();
 assert.equal(await page.getByRole('slider',{name:'Transpose',exact:true}).inputValue(),'0');
 assert.equal(await page.evaluate(()=>window.playerStops),beforeUiStops);
 assert.equal(await page.evaluate(()=>window.playback.getState().playing),true);
 await shot('listening-rejected');await panel(false);await page.getByRole('button',{name:'Stop playback',exact:true}).click();
 await page.evaluate(()=>window.go('/scores/private'));await ready('private');
 await page.evaluate(()=>window.auth(null));
 await page.getByRole('alert').filter({hasText:'could not be found'}).waitFor();
 assert.equal(await page.locator('.paper').count(),0,'signing out drops the previously readable private document');
 assert.equal(await page.getByRole('button',{name:'Open in editor',exact:true}).isDisabled(),true);
 assert.deepEqual(errors,[]);assert.deepEqual(unexpected,[]);
 console.log(`PASS ${engine}/${width}/${theme}: real catalog/draft/playback/edit HTTP and domain; GET-only reader; mutation guards; voice colours; full Waterfall; speed/transpose retiming, output/clock, pause/rapid commits and whole-change range rejection; anonymous continuation/held re-read; one rapid create; Edit+Undo; rejection/retry; stale reads and creation; viewport geometry`);
} finally {await browser.close();child.stdin.end();}
