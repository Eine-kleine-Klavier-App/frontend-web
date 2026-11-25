import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, readFile } from 'node:fs/promises';

const require = createRequire(import.meta.url);
const {
  PLAYWRIGHT_MODULE_PATH, ENGINE = 'chromium', VITE_URL = 'http://localhost:5173',
  TEST_WIDTH = '1440', TEST_THEME = 'light', REDUCED_MOTION, SCORE_FIXTURE, TEST_OUTPUT,
} = process.env;
assert.ok(PLAYWRIGHT_MODULE_PATH, 'Set PLAYWRIGHT_MODULE_PATH to the installed Playwright package.');
const { [ENGINE]: engine } = require(PLAYWRIGHT_MODULE_PATH);
const readJson = async path => JSON.parse(await readFile(path, 'utf8'));
const fixture = SCORE_FIXTURE ? await readJson(SCORE_FIXTURE) : {
  view: await readJson(new URL('../demo-editor-view.json', import.meta.url)),
  map: { version: 1, extent_ms: 0, notes: [], anchors: [], segments: [], pedals: [] },
};
const viewport = { width: Number(TEST_WIDTH), height: 900 };
const token = `isolated.${Buffer.from(JSON.stringify({ sub: 'test-user' })).toString('base64url')}.isolated`;
const saved = {
  id: 'transition-score', title: 'Transition score', composer: null, author_id: 'test-user',
  author_name: 'Test musician', is_public: true, updated_at: '2026-11-19T00:00:00Z',
};
const draftId = 'transition-draft';
const draft = { draft_id: draftId, title: 'Transition draft', ref_score_id: saved.id, updated_at: saved.updated_at };
const { view, map } = fixture;

// This isolated HTTP fixture preserves the server's wire shape and reconstructs
// its complete document in DraftSync. These cases exercise reads and navigation.
const presentation = { vertical: [], endpoints: [], directions: [], horizontal: [], horizontal_endpoints: [] };
const firstMeasure = view.measures[0];
const draftSync = {
  sync: {
    from_version: null, to_version: 1,
    header: {
      music_revision: view.music_revision, staffs: view.staffs, voice_ids: view.voices.map(voice => voice.id),
      measure_ids: view.measures.map(measure => measure.id),
      presentation: { ...presentation, ...view.presentation }, presentation_capabilities: view.presentation_capabilities ?? [],
    },
    measures: view.measures.map(measure => ({
      measure, voice_roots: measure === firstMeasure
        ? view.voices.map(voice => ({ voice_id: voice.id, rhythmic_container_ids: voice.rhythmic_container_ids })) : [],
      rhythmic_containers: measure === firstMeasure ? view.rhythmic_containers : [],
      carriers: measure === firstMeasure ? view.carriers : [],
      items: measure === firstMeasure ? view.items : [],
      relations: measure === firstMeasure ? view.relations : [],
      contexts: measure === firstMeasure ? view.contexts ?? [] : [],
      insertion_spaces: measure === firstMeasure ? view.insertion_spaces ?? [] : [],
      presentation, presentation_capabilities: [],
    })),
    removed: [], sounds: [{
      measure_id: firstMeasure.id, strikes: [], notes: map.notes, anchors: map.anchors,
    }],
    timing: { extent_ms: map.extent_ms, pedals: map.pedals, segments: map.segments }, sound_error: null,
  },
};

function hold() {
  let release;
  let reached;
  return {
    waiting: new Promise(resolve => { release = resolve; }),
    requested: new Promise(resolve => { reached = resolve; }),
    release: () => release(),
    markRequested: () => reached(),
  };
}

const browser = await engine.launch({
  headless: true,
  ...(ENGINE === 'chromium' ? { args: ['--use-angle=metal', '--enable-gpu', '--mute-audio'] } : {}),
});
try {
  const page = await browser.newPage({
    viewport, colorScheme: TEST_THEME, reducedMotion: REDUCED_MOTION ? 'reduce' : 'no-preference',
  });
  page.setDefaultTimeout(12000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(theme => localStorage.setItem('piano-theme', theme), TEST_THEME);
  const gates = new Map();
  let rejectMap = false;
  const arm = path => {
    const pending = hold();
    gates.set(path, pending);
    return pending;
  };
  await page.route('**/api/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const gate = gates.get(path);
    if (gate) {
      gate.markRequested();
      await gate.waiting;
    }
    const reply = (json, status = 200) => route.fulfill({ json, status });
    if (path === '/api/auth/refresh') return reply({ access_token: token });
    if (path === '/api/auth/me') return reply({ user_id: 'test-user', username: 'Test musician' });
    if (path === '/api/drafts/from-score/' + saved.id && request.method() === 'POST') return reply(draft, 201);
    if (path === '/api/drafts') return reply([draft]);
    if (path === '/api/drafts/' + draftId) return reply(draftSync);
    if (path === '/api/scores/' + saved.id + '/playback/map') return rejectMap
      ? reply({ detail: 'Map test rejection' }, 503) : reply(map);
    if (path === '/api/scores/' + saved.id) return reply({ ...saved, document: view });
    if (path === '/api/scores/missing-score') return reply({ detail: 'Score not found' }, 404);
    if (path === '/api/scores' || path === '/api/scores/mine') return reply({ items: [saved], next_cursor: null });
    if (path === '/api/collections') return reply([]);
    if (path.endsWith('/branches') || path.endsWith('/scores')) return reply({ items: [], next_cursor: null });
    return reply([]);
  });

  const root = '.route-transition-root';
  const outlet = '.shell-outlet';
  const stage = selector => page.locator(`${selector} > .page-transition-layer[data-layer="base"]`);
  const settled = selector => page.waitForFunction(selector =>
    document.querySelector(selector)?.querySelectorAll(':scope > .page-transition-layer').length === 1, selector);
  const status = (selector, text) => page.locator(`${selector} > .screen-transition-status`).getByRole('status', { name: '' }).filter({ hasText: text });
  const go = async target => page.evaluate(target => {
    history.pushState(null, '', target);
    dispatchEvent(new PopStateEvent('popstate'));
  }, target);
  const screenshot = async name => {
    if (!TEST_OUTPUT) return;
    await mkdir(TEST_OUTPUT, { recursive: true });
    await page.screenshot({ path: `${TEST_OUTPUT}/${ENGINE}-${TEST_WIDTH}-${name}.png` });
  };
  const startTrace = selector => page.evaluate(selector => {
    window.screenTransitionProbe?.stop();
    const samples = [];
    let handle = 0;
    const take = now => {
      const container = document.querySelector(selector);
      const layers = [...(container?.querySelectorAll(':scope > .page-transition-layer') ?? [])];
      const rect = container?.getBoundingClientRect();
      const alpha = layers.map(layer => Number(getComputedStyle(layer).opacity));
      const transforms = layers.map(layer => getComputedStyle(layer).transform);
      if (rect) samples.push({ now, count: layers.length, coverage: Math.max(...alpha), visible: alpha.filter(value => value > 0.001).length, top: rect.top, height: rect.height, transforms });
      handle = requestAnimationFrame(take);
    };
    handle = requestAnimationFrame(take);
    window.screenTransitionProbe = { samples, stop: () => cancelAnimationFrame(handle) };
  }, selector);
  const checkTrace = async (label, stableGeometry) => {
    const frames = await page.evaluate(() => {
      const { stop, samples } = window.screenTransitionProbe;
      stop();
      return samples;
    });
    assert.ok(frames.length >= 4, `${label}: too few animation frames`);
    // A scene leaves before the next one arrives: at no frame are two scenes on screen together, and the empty moment between them is short.
    assert.ok(frames.every(sample => sample.visible <= 1), `${label}: two scenes were visible at once`);
    let emptySince = null;
    let longestEmpty = 0;
    for (const sample of frames) {
      if (sample.coverage < 0.05) emptySince ??= sample.now;
      else if (emptySince !== null) { longestEmpty = Math.max(longestEmpty, sample.now - emptySince); emptySince = null; }
    }
    assert.ok(longestEmpty < 400, `${label}: the screen was empty for ${longestEmpty.toFixed(0)}ms between the scenes`);
    assert.ok(frames.every(sample => sample.transforms.every(transform => transform === 'none' || /^matrix\(1, 0, 0, 1, -?[\d.]+, 0\)$/.test(transform))), `${label}: a screen was moved other than sideways`);
    assert.ok(frames.every(sample => sample.count <= 3), `${label}: excess retained layers`);
    if (stableGeometry) {
      assert.ok(frames.every(frame => frame.top === frames[0].top && frame.height === frames[0].height), `${label}: jumping layout`);
    }
    const gaps = frames.slice(1).map((frame, index) => frame.now - frames[index].now);
    console.log(`PASS ${ENGINE}/${TEST_WIDTH} ${label}: ${frames.length} frames, max rAF gap ${Math.max(...gaps).toFixed(1)}ms`);
  };

  const catalog = arm('/api/scores');
  await page.goto(new URL('/you', VITE_URL).href);
  await page.getByRole('heading', { name: 'Test musician', exact: true }).waitFor();
  await startTrace(outlet);
  await page.getByRole('link', { name: 'Explore', exact: true }).click();
  await catalog.requested;
  const loader = status(outlet, 'Loading…');
  await loader.waitFor();
  assert.match(await stage(outlet).innerText(), /Test musician/);
  assert.equal(await page.locator(outlet + ' > [data-layer="pending"]').evaluate(el => getComputedStyle(el).opacity), '0');
  const readPulse = () => loader.locator('i').first().evaluate(dot => ({
    opacity: Number(getComputedStyle(dot).opacity), tracks: dot.getAnimations().length,
    time: dot.getAnimations()[0]?.currentTime ?? 0,
  }));
  const pulse = await readPulse();
  await page.waitForTimeout(100);
  const later = await readPulse();
  assert.equal(pulse.tracks, REDUCED_MOTION ? 0 : 1);
  if (!REDUCED_MOTION) assert.ok(later.time > pulse.time, 'loading animation did not progress');
  else assert.equal(later.opacity, pulse.opacity, 'reduced motion changed the indicator');
  await screenshot('browse-loading');
  catalog.release();
  await stage(outlet).getByRole('heading', { name: 'Recently updated' }).waitFor();
  await settled(outlet);
  await checkTrace('cold You to Explore', true);

  await page.getByRole('link', { name: 'Library', exact: true }).click();
  await stage(outlet).getByRole('heading', { name: 'Library', exact: true }).waitFor();
  await go('/explore');
  await stage(outlet).getByRole('heading', { name: 'Recently updated' }).waitFor();
  assert.equal(await loader.count(), 0, 'cached browse navigation displayed loading');
  await go('/library?preview=' + saved.id);
  await stage(outlet).getByRole('heading', { name: 'Library', exact: true }).waitFor();

  const savedRead = arm('/api/scores/' + saved.id);
  const mapRead = arm('/api/scores/' + saved.id + '/playback/map');
  await startTrace(root);
  const open = page.getByRole('button', { name: 'Open score', exact: true });
  await open.click();
  await savedRead.requested;
  await status(root, 'Loading…').waitFor();
  assert.equal(await stage(root).locator('.library-heading h1').textContent(), 'Library');
  assert.equal(await page.locator('.editor-screen').count(), 1);
  await screenshot('library-to-read-loading');
  savedRead.release();
  await stage(root).locator('.paper[data-ready="true"] svg').first().waitFor().catch(async error => {
    console.error(await page.locator(root).locator('[role="alert"]').allTextContents(), errors);
    throw error;
  });
  await settled(root);
  await checkTrace('cold Library to Read', true);
  await screenshot('read-ready');

  const waterfall = page.getByRole('radio', { name: 'Waterfall', exact: true });
  const score = page.getByRole('radio', { name: 'Score', exact: true });
  await waterfall.click();
  await mapRead.requested;
  await page.getByRole('status').filter({ hasText: 'Preparing frames…' }).waitFor();
  assert.equal(await page.locator('.desk').evaluate(el => getComputedStyle(el).opacity), '1');
  await score.click();
  mapRead.release();
  await page.waitForFunction(() => !document.querySelector('.editor-screen.is-waterfall'));
  await waterfall.click();
  await page.locator('.editor-screen.is-waterfall').waitFor();
  await score.click();
  await page.waitForFunction(() => !document.querySelector('.editor-screen.is-waterfall'));
  console.log('PASS cold, cancelled, and warm Score ↔ Waterfall');

  await page.getByRole('link', { name: 'Back to scores', exact: true }).click();
  await stage(root).getByRole('heading', { name: 'Library', exact: true }).waitFor();
  await open.click();
  await stage(root).locator('.paper[data-ready="true"] svg').first().waitFor();
  console.log('PASS Read back to the same Library preview');

  const obsoleteDraft = arm('/api/drafts/' + draftId);
  const edit = page.getByRole('button', { name: 'Open in editor', exact: true });
  await edit.click();
  await obsoleteDraft.requested;
  await page.getByRole('status').filter({ hasText: 'Opening score…' }).waitFor();
  assert.equal(await page.locator('.workspace-route-content').evaluate(el => el.inert), true);
  await page.goBack();
  await page.waitForURL('**/scores/' + saved.id);
  // The same queued gateway can still have the obsolete HTTP read in flight.
  obsoleteDraft.release();
  await edit.waitFor();
  await page.waitForFunction(() => getComputedStyle(document.querySelector('.workspace-transition-cover')).opacity === '0');
  assert.equal(await page.locator('.editor-screen').count(), 1);
  console.log('PASS Back while the workspace cover is fully opaque');

  const draftRead = arm('/api/drafts/' + draftId);
  await edit.click();
  await draftRead.requested;
  await page.getByRole('status').filter({ hasText: 'Opening score…' }).waitFor();
  assert.equal(await page.locator('.editor-screen').count(), 1);
  assert.equal(await page.locator('.workspace-transition-cover').evaluate(el => getComputedStyle(el).opacity), '1');
  draftRead.release();
  await page.waitForURL('**/edit/' + draftId);
  await page.getByRole('link', { name: 'Back to Library', exact: true }).waitFor();
  await page.waitForFunction(() => getComputedStyle(document.querySelector('.workspace-transition-cover')).opacity === '0');
  await page.locator('.paper[data-ready="true"] svg').first().waitFor();
  await page.getByRole('link', { name: 'Back to Library', exact: true }).click();
  await stage(root).getByRole('heading', { name: 'Library', exact: true }).waitFor();
  await page.getByRole('button', { name: /Transition draft/ }).first().click();
  await stage(root).locator('.paper[data-ready="true"] svg').first().waitFor();
  await page.goBack();
  await stage(root).getByRole('heading', { name: 'Library', exact: true }).waitFor();
  await page.goForward();
  await stage(root).locator('.paper[data-ready="true"] svg').first().waitFor();
  console.log('PASS Read to Editor, Library ↔ Editor, Back and Forward');

  await go('/scores/' + saved.id + '/practice');
  await page.locator('.practice-screen').waitFor();
  await page.getByRole('radiogroup', { name: 'View' }).getByRole('radio', { name: 'Waterfall' }).click();
  await page.waitForFunction(() => document.querySelector('.editor-screen.is-waterfall') && getComputedStyle(document.querySelector('.workspace-transition-cover')).opacity === '0', null, { timeout: 8000 });
  console.log('PASS Practice to Waterfall opens and settles');

  await go('/scores/missing-score');
  await page.getByRole('alert').filter({ hasText: 'This score could not be found.' }).waitFor();
  await page.waitForFunction(() => getComputedStyle(document.querySelector('.workspace-transition-cover')).opacity === '0');
  await page.getByRole('link', { name: 'Back to scores', exact: true }).click();
  await stage(root).getByRole('heading', { name: 'Recently updated' }).waitFor();

  rejectMap = true;
  gates.delete('/api/scores/' + saved.id + '/playback/map');
  await go('/scores/' + saved.id);
  await stage(root).locator('.paper[data-ready="true"] svg').first().waitFor();
  await waterfall.click();
  await page.getByRole('alert').filter({ hasText: 'The playback map could not be loaded.' }).waitFor();
  await score.click();
  await page.waitForFunction(() => !document.querySelector('.editor-screen.is-waterfall'));
  assert.deepEqual(errors, []);
  console.log('PASS missing score and rejected map reveal their error and remain navigable');
} finally {
  await browser.close();
}
