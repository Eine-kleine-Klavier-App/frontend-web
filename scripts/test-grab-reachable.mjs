import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
if (process.argv.includes('--help')) {
  console.log('VITE_URL, ENGINE, PLAYWRIGHT_MODULE_PATH, PLAYWRIGHT_CHROMIUM_EXECUTABLE');
  process.exit(0);
}
const playwright = process.env.PLAYWRIGHT_MODULE_PATH ? require(process.env.PLAYWRIGHT_MODULE_PATH) : await import('playwright');
const engine = process.env.ENGINE || 'chromium';
const executablePath = engine === 'chromium' ? process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE : undefined;
const browser = await playwright[engine].launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
const base = process.env.VITE_URL || 'http://localhost:5173';

// Every element that is dragged must be reachable at its own ink: a press on a rest starts the rest's drag, a press on a point mark (a dynamic, a tempo)
// starts the mark's drag, whatever lies over it in the overlay. A drag that runs holds the pointer.
const viewIds = (file, pick) => JSON.parse(fs.readFileSync(new URL('../' + file, import.meta.url), 'utf8')).carriers.filter(pick).map((carrier) => carrier.id);

async function open(view) {
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${base}/demo-editor.html?view=${view}`);
  await page.waitForSelector('.vf-stavenote', { timeout: 30000 });
  // the stand holds the playback clock still, which locks editing: unlock it
  await page.evaluate(() => window.__editor.setState({ playbackLocked: false, manualLocked: false, locked: false }));
  await page.waitForTimeout(500);
  return { page, errors };
}

// the centre of what is drawn for a note or a rest, and what the overlay has on top there
async function inkOf(page, id) {
  return page.evaluate((id) => {
    const head = [...document.querySelectorAll(`[data-individual-note-id="${CSS.escape(id)}"]`)].find((node) => !node.closest('.overlay'));
    if (!head) return null;
    head.scrollIntoView({ block: 'center', inline: 'center' });
    const box = head.getBoundingClientRect();
    const x = box.left + box.width / 2, y = box.top + box.height / 2;
    const top = document.elementFromPoint(x, y);
    return { x, y, covered: top?.getAttribute('data-pick-id') !== id };
  }, id);
}

// a drag that has started holds the pointer: the overlay captures it once the pointer has moved
async function startsDrag(page, point) {
  await page.mouse.move(point.x, point.y);
  await page.mouse.down();
  for (let step = 1; step <= 4; step += 1) await page.mouse.move(point.x, point.y + step * 4);
  const started = await page.evaluate(() => document.querySelector('svg.overlay').hasPointerCapture(1));
  for (let step = 3; step >= 0; step -= 1) await page.mouse.move(point.x, point.y + step * 4);
  await page.mouse.up();
  return started;
}

try {
  // the rests of a score with several voices, some of them under the hit areas of notes
  const rests = viewIds('demo-cross-staff.json', (carrier) => carrier.kind === 'rest');
  assert.ok(rests.length > 0, 'the fixture has rests');
  let coveredRests = 0;
  for (const id of rests) {
    const { page, errors } = await open('demo-cross-staff');
    const point = await inkOf(page, id);
    assert.ok(point, `rest ${id.slice(0, 6)} is drawn`);
    if (point.covered) coveredRests += 1;
    assert.ok(await startsDrag(page, point), `a press on the ink of rest ${id.slice(0, 6)} starts its drag${point.covered ? ' (a note hit area is over it)' : ''}`);
    assert.deepEqual(errors, []);
    await page.close();
  }
  console.log(`PASS rests: ${rests.length} reachable at their ink (${coveredRests} with a note's hit area over them)`);

  // every note is reachable at its own notehead: a click on the notehead selects that note (where no other notehead's ink lies under the same point)
  for (const view of ['demo-cross-staff', 'demo-editor-view', 'demo-graces']) {
    const { page, errors } = await open(view);
    const heads = await page.evaluate(() => {
      const items = [...document.querySelectorAll('[data-individual-note-id]')].filter((node) => !node.closest('.overlay')).map((node) => {
        const box = node.getBoundingClientRect();
        return { id: node.getAttribute('data-individual-note-id'), box };
      });
      return items.map(({ id, box }) => {
        const x = box.left + box.width / 2, y = box.top + box.height / 2;
        const shared = items.some((other) => other.id !== id && x >= other.box.left && x <= other.box.right && y >= other.box.top && y <= other.box.bottom);
        return { id, shared };
      });
    });
    let checked = 0;
    for (const { id, shared } of heads) {
      if (shared) continue;
      const point = await inkOf(page, id);
      if (!point) continue;
      await page.mouse.click(point.x, point.y);
      const selected = await page.evaluate(() => window.__editor.getState().selectedIds);
      assert.deepEqual(selected, [id], `${view}: a click on the notehead of ${id.slice(0, 6)} selects it${point.covered ? ' (a hit area is over it)' : ''}`);
      checked += 1;
      await page.waitForTimeout(60);
    }
    assert.deepEqual(errors, []);
    console.log(`PASS ${view}: ${checked} noteheads selected by a click on them`);
    await page.close();
  }

  // the other dragged things, on the stand with beams, slurs and marks: a point mark, the handles of a selected beam, of a selected slur
  {
    const { page, errors } = await open('demo-editor-view');
    const pressHolds = async (point) => {
      await page.mouse.move(point.x, point.y);
      await page.mouse.down();
      for (let step = 1; step <= 4; step += 1) await page.mouse.move(point.x, point.y + step * 4);
      const held = await page.evaluate(() => document.querySelector('svg.overlay').hasPointerCapture(1));
      for (let step = 3; step >= 0; step -= 1) await page.mouse.move(point.x, point.y + step * 4);
      await page.mouse.up();
      await page.keyboard.press('Escape');
      return held;
    };
    const centreOf = (selector, nth = 0) => page.evaluate(([selector, nth]) => {
      const node = document.querySelectorAll(selector)[nth];
      if (!node) return null;
      node.scrollIntoView({ block: 'center', inline: 'center' });
      const box = node.getBoundingClientRect();
      return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
    }, [selector, nth]);
    // every point mark that is not an opening one (at the start of the piece: those cannot be moved) starts its drag
    const marks = await page.evaluate(() => {
      const contexts = window.__editor.getState().document.contexts;
      return [...document.querySelectorAll('g.context-hit')].flatMap((node) => {
        const context = contexts.find((entry) => entry.id === node.getAttribute('data-pick-id'));
        const box = node.querySelector(':scope > rect');
        if (!context || !box || 'endMeasureId' in context || context.kind === 'volta') return [];
        const opening = context.measureId === window.__editor.getState().document.measures[0].id && context.position.numerator === 0 && ['clef', 'keySignature', 'tempo', 'dynamic'].includes(context.kind);
        node.scrollIntoView({ block: 'center', inline: 'center' });
        const shape = box.getBoundingClientRect();
        return [{ id: context.id, kind: context.kind, opening, x: shape.left + shape.width / 2, y: shape.top + shape.height / 2 }];
      });
    });
    assert.ok(marks.some((mark) => !mark.opening), 'the stand has a point mark that can be moved');
    for (const mark of marks.filter((entry) => !entry.opening)) {
      const point = await page.evaluate((id) => { const box = document.querySelector(`g.context-hit[data-pick-id="${id}"] > rect`); box.scrollIntoView({ block: 'center', inline: 'center' }); const r = box.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }, mark.id);
      assert.ok(await pressHolds(point), `a press on the ${mark.kind} mark starts its drag`);
    }
    // the handles of a selected slur
    const slur = await page.evaluate(() => window.__editor.getState().document.contexts.find((context) => context.kind === 'slur')?.id);
    assert.ok(slur, 'the stand has a slur');
    await page.evaluate((id) => window.__editor.getState().selectStructure(id, false), slur);
    await page.waitForTimeout(300);
    const slurHandle = await centreOf('g[data-pick-kind="slurHandle"] circle');
    assert.ok(slurHandle, 'a selected slur shows its handles');
    assert.ok(await pressHolds(slurHandle), 'a press on a slur handle starts its drag');
    // the edge handles of a selected span (a hairpin)
    const hairpin = await page.evaluate(() => window.__editor.getState().document.contexts.find((context) => context.kind === 'hairpin')?.id);
    assert.ok(hairpin, 'the stand has a hairpin');
    await page.evaluate((id) => window.__editor.getState().selectStructure(id, false), hairpin);
    await page.waitForTimeout(300);
    const edge = await centreOf('g.context-endpoint[data-pick-kind="contextHandle"] circle');
    assert.ok(edge, 'a selected hairpin shows its edge handles');
    assert.ok(await pressHolds(edge), 'a press on a span edge handle starts its drag');
    assert.deepEqual(errors, []);
    console.log('PASS the movable point marks, the handles of a slur and the edges of a hairpin start their drags');
    await page.close();
  }
  {
    // the handles of a selected beam
    const { page, errors } = await open('demo-cross-staff');
    const beam = await page.evaluate(() => window.__editor.getState().document.beams[0]?.id);
    assert.ok(beam, 'the stand has a beam');
    await page.evaluate((id) => window.__editor.getState().selectStructure(id, false), beam);
    await page.waitForTimeout(300);
    const handle = await page.evaluate(() => {
      const node = document.querySelector('g[data-pick-kind="beamHandle"] circle');
      if (!node) return null;
      node.scrollIntoView({ block: 'center', inline: 'center' });
      const box = node.getBoundingClientRect();
      return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
    });
    assert.ok(handle, 'a selected beam shows its handles');
    await page.mouse.move(handle.x, handle.y);
    await page.mouse.down();
    for (let step = 1; step <= 4; step += 1) await page.mouse.move(handle.x, handle.y + step * 4);
    assert.ok(await page.evaluate(() => document.querySelector('svg.overlay').hasPointerCapture(1)), 'a press on a beam handle starts its drag');
    await page.mouse.up();
    assert.deepEqual(errors, []);
    console.log('PASS the handles of a beam start their drag');
    await page.close();
  }

  {
    // a stem is grabbed on its line, between the notes of a chord as well as beyond them: the drag previews a stem of another length
    const { page, errors } = await open('demo-editor-view');
    const stems = await page.evaluate(() => [...document.querySelectorAll('.stem-handle-group')].filter((group) => group.querySelector('.stem-handle-dot')).slice(0, 6).map((group) => {
      const line = group.querySelector('.stem-handle-visual').getBoundingClientRect();
      const dot = group.querySelector('.stem-handle-dot').getBoundingClientRect();
      const tip = dot.top + dot.height / 2;
      const away = Math.abs(tip - line.top) < Math.abs(tip - line.bottom) ? -1 : 1;
      return { id: group.getAttribute('data-pick-id'), x: line.left + line.width / 2, y: tip - away * (line.bottom - line.top) * 0.3, away };
    }));
    assert.ok(stems.length > 0, 'the stand has stems that can be dragged');
    for (const stem of stems) {
      await page.evaluate(() => window.__editor.setState({ stemOverrides: {} }));
      await page.mouse.move(stem.x, stem.y);
      await page.mouse.down();
      for (let step = 1; step <= 5; step += 1) await page.mouse.move(stem.x, stem.y + stem.away * step * 5);
      const previewed = await page.evaluate((id) => id in window.__editor.getState().stemOverrides, stem.id);
      await page.mouse.up();
      assert.ok(previewed, `a drag from the line of the stem of ${stem.id.slice(0, 6)} previews its length`);
    }
    assert.deepEqual(errors, []);
    console.log(`PASS ${stems.length} stems are dragged by their lines`);
    await page.close();
  }
} finally {
  await browser.close();
}
