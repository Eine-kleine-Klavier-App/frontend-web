import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import path from 'node:path';
import fs from 'node:fs';
const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const backend = process.env.PIANO_BACKEND || path.resolve(root, '../PianoAppBackend');
// Real domain commands and ScoreView serialization, isolated in one in-memory process. No server,
// draft repository, database, browser profile or production auth session participates in this test.
const python = String.raw`
import json, sys
from fractions import Fraction
from tests.unit.domain.document_builders import note
from piano_app.application.use_cases.score.shared import ScoreView
from piano_app.domain.score.document.models import ScoreDocument
from piano_app.domain.score.document.models.notation import DynamicMarking
from piano_app.domain.score.document.models.structural import MeasurePosition
from piano_app.domain.score.document.services.mutation import build_compiler, build_engine
from piano_app.domain.score.document.services.mutation.compiler import (SetDynamicIntent, AddContextVoiceIntent, RemoveContextVoiceIntent, CreateHairpinIntent, CreateSlurIntent, CreateRefrainIntent, SetRefrainTimesIntent)
from piano_app.domain.score.document.services.mutation.instructions import MutationRejectedError

def position(p): return MeasurePosition.of(numerator=p['numerator'], denominator=p['denominator'])
def run(intent): return build_engine().process(document=document, requests=build_compiler().compile(document=document, intent=intent))
document=None
undo=[]
redo=[]
for line in sys.stdin:
 try:
  request=json.loads(line)
  op=request['op']
  if op=='reset':
   document=ScoreDocument.create_fresh(voice_count=2, staff_count=2, measure_count=3)
   undo=[];redo=[]
   if request.get('legacy'):
    run(SetDynamicIntent(measure_id=document.measures[0].id,position=MeasurePosition.of(numerator=0,denominator=1),voice_ids=(document.voices[1].id,),dynamic=DynamicMarking.PIANO))
   if request.get('music'):
    for m in range(3):
     for v in range(2):
      for n in range(4): note(document,Fraction(m)+Fraction(n,4),voice=v,staff=0,step=v*2)
    start=MeasurePosition.of(numerator=0,denominator=1)
    run(SetDynamicIntent(measure_id=document.measures[0].id,position=MeasurePosition.of(numerator=1,denominator=4),voice_ids=tuple(v.id for v in document.voices),dynamic=DynamicMarking.MEZZO_FORTE))
    run(CreateHairpinIntent(start_measure_id=document.measures[1].id,start_position=start,end_measure_id=document.measures[2].id,end_position=start,voice_ids=(document.voices[0].id,),target=DynamicMarking.FORTE))
    run(CreateSlurIntent(start_measure_id=document.measures[0].id,start_position=start,end_measure_id=document.measures[0].id,end_position=MeasurePosition.of(numerator=3,denominator=4),voice_ids=(document.voices[0].id,)))
    run(CreateRefrainIntent(start_measure_id=document.measures[1].id,start_position=start,end_measure_id=document.measures[2].id,end_position=start,times=2))
  elif op=='undo':
   log=undo.pop();log.rollback();redo.append(log)
  elif op=='redo':
   log=redo.pop();log.reapply();undo.append(log)
  else:
   body=request['body']
   if op=='dynamics': intent=SetDynamicIntent(measure_id=body['measure_id'],position=position(body['position']),voice_ids=tuple(body['voice_ids']),dynamic=DynamicMarking(body['dynamic']))
   elif op=='context-voices': intent=AddContextVoiceIntent(context_id=body['context_id'],voice_id=body['voice_id'])
   elif op=='context-voice-removals': intent=RemoveContextVoiceIntent(context_id=body['context_id'],voice_id=body['voice_id'])
   elif op=='refrain-times': intent=SetRefrainTimesIntent(refrain_id=body['refrain_id'],times=body['times'])
   else: raise ValueError(op)
   undo.append(run(intent));redo=[]
  print(json.dumps({'status':200,'document':ScoreView(document=document).jsonify()}),flush=True)
 except MutationRejectedError as error: print(json.dumps({'status':422,'detail':str(error)}),flush=True)
 except Exception as error: print(json.dumps({'status':500,'detail':repr(error)}),flush=True)
`;
const child = spawn(path.join(backend, '.venv/bin/python'), ['-u', '-c', python], { cwd: backend, stdio: ['pipe', 'pipe', 'inherit'] });
const queue = [];
createInterface({ input: child.stdout }).on('line', line => { const pending = queue.shift(); if (pending) pending.resolve(JSON.parse(line)); });
child.on('exit', code => { while (queue.length) queue.shift().reject(new Error(`Domain stand exited: ${code}`)); });
const domain = request => new Promise((resolve, reject) => { queue.push({ resolve, reject }); child.stdin.write(JSON.stringify(request) + '\n'); });
const playwright = require(process.env.PLAYWRIGHT_MODULE_PATH || '/Users/admin/.npm/_npx/db89d7302a373f10/node_modules/playwright');
const engine = process.env.ENGINE || 'webkit', width = Number(process.env.TEST_WIDTH || 1440), theme = process.env.TEST_THEME || 'light';
const output = process.env.TEST_OUTPUT || '/private/tmp/piano-multi-choice'; fs.mkdirSync(output, { recursive: true });
let browser;
try {
  browser = await playwright[engine].launch({ headless: true, ...(engine === 'chromium' && process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });
  const page = await browser.newPage({ viewport: { width, height: 1000 }, reducedMotion: process.env.REDUCED ? 'reduce' : 'no-preference' });
  const errors = [], requests = []; let rejectNext = false;
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/**', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.pathname.startsWith('/api/drafts/demo/edit/')) {
      const op = url.pathname.split('/').at(-1), body = request.postData() ? request.postDataJSON() : {};
      requests.push({ op, method: request.method(), body });
      const response = rejectNext ? { status: 422, detail: 'Scope rejected by isolated fixture' } : await domain({ op, body }); rejectNext = false;
      return route.fulfill({ status: response.status, contentType: 'application/json', body: JSON.stringify(response.status === 200 ? { document: response.document } : { detail: response.detail }) });
    }
    if (url.pathname === '/api/drafts') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ draft_id: 'demo', title: 'Context checks', ref_score_id: null, updated_at: '2026-11-12T00:00:00Z' }]) });
    return route.fulfill({ status: url.pathname === '/api/auth/refresh' ? 401 : 404, contentType: 'application/json', body: '{}' });
  });
  await page.goto(`${process.env.VITE_URL || 'http://localhost:5173'}/demo-editor.html?playing=0&t=0&theme=${theme}`);
  await page.waitForLoadState('networkidle');
  await page.evaluate(async () => {
    const { HttpGateway } = await import('/src/core/gateway/HttpGateway.ts');
    const { useAuthStore } = await import('/src/core/auth/authStore.ts');
    const { playback } = await import('/src/core/playback/PlaybackController.ts');
    playback.unlock = () => {}; playback.previewCarrier = async () => {};
    useAuthStore.setState({ status: 'authed', userId: 'isolated-context', username: 'Test', accessToken: 'isolated-context-token' });
    window.__editor.setState({ gateway: new HttpGateway() });
  });
  const load = async (music, legacy = false) => {
    const response = await domain({ op: 'reset', music, legacy }); assert.equal(response.status, 200, response.detail);
    await page.mouse.move(0, 0);
    await page.evaluate(async view => {
      const { fromView } = await import('/src/core/model/fromView.ts'); const document = fromView(view, 'demo');
      if (document.measures[0].voices.some(v => v.items.length)) window.domainMusicFixture = structuredClone(document);
      window.__editor.setState({ document, scoreId: 'demo', tool: 'select', error: null, currentStaff: document.staffOrder[0], currentVoice: 0,
        selectedIds: [], carrierSelectedIds: [], selectedStructureIds: [], selectedMeasureIds: [], stemOverrides: document.stemOverrides });
    }, response.document);
    await page.waitForFunction(() => document.querySelectorAll('.inspector:not([inert]) [role="group"][aria-label="Voices"]').length === 0);
  };
  const select = async id => {
    await page.evaluate(id => { window.__editor.getState().select(null); window.__editor.getState().selectStructure(id, false); }, id);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await page.waitForFunction(() => document.querySelectorAll('.inspector:not([inert]) .multi-choice').length === 1);
  };
  const contexts = () => page.evaluate(() => window.__editor.getState().document.contexts);
  const scope = () => page.locator('.inspector:not([inert]) .multi-choice[aria-label="Voices"]');
  const waitChecked = async (label, expected) => page.waitForFunction(({ label, expected }) => {
    const groups = [...document.querySelectorAll('.inspector:not([inert]) [role="group"][aria-label="Voices"]')];
    return groups.length === 1 && [...groups[0].querySelectorAll('button')].find(button => button.textContent === label)?.getAttribute('aria-pressed') === String(expected);
  }, { label, expected });
  const waitDone = () => page.waitForFunction(() => { const group = document.querySelector('.inspector:not([inert]) .multi-choice'); return !!group && group.getAttribute('aria-disabled') !== 'true'; });
  await load(false);
  let sharedStart = (await contexts()).filter(c => c.kind === 'dynamic');
  assert.equal(sharedStart.length, 1, 'a new score starts with one shared dynamic');
  assert.equal(sharedStart[0].voiceIds.length, 2);
  await select(sharedStart[0].id);
  assert.equal(await scope().getByRole('button', { pressed: true }).count(), 2);
  await load(true);
  const firstNote = await page.evaluate(() => window.__editor.getState().document.measures[0].voices[0].items[0].notes[0].noteId);
  await page.evaluate(() => window.__editor.setState({ currentVoice: 1, tool: 'mark:dyn:f' }));
  const firstPoint = await page.locator(`[data-individual-note-id="${firstNote}"]`).evaluate(el => {const rect=el.getBoundingClientRect();return{x:rect.x+rect.width/2,y:rect.y+rect.height/2};});
  await page.mouse.move(firstPoint.x, firstPoint.y); await page.mouse.click(firstPoint.x, firstPoint.y);
  await page.waitForFunction(() => window.__editor.getState().document.contexts.some(c => c.kind === 'dynamic' && c.position.numerator === 0 && c.dynamic === 'f'));
  const split = (await contexts()).filter(c => c.kind === 'dynamic' && c.position.numerator === 0);
  const expectedVoices = await page.evaluate(() => window.__editor.getState().document.voices.map(v => v.id));
  assert.equal(split.length, 2);
  assert.deepEqual(split.find(c => c.dynamic === 'p').voiceIds, [expectedVoices[0]]);
  assert.deepEqual(split.find(c => c.dynamic === 'f').voiceIds, [expectedVoices[1]]);
  assert.deepEqual(requests.at(-1).body.voice_ids, [expectedVoices[1]], 'inserting with voice 2 only detaches voice 2');
  await page.evaluate(() => window.__editor.getState().undo());
  const restored = (await contexts()).filter(c => c.kind === 'dynamic' && c.position.numerator === 0);
  assert.equal(restored.length, 1); assert.equal(restored[0].voiceIds.length, 2);
  await load(false, true);
  const voiceIds = await page.evaluate(() => window.__editor.getState().document.voices.map(v => v.id));
  let initial = (await contexts()).filter(c => c.kind === 'dynamic').sort((a, b) => voiceIds.indexOf(a.voiceIds[0]) - voiceIds.indexOf(b.voiceIds[0])); assert.equal(initial.length, 2);
  for (const context of initial) {
    assert.equal(await page.locator(`.score-scale [data-object-id="${context.id}"]`).count(), 1, 'every separate initial p is drawn');
    // Exercise the actual engraved mark / overlay click, not just store selection.
    const hit = page.locator(`.overlay [data-pick-kind="context"][data-pick-id="${context.id}"]`);
    await hit.hover(); await hit.click();
    await page.waitForFunction(id => window.__editor.getState().selectedStructureIds.includes(id), context.id);
    await page.waitForFunction(() => document.querySelectorAll('.inspector:not([inert]) [role="group"][aria-label="Voices"]').length === 1);
    assert.equal(await scope().getByRole('button', { pressed: true }).count(), 1);
  }
  await select(initial[0].id);
  await page.screenshot({ path: `${output}/separate-${engine}-${width}-${theme}.png` });
  const count = requests.length;
  await scope().getByRole('button', { name: 'Voice 2', exact: true }).evaluate(button => { button.click(); button.click(); });
  await waitChecked('Voice 2', true); await waitDone();
  assert.equal(requests.length, count + 1, 'rapid repeated join emits one command');
  assert.equal(requests.at(-1).op, 'dynamics'); assert.equal(requests.at(-1).method, 'PUT'); assert.equal(requests.at(-1).body.voice_ids.length, 2);
  assert.equal((await contexts()).filter(c => c.kind === 'dynamic').length, 1);
  assert.equal(await scope().getByRole('button', { pressed: true }).count(), 2);
  assert.equal(await scope().locator('button:disabled').count(), 2, 'initial dynamic removals stay protected');
  await page.screenshot({ path: `${output}/shared-${engine}-${width}-${theme}.png` });
  await page.evaluate(() => window.__editor.getState().undo());
  assert.equal((await contexts()).filter(c => c.kind === 'dynamic').length, 2, 'one real Undo restores the two initial dynamics');
  await page.evaluate(() => window.__editor.getState().redo());
  assert.equal((await contexts()).filter(c => c.kind === 'dynamic').length, 1);
  await load(true);
  let middle = (await contexts()).find(c => c.kind === 'dynamic' && c.position.numerator !== 0); await select(middle.id);
  const voice2 = scope().getByRole('button', { name: 'Voice 2', exact: true }); await voice2.focus();
  const beforeKeyboard = requests.length;
  await page.keyboard.press('ArrowLeft');
  assert.equal(await scope().getByRole('button', { name: 'Voice 1', exact: true }).evaluate(button => button === document.activeElement), true);
  assert.equal(requests.length, beforeKeyboard, 'arrows move focus without changing the set');
  await page.keyboard.press('Space'); await waitChecked('Voice 1', false); await waitDone();
  assert.equal(requests.at(-1).op, 'context-voice-removals');
  assert.equal((await contexts()).find(c => c.id === middle.id).voiceIds.length, 1, 'noninitial removal keeps the context id');
  await scope().getByRole('button', { name: 'Voice 1', exact: true }).focus(); await page.keyboard.press('ArrowRight');
  assert.equal(await scope().getByRole('button', { name: 'Voice 1', exact: true }).evaluate(button => button === document.activeElement), true, 'focus skips disabled last voice');
  await page.keyboard.press('Home'); await page.keyboard.press('End');
  rejectNext = true; await page.keyboard.press('Enter');
  await page.waitForFunction(() => !!window.__editor.getState().error); await waitDone();
  await waitChecked('Voice 1', false);
  assert.deepEqual(await page.evaluate(() => window.__editor.getState().selectedStructureIds), [middle.id]);
  await scope().getByRole('button', { name: 'Voice 1', exact: true }).click(); await waitChecked('Voice 1', true); await waitDone();
  assert.equal(await page.evaluate(() => window.__editor.getState().error), null);
  const shared = (await contexts()).find(c => c.kind === 'dynamic' && c.position.numerator !== 0);
  assert.equal(shared.voiceIds.length, 2); assert.notEqual(shared.id, middle.id);
  assert.deepEqual(await page.evaluate(() => window.__editor.getState().selectedStructureIds), [shared.id], 'successful replacement becomes selected');
  for (const kind of ['hairpin', 'slur']) {
    const context = (await contexts()).find(c => c.kind === kind); await select(context.id);
    await scope().getByRole('button', { name: 'Voice 2', exact: true }).click(); await waitChecked('Voice 2', true); await waitDone();
    assert.equal(requests.at(-1).op, 'context-voices'); assert.equal((await contexts()).find(c => c.id === context.id).voiceIds.length, 2);
    await scope().getByRole('button', { name: 'Voice 1', exact: true }).click(); await waitChecked('Voice 1', false); await waitDone();
    assert.equal(requests.at(-1).op, 'context-voice-removals'); assert.equal((await contexts()).find(c => c.id === context.id).voiceIds.length, 1);
  }
  // Constructor shares the same control, but does not send a command while editing its tool scope.
  await page.evaluate(() => window.__editor.getState().select(null));
  await page.waitForFunction(() => document.querySelectorAll('.inspector:not([inert]) [role="group"]').length === 0);
  const sidebarButton = page.getByRole('button', { name: 'Show panel', exact: true });
  if (await sidebarButton.count()) await sidebarButton.click();
  await page.getByRole('tab', { name: 'Build', exact: true }).click();
  await page.getByRole('radio', { name: 'Mark', exact: true }).click();
  const constructorScope = page.locator('.hp-build .multi-choice[aria-label="Voices"]');
  const beforeConstructor = requests.length;
  await constructorScope.getByRole('button', { name: 'Voice 2', exact: true }).click();
  assert.equal(await constructorScope.getByRole('button', { pressed: true }).count(), 2);
  assert.equal(requests.length, beforeConstructor);
  await page.waitForTimeout(600); // inspect the settled existing choice thumbs, not their transition
  await page.screenshot({ path: `${output}/constructor-${engine}-${width}-${theme}.png` });
  if (width <= 1024) {
    await page.getByRole('button', { name: 'Hide panel', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.editor-rail').getBoundingClientRect().right <= 1);
  }
  console.log(`PASS ${engine}: independent/shared initial dynamics, real HTTP/domain join/remove/Undo/Redo, rapid repeats, rejected join/retry, keyboard, hairpin/slur voices and constructor`);
  // Color fixtures exercise rendered SVG feedback. They are presentation fixtures, not domain edits.
  await load(true);
  await page.evaluate(() => {
    const state = window.__editor.getState(), document = structuredClone(state.document), upper = document.staffOrder[0];
    const voices = document.measures[0].voices;
    voices[0].items.forEach((item, i) => { item.duration = '8'; item.writtenSize = { value: { value: 8, dots: 0 }, count: 1 }; item.occupiedSize = undefined;
      item.position = i / 2; item.positionFraction = { numerator: i, denominator: 8 }; item.notes[0].staffId = upper; item.notes[0].staffStep = 0; });
    voices[0].items[0].ornament = 'trill'; voices[0].items[0].articulations = ['accent']; voices[0].items[0].notes[0].fingering = 2;
    voices[1].items.forEach((item, i) => item.notes[0].staffStep = 4 + i * 2);
    document.beams = [{ id: 'color-beam', carrierIds: voices[0].items.map(item => item.id) }];
    document.tuplets = [{ id: 'color-tuplet', carrierIds: voices[1].items.slice(0, 3).map(item => item.id), numNotes: 3, notesOccupied: 2 }];
    document.ties = [{ id: 'color-tie', startNoteId: voices[0].items[0].notes[0].noteId, endNoteId: voices[0].items[1].notes[0].noteId }];
    document.glissandos = [{ id: 'color-gliss', startNoteId: voices[1].items[1].notes[0].noteId, endNoteId: voices[1].items[2].notes[0].noteId, glissandoType: 'straight' }];
    window.colorFixture = document;
    window.__editor.setState({ document, selectedIds: [], carrierSelectedIds: [], selectedStructureIds: [], selectedMeasureIds: [], voiceColors: {} });
  });
  const colors = () => page.evaluate(() => {
    const document = window.__editor.getState().document;
    const voiceInk = document.voices.map(voice => {
      const item = document.measures[0].voices.find(v => v.id === voice.id).items[0];
      return getComputedStyle(window.document.querySelector(`[data-individual-note-id="${item.notes[0].noteId}"] path`)).fill;
    });
    const read = (id, property = 'fill') => [...window.document.querySelectorAll(`.score-scale [data-object-id="${id}"] path, .score-scale [data-object-id="${id}"] text`)].map(el => getComputedStyle(el)[property]).filter(color => color !== 'none');
    return { voiceInk, beam: read('color-beam'), tuplet: read('color-tuplet'), tupletStroke: read('color-tuplet', 'stroke'), tie: read('color-tie'), gliss: read('color-gliss', 'stroke'),
      contexts: document.contexts.map(context => ({ kind: context.kind, values: read(context.id, context.kind === 'hairpin' ? 'stroke' : 'fill'), stroke: read(context.id, 'stroke') })),
      attached: [...window.document.querySelectorAll(`.vf-stavenote[data-note-id="${document.measures[0].voices[0].items[0].id}"] path:not(.vf-ledger), .vf-stavenote[data-note-id="${document.measures[0].voices[0].items[0].id}"] text`)].map(el => getComputedStyle(el).fill) };
  });
  const plain = await colors();
  for (const kind of ['beam', 'tuplet', 'tie', 'gliss']) assert.ok(plain[kind].length, `${kind} is engraved before feedback`);
  assert.equal(await page.locator('.score-scale [data-object-id].selected, .score-scale [data-object-id].hovered').count(), 0);
  await page.evaluate(() => {
    const d = window.__editor.getState().document;
    window.__editor.setState({ selectedIds: d.measures[0].voices.flatMap(v => v.items.flatMap(item => item.notes.map(n => n.noteId))),
      carrierSelectedIds: d.measures[0].voices.flatMap(v => v.items.map(item => item.id)),
      selectedStructureIds: ['color-beam', 'color-tuplet', 'color-tie', 'color-gliss', ...d.contexts.map(c => c.id)], selectedMeasureIds: [d.measures[0].id] });
  });
  await page.waitForFunction(() => window.document.querySelector('[data-object-id="color-tie"].selected'));
  const checkColors = async () => {
    const result = await colors();
    for (const [kind, index] of [['beam', 0], ['tie', 0], ['tuplet', 1], ['tupletStroke', 1], ['gliss', 1]]) {
      assert.ok(result[kind].length, `${kind} has visible SVG`);
      assert.ok(result[kind].every(value => value === result.voiceInk[index]), `${kind} matches its voice: ${JSON.stringify(result[kind])} / ${result.voiceInk[index]}`);
    }
    const contextsWithInk = result.contexts.filter(c => c.values.length);
    const pink = contextsWithInk.find(c => c.kind === 'dynamic').values[0];
    for (const context of contextsWithInk) assert.ok([...context.values, ...context.stroke].every(color => color === pink), `${context.kind} uses common pink: ${JSON.stringify(context.values)} / ${pink}`);
    assert.notEqual(pink, result.voiceInk[0]); assert.notEqual(pink, result.voiceInk[1]);
    assert.ok(result.attached.length); assert.ok(result.attached.every(color => color === result.voiceInk[0]), 'attached marks retain note voice');
    const handleInk = await page.locator('.slur-handles').first().evaluate(el => getComputedStyle(el).color);
    assert.equal(handleInk, pink, 'slur handles match context ink');
    return pink;
  };
  const pink = await checkColors();
  const selectedColors = await colors();
  for (const kind of ['beam', 'tuplet', 'tie', 'gliss']) assert.notDeepEqual(plain[kind], selectedColors[kind], `${kind} only takes voice feedback ink after selection`);
  await page.evaluate(() => { const voices = window.__editor.getState().document.voices; window.__editor.setState({ voiceColors: { [voices[0].id]: '#b3683a', [voices[1].id]: '#6a5cb8' } }); });
  await page.waitForFunction(() => document.querySelector('[data-object-id="color-tie"]')?.style.getPropertyValue('--voice-color') === '#b3683a');
  assert.equal(await checkColors(), pink, 'custom voice colors do not affect contexts');
  const custom = await colors();
  assert.notEqual(custom.voiceInk[0], plain.voiceInk[0]);

  await page.waitForTimeout(600); // let the existing inspector content swap settle for visual inspection
  await page.screenshot({ path: `${output}/colors-${engine}-${width}-${theme}.png` });
  const hoverCases = [['color-tie', custom.voiceInk[0], 'fill'], ['color-gliss', custom.voiceInk[1], 'stroke'], [(await contexts()).find(c => c.kind === 'dynamic').id, pink, 'fill']];
  for (const [id, expected, property] of hoverCases) {
    await page.mouse.move(0, 0);
    await page.evaluate(() => window.__editor.setState({ selectedIds: [], carrierSelectedIds: [], selectedStructureIds: [], selectedMeasureIds: [] }));
    await page.waitForFunction(() => [...document.querySelectorAll('.inspector')].every(el => el.classList.contains('inspector--rail') || el.getBoundingClientRect().top >= innerHeight - 1));
    const hit = page.locator(`.overlay [data-pick-id="${id}"]`).first();
    const points = await hit.evaluate(element => {
      const path = element.matches('path') ? element : element.querySelector('path');
      const box = path.getBBox(), rect = path.getBoundingClientRect();
      return [.75, .25, .5, .15, .35, .65, .85].map(fraction => {
        const point = path.getPointAtLength(path.getTotalLength() * fraction);
        return { x: rect.x + (point.x - box.x) / box.width * rect.width, y: rect.y + (point.y - box.y) / box.height * rect.height };
      });
    });
    let hovered = false;
    for (const point of points) {
      await page.mouse.move(point.x, point.y);
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      hovered = await page.locator(`.score-scale [data-object-id="${id}"].hovered`).count() > 0;
      if (hovered) break;
    }
    assert.ok(hovered, `${id} exposes a real curve point for hover, outside neighboring note pads`);
    const inks = await page.locator(`.score-scale [data-object-id="${id}"] path`).evaluateAll((elements, property) => elements.map(el => getComputedStyle(el)[property]).filter(color => color !== 'none'), property);
    assert.ok(inks.length && inks.every(color => color === expected), `${id} hover uses the same semantic ink`);
  }
  // A real system break must not drop the voice color on either half of a tie.
  await page.mouse.move(0, 0);
  await page.evaluate(() => {
    const d = structuredClone(window.domainMusicFixture), template = d.measures[0];
    d.measures = Array.from({ length: 14 }, (_, mi) => ({ ...structuredClone(template), id: `cross-m-${mi}`,
      voices: template.voices.map((voice, vi) => ({ id: voice.id, items: voice.items.map((item, ni) => ({ ...structuredClone(item), id: `cross-c-${mi}-${vi}-${ni}`,
        notes: item.notes.map((n, i) => ({ ...n, noteId: `cross-n-${mi}-${vi}-${ni}-${i}` })) })) })) }));
    d.contexts = d.contexts.filter(c => c.measureId === template.id && c.position.numerator === 0 && !('endMeasureId' in c)).map(c => ({ ...c, measureId: 'cross-m-0' }));
    d.ties = []; d.glissandos = []; d.beams = []; d.tuplets = [];
    window.__editor.setState({ document: d, selectedIds: [], carrierSelectedIds: [], selectedStructureIds: [], selectedMeasureIds: [] });
  });
  await page.waitForSelector('[data-individual-note-id="cross-n-13-0-0-0"]');
  const crossIndex = await page.evaluate(() => {
    const ys = Array.from({ length: 14 }, (_, i) => document.querySelector(`[data-individual-note-id="cross-n-${i}-0-0-0"]`).getBoundingClientRect().y);
    return ys.findIndex((y, i) => i > 0 && y > ys[i - 1] + 40);
  });
  assert.ok(crossIndex > 0);
  await page.evaluate(index => { const d = structuredClone(window.__editor.getState().document); d.ties = [{ id: 'cross-tie', startNoteId: `cross-n-${index - 1}-0-3-0`, endNoteId: `cross-n-${index}-0-0-0` }]; window.__editor.setState({ document: d, selectedStructureIds: ['cross-tie'] }); }, crossIndex);
  await page.waitForFunction(() => document.querySelectorAll('[data-object-id="cross-tie"].selected').length === 2);
  const halves = await page.locator('.score-scale [data-object-id="cross-tie"] path').evaluateAll(elements => elements.map(el => getComputedStyle(el).fill));
  assert.equal(halves.length, 2); assert.ok(halves.every(color => color === custom.voiceInk[0]));
  assert.deepEqual(errors, []);
  console.log(`PASS ${engine}: beam/tuplet/tie/gliss voice feedback, custom voice colors, attached marks, common context/slur-handle pink, actual hover and both tie halves across systems`);
} finally { await browser?.close(); child.stdin.end(); }
