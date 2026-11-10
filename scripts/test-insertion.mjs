import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const load = file => {
  const module = { exports: {} };
  const source = ts.transpileModule(fs.readFileSync(path.join(root, file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(source, { module, exports: module.exports });
  return module.exports;
};

const { insertionPosition: snap, insertionPositions: positions } =
  load('src/features/editor/insertionPosition.ts');
const { staffInsertionX: xAt, staffInsertionBeat: beatAt } = load('src/rendering/ScoreRenderer.ts');
const f = (numerator, denominator = 1) => ({ numerator, denominator });
const key = position => `${position.numerator}/${position.denominator}`;
const keys = (document, measureId, voiceId = 'v') =>
  Array.from(positions(document, measureId, voiceId), candidate => key(candidate.position));
const item = (kind, positionFraction) => ({ kind, positionFraction, notes: kind === 'note' ? [{ noteId: 'n' }] : [] });
const measure = (id, timeSignature = { beats: 4, beatValue: 4 }) => ({
  id, timeSignature, voices: [{ id: 'v', items: [] }, { id: 'other', items: [] }],
});
const blank = () => ({
  measures: [measure('a'), measure('b')], voices: [{ id: 'v' }, { id: 'other' }], insertionSpaces: [],
});
let checks = 0;
function test(name, run) { run(); checks++; console.log('PASS ' + name); }

test('an empty measure offers only its beginning, in either voice', () => {
  const doc = blank();
  assert.deepEqual(keys(doc, 'a'), ['0/1']);
  assert.deepEqual(keys(doc, 'b', 'other'), ['0/1']);
  assert.equal(key(snap(doc, 'b', 'v', 3.9).position), '0/1');
  assert.equal(key(snap(doc, 'b', 'v', 4).position), '0/1');
});

test('notes and rests in the selected voice supply exact onsets, without extra grid positions', () => {
  const doc = blank();
  doc.measures[0].voices[0].items = [item('note', f(1, 8)), item('rest', f(3, 8)), item('note', f(3, 8))];
  doc.measures[0].voices[1].items = [item('note', f(1, 4))];
  assert.deepEqual(keys(doc, 'a'), ['0/1', '1/8', '3/8']);
  assert.deepEqual(keys(doc, 'a', 'other'), ['0/1', '1/4']);
  assert.equal(key(snap(doc, 'a', 'v', 0.9).position), '1/8');
  assert.equal(key(snap(doc, 'a', 'v', 1.6).position), '3/8');
  assert.equal(key(snap(doc, 'a', 'v', 1).position), '1/8');
});

test('existing tuplet attacks remain available without filling gaps in the tuplet', () => {
  const doc = blank();
  doc.insertionSpaces = [{ id: 'triplet', voiceId: 'v', start: f(0), scale: f(2, 3), extent: f(3, 8) }];
  doc.measures[0].voices[0].items = [item('note', f(1, 12)), item('rest', f(1, 6))];
  assert.deepEqual(keys(doc, 'a'), ['0/1', '1/12', '1/6']);
  assert.equal(key(snap(doc, 'a', 'v', 0.34).position), '1/12');
  assert.equal(key(snap(doc, 'a', 'v', 0.67).position), '1/6');
  assert.deepEqual(keys(doc, 'a', 'other'), ['0/1']);
});

test('measure-local starts work after another metre and cross-bar groups do not synthesize onsets', () => {
  const doc = blank();
  doc.measures[0].timeSignature = { beats: 6, beatValue: 8 };
  doc.insertionSpaces = [{ id: 'cross', voiceId: 'v', start: f(5, 8), scale: f(2, 3), extent: f(3, 4) }];
  doc.measures[1].voices[0].items = [item('note', f(1, 24))];
  assert.deepEqual(keys(doc, 'b'), ['0/1', '1/24']);
  assert.equal(key(snap(doc, 'b', 'v', 1 / 6).position), '1/24');
  assert.equal(key(snap(doc, 'b', 'v', 2).position), '1/24');
});

test('unknown targets, invalid pointers and out-of-measure items are ignored', () => {
  const doc = blank();
  doc.measures[0].voices[0].items = [item('note', f(-1, 8)), item('rest', f(1)), item('note', f(1, 4))];
  assert.deepEqual(keys(doc, 'a'), ['0/1', '1/4']);
  assert.deepEqual(keys(doc, 'missing'), []);
  assert.deepEqual(keys(doc, 'a', 'missing'), []);
  for (const raw of [NaN, Infinity, -Infinity]) assert.equal(snap(doc, 'a', 'v', raw), null);
});

test('hover target and committed position are the same exact fraction', () => {
  const doc = blank();
  doc.measures[0].voices[0].items = [item('rest', f(1, 24)), item('note', f(7, 16))];
  const allowed = new Set(keys(doc, 'a'));
  for (let step = 0; step <= 400; step++) {
    const target = snap(doc, 'a', 'v', step / 100);
    assert.ok(allowed.has(key(target.position)));
    assert.equal(target.beat, 4 * target.position.numerator / target.position.denominator);
  }
});

test('inline glyph gaps remain non-targets and existing note anchors use the insertion map', () => {
  const zone = {
    x0: 60, x1: 420, segments: [{ beat: 0, x: 100 }, { beat: 2, x: 300 }, { beat: 4, x: 420 }],
    insertionSegments: [{ beat: 0, x: 100 }, { beat: 2, x: 220 }, { beat: 2, x: 300 }, { beat: 4, x: 420 }],
  };
  const doc = blank();
  doc.measures[0].voices[0].items = [item('note', f(1, 2))];
  assert.equal(xAt(zone, 2), 300);
  assert.equal(beatAt(zone, 300), 2);
  for (const x of [60, 90, 220, 240, 299]) assert.equal(beatAt(zone, x), null);
  assert.equal(key(snap(doc, 'a', 'v', beatAt(zone, 300)).position), '1/2');
});

console.log(`PASS ${checks} insertion scenarios`);

if (process.env.PLAYWRIGHT_MODULE_PATH) {
  const playwright = require(process.env.PLAYWRIGHT_MODULE_PATH);
  const engine = process.env.ENGINE || 'webkit', width = Number(process.env.TEST_WIDTH || 1440), theme = process.env.TEST_THEME || 'light';
  const browser = await playwright[engine].launch({ headless: true, ...(engine === 'chromium' ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || '/Users/admin/Library/Caches/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-mac-arm64/chrome-headless-shell' } : {}) });
  try {
    const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: process.env.REDUCED ? 'reduce' : 'no-preference' });
    page.setDefaultTimeout(15000);
    const errors = [], requests = [], unexpected = [];
    let responseView, rejectInsert = false;
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/api/**', route => {
      const request = route.request(), pathname = new URL(request.url()).pathname;
      if (request.method() === 'POST' && pathname === '/api/auth/refresh') return route.fulfill({ status: 401, contentType: 'application/json', body: '{}' });
      if (request.method() === 'GET' && pathname === '/api/drafts') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ draft_id: 'demo', title: 'Untitled', ref_score_id: null, updated_at: '2026-11-12T00:00:00Z' }]) });
      if (request.method() === 'POST' && pathname === '/api/drafts/demo/edit/notes') {
        requests.push(request.postDataJSON());
        return route.fulfill({ status: rejectInsert ? 409 : 200, contentType: 'application/json', body: JSON.stringify(rejectInsert ? { detail: 'Insertion refused by fixture' } : { document: responseView }) });
      }
      unexpected.push(`${request.method()} ${pathname}`);
      return route.fulfill({ status: 500, contentType: 'application/json', body: '{"detail":"Unexpected isolated request"}' });
    });
    const base = process.env.VITE_URL || 'http://localhost:5173';
    responseView = await (await page.request.get(`${base}/demo-editor-view.json`)).json();
    await page.goto(`${base}/demo-editor.html?playing=0&t=0&theme=${theme}`);
    await page.waitForLoadState('networkidle');
    await page.waitForFunction(() => window.__editor?.getState().document.measures.length > 0, {}, { timeout: 15000 });
    await page.evaluate(async () => {
      const { HttpGateway } = await import('/src/core/gateway/HttpGateway.ts');
      const { useAuthStore } = await import('/src/core/auth/authStore.ts');
      const { playback } = await import('/src/core/playback/PlaybackController.ts');
      playback.unlock = () => {}; playback.previewCarrier = async () => {};
      useAuthStore.setState({ status: 'authed', userId: 'isolated-insert', username: 'Test', accessToken: 'isolated-insert-token' });
      const doc = structuredClone(window.__editor.getState().document);
      const template = doc.measures.flatMap(m => m.voices.flatMap(v => v.items)).find(item => item.kind === 'note');
      const voice = doc.voices[0], staff = doc.staffOrder[0];
      doc.contexts = []; doc.ties = []; doc.beams = []; doc.tuplets = []; doc.glissandos = []; doc.voices = [voice];
      doc.measures = [{ id: 'insert-measure', timeSignature: { beats: 4, beatValue: 4 }, voices: [{ id: voice.id,
        items: Array.from({ length: 4 }, (_, i) => ({ ...template, id: `insert-${i}`, kind: 'note', duration: 'q', dots: 0,
          position: i, positionFraction: { numerator: i, denominator: 4 }, writtenSize: { value: { value: 4, dots: 0 }, count: 1 },
          occupiedSize: undefined, graceBefore: null, graceAfter: null, articulations: [], ornament: 'none',
          notes: [{ ...template.notes[0], noteId: `insert-head-${i}`, staffId: staff, staffStep: 0, accidental: null, fingering: 0 }],
        })),
      }] }];
      window.insertFixture = doc; window.insertCompletions = 0;
      const http = new HttpGateway();
      window.__editor.setState({ document: doc, currentVoice: 0, currentStaff: staff, selectedIds: [], carrierSelectedIds: [], stemOverrides: {}, error: null,
        gateway: { async apply(draftId, command) {
          await http.apply(draftId, command);
          window.insertCompletions++;
          // Keep the target fixed between transport cases. Domain replacement is verified separately.
          return window.insertFixture;
        } },
      });
    });
    await page.waitForFunction(() => document.querySelector('[data-pick-id="insert-head-0"]'), {}, { timeout: 15000 });
    const variants = [
      { value: '8', denominator: 8, dots: 0 }, { value: 'h', denominator: 2, dots: 0 },
      { value: 'q', denominator: 4, dots: 0 }, { value: 'q', denominator: 4, dots: 1 },
      { value: '8', denominator: 8, dots: 2 },
    ];
    let count = 0;
    for (const chord of [false, true]) {
      await page.evaluate(chord => {
        const document = structuredClone(window.insertFixture);
        if (chord) document.measures[0].voices[0].items[0].notes.push({ ...document.measures[0].voices[0].items[0].notes[0], noteId: 'insert-chord-head', staffStep: 4 });
        window.insertFixture = document; window.__editor.setState({ document });
      }, chord);
      for (const variant of variants) {
        await page.evaluate(async variant => {
          const { toolId } = await import('/src/core/model/insertItems.ts');
          window.__editor.getState().setTool(toolId({ kind: 'note', value: variant.value, dots: variant.dots, articulations: [], accidental: null }));
        }, variant);
        const point = await page.locator('.overlay [data-pick-id="insert-head-0"]').evaluate(element => {
          const box = element.getBBox(), svg = element.ownerSVGElement;
          const point = new DOMPoint(box.x + box.width / 2, box.y + box.height / 2 - 10).matrixTransform(svg.getScreenCTM());
          return { x: point.x, y: point.y };
        });
        await page.mouse.move(point.x, point.y);
        await page.waitForFunction(async variant => {
          const { getGhostGlyphMarkup } = await import('/src/rendering/vexflow/noteGlyph.ts');
          const ghost = document.querySelector('.insert-ghost');
          const normalize = markup => markup.replace(/ id="[^"]*"/g, '');
          return ghost && normalize(ghost.innerHTML) === normalize(getGhostGlyphMarkup(variant.value, 2, 'treble', false, variant.dots));
        }, variant, { timeout: 15000 });
        if (chord && variant.value === '8' && variant.dots === 0) await page.screenshot({ path: `/private/tmp/insertion-duration-${engine}-${width}-${theme}.png` });
        await page.mouse.click(point.x, point.y);
        await page.waitForFunction(expected => window.insertCompletions === expected, ++count);
        assert.equal(requests.length, count, 'one request per insert');
        const sent = requests.at(-1);
        assert.deepEqual(sent.written_value, { value: variant.denominator, dots: variant.dots }, `${chord ? 'chord' : 'single note'} uses the chosen duration and dots`);
        assert.deepEqual(sent.position, { numerator: 0, denominator: 1 });
        assert.equal(sent.measure_id, 'insert-measure');
        assert.equal(sent.staff_step, 2); assert.equal(sent.accidental, null);
        assert.equal(await page.evaluate(() => window.__editor.getState().error), null);
      }
    }
    // A refusal is visible and cannot silently restore the target's quarter duration.
    rejectInsert = true;
    const point = await page.locator('.overlay [data-pick-id="insert-head-0"]').evaluate(element => {
      const box = element.getBBox();
      const point = new DOMPoint(box.x + box.width / 2, box.y + box.height / 2 - 10).matrixTransform(element.ownerSVGElement.getScreenCTM());
      return { x: point.x, y: point.y };
    });
    await page.mouse.move(point.x, point.y); await page.mouse.click(point.x, point.y);
    await page.waitForFunction(() => window.__editor.getState().error !== null);
    assert.match(await page.getByRole('alert').filter({ hasText: 'Insertion refused by fixture' }).innerText(), /Insertion refused by fixture/);
    assert.deepEqual(requests.at(-1).written_value, { value: 8, dots: 2 });
    assert.deepEqual(unexpected, []); assert.deepEqual(errors, []);
    console.log(`PASS ${engine}/${width}/${theme}: ten hover/HTTP cases over note/chord preserve chosen size and dots; same-value join request, mismatch replacement request and visible rejection`);
  } finally { await browser.close(); }
}
