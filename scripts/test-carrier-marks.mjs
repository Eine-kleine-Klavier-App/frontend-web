import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const ts = require('typescript');
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
function load(file, imports = {}) {
  const module = { exports: {} };
  const source = ts.transpileModule(fs.readFileSync(path.join(root, file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(source, {
    module, exports: module.exports, Response, JSON,
    require(name) { assert.ok(name in imports, 'Unexpected import: ' + name); return imports[name]; },
  });
  return module.exports;
}
const articulation = load('src/core/model/articulation.ts');
const { backendAccidental, parseTool } = load('src/core/model/insertItems.ts', { './articulation': articulation });
const requests = [];
const { HttpGateway } = load('src/core/gateway/HttpGateway.ts', {
  '@/core/model/fromView': { fromView: (view, id) => ({ view, id }) },
  './apiBase': { API_BASE: '/api' },
  './measureSync': { DraftSync: class { apply() { return {}; } } },
  '@/core/playback/draftSounds': { draftSounds: { apply() {} } },
  '@/core/auth/authorizedFetch': { async authorizedFetch(url, options) {
    requests.push({ url, method: options.method, body: JSON.parse(options.body) });
    return new Response(JSON.stringify({ sync: {} }));
  } },
});
const gateway = new HttpGateway();
// several carriers go in ONE request; a mark left out is left out of the body
await gateway.apply('d', { type: 'setCarrierMarks', items: [
  { carrierId: 'a', ornament: 'trill' },
  { carrierId: 'b', articulations: ['accent', 'arpeggio_up'] },
  { carrierId: 'c', articulations: [], ornament: 'none' },
] });
assert.equal(requests.length, 1);
assert.equal(requests[0].method, 'PUT');
assert.match(requests[0].url, /\/drafts\/d\/edit\/carrier-marks$/);
assert.deepEqual(requests[0].body, { items: [
  { carrier_id: 'a', ornament: 'trill' },
  { carrier_id: 'b', articulations: ['accent', 'arpeggio_up'] },
  { carrier_id: 'c', articulations: [], ornament: 'none' },
] });
// the ornament signs: one per backend value, with a SMuFL glyph each
const { ORNAMENT_SIGNS } = load('src/core/model/ornament.ts');
assert.deepEqual(Array.from(ORNAMENT_SIGNS, (o) => o.value), ['trill', 'upper_mordent', 'lower_mordent', 'turn', 'inverted_turn', 'tremolo_1', 'tremolo_2', 'tremolo_3']);
assert.ok(ORNAMENT_SIGNS.every((o) => o.glyphs.length > 0 && o.glyphs.every((g) => g.startsWith('ornament') || g.startsWith('tremolo')) && o.label));
const { TREMOLO_STROKES } = load('src/core/model/ornament.ts');
assert.deepEqual(Object.assign({}, TREMOLO_STROKES), { tremolo_1: 1, tremolo_2: 2, tremolo_3: 3 });
console.log('PASS the marks of several carriers go in one request; ornament signs match the backend values');

if (process.env.PLAYWRIGHT_MODULE_PATH) {
  const playwright = require(process.env.PLAYWRIGHT_MODULE_PATH);
  const engine = process.env.ENGINE || 'webkit', width = Number(process.env.TEST_WIDTH || 1440), theme = process.env.TEST_THEME || 'light';
  const browser = await playwright[engine].launch({ headless: true, ...(engine === 'chromium' ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || '/Users/admin/Library/Caches/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-mac-arm64/chrome-headless-shell' } : {}) });
  try {
    const page = await browser.newPage({ viewport: { width, height: 1000 }, reducedMotion: process.env.REDUCED ? 'reduce' : 'no-preference' });
    page.setDefaultTimeout(15000);
    const errors = [], unexpected = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/api/**', route => {
      const request = route.request(), pathname = new URL(request.url()).pathname;
      // The real editor bootstraps its session; all requests stay inside this fixture.
      if (request.method() !== 'POST' || pathname !== '/api/auth/refresh') unexpected.push(`${request.method()} ${pathname}`);
      return route.fulfill({ status: 401, contentType: 'application/json', body: '{"detail":"Isolated ornament test"}' });
    });
    await page.goto(`${process.env.VITE_URL || 'http://localhost:5173'}/demo-editor.html?playing=0&t=0&theme=${theme}`);
    await page.waitForLoadState('networkidle');
    await page.waitForFunction(() => window.__editor?.getState().document.measures.length > 0, {}, { timeout: 15000 });
    await page.evaluate(() => {
      const state = window.__editor.getState(), doc = structuredClone(state.document);
      const template = doc.measures.flatMap(m => m.voices.flatMap(v => v.items)).find(item => item.kind === 'note');
      const voice = doc.voices[0], staff = doc.staffOrder[0];
      const signs = ['trill', 'upper_mordent', 'lower_mordent', 'turn', 'inverted_turn', 'tremolo_1', 'tremolo_2', 'tremolo_3'];
      const marks = [[], ['staccatissimo', 'marcato'], ['staccato', 'accent'], ['fermata', 'accent']];
      doc.contexts = []; doc.ties = []; doc.beams = []; doc.tuplets = []; doc.glissandos = []; doc.voices = [voice]; doc.measures = [];
      window.ornamentCases = [];
      for (const step of [0, 8]) for (const ornament of signs) {
        const mi = doc.measures.length;
        const items = marks.map((articulations, i) => {
          const id = `ornament-${mi}-${i}`;
          window.ornamentCases.push({ id, ornament, articulations, step });
          return { ...template, id, kind: 'note', duration: 'q', dots: 0, position: i, positionFraction: undefined,
            writtenSize: undefined, occupiedSize: undefined, graceBefore: null, graceAfter: null, articulations, ornament,
            notes: [{ ...template.notes[0], noteId: `${id}-head`, staffId: staff, staffStep: step, accidental: null, fingering: undefined }] };
        });
        doc.measures.push({ id: `ornament-measure-${mi}`, timeSignature: { beats: 4, beatValue: 4 }, voices: [{ id: voice.id, items }] });
      }
      window.ornamentCommands = [];
      window.__editor.setState({ document: doc, selectedIds: [], carrierSelectedIds: [], stemOverrides: {},
        dispatch: async command => {
          window.ornamentCommands.push(command);
          if (command.type !== 'setCarrierMarks') throw new Error('Unexpected isolated command');
          const document = structuredClone(window.__editor.getState().document);
          for (const change of command.items) {
            const item = document.measures.flatMap(m => m.voices.flatMap(v => v.items)).find(item => item.id === change.carrierId);
            if (change.ornament !== undefined) item.ornament = change.ornament;
          }
          window.__editor.setState({ document });
        },
      });
    });
    await page.waitForFunction(() => document.querySelector('[data-note-id="ornament-15-3"]'), {}, { timeout: 15000 });
    const geometry = await page.evaluate(async () => {
      const { inkBox } = await import('/src/rendering/vexflow/collisionLayout.ts');
      return window.ornamentCases.map(test => {
        const note = document.querySelector(`[data-note-id="${test.id}"]`), head = inkBox(note.querySelector('.vf-notehead'));
        const ornament = note.querySelector('.vf-ornament');
        return { ...test, head, ornamentBox: ornament ? inkBox(ornament) : null,
          marks: [...(note.querySelector('.vf-note-modifiers')?.children ?? [])].filter(el => !el.classList.contains('vf-ornament')).map(inkBox),
          tremoloPaths: note.querySelectorAll('.vf-note-modifiers > path').length };
      });
    });
    assert.equal(geometry.length, 64);
    for (const test of geometry) {
      if (test.ornament.startsWith('tremolo_')) {
        assert.equal(test.ornamentBox, null, 'tremolo remains a stem modifier');
        if (!test.articulations.length) assert.equal(test.tremoloPaths, Number(test.ornament.slice(-1)), `${test.ornament}: all stem strokes draw`);
        continue;
      }
      assert.equal(test.marks.length, test.articulations.length, 'every articulation is measured');
      const box = test.ornamentBox;
      assert.ok(box && box.width > 0 && box.height > 0, `${test.ornament}: glyph is visible`);
      assert.ok(Math.abs(box.x + box.width / 2 - test.head.x - test.head.width / 2) < 1, `${test.ornament}: centred on notehead`);
      assert.ok(box.y + box.height < test.head.y, `${test.ornament}: above its note`);
      for (const mark of test.marks.filter(mark => mark.y < test.head.y)) {
        assert.ok(box.y + box.height <= mark.y + .1, `${test.ornament}: upper marks remain clear`);
      }
      if (test.step === 0 && !test.articulations.includes('fermata')) {
        const plain = geometry.find(other => other.ornament === test.ornament && other.step === test.step && !other.articulations.length);
        const gap = test.head.y - box.y - box.height, plainGap = plain.head.y - plain.ornamentBox.y - plain.ornamentBox.height;
        assert.ok(Math.abs(gap - plainGap) < .1, `${test.ornament}: lower marks do not lift the glyph`);
      }
    }
    await page.screenshot({ path: `/private/tmp/ornaments-score-${engine}-${width}-${theme}.png` });
    await page.evaluate(() => window.__editor.setState({ selectedIds: ['ornament-0-0-head'], carrierSelectedIds: ['ornament-0-0'] }));
    const group = page.getByRole('radiogroup', { name: 'Ornament', exact: true });
    await group.waitFor();
    assert.equal(await group.count(), 1); assert.equal(await page.getByRole('radiogroup', { name: 'Tremolo', exact: true }).count(), 0);
    assert.equal(await group.getByRole('radio').count(), 9); assert.equal(await group.getByRole('radio', { name: 'None', exact: true }).count(), 1);
    await page.waitForFunction(() => document.querySelector('[role="radiogroup"][aria-label="Ornament"] [role="radio"][aria-label="Trill"]').getAttribute('aria-checked') === 'true');
    const choices = await group.getByRole('radio').evaluateAll(elements => elements.map(el => { const r = el.getBoundingClientRect(); const g = el.parentElement.getBoundingClientRect(); return { top: Math.round(r.top), fits: r.left >= g.left && r.right <= g.right && r.width > 0 }; }));
    assert.ok(choices.every(choice => choice.fits), 'all ornament choices fit their group');
    assert.equal(new Set(choices.map(choice => choice.top)).size, 3, 'shared wrap lays out nine choices on three rows');
    const tremolo = group.getByRole('radio', { name: 'Tremolo, three strokes', exact: true });
    await tremolo.hover(); await tremolo.click();
    await page.waitForFunction(() => window.ornamentCommands.length === 1);
    assert.deepEqual(await page.evaluate(() => window.ornamentCommands[0]), { type: 'setCarrierMarks', items: [{ carrierId: 'ornament-0-0', ornament: 'tremolo_3' }] });
    await group.getByRole('radio', { name: 'None', exact: true }).click();
    await page.waitForFunction(() => window.ornamentCommands.length === 2);
    assert.equal(await page.evaluate(() => window.ornamentCommands.at(-1).items[0].ornament), 'none');
    await group.getByRole('radio', { name: 'Trill', exact: true }).click();
    await page.waitForFunction(() => window.ornamentCommands.length === 3);
    assert.equal(await page.evaluate(() => window.ornamentCommands.at(-1).items[0].ornament), 'trill');
    await page.screenshot({ path: `/private/tmp/ornaments-panel-${engine}-${width}-${theme}.png` });
    await page.evaluate(() => window.__editor.setState({ selectedIds: ['ornament-0-1-head', 'ornament-5-0-head'], carrierSelectedIds: ['ornament-0-1', 'ornament-5-0'] }));
    await page.waitForFunction(() => !document.querySelector('[role="radiogroup"][aria-label="Ornament"] [aria-checked="true"]'));
    await group.getByRole('radio', { name: 'None', exact: true }).click();
    await page.waitForFunction(() => window.ornamentCommands.length === 4);
    assert.deepEqual(await page.evaluate(() => window.ornamentCommands.at(-1)), { type: 'setCarrierMarks', items: [
      { carrierId: 'ornament-0-1', ornament: 'none' }, { carrierId: 'ornament-5-0', ornament: 'none' },
    ] });
    const none = group.getByRole('radio', { name: 'None', exact: true });
    await none.focus(); await page.keyboard.press('ArrowRight');
    await page.waitForFunction(() => window.ornamentCommands.length === 5);
    assert.deepEqual(await page.evaluate(() => window.ornamentCommands.at(-1).items.map(item => item.ornament)), ['trill', 'trill']);
    assert.equal(await group.getByRole('radio', { name: 'Trill', exact: true }).evaluate(el => el === document.activeElement), true);
    assert.deepEqual(await page.evaluate(() => window.__editor.getState().document.measures[0].voices[0].items[1].articulations), ['staccatissimo', 'marcato'], 'ornament edits preserve articulations');
    await page.evaluate(() => {
      const document = structuredClone(window.__editor.getState().document);
      document.ties = [{ id: 'ornament-tie', startNoteId: 'ornament-0-1-head', endNoteId: 'ornament-5-0-head' }];
      window.__editor.setState({ document });
    });
    await page.getByText('1 of the selected continue a tie and are left out.', { exact: true }).waitFor();
    await group.getByRole('radio', { name: 'None', exact: true }).click();
    await page.waitForFunction(() => window.ornamentCommands.length === 6);
    assert.deepEqual(await page.evaluate(() => window.ornamentCommands.at(-1)), { type: 'setCarrierMarks', items: [{ carrierId: 'ornament-0-1', ornament: 'none' }] }, 'a batch excludes tie continuations');
    assert.deepEqual(errors, []);
    assert.deepEqual(unexpected, [], 'isolated control tests do not reach live APIs');
    console.log(`PASS ${engine}/${width}/${theme}: 64 ornament/mark/stem cases, centred upper glyphs, lower/upper spacing, tremolo strokes; one wrapped group, replacement/None/mixed/batch and keyboard`);
  } finally { await browser.close(); }
}
