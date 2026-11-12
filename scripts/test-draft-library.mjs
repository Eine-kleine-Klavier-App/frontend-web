import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
if (!process.env.PLAYWRIGHT_MODULE_PATH) { console.log('Set PLAYWRIGHT_MODULE_PATH to test against the existing Vite server.'); process.exit(0); }
const pw = require(process.env.PLAYWRIGHT_MODULE_PATH);
const engine = process.env.ENGINE || 'webkit', width = Number(process.env.TEST_WIDTH || 1440), theme = process.env.TEST_THEME || 'dark';
const browser = await pw[engine].launch({headless:true, ...(engine === 'chromium' ? {executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || '/Users/admin/Library/Caches/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-mac-arm64/chrome-headless-shell'} : {})});
try {
 const context = await browser.newContext({viewport:{width,height:900}, reducedMotion:process.env.REDUCED ? 'reduce':'no-preference'});
 const page = await context.newPage(), errors=[], unexpected=[], writes=[];
 let responseMode='normal', newAttempts=0, listReads=0, deleteAttempts=0, pendingDelete=null;
 const drafts = Array.from({length:14}, (_,i)=>({draft_id:`copy-${i}`, title:i>=12?'Shared study':i===0?'Untitled':`Draft ${String(i).padStart(2,'0')}`, ref_score_id:i>=12?'shared':i%2===0?null:`score-${i}`, updated_at:new Date(Date.UTC(2026,10,11,0,i)).toISOString()}));
 page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/api/**', async route=>{
  const req=route.request(), path=new URL(req.url()).pathname;
  const json=(value,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(value)});
  if(req.method()!=='GET') writes.push(`${req.method()} ${path}`);
  if(path==='/api/drafts/copy-11' && req.method()==='DELETE') {
   deleteAttempts++;
   if(deleteAttempts===1) return json({detail:'Deletion unavailable'},503);
   pendingDelete=route; return;
  }
  if(path==='/api/drafts' && req.method()==='GET') { listReads++;
   if(responseMode==='error') return json({detail:'Draft listing unavailable'},503);
   return json(responseMode==='empty'?[]:drafts);
  }
  if(path==='/api/scores/shared') return json({id:'shared',title:'Shared study',composer:null,author_id:'me',author_name:'Pianist',is_public:false,updated_at:'2026-11-11T00:00:00Z'});
  if(path==='/api/scores/mine' || path==='/api/scores') return json({items:[],next_cursor:null});
  if(path==='/api/drafts' && req.method()==='POST') {newAttempts++; return newAttempts===1?json({detail:'Creation unavailable'},503):json({draft_id:'created-copy',document:{}},201);}
  if(path==='/api/drafts/copy-0/edit/presentation' && req.method()==='PUT') {
   drafts[0].updated_at='2026-11-11T23:59:00.000Z';
   const view=await(await page.request.get(new URL('/demo-editor-view.json',process.env.VITE_URL||'http://localhost:5173').href)).json();
   view.presentation.vertical=req.postDataJSON().changes.filter(c=>c.kind==='vertical').map(c=>({...c.target,offset:c.offset}));
   view.presentation.directions=req.postDataJSON().changes.filter(c=>c.kind==='direction').map(c=>({...c.target,direction:c.direction}));
   return json({document:view});
  }
  if(path.endsWith('/playback/preview/map')) return json({version:0,carriers:[]});
  if(path.startsWith('/api/drafts/copy-') || path==='/api/drafts/created-copy') return json({document:await (await page.request.get(new URL('/demo-editor-view.json',process.env.VITE_URL||'http://localhost:5173').href)).json()});
  unexpected.push(`${req.method()} ${path}`); return json({detail:'Unexpected isolated test request'},500);
 });
 await page.route('**/__draft_test__',route=>route.fulfill({contentType:'text/html',body:'<link rel="stylesheet" href="/src/styles/tokens.css"><link rel="stylesheet" href="/src/index.css"><div id="root"></div>'}));
 await page.goto(new URL('/__draft_test__',process.env.VITE_URL||'http://localhost:5173').href);
 await page.evaluate(async theme=>{
  document.documentElement.dataset.theme=theme;
  const Refresh=await import('/@react-refresh'); Refresh.default.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>type=>type; window.__vite_plugin_react_preamble_installed__=true;
  const source=await (await fetch('/src/app/AppRouter.tsx')).text();
  const rm=await import(source.match(/from ["']([^"']*\/react\.js[^"']*)["']/)[1]); const React=rm.default??rm;
  const cm=await import('/node_modules/.vite/deps/react-dom_client.js'); const {createRoot}=cm.default??cm;
  const {useAuthStore}=await import(source.match(/from ["']([^"']*\/auth\/authStore\.ts[^"']*)["']/)[1]);
  const {default:AppRouter}=await import('/src/app/AppRouter.tsx');
  const {useAuthPrompt}=await import(source.match(/from ["']([^"']*\/auth\/authPrompt\.ts[^"']*)["']/)[1]);
  window.testSignIn=()=>{window.testAuth(true);useAuthPrompt.getState().succeed();};
  const cache=await import('/src/core/gateway/browseQueryCache.ts');
  window.refreshDrafts=()=>cache.invalidateBrowseQueries('private',cache.BROWSE_QUERY_KEYS.myDrafts);
  window.testAuth=authed=>useAuthStore.setState({status:authed?'authed':'anonymous',userId:authed?'me':null,username:authed?'Pianist':null,accessToken:authed?'isolated-only':null});
  window.testAuth(true);
  window.testNavigate=path=>{history.pushState(null,'',path); dispatchEvent(new PopStateEvent('popstate'));};
  history.replaceState(null,'','/library');
  createRoot(document.querySelector('#root')).render(React.createElement(AppRouter));
 },theme);
 const settle=async()=>{
  await page.waitForFunction(()=>[...document.querySelectorAll('.page-transition-layer')].every(el=>getComputedStyle(el).pointerEvents==='none'?Number(getComputedStyle(el).opacity)<.01:Number(getComputedStyle(el).opacity)>.99));
  await page.evaluate(async()=>{const animations=document.getAnimations().filter(a=>a.effect?.getTiming().iterations!==Infinity); await Promise.allSettled(animations.map(a=>a.finished));});
 };
 const cards=()=>page.locator('.work-card');
 await page.waitForFunction(()=>document.querySelectorAll('.work-card').length===6); await settle();
 assert.deepEqual(await cards().evaluateAll(els=>els.map(el=>el.dataset.draftId)),['copy-13','copy-12','copy-11','copy-10','copy-9','copy-8']);
 assert.equal(await cards().filter({hasText:'Shared study'}).count(),2,'same score keeps both recent copies');
 assert.equal(await page.locator('.work-card-kind').count(),0);
 assert.equal(await page.getByRole('button',{name:/^Delete /}).count(),0,'recent shelf has no delete control');
 await page.screenshot({path:`/private/tmp/draft-recent-${engine}-${width}-${theme}.png`});
 await page.getByRole('link',{name:'See all',exact:true}).click();
 await page.getByRole('heading',{name:'Drafts',exact:true}).waitFor();
 await page.waitForFunction(count=>document.querySelectorAll('.draft-grid .work-card').length===count,drafts.length); await settle();
 assert.equal(await page.locator('.app-nav-item.active').innerText(),'Library');
 assert.equal(await page.getByRole('searchbox',{name:'Search drafts',exact:true}).count(),1);
 assert.equal(await page.locator('.work-card-kind').count(),0);
 assert.equal(await cards().filter({hasText:'Untitled'}).count(),1,'rootless draft stays in same grid');
 assert.equal(await cards().filter({hasText:'Shared study'}).count(),2);
 assert.equal(await page.getByRole('heading',{name:'Your scores',exact:true}).count(),0);
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
 const geometry=await cards().evaluateAll(els=>els.map(el=>{const r=el.getBoundingClientRect();return {left:r.left,right:r.right,width:r.width};}));
 assert.ok(geometry.every(r=>r.left>=0&&r.right<=width+1&&r.width>0),'draft grid stays inside viewport');
 const actions=await page.locator('.draft-entry').evaluateAll(entries=>entries.map(entry=>{
  const card=entry.getBoundingClientRect(),open=entry.querySelector('.work-card'),remove=entry.querySelector('.draft-delete-action');
  const action=remove.getBoundingClientRect(),opening=open.getBoundingClientRect();
  return {inside:action.left>=card.left&&action.right<card.right&&action.top>=card.top&&action.bottom<=card.bottom,
   aligned:Math.abs((action.top+action.bottom-card.top-card.bottom)/2)<=1,
   separate:opening.right<=action.left&&remove.parentElement===open.parentElement,
   surface:getComputedStyle(entry).backgroundColor,openSurface:getComputedStyle(open).backgroundColor};
 }));
 assert.ok(actions.every(action=>action.inside&&action.aligned&&action.separate),'Delete stays inside its card, centred and separate from Open');
 assert.ok(actions.every(action=>action.surface!=='rgba(0, 0, 0, 0)'&&action.openSurface==='rgba(0, 0, 0, 0)'),'the common card owns the visible surface');
 await page.screenshot({path:`/private/tmp/draft-all-${engine}-${width}-${theme}.png`});
 await page.getByRole('button',{name:'Sort drafts'}).click();
 await page.getByRole('option',{name:'Title',exact:true}).click();
 const titles=await page.locator('.draft-grid .work-card-title').allTextContents();
 assert.deepEqual(titles,[...titles].sort((a,b)=>a.localeCompare(b)));
 const search=page.getByRole('searchbox',{name:'Search drafts',exact:true});
 await search.fill('sHaReD'); await page.waitForFunction(()=>document.querySelectorAll('.draft-grid .work-card').length===2);
 await search.fill('does-not-exist'); await page.getByText('No drafts match your search.',{exact:true}).waitFor();
 await page.getByRole('button',{name:'Clear search',exact:true}).click();
 await page.waitForFunction(count=>document.querySelectorAll('.draft-grid .work-card').length===count,drafts.length); await settle();
 // Native buttons activate both Enter and Space and route to the selected working copy.
 for (const key of ['Enter','Space']) {
  const target=page.locator('.work-card[data-draft-id="copy-12"]'); await target.focus(); await page.keyboard.press(key);
  await page.waitForURL('**/edit/copy-12');
  await page.evaluate(()=>window.testNavigate('/library/drafts')); await page.getByRole('heading',{name:'Drafts',exact:true}).waitFor(); await settle();
 }
 // Deletion lives inside the full chooser card and never activates its separate Open button.
 const deleteRow=page.locator('.draft-entry').filter({has:page.locator('[data-draft-id="copy-11"]')});
 const deleteButton=deleteRow.getByRole('button',{name:'Delete Draft 11',exact:true});
 const confirm=page.getByRole('dialog',{name:'Delete draft?',exact:true});
 await deleteButton.hover(); await deleteButton.click();
 await confirm.waitFor(); assert.match(await confirm.innerText(),/Draft 11/);
 assert.equal(new URL(page.url()).pathname,'/library/drafts');
 assert.equal(await confirm.getByRole('button',{name:'Cancel',exact:true}).evaluate(el=>el===document.activeElement),true);
 await page.screenshot({path:`/private/tmp/draft-delete-confirm-${engine}-${width}-${theme}.png`});
 await confirm.getByRole('button',{name:'Cancel',exact:true}).click();
 await page.waitForFunction(()=>!document.querySelector('.draft-delete-dialog[open]'));
 assert.equal(deleteAttempts,0);
 assert.equal(await deleteButton.evaluate(el=>el===document.activeElement),true,'cancel restores the delete trigger');
 await deleteButton.focus(); await page.keyboard.press('Enter'); await confirm.waitFor();
 assert.equal(new URL(page.url()).pathname,'/library/drafts','keyboard Delete does not open the draft');
 await page.keyboard.press('Escape');
 await page.waitForFunction(()=>!document.querySelector('.draft-delete-dialog[open]')); assert.equal(deleteAttempts,0);
 await deleteButton.click(); await confirm.waitFor();
 const readsBeforeFailure=listReads;
 await confirm.getByRole('button',{name:'Delete',exact:true}).click();
 await confirm.getByRole('alert').filter({hasText:'Deletion unavailable'}).waitFor();
 assert.equal(await deleteRow.count(),1,'failed deletion keeps the working copy');
 assert.equal(listReads,readsBeforeFailure,'rejected deletion does not replace the list');
 await confirm.getByRole('button',{name:'Delete',exact:true}).click();
 await confirm.getByRole('button',{name:'Deleting…',exact:true}).waitFor();
 assert.equal(await confirm.getByRole('button',{name:'Deleting…',exact:true}).isDisabled(),true);
 await confirm.getByRole('button',{name:'Deleting…',exact:true}).evaluate(el=>{el.click();el.click();});
 await page.keyboard.press('Escape'); assert.equal(await confirm.count(),1,'pending deletion keeps its dialog');
 assert.equal(deleteAttempts,2,'pending repeated clicks send no duplicate DELETE');
 assert.equal(await confirm.getByRole('button',{name:'Cancel',exact:true}).isDisabled(),true);
 drafts.splice(drafts.findIndex(draft=>draft.draft_id==='copy-11'),1);
 await pendingDelete.fulfill({status:204,body:''}); pendingDelete=null;
 await page.waitForFunction(()=>!document.querySelector('.draft-delete-dialog[open]'));
 await page.waitForFunction(count=>document.querySelectorAll('.draft-grid .work-card').length===count,drafts.length);
 await settle(); assert.equal(await deleteRow.count(),0);
 assert.equal(await page.getByRole('heading',{name:'Drafts',exact:true}).evaluate(el=>el===document.activeElement),true);
 assert.equal(await cards().filter({hasText:'Shared study'}).count(),2,'other copies of saved scores survive');
 const back=page.getByRole('link',{name:'Back to Library',exact:true}).first();
 assert.equal(await back.locator('svg').count(),1,'return action has the established arrow icon');
 await back.focus(); await page.keyboard.press('Enter');
 await page.waitForFunction(()=>document.querySelectorAll('.jump-track .work-card').length===6); await settle();
 assert.equal(await page.locator('.jump-track [data-draft-id="copy-11"]').count(),0);
 assert.equal(await page.getByRole('button',{name:/^Delete /}).count(),0);
 await page.getByRole('link',{name:'See all',exact:true}).click();
 await page.getByRole('heading',{name:'Drafts',exact:true}).waitFor(); await settle();
 // Successful real editor command must update recent order on return, without Save.
 await page.evaluate(()=>window.testNavigate('/edit/copy-0'));
 await page.locator('.editor-screen').waitFor();
 assert.equal(await page.locator('.editor-screen').getByRole('button',{name:/^Delete /}).count(),0);
 await page.evaluate(async()=>{
  const source=await(await fetch('/src/features/editor/EditorScreen.tsx')).text();
  const {useEditor}=await import(source.match(/from ["']([^"']*\/app\/store\.ts[^"']*)["']/)[1]);
  window.draftTestEditor=useEditor;
 });
 await page.waitForFunction(()=>!window.draftTestEditor.getState().loading&&window.draftTestEditor.getState().scoreId==='copy-0');
 await page.evaluate(async()=>{
  const state=window.draftTestEditor.getState();
  const item=state.document.measures.flatMap(m=>m.voices.flatMap(v=>v.items)).find(i=>i.notes?.length);
  if(!item) throw new Error('Fixture has no carrier');
  await state.dispatch({type:'setStems',carrierIds:[item.carrierId],override:{direction:-1,lengthFactor:1.5}});
  if(window.draftTestEditor.getState().error) throw new Error('Editor fixture command failed');
 });
 const readsBeforeReturn=listReads;
 await page.getByRole('link',{name:'Back to Library',exact:true}).first().click();
 await page.waitForFunction(()=>document.querySelector('.work-card')?.dataset.draftId==='copy-0');
 assert.ok(listReads>readsBeforeReturn,'returning from editing refreshes modified times');
 await page.getByRole('link',{name:'See all',exact:true}).click();
 await page.getByRole('heading',{name:'Drafts',exact:true}).waitFor(); await settle();
 await page.getByRole('button',{name:'New score',exact:true}).click(); await page.getByRole('alert').filter({hasText:'Creation unavailable'}).waitFor();
 assert.equal(newAttempts,1);
 await page.getByRole('button',{name:'New score',exact:true}).click(); await page.waitForURL('**/edit/created-copy');
 assert.equal(newAttempts,2);
 await page.evaluate(()=>window.testNavigate('/library/drafts')); await page.getByRole('heading',{name:'Drafts',exact:true}).waitFor(); await settle();
 responseMode='empty'; await page.evaluate(()=>window.refreshDrafts()); await page.getByText('No drafts yet.',{exact:true}).waitFor();
 responseMode='error'; await page.evaluate(()=>window.refreshDrafts()); await page.getByRole('alert').filter({hasText:'Draft listing unavailable'}).waitFor();
 await page.waitForFunction(()=>![...document.querySelectorAll('.library-empty')].some(el=>el.textContent==='No drafts yet.'));
 assert.equal(await page.getByText('No drafts yet.',{exact:true}).count(),0,'failure is not empty state');
 responseMode='normal'; await page.evaluate(()=>window.refreshDrafts()); await page.waitForFunction(count=>document.querySelectorAll('.draft-grid .work-card').length===count,drafts.length); await settle();
 // Reversals reuse AppShell/PageTransition, leaving a single interactive route.
 await page.evaluate(async()=>{for(let i=0;i<18;i++){window.testNavigate(i%2?'/library/drafts':'/library');await new Promise(requestAnimationFrame);}});
 await page.getByRole('heading',{name:'Drafts',exact:true}).waitFor(); await settle();
 assert.equal(await cards().count(),drafts.length);
 // Direct anonymous drafts URL must fail closed and preserve its login destination.
 await page.evaluate(()=>window.testNavigate('/library/drafts?q=study'));
 await page.waitForFunction(()=>document.querySelector('.scoped-search-input')?.value==='study');
 await page.evaluate(()=>window.testAuth(false));
 await page.waitForURL('**/explore');
 await page.waitForFunction(()=>document.querySelectorAll('.work-card').length===0);
 assert.equal(await cards().count(),0);
 await page.waitForFunction(()=>document.querySelector('[role="dialog"],dialog'));
 await settle();
 await page.evaluate(()=>window.testSignIn());
 await page.waitForURL('**/library/drafts?q=study',{timeout:8000}).catch(async error=>{console.log('AUTH DIAG',await page.evaluate(()=>({url:location.href,layers:[...document.querySelectorAll('.page-transition-layer')].map(el=>({opacity:getComputedStyle(el).opacity,pointer:getComputedStyle(el).pointerEvents,text:el.innerText.slice(0,65)}))})));console.log('UNEXPECTED',unexpected,'ERRORS',errors);throw error;});
 await page.getByRole('searchbox',{name:'Search drafts',exact:true}).waitFor();
 await page.waitForFunction(()=>document.querySelectorAll('.draft-grid .work-card').length===2);
 assert.deepEqual(unexpected,[]); assert.deepEqual(errors,[]);
 assert.deepEqual(writes,['DELETE /api/drafts/copy-11','DELETE /api/drafts/copy-11','PUT /api/drafts/copy-0/edit/presentation','POST /api/drafts','POST /api/drafts'],'only requested delete attempts, edit, and explicit creation attempts write');
 console.log(`PASS ${engine} ${width} ${theme}: six recent copies; all mixed drafts; search/sort; deletion cancel/error/retry/pending/list refresh; keyboard; existing IDs; new/rejection/retry; empty/error; auth/deep link; rapid navigation`);
 await context.close();
} finally {await browser.close();}
