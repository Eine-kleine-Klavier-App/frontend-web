import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
if (!process.env.PLAYWRIGHT_MODULE_PATH) { console.log('Set PLAYWRIGHT_MODULE_PATH to run against the existing Vite server.'); process.exit(0); }
const playwright = require(process.env.PLAYWRIGHT_MODULE_PATH);
const engine = process.env.ENGINE || 'webkit';
const width = Number(process.env.TEST_WIDTH || 1440), theme = process.env.TEST_THEME || 'light';
const browser = await playwright[engine].launch({ headless: true, ...(engine === 'chromium' ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || '/Users/admin/Library/Caches/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-mac-arm64/chrome-headless-shell' } : {}) });
try {
 const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: process.env.REDUCED ? 'reduce' : 'no-preference' });
 const errors = [], writes = [], requests = [];
 page.on('pageerror', error => errors.push(error.message));
 let privacyAttempts = 0, holdRead = false, pendingRead = null, pendingPrivacy = null, versionExtent = 300, holdPlaybackMap = false, pendingPlaybackMap = null, notifyPendingMap = () => {};
 const saved = { id: 'saved', title: 'Nocturne', composer: 'F. Chopin', author_id: 'me', author_name: 'Pianist', is_public: false, updated_at: '2026-11-11T00:00:00Z' };
 const version = { ...saved, id: 'version', title: 'My Nocturne', is_public: true };
 const studies = Array.from({ length: 30 }, (_, index) => ({ ...saved, id: `study-${index}`, title: `Nocturne study ${index + 1}`, composer:index===0?'':index===1?'   ':saved.composer, is_public:true }));
 await page.route('**/api/**', async route => {
   const request = route.request(), path = new URL(request.url()).pathname;
   requests.push(`${request.method()} ${path}`);
   const json = (value, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
   if (request.method() === 'GET' && path.endsWith('/branches')) return json({ items:path==='/api/scores/saved/branches'?[version]:[], next_cursor:null });
   if (request.method() === 'GET' && path === '/api/scores/saved') { if (holdRead) { pendingRead=route; return; } const viewer=await page.evaluate(()=>window.testViewer); return !saved.is_public&&viewer!=='me'?json({detail:'Not found'},404):json(saved); }
   if (request.method() === 'GET' && path === '/api/scores') return json({ items:saved.is_public?[saved,...studies]:studies, next_cursor:null });
   if (request.method() === 'GET' && path === '/api/scores/mine') return json({ items:[saved,version,...studies], next_cursor:null });
   if (request.method() === 'GET' && path === '/api/drafts') return json([]);
   if (request.method() === 'GET' && path === '/api/scores/missing') return json({ detail:'Not found' },404);
   if (request.method() === 'GET' && path === '/api/scores/version') return json(version);
   if (request.method() === 'GET' && path.startsWith('/api/scores/study-')) return json(studies.find(score=>score.id===path.split('/').at(-1)));
   if (request.method() === 'POST' && path === '/api/drafts/from-score/version') return json({draft_id:'working',document:{}},201);
   if (request.method() === 'PATCH' && path === '/api/scores/saved') {
     privacyAttempts++; writes.push(request.postDataJSON());
     if (privacyAttempts === 1) { pendingPrivacy=route; return; }
     Object.assign(saved,request.postDataJSON()); return json(null);
   }
   if (request.method()==='GET' && path.endsWith('/playback/map')) {
     const extent=path.includes('/version/')?versionExtent:30000;
     const end=Math.min(200,extent);
     const payload = {version:path.includes('/version/')&&versionExtent>300?4:3,extent_ms:extent,
       notes:[{source_id:'fixture-note',pitch:60,start_ms:0,key_release_ms:end,end_ms:end,velocity:60}],
       pedals:[],anchors:[],segments:[]};
     if (holdPlaybackMap && path === '/api/scores/saved/playback/map') { pendingPlaybackMap = { route, payload }; notifyPendingMap(); return; }
     return json(payload);
   }
   throw new Error(`Unexpected fixture request ${request.method()} ${path}`);
 });
 await page.route('**/__score_window_test__',route=>route.fulfill({contentType:'text/html',body:'<link rel="stylesheet" href="/src/styles/tokens.css"><link rel="stylesheet" href="/src/index.css"><div id="root"></div>'}));
 await page.goto(`${process.env.VITE_URL||'http://localhost:5173'}/__score_window_test__`);
 await page.evaluate(async ({theme})=>{
   document.documentElement.dataset.theme=theme;
   const Refresh=await import('/@react-refresh');Refresh.default.injectIntoGlobalHook(window);
   window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;
   const source=await(await fetch('/src/features/browse/PreviewPanel.tsx')).text();
   const moduleUrl=pattern=>source.match(pattern)[1];
   const reactModule=await import(moduleUrl(/from ["']([^"']*\/react\.js[^"']*)["']/));const React=reactModule.default??reactModule;
   const {createRoot}=(await import('/node_modules/.vite/deps/react-dom_client.js')).default;
   const {MemoryRouter,Routes,Route,useNavigate,useLocation}=await import(moduleUrl(/from ["']([^"']*react-router-dom[^"']*)["']/));
   const {useAuthStore}=await import(moduleUrl(/from ["']([^"']*\/auth\/authStore\.ts[^"']*)["']/));
   const {useAuthPrompt}=await import(moduleUrl(/from ["']([^"']*\/auth\/authPrompt\.ts[^"']*)["']/));
   const shellSource=await(await fetch('/src/app/AppShell.tsx')).text();
   const savedUrl=shellSource.match(/from ["']([^"']*SavedScorePlayback\.ts[^"']*)["']/)[1];
   const savedSource=await(await fetch(savedUrl)).text();
   const pcmUrl=savedSource.match(/from ["']([^"']*PcmStreamPlayer\.ts[^"']*)["']/)[1];
   const {PcmStreamPlayer}=await import(pcmUrl);
   const originalPlay=PcmStreamPlayer.prototype.play;
   window.sessions=[];
   PcmStreamPlayer.prototype.play=function(audio,signal,onStarted,startMs,onTime,...rest){
     const record={aborted:false,started:false,finished:false,time:0,context:this.context,startMs};window.sessions.push(record);
     this.gain.gain.value=.0001;
     signal.addEventListener('abort',()=>{record.aborted=true;},{once:true});
     return originalPlay.call(this,audio,signal,()=>{record.started=true;onStarted();},startMs,ms=>{record.time=ms;onTime(ms);},...rest).finally(()=>{record.finished=true;});
   };
   const {LoginModal}=await import('/src/features/auth/LoginModal.tsx');
   const {AppShell}=await import('/src/app/AppShell.tsx');
   const {default:ExploreScreen}=await import('/src/features/explore/ExploreScreen.tsx');
   const {default:LibraryScreen}=await import('/src/features/library/LibraryScreen.tsx');
   useAuthStore.setState({status:'authed',userId:'me',accessToken:'isolated-test-only'});
   window.testViewer='me';
   window.testIdentity=id=>{window.testViewer=id;useAuthStore.setState({status:id?'authed':'anonymous',userId:id,accessToken:id?'isolated-test-only':null});};
   window.testLoginSuccess=()=>{window.testViewer='me';useAuthStore.setState({status:'authed',userId:'me',accessToken:'isolated-test-only'});useAuthPrompt.getState().succeed();};
   const root=createRoot(document.querySelector('#root'));let shell=0;
   function RecordRoute(){window.navigateTest=useNavigate();window.testSearch=useLocation().search;const login=useAuthPrompt(s=>s.isOpen);return React.createElement(React.Fragment,null,React.createElement(AppShell),login?React.createElement(LoginModal):null);}
   window.showRealShell=()=>root.render(React.createElement(MemoryRouter,{key:++shell,initialEntries:['/library?q=nocturne']},React.createElement(Routes,null,
     React.createElement(Route,{element:React.createElement(RecordRoute)},React.createElement(Route,{path:'/explore',element:React.createElement(ExploreScreen)}),React.createElement(Route,{path:'/library',element:React.createElement(LibraryScreen)})),
     React.createElement(Route,{path:'/edit/:draftId',element:React.createElement('h1',null,'Editor fixture')}),React.createElement(Route,{path:'/scores/:scoreId',element:React.createElement('h1',null,'Reader fixture')}))));
   window.showRealShell();
 },{theme});
 const panel=page.locator('.preview-panel[data-open="true"]'),dock=page.locator('.now-playing-bar');
 const primary=(action,title='Nocturne')=>panel.locator('.preview-panel-actions').getByRole('button',{name:`${action} preview of ${title}`,exact:true});
 const settled=async(open=true)=>page.waitForFunction(open=>{
   const panel=document.querySelector('.preview-panel'),inner=panel?.querySelector('.preview-panel-inner');
   if(!panel||!inner||document.querySelector('.app-shell')?.classList.contains('panels-moving'))return false;
   const r=inner.getBoundingClientRect();return open?!panel.inert&&Math.abs(r.right-innerWidth)<.1&&panel.getBoundingClientRect().width>0:panel.inert&&panel.getBoundingClientRect().width<.1;
 },open);
 const open=async()=>{const card=page.locator('.piece-card').filter({has:page.getByText('Nocturne',{exact:true})});await card.focus();await page.keyboard.press('Enter');await panel.getByRole('heading',{name:'Nocturne',exact:true}).waitFor();await settled();};
 await open();
 assert.equal(await panel.locator('.preview-panel-composer').innerText(),'F. Chopin');
 assert.equal(await page.evaluate(()=>document.activeElement?.getAttribute('aria-label')),'Close preview and player');
 assert.equal(await panel.locator('.score-window-summary').count(),0,'restored structure, not the replacement metadata layout');
 assert.equal(await panel.getByRole('button',{name:'Edit details'}).count(),0);
 assert.equal(await panel.getByRole('button',{name:'Create your version'}).count(),0);
 assert.equal(await panel.getByRole('button',{name:'Delete'}).count(),0,'saved-score deletion is outside this package');
 await page.screenshot({path:`/private/tmp/score-window-restored-${engine}-${width}-${theme}.png`});
 await page.keyboard.press('Shift+Tab');await page.keyboard.press('Shift+Tab');
 assert.equal(await page.locator('.preview-panel').evaluate(el=>el.contains(document.activeElement)),false,'no panel Tab trap');
 // A pending map exposes cancellation without flashing a Stop glyph. No timer controls this state.
 const mapRequested=()=>new Promise(resolve=>{notifyPendingMap=resolve;});
 holdPlaybackMap=true;const firstMapRequested=mapRequested();
 await primary('Play').click();await firstMapRequested;const cancel=primary('Cancel loading');await cancel.waitFor();
 assert.ok(pendingPlaybackMap,'the real fetch is awaiting its map');
 assert.equal(await cancel.getAttribute('aria-busy'),'true');
 assert.equal(await cancel.locator('svg').count(),1);
 assert.equal(await cancel.locator('svg path').count(),1,'loading retains the editor-style Play glyph');
 assert.equal(await cancel.locator('svg rect').count(),0,'no Stop or premature Pause glyph while loading');
 await page.screenshot({path:`/private/tmp/preview-loading-${engine}-${width}-${theme}.png`});
 await cancel.click();await primary('Play').waitFor();
 assert.equal(await primary('Play').getAttribute('aria-busy'),'false');
 const cancelledMap=pendingPlaybackMap;pendingPlaybackMap=null;
 await cancelledMap.route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(cancelledMap.payload)});
 await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
 assert.equal(await page.evaluate(()=>window.sessions.length),0,'a cancelled map cannot launch audio after its late response');
 const mapReadsBeforePlay=requests.filter(r=>r==='GET /api/scores/saved/playback/map').length;
 await page.evaluate(()=>{
   window.previewIconViolations=[];
   const inspect=()=>{for(const button of document.querySelectorAll('.preview-play[aria-busy="true"]')){
     if(button.querySelectorAll('svg').length!==1||button.querySelector('svg rect'))window.previewIconViolations.push(button.outerHTML);
   }};
   window.previewIconObserver=new MutationObserver(inspect);window.previewIconObserver.observe(document.body,{subtree:true,attributes:true,childList:true});
 });
 const secondMapRequested=mapRequested();
 await primary('Play').focus();await page.keyboard.press('Enter');await secondMapRequested;await primary('Cancel loading').waitFor();
 assert.ok(pendingPlaybackMap);const startingMap=pendingPlaybackMap;pendingPlaybackMap=null;holdPlaybackMap=false;
 await startingMap.route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(startingMap.payload)});
 await primary('Pause').waitFor();
 assert.equal(await primary('Pause').getAttribute('aria-busy'),'false');
 assert.equal(await primary('Pause').locator('svg').count(),1);
 assert.equal(await primary('Pause').locator('svg rect[width="5"]').count(),2,'Pause only appears after playback starts');
 await page.waitForFunction(()=>window.sessions[0]?.time>80);
 await panel.getByRole('button',{name:'Collapse preview panel',exact:true}).click();await settled(false);
 await dock.getByText('Now playing',{exact:true}).waitFor();
 const beforeCollapsed=await page.evaluate(()=>window.sessions[0].time);
 await page.waitForFunction(before=>window.sessions[0].time>before+100,beforeCollapsed);
 assert.equal(await page.evaluate(()=>window.sessions[0].aborted),false,'collapse preserves the same output');
 await page.screenshot({path:`/private/tmp/score-window-mini-${engine}-${width}-${theme}.png`});
 await dock.getByRole('button',{name:'Pause preview of Nocturne',exact:true}).click();await dock.getByText('Paused',{exact:true}).waitFor();
 await page.waitForFunction(()=>window.sessions[0].context.state==='suspended');
 await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
 const paused=await page.evaluate(()=>window.sessions[0].time);await page.waitForTimeout(120);
 assert.equal(await page.evaluate(()=>window.sessions[0].time),paused);
 await dock.getByRole('button',{name:'Resume preview of Nocturne',exact:true}).click();await dock.getByText('Now playing',{exact:true}).waitFor();
 await page.waitForFunction(before=>window.sessions[0].time>before+50,paused);
 assert.equal(requests.filter(r=>r==='GET /api/scores/saved/playback/map').length,mapReadsBeforePlay+1,'resume does not restart synthesis');
 await dock.getByRole('button',{name:'Stop preview of Nocturne',exact:true}).click();
 await dock.waitFor({state:'detached'});
 await page.waitForFunction(()=>window.sessions[0].aborted&&window.sessions[0].finished);
 assert.equal(await dock.count(),0,'Stop finishes and dismisses the mini-player');
 await page.screenshot({path:`/private/tmp/score-window-stopped-${engine}-${width}-${theme}.png`});
 const startAgain=async()=>{
   await page.evaluate(()=>window.navigateTest('/library?q=nocturne&preview=saved'));
   await primary('Play').waitFor();await settled();await primary('Play').click();await primary('Pause').waitFor();
   await panel.getByRole('button',{name:'Collapse preview panel',exact:true}).click();await settled(false);
   await dock.getByText('Now playing',{exact:true}).waitFor();
 };
 await startAgain();await page.waitForFunction(()=>window.sessions.length===2&&window.sessions[1].time>80);
 assert.equal(await page.evaluate(()=>window.sessions[1].startMs),0,'new playback after Stop starts at zero');
 await dock.getByRole('button',{name:'Pause preview of Nocturne',exact:true}).click(); await dock.getByText('Paused',{exact:true}).waitFor();
 assert.equal(await dock.count(),1,'Pause keeps the mini-player and selected score');
 await dock.getByRole('button',{name:'Stop preview of Nocturne',exact:true}).click();await dock.waitFor({state:'detached'});
 await page.waitForFunction(()=>window.sessions[1].aborted&&window.sessions[1].finished);
 assert.equal(await dock.count(),0,'Stop while paused also dismisses the mini-player');
 await startAgain();await page.waitForFunction(()=>window.sessions.length===3&&window.sessions[2].time>80);
 assert.equal(await page.evaluate(()=>window.sessions[2].startMs),0);
 await page.waitForFunction(()=>document.querySelector('.now-playing-bar .time')?.textContent.trim().startsWith('0:01'));
 const miniGeometry=await dock.evaluate(el=>{const r=el.getBoundingClientRect();return {left:r.left,right:r.right,children:[...el.querySelectorAll('button,.time')].map(c=>{const b=c.getBoundingClientRect();return{left:b.left,right:b.right}})};});
 assert.ok(miniGeometry.left>=0&&miniGeometry.right<=width+1&&miniGeometry.children.every(c=>c.left>=miniGeometry.left&&c.right<=miniGeometry.right+1),'mini transport stays inside its frame');

 await dock.getByRole('button',{name:'Open Nocturne details',exact:true}).click();await settled();await primary('Pause').waitFor();
 assert.equal(await dock.count(),0,'open panel hides the duplicate mini-player');
 await page.getByRole('navigation',{name:'Main',exact:true}).getByRole('link',{name:'Explore',exact:true}).click();await settled();
 assert.equal(await page.evaluate(()=>window.sessions[2].aborted),false,'browse route switch preserves the audio session');
 assert.match(await page.evaluate(()=>window.testSearch),/preview=saved/);
 await page.evaluate(()=>window.navigateTest('/explore?q=nocturne&preview=study-2'));
 await panel.getByRole('heading',{name:'Nocturne study 3',exact:true}).waitFor();await settled();
 await primary('Play','Nocturne study 3').waitFor();assert.equal(await page.evaluate(()=>window.sessions[2].aborted),false,'viewing another score does not replace audio');
 await panel.getByRole('button',{name:'Collapse preview panel'}).click();await settled(false);
 await dock.getByRole('button',{name:'Open Nocturne details'}).click();await settled();await primary('Pause').waitFor();
 await panel.getByRole('button',{name:'Close preview and player'}).click();await settled(false);
 await page.waitForFunction(()=>window.sessions[2].aborted&&window.sessions[2].finished);assert.equal(await dock.count(),0);
 // A session cannot expose an old private score after the account changes.
 await page.evaluate(()=>window.navigateTest('/explore?q=nocturne&preview=saved'));await primary('Play').waitFor();await settled();
 await primary('Play').click();await primary('Pause').waitFor();
 const privateSession=await page.evaluate(()=>window.sessions.length-1);
 await panel.locator('.branch-row-main').filter({hasText:'My Nocturne'}).click();
 holdRead=true;await page.evaluate(()=>window.testIdentity(null));
 await panel.locator('.preview-panel-content[aria-busy="true"]').waitFor();
 assert.equal(await panel.getByRole('button',{name:/Back to original/}).count(),0,'old private parent metadata stays hidden while the new identity is checked');
 assert.equal(await panel.locator('.preview-panel-titleblock').count(),0);
 assert.ok(pendingRead);await pendingRead.fulfill({status:404,contentType:'application/json',body:JSON.stringify({detail:'Not found'})});holdRead=false;
 await panel.getByRole('alert').filter({hasText:'This score is unavailable.'}).waitFor();
 await page.waitForFunction(index=>window.sessions[index].aborted,privateSession);
 await panel.getByRole('button',{name:'Collapse preview panel'}).click();await settled(false);assert.equal(await dock.count(),0,'account change clears private playback and metadata');
 await page.evaluate(()=>window.testIdentity('me'));
 await page.evaluate(()=>window.navigateTest('/explore?q=nocturne&preview=saved'));await settled();
 await panel.getByRole('button',{name:/Back to original/}).click();await primary('Play').waitFor();
 await panel.getByRole('button',{name:'Close preview and player'}).click();await settled(false);
 // Branch selection and completed Replay keep the original panel identity across collapse/reopen.
 await page.evaluate(()=>window.navigateTest('/explore?q=nocturne&preview=saved'));await primary('Play').waitFor();await settled();
 await panel.locator('.branch-row').getByRole('button',{name:'Play preview of My Nocturne',exact:true}).click();
 await panel.locator('.branch-row').getByRole('button',{name:'Replay preview of My Nocturne',exact:true}).waitFor();
 await panel.locator('.branch-row-main').filter({hasText:'My Nocturne'}).click();await primary('Replay','My Nocturne').waitFor();
 await panel.getByRole('button',{name:'Collapse preview panel'}).click();await settled(false);
 await dock.getByText('Preview finished',{exact:true}).waitFor();await dock.getByRole('button',{name:'Open My Nocturne details'}).click();await settled();
 await primary('Replay','My Nocturne').waitFor();assert.match(await page.evaluate(()=>window.testSearch),/preview=saved/);
 await page.screenshot({path:`/private/tmp/score-window-version-${engine}-${width}-${theme}.png`});
 await panel.getByRole('button',{name:/Back to original/}).click();await primary('Play').waitFor();
 // The original panel retained the selected version when another parent was briefly viewed.
 versionExtent=30000;
 await panel.locator('.branch-row-main').filter({hasText:'My Nocturne'}).click();
 await primary('Replay','My Nocturne').click();await primary('Pause','My Nocturne').waitFor();
 await page.evaluate(()=>window.navigateTest('/explore?q=nocturne&preview=study-2'));
 await panel.getByRole('heading',{name:'Nocturne study 3',exact:true}).waitFor();await settled();
 await panel.getByRole('button',{name:'Collapse preview panel'}).click();await settled(false);
 await dock.getByRole('button',{name:'Open My Nocturne details'}).click();await settled();
 await panel.getByRole('heading',{name:'My Nocturne',exact:true}).waitFor();await primary('Pause','My Nocturne').waitFor();
 await panel.getByRole('button',{name:'Close preview and player'}).click();await settled(false);
 await page.evaluate(()=>window.navigateTest('/explore?q=nocturne&preview=saved'));await settled();
 await panel.getByRole('button',{name:/Back to original/}).click();await primary('Play').waitFor();
 const privacy=panel.getByRole('radiogroup',{name:'Score privacy',exact:true});
 await privacy.getByRole('radio',{name:'Public',exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('.preview-panel-privacy')?.disabled);
 assert.equal(await panel.getByRole('button',{name:'Open in editor',exact:true}).isDisabled(),true,'privacy save disables editing without pretending to open a draft');
 assert.ok(pendingPrivacy);await pendingPrivacy.fulfill({status:503,contentType:'application/json',body:JSON.stringify({detail:'Privacy write rejected'})});
 await panel.getByRole('alert').filter({hasText:'Privacy write rejected'}).waitFor();
 assert.equal(await privacy.getByRole('radio',{name:'Private',exact:true}).getAttribute('aria-checked'),'true');
 await privacy.getByRole('radio',{name:'Public',exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('[aria-label="Score privacy"] [aria-checked="true"]')?.textContent==='Public');
 assert.deepEqual(writes,[{is_public:true},{is_public:true}]);
 await page.keyboard.press('Escape');await settled(false);assert.equal(await dock.count(),0,'full close clears retained Replay too');
 for(const id of ['study-0','study-1']){
   await page.evaluate(id=>window.navigateTest(`/explore?q=nocturne&preview=${id}`),id);
   await panel.getByRole('heading',{name:studies[Number(id.slice(6))].title,exact:true}).waitFor();await settled();
   assert.equal(await panel.locator('.preview-panel-composer').count(),0,'blank composer does not reserve a row');
   await page.keyboard.press('Escape');await settled(false);
 }
 // A late read cannot restore a panel that has been closed or launch a stale score.
 holdRead=true;await page.evaluate(()=>window.navigateTest('/explore?q=nocturne&preview=saved'));
 await panel.locator('.preview-panel-content[aria-busy="true"]').waitFor();assert.equal(await panel.locator('.preview-panel-actions .preview-play').isDisabled(),true);
 await page.keyboard.press('Escape');await settled(false);assert.ok(pendingRead);
 await pendingRead.fulfill({status:200,contentType:'application/json',body:JSON.stringify(saved)});holdRead=false;
 await page.evaluate(()=>window.navigateTest('/explore?q=nocturne&preview=missing'));
 await panel.getByRole('alert').filter({hasText:'This score is unavailable.'}).waitFor();assert.equal(await panel.locator('.preview-play').count(),0);
 await page.keyboard.press('Escape');await settled(false);
 await page.evaluate(()=>window.testIdentity('other'));await page.evaluate(()=>window.navigateTest('/explore?q=nocturne&preview=saved'));
 await primary('Play').waitFor();assert.equal(await panel.getByRole('radiogroup',{name:'Score privacy'}).count(),0);
 await page.keyboard.press('Escape');await settled(false);
 await page.evaluate(()=>window.testIdentity(null));await page.evaluate(()=>window.navigateTest('/explore?q=nocturne&preview=saved'));
 await primary('Play').waitFor();await panel.locator('.branch-row-main').filter({hasText:'My Nocturne'}).click();
 await primary('Play','My Nocturne').waitFor();
 const draftsBeforeReading=requests.filter(r=>r.startsWith('POST /api/drafts')).length;
 await panel.getByRole('button',{name:'Open score',exact:true}).click();
 await page.getByRole('heading',{name:'Reader fixture',exact:true}).waitFor();
 assert.equal(requests.filter(r=>r.startsWith('POST /api/drafts')).length,draftsBeforeReading,'Open score never creates a working copy');
 assert.equal(await page.getByRole('dialog').count(),0,'public reading does not prompt sign-in');
 await page.evaluate(()=>window.showRealShell());
 await page.evaluate(()=>window.navigateTest('/explore?q=nocturne&preview=saved'));await primary('Play').waitFor();await settled();
 await panel.locator('.branch-row-main').filter({hasText:'My Nocturne'}).click();await primary('Play','My Nocturne').waitFor();
 await panel.getByRole('button',{name:'Open in editor',exact:true}).click();
 await page.getByRole('dialog').filter({hasText:'Sign in'}).waitFor();assert.equal(await panel.evaluate(el=>el.inert),true);
 await page.evaluate(()=>window.testLoginSuccess());await page.getByRole('heading',{name:'Editor fixture',exact:true}).waitFor();
 assert.equal(requests.filter(r=>r==='POST /api/drafts/from-score/version').length,1,'sign-in continuation opens the selected branch, not its parent');
 await page.waitForFunction(()=>window.sessions.every(session=>session.context.state==='closed'));
 await page.evaluate(()=>window.showRealShell());await open();
 const main=page.locator('.app-shell-content'),panelWidth=await page.locator('.preview-panel-inner').evaluate(el=>el.offsetWidth);
 const after=await main.boundingBox();await page.keyboard.press('Escape');await settled(false);const before=await main.boundingBox();
 assert.ok(Math.abs(before.width-after.width-(width>=1080?panelWidth:0))<.1,'same wide column/narrow overlay behavior');
 await open();
 for(const captureTheme of ['light','dark']){
   await page.evaluate(async value=>{document.documentElement.dataset.theme=value;document.body.getBoundingClientRect();await Promise.all(document.getAnimations().filter(a=>a instanceof CSSTransition).map(a=>a.finished.catch(()=>{})));},captureTheme);
   await page.screenshot({path:`/private/tmp/score-window-shell-${engine}-${width}-${captureTheme}.png`});
 }
 await page.evaluate(value=>{document.documentElement.dataset.theme=value;},theme);
 assert.equal(await panel.getByRole('button',{name:'Close preview and player'}).evaluate(el=>{const r=el.getBoundingClientRect();return el.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));}),true);
 // The panel is the same fixed-width surface through rapid reversals; only its slot reflows.
 await page.evaluate(()=>window.navigateTest('/explore?q=nocturne&preview=saved'));
 await panel.getByRole('heading',{name:'Nocturne',exact:true}).waitFor(); await settled();
 const quietRight = await page.evaluate(async () => {
   const pane=document.querySelector('.preview-panel'),inner=pane.querySelector('.preview-panel-inner');
   const reduce=matchMedia('(prefers-reduced-motion:reduce)').matches; let min=1,max=0,reversals=0,maxEdgeGap=0;
   for(const opening of [false,true]){
     window.navigateTest(opening?'/explore?q=nocturne&preview=saved':'/explore?q=nocturne');
     let previous=opening?0:1;
     for(let frame=0;frame<60;frame++){
       await new Promise(requestAnimationFrame);
       const r=inner.getBoundingClientRect(),slot=pane.getBoundingClientRect();
       const progress=reduce?slot.width/r.width:(innerWidth-r.left)/r.width;
       min=Math.min(min,progress);max=Math.max(max,progress);
       if((opening?progress-previous:previous-progress)<-.001)reversals++;
       previous=progress;
       if(!reduce&&matchMedia('(min-width:67.5em)').matches)maxEdgeGap=Math.max(maxEdgeGap,Math.abs(document.querySelector('.app-shell-content').getBoundingClientRect().right-r.left));
     }
   }
   return{min,max,reversals,maxEdgeGap};
 });
 assert.ok(quietRight.min>=-.001&&quietRight.max<=1.001,JSON.stringify(quietRight));
 assert.equal(quietRight.reversals,0,'right panel has no recoil or anticipation kick');
 assert.ok(quietRight.maxEdgeGap<.1,JSON.stringify(quietRight)); await settled();
 console.log(`PASS ${engine}/${width}: right panel is monotonic, stays in range and moves on the same edge as the list`);

 const motion = await page.evaluate(async () => {
   const pane=document.querySelector('.preview-panel'),inner=pane.querySelector('.preview-panel-inner'),main=document.querySelector('.app-shell-content');
   const fixed=inner.offsetWidth, wide=matchMedia('(min-width:67.5em)').matches;
   const baseWidth=main.getBoundingClientRect().width+(wide?pane.getBoundingClientRect().width:0);
   let maxWidthError=0,maxLayoutError=0,maxVisibleStep=0,maxOvershoot=0,previous=null,blank=0;
   for(let frame=0;frame<130;frame++){
     if([0,12,24,36].includes(frame))window.navigateTest(frame===0||frame===24?'/explore?q=nocturne':'/explore?q=nocturne&preview=saved');
     await new Promise(requestAnimationFrame);
     const p=pane.getBoundingClientRect(),r=inner.getBoundingClientRect(),m=main.getBoundingClientRect();
     maxWidthError=Math.max(maxWidthError,Math.abs(r.width-fixed));
     const progress=matchMedia('(prefers-reduced-motion:reduce)').matches?p.width/fixed:(innerWidth-r.left)/fixed;
     maxOvershoot=Math.max(maxOvershoot,-progress,progress-1);
     maxLayoutError=Math.max(maxLayoutError,Math.abs(m.width+(wide?p.width:0)-baseWidth),Math.max(0,p.width-fixed),Math.max(0,-p.width));
     const close=inner.querySelector('[aria-label="Close preview and player"]').getBoundingClientRect();
     const point={x:close.x+close.width/2,y:close.y+close.height/2,visible:close.x+close.width/2>=0&&close.x+close.width/2<=innerWidth};
     if(previous?.visible&&point.visible)maxVisibleStep=Math.max(maxVisibleStep,Math.hypot(point.x-previous.x,point.y-previous.y));
     previous=point;if(!inner.querySelector('h2'))blank++;
   }
   return{maxWidthError,maxLayoutError,maxVisibleStep,maxOvershoot,blank};
 });
 assert.ok(motion.maxWidthError<.1&&motion.maxLayoutError<.1,JSON.stringify(motion));
 assert.ok(motion.maxVisibleStep<=70,JSON.stringify(motion)); assert.equal(motion.blank,0,'content remains while the panel reverses');
 assert.ok(motion.maxOvershoot<.001,'rapid right-panel reversals stay within their endpoints');
 await settled(); await panel.getByRole('button',{name:'Close preview and player'}).click(); await settled(false);
 assert.equal(await page.locator('.preview-panel').evaluate(element=>element.inert),true);
 // Open a visible card after scrolling; closing must retain the list's place.
 const scrollport=page.locator('.shell-outlet');
 await scrollport.evaluate(element=>{element.scrollTop=500;});
 const anchor=await page.evaluate(()=>{
   const port=document.querySelector('.shell-outlet'),r=port.getBoundingClientRect();
   const card=[...port.querySelectorAll('.piece-card')].find(element=>{const c=element.getBoundingClientRect();return c.top>r.top&&c.bottom<r.bottom;});
   if(!card)throw new Error('No visible scroll anchor');card.dataset.sidebarAnchor='true';
   card.focus({preventScroll:true});return{title:card.querySelector('.piece-card-title')?.textContent,scroll:port.scrollTop};
 });
 await page.keyboard.press('Enter'); await panel.getByRole('heading',{name:anchor.title,exact:true}).waitFor(); await settled();
 await panel.getByRole('button',{name:'Close preview and player'}).click(); await settled(false);
 assert.ok(Math.abs(await scrollport.evaluate(element=>element.scrollTop)-anchor.scroll)<2,'closing restores the same list scroll position');
 assert.equal(await page.locator('[data-sidebar-anchor]').evaluate(element=>element===document.activeElement),true,'focus returns without scrolling');
 assert.equal(await page.evaluate(()=>window.testSearch),'?q=nocturne');

 assert.equal(requests.filter(r=>r.includes('/metadata')||(r.startsWith('POST')&&r.endsWith('/branches'))||r.startsWith('DELETE')).length,0,'only privacy is added to the restored panel');
 assert.deepEqual(await page.evaluate(()=>window.previewIconViolations),[],'no square flash on any preview loading transition');
 assert.deepEqual(errors,[]);
 console.log(`PASS ${engine}/${width}/${theme}: original panel/dock, local synth output, one-map pause/resume, branch Replay/reopen, privacy rejection/retry, owner controls, branch auth continuation and cleanup`);
} finally { await browser.close(); }
