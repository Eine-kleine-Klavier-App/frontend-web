import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const ts = require('typescript');
const requests = [];
let response = () => new Response(JSON.stringify({ score_id: 'saved-id' }), { status: 200 });
const module = { exports: {} };
const code = ts.transpileModule(fs.readFileSync(new URL('../src/core/gateway/HttpLibraryGateway.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
vm.runInNewContext(code, { module, exports: module.exports, require(name) {
  if (name === '@/core/model/fromView') return { fromView() { throw new Error('Document mapping belongs to the reading gateway test.'); } };
  if (name === './apiBase') return { API_BASE: '/api' };
  if (name === '@/core/auth/authorizedFetch') return { authorizedFetch: async (url, options) => { requests.push({ url, options }); return response(); } };
  throw new Error(name);
}, console });
const gateway = new module.exports.HttpLibraryGateway();
assert.equal((await gateway.saveDraftAsScore('draft / id', { title: 'Nocturne', composer: null, isPublic: false })).scoreId, 'saved-id');
assert.equal(requests[0].url, '/api/drafts/draft%20%2F%20id/branches');
assert.deepEqual(JSON.parse(requests[0].options.body), { title: 'Nocturne', composer: null, is_public: false });
assert.equal((await gateway.promoteDraft('owned')).scoreId, 'saved-id');
assert.equal(requests[1].url, '/api/drafts/owned/promote');
assert.equal(requests[1].options.method, 'POST');
assert.equal(requests[1].options.body, undefined);
await gateway.saveDraftAsScore('publish', { title: 'Public score', composer: null, isPublic: true });
assert.equal(JSON.parse(requests[2].options.body).is_public, true);
response = () => new Response(JSON.stringify({ detail: 'Saving was rejected' }), { status: 403 });
await assert.rejects(gateway.promoteDraft('foreign'), /Saving was rejected/);
await assert.rejects(gateway.saveDraftAsScore('draft', { title: 'X', composer: null, isPublic: false }), /Saving was rejected/);
console.log('PASS saving gateway: explicit privacy choices and rejected writes');

// Browser fixtures intercept every API request; no token or write reaches the running backend.
if (!process.env.PLAYWRIGHT_MODULE_PATH) {
  console.log('Browser scenarios: set PLAYWRIGHT_MODULE_PATH and optional ENGINE=webkit|chromium against an existing Vite server.');
  process.exit(0);
}
const playwright = require(process.env.PLAYWRIGHT_MODULE_PATH), engine = process.env.ENGINE || 'webkit';
const browser = await playwright[engine].launch({ headless: true, ...(engine === 'chromium' && process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });
try {
  for (const mode of ['new', 'new-public', 'owned', 'foreign'].filter(mode => !process.env.SAVE_SCENARIO || mode === process.env.SAVE_SCENARIO)) {
    const width = Number(process.env.TEST_WIDTH || 1440), theme = process.env.TEST_THEME || 'light';
    const shot = `/private/tmp/editor-save-${engine}-${mode}-${width}-${theme}`;
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    const events = [], exceptions = [];
    page.on('pageerror', error => { exceptions.push(error.message); console.error('Browser exception:', error.message); });
    const scoreDto = (id, author, title) => ({ id, author_id: author, title, composer: null, author_name: 'Test author', is_public: false, updated_at: '2026-11-10T00:00:00Z' });
    let created = false, openAttempts = 0, promotes = 0;
    const fresh = mode.startsWith('new'), publish = mode === 'new-public';
    await page.exposeFunction('recordSaveFlush', () => events.push('flush'));
    await page.route('**/api/**', async route => {
      const request = route.request(), url = new URL(request.url()), path = url.pathname;
      const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
      if (path === '/api/drafts' && request.method() === 'GET') return json([
        { draft_id: 'working', title: fresh ? 'Untitled' : 'Original title', ref_score_id: fresh ? null : 'original', updated_at: '2026-11-11T00:00:00Z' },
        ...(created ? [{ draft_id: 'saved-copy', title: 'Nocturne', ref_score_id: 'saved-score', updated_at: '2026-11-11T00:00:00Z' }] : []),
      ]);
      if (path === '/api/scores') return json({ items: created && publish ? [{ ...scoreDto('saved-score', 'me', 'Nocturne'), is_public: true }] : [], next_cursor: null });
      if (path === '/api/scores/mine') return json({ items: created ? [{ ...scoreDto('saved-score', 'me', 'Nocturne'), is_public: publish }] : [], next_cursor: null });
      if (path === '/api/scores/original') return json({ ...scoreDto('original', mode === 'owned' ? 'me' : 'another-author', 'Original title'), is_public: mode === 'foreign' });
      if (path === '/api/scores/saved-score') return json({ ...scoreDto('saved-score', 'me', 'Nocturne'), is_public: publish });
      if (path === '/api/drafts/working/branches') {
        events.push('create');
        assert.equal(mode === 'owned', false, 'owned scores must not create a branch');
        assert.deepEqual(request.postDataJSON(), { title: 'Nocturne', composer: null, is_public: publish });
        created = true; return json({ score_id: 'saved-score' }, 201);
      }
      if (path === '/api/drafts/from-score/saved-score') {
        events.push('open'); openAttempts++;
        return openAttempts === 1 ? json({ detail: 'Temporary opening failure' }, 503) : json({ draft_id: 'saved-copy', document: {} }, 201);
      }
      if (path === '/api/drafts/working/promote' || path === '/api/drafts/saved-copy/promote') {
        events.push('promote'); promotes++;
        assert.notEqual(mode === 'foreign' && path.includes('/working/'), true, 'another author must never be overwritten');
        return promotes === 1 ? json({ detail: 'Temporary saving failure' }, 503) : json({ score_id: mode === 'owned' ? 'original' : 'saved-score' });
      }
      throw new Error(`Unexpected test request ${request.method()} ${path}`);
    });
    await page.route('**/__save_test__', route => route.fulfill({ contentType: 'text/html', body: '<link rel="stylesheet" href="/src/styles/tokens.css"><link rel="stylesheet" href="/src/index.css"><div id="root"></div>' }));
    await page.goto(new URL('/__save_test__', process.env.VITE_URL || 'http://localhost:5173').href);
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    await page.evaluate(async () => {
      const Refresh = await import('/@react-refresh');
      Refresh.default.injectIntoGlobalHook(window);
      window.$RefreshReg$ = () => {}; window.$RefreshSig$ = () => (type) => type;
      window.__vite_plugin_react_preamble_installed__ = true;
      const componentSource = await (await fetch('/src/features/editor/EditorDocumentActions.tsx')).text();
      const reactModule = await import(componentSource.match(/from ["']([^"']*\/react\.js[^"']*)["']/)[1]);
      const React = reactModule.default ?? reactModule;
      const clientModule = await import('/node_modules/.vite/deps/react-dom_client.js');
      const { createRoot } = clientModule.default ?? clientModule;
      const routerUrl = componentSource.match(/from [\"']([^\"']*react-router-dom[^\"']*)[\"']/)[1];
      const routerModule = await import(routerUrl);
      const { MemoryRouter, Routes, Route, useNavigate, useLocation } = routerModule.default ?? routerModule;
      const { default: EditorScreen } = await import('/src/features/editor/EditorScreen.tsx');
      const { default: LibraryScreen } = await import('/src/features/library/LibraryScreen.tsx');
      const { default: ExploreScreen } = await import('/src/features/explore/ExploreScreen.tsx');
      const view = await (await fetch('/demo-editor-view.json')).json();
      const { fromView } = await import('/src/core/model/fromView.ts');
      const { useAuthStore } = await import(componentSource.match(/from [\"']([^\"']*\/auth\/authStore\.ts[^\"']*)[\"']/)[1]);
      const { useEditor } = await import(componentSource.match(/from [\"']([^\"']*\/app\/store\.ts[^\"']*)[\"']/)[1]);
      useAuthStore.setState({ status: 'authed', userId: 'me', accessToken: 'isolated-test-only' });
      const { QueuedGateway } = await import('/src/core/gateway/QueuedGateway.ts');
      let releaseEdit;
      useEditor.setState({ gateway: new QueuedGateway({
        async load() { await window.recordSaveFlush(); return useEditor.getState().document; },
        async apply() { await new Promise(resolve => { releaseEdit = resolve; }); return { ...useEditor.getState().document, musicRevision: useEditor.getState().document.musicRevision + '-queued' }; },
      }) });
      window.beginPendingEdit = () => { const s = useEditor.getState(); s.setLocked(false); void s.dispatch({ type: 'editPresentation', changes: [] }); };
      window.completePendingEdit = () => releaseEdit();
      window.changeScoreContent = () => {
        const state = useEditor.getState();
        useEditor.setState({ document: { ...state.document, musicRevision: state.document.musicRevision + '-edited' } });
      };
      window.replaceScoreResponse = () => {
        const state = useEditor.getState();
        useEditor.setState({ document: fromView(view, state.scoreId) });
      };
      function View() {
        const path = useLocation().pathname;
        React.useLayoutEffect(() => {
          if (path.startsWith('/edit/')) useEditor.setState({ document: fromView(view, path.split('/').at(-1)), loading: false });
        }, [path]);
        window.testPath = useLocation().pathname; window.navigateTest = useNavigate();
        return React.createElement(Routes, null,
          React.createElement(Route, { path: '/edit/:draftId', element: React.createElement(EditorScreen) }),
          React.createElement(Route, { path: '/library', element: React.createElement(LibraryScreen) }),
          React.createElement(Route, { path: '/explore', element: React.createElement(ExploreScreen) }),
        );
      }
      createRoot(document.querySelector('#root')).render(React.createElement(MemoryRouter, { initialEntries: ['/explore'] }, React.createElement(View)));

    });
    await page.getByText('No published scores yet', { exact: true }).waitFor();
    await page.evaluate(() => window.navigateTest('/edit/working'));
    await page.waitForFunction(() => { const button = document.querySelector('.document-save'); return button && !button.disabled; }, null, { timeout: 10000 }).catch(async error => { console.error('Save fixture state:', await page.evaluate(() => ({ html: document.body.innerHTML, path: window.testPath }))); throw error; });
    if (mode !== 'owned') {
      if (fresh) await page.keyboard.press('Meta+s');
      else await page.getByRole('button', { name: 'Save', exact: true }).click();
      const dialog = page.getByRole('dialog'); await dialog.waitFor();
      await dialog.getByLabel('Title', { exact: true }).fill('   ');
      assert.equal(await dialog.getByRole('button', { name: 'Save', exact: true }).isDisabled(), true);
      await dialog.getByLabel('Title', { exact: true }).fill(' Nocturne ');
      const visibility = dialog.getByRole('radiogroup', { name: 'Score privacy' });
      assert.equal(await visibility.getByRole('radio', { checked: true }).count(), 0, 'creation has no default privacy');
      assert.equal(await visibility.getAttribute('aria-required'), 'true');
      assert.equal(await dialog.getByRole('button', { name: 'Save', exact: true }).isDisabled(), true);
      await page.keyboard.press('Meta+s');
      assert.equal(events.filter(item => item === 'create').length, 0, 'shortcut cannot bypass the explicit choice');
      await visibility.getByRole('radio', { name: publish ? 'Public' : 'Private', exact: true }).click();
      await page.screenshot({ path: `${shot}-dialog.png` });
      await dialog.getByRole('button', { name: 'Save', exact: true }).click();
      await dialog.getByText(/The score was saved, but/).waitFor();
      assert.equal(events.filter(item => item === 'create').length, 1);
      assert.equal(await dialog.getByLabel('Title', { exact: true }).isDisabled(), true);
      await dialog.getByRole('button', { name: 'Open saved score', exact: true }).click();
      await page.waitForFunction(() => window.testPath === '/edit/saved-copy');
      await page.waitForFunction(() => document.querySelector('.document-save')?.textContent === 'Saved', null, { timeout: 10000 });
      assert.equal(events.filter(item => item === 'create').length, 1, 'opening retry must not create another saved score');
      assert.equal(await page.locator('.editor-bar .title').textContent(), 'Nocturne');
      assert.equal(await page.locator('.sheet-title h1').textContent(), 'Nocturne', 'the actual paper uses the saved metadata title');
      await page.evaluate(() => window.replaceScoreResponse());
      assert.equal(await page.locator('.sheet-title h1').textContent(), 'Nocturne', 'subsequent score responses do not reset its title to Untitled');
      await page.screenshot({ path: `${shot}-paper.png` });
    }
    await page.evaluate(() => window.changeScoreContent());
    const saveWidth = (await page.locator('.document-save').boundingBox()).width;
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: 'Temporary saving failure' }).waitFor();
    assert.equal(promotes, 1);
    await page.evaluate(() => { const button = document.querySelector('.document-save'); button.click(); button.click(); button.click(); });
    await page.locator('.document-save').filter({ hasText: 'Saved' }).waitFor();
    assert.equal(await page.locator('.document-action-notice[role="status"]').count(), 0, 'success stays on the save button');
    assert.equal(await page.locator('.document-save').isDisabled(), false);
    assert.equal(promotes, 2, 'repeated presses during the same save produce only one request');
    assert.equal((await page.locator('.document-save').boundingBox()).width, saveWidth, 'Save/Saved width is stable');
    await page.keyboard.press('Meta+s');
    await page.waitForFunction(() => document.querySelector('.document-save')?.textContent === 'Saved');
    assert.equal(promotes, 2, 'already-saved shortcut makes no extra request');
    await page.evaluate(() => window.beginPendingEdit());
    await page.keyboard.press('Meta+s');
    await page.locator('.document-save').filter({ hasText: 'Saving…' }).waitFor();
    assert.equal((await page.locator('.document-save').boundingBox()).width, saveWidth, 'Saving width is stable');
    assert.equal(promotes, 2, 'save waits for the pending edit');
    await page.evaluate(() => window.completePendingEdit());
    await page.locator('.document-save').filter({ hasText: 'Saved' }).waitFor();
    assert.equal(promotes, 3, 'Cmd+S while Saved must include an in-flight edit');
    await page.screenshot({ path: `${shot}-saved.png` });
    const headerRects = await page.evaluate(() => ['.bar-back', '.document-save', '.bar-history > .choice'].map(selector => document.querySelector(selector).getBoundingClientRect().toJSON()));
    for (let a = 0; a < headerRects.length; a++) for (let b = a + 1; b < headerRects.length; b++) {
      const x = Math.min(headerRects[a].right, headerRects[b].right) - Math.max(headerRects[a].left, headerRects[b].left);
      const y = Math.min(headerRects[a].bottom, headerRects[b].bottom) - Math.max(headerRects[a].top, headerRects[b].top);
      assert.ok(x <= 0 || y <= 0, 'Save, Back and view tabs must not overlap: ' + JSON.stringify(headerRects));
    }
    await page.screenshot({ path: `${shot}-saved.png` });
    await page.evaluate(() => window.changeScoreContent());
    await page.getByRole('button', { name: 'Save', exact: true }).waitFor();
    for (let index = 0; index < events.length; index++) if (events[index] === 'create' || events[index] === 'promote') assert.equal(events[index - 1], 'flush', 'save must wait for queued edits');
    await page.getByRole('link', { name: 'Back to Library', exact: true }).click();
    const workingCard = page.locator('.work-card').filter({ hasText: mode === 'owned' ? 'Original title' : 'Nocturne' }).first();
    await workingCard.waitFor();
    assert.equal(await page.locator('.work-card-kind').count(), 0, 'all working copies share one unlabelled card');
    if (fresh) await page.locator('.work-card').filter({ hasText: 'Untitled' }).waitFor();
    await page.waitForFunction(() => { let element = document.querySelector('.piece-card'); if (!element) return true; for (; element; element = element.parentElement) if (Number(getComputedStyle(element).opacity) < .99) return false; return true; });
    await page.screenshot({ path: `${shot}-library.png` });
    await page.evaluate(() => window.navigateTest('/explore'));
    if (publish) await page.locator('.piece-card-title').filter({ hasText: 'Nocturne' }).waitFor();
    else await page.getByText('No published scores yet', { exact: true }).waitFor();
    await page.waitForFunction(() => { let element = document.querySelector('.explore'); if (!element) return false; for (; element; element = element.parentElement) if (Number(getComputedStyle(element).opacity) < .99) return false; const card = document.querySelector('.piece-card'); if (card) for (let part = card; part; part = part.parentElement) if (Number(getComputedStyle(part).opacity) < .99) return false; return true; });
    await page.screenshot({ path: `${shot}-explore.png` });
    assert.deepEqual(exceptions, []);
    console.log(`PASS ${engine} ${mode}: one Save action, queued edits, failure/retry, no duplicate creation or foreign overwrite`);
    await page.close();
  }
} finally { await browser.close(); }
