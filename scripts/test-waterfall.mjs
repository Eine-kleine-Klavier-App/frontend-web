import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const ts = require('typescript');
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

function load(file, stubs = {}) {
  const full = path.join(root, file);
  const module = { exports: {} };
  const js = ts.transpileModule(fs.readFileSync(full, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(js, { module, exports: module.exports, Math, Map, Set, parseInt, require(name) {
    if (name in stubs) return stubs[name];
    throw new Error('Unexpected import: ' + name);
  } }, { filename: full });
  return module.exports;
}

const { voiceRamp, rgba } = load('src/features/playback/waterfall/waterfallPalette.ts', { '@/ui/cssToken': { readCssToken: () => '' } });

// A voice colour keeps its own hue: the brightest channel of the ramp is the voice's brightest channel.
const hue = ([r, g, b]) => (r >= g && r >= b ? 'r' : g >= b ? 'g' : 'b');
for (const [hex, dominant] of [['#4a6fb3', 'b'], ['#2f8579', 'g'], ['#b3683a', 'r']]) {
  const ramp = voiceRamp(hex);
  assert.equal(hue(ramp.near), dominant, `${hex}: near keeps the voice hue`);
  assert.equal(hue(ramp.glow), dominant, `${hex}: glow keeps the voice hue`);
  for (const channel of [...ramp.near, ...ramp.far, ...ramp.glow]) assert.ok(channel >= 0 && channel <= 255, `${hex}: channels stay in range`);
}
assert.deepEqual(Array.from(voiceRamp('#808080').near, Math.round), Array.from(voiceRamp('#202020').near, Math.round), 'a grey has no hue: every grey gives the same ramp');
assert.equal(rgba([300, -5, 10.4], 2), 'rgba(255,0,10,1)', 'rgba clamps its channels and its alpha');
console.log('PASS voice colour → ramp keeps the hue and stays in range');

const { waterfallNotes, waterfallBars } = load('src/features/playback/waterfall/waterfallNotes.ts', {
  '@/core/model/contexts': { measureBeats: (signature) => signature.beats * 4 / signature.beatValue },
  '@/core/playback/PlaybackController': { timeInSegment: (segment, beats) => segment.startMs + (beats - segment.startBeats) / (segment.endBeats - segment.startBeats) * (segment.endMs - segment.startMs) },
});
const document = {
  voices: [{ id: 'first', index: 0 }, { id: 'second', index: 1 }],
  measures: [0, 1].map((n) => ({
    timeSignature: { beats: 4, beatValue: 4 },
    voices: [
      { id: 'first', items: n === 0 ? [{ notes: [{ noteId: 'a' }] }] : [] },
      { id: 'second', items: n === 0 ? [{ notes: [{ noteId: 'b' }] }] : [] },
    ],
  })),
};
const map = {
  notes: [
    { sourceId: 'a', pitch: 60, startMs: 0, keyReleaseMs: 250, endMs: 500, velocity: 127 },
    { sourceId: 'b', pitch: 48, startMs: 500, keyReleaseMs: 1500, endMs: 1500, velocity: 64 },
    { sourceId: 'gone', pitch: 72, startMs: 1500, keyReleaseMs: 2000, endMs: 2000, velocity: 1 },
  ],
  pedals: [{ downMs: 0, upMs: 500 }],
  anchors: [],
  // measures 1 and 2 are played, then measure 1 again: a repeat
  segments: [{ startBeats: 0, endBeats: 8, startMs: 0, endMs: 4000 }, { startBeats: 0, endBeats: 4, startMs: 4000, endMs: 6000 }],
  extentMs: 6000,
  version: 1,
};
const notes = waterfallNotes(map, document);
assert.deepEqual(Array.from(notes, (note) => note.voice), [0, 1, 0], 'each note takes its voice from the score; an unknown note falls to the first voice');
assert.deepEqual(Array.from(notes, (note) => [note.start, note.duration]), [[0, 0.25], [0.5, 1], [1.5, 0.5]], 'times are seconds');
assert.equal(notes[0].sustainDuration, 0.5, 'pedal holds the sound after the physical key release');
assert.equal(notes[0].velocity, 1);
assert.ok(Math.abs(notes[1].velocity - 64 / 127) < 1e-9, 'loudness is 0..1');
assert.deepEqual(Array.from(waterfallBars(map, document)), [0, 2, 4], 'a measure is marked once for each pass, in the time it is played');
console.log('PASS the play map → timed notes in voices and measure marks');


if (process.env.PLAYWRIGHT_MODULE_PATH) {
  const playwright = require(process.env.PLAYWRIGHT_MODULE_PATH), engine = process.env.ENGINE || 'webkit';
  const browser = await playwright[engine].launch({ headless: true, ...(engine === 'chromium' && process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });
  try {
    const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
    await page.route('**/__strip_test__', route => route.fulfill({ contentType: 'text/html', body: '<style>html,body{margin:0;height:100%;overflow:hidden}canvas{width:100%;height:100%;display:block}</style><canvas></canvas>' }));
    await page.goto(`${process.env.VITE_URL || 'http://localhost:5173'}/__strip_test__`);
    const result = await page.evaluate(async () => {
      const { WaterfallScene } = await import('/src/features/playback/waterfall/rollScene.ts');
      const scene = new WaterfallScene(document.querySelector('canvas'));
      const { voiceRamp } = await import('/src/features/playback/waterfall/waterfallPalette.ts');
      scene.setRamps([voiceRamp('#4a6fb3')]);
      scene.resize(); scene.setPiece([], [0, 2, 4, 4.4]); scene.setStripLight('#26183f');
      const fields = [0, .081, .5, 2.081, 4.036, 4.3].map(time => { scene.render(time); return Array.from(scene.underField); });
      scene.setStripLight('#39724a'); scene.render(4.3); const changed = Array.from(scene.underField);
      scene.dispose();
      return { fields, changed };
    });
    assert.ok(result.fields[0].some(channel => channel > 0), 'the actual strip was rendered');
    for (const field of result.fields) assert.deepEqual(field, result.fields[0], 'strip light stays constant across measure starts and seeks');
    assert.notDeepEqual(result.changed, result.fields[0], 'strip colour is still adjustable');
    console.log(`PASS ${engine}: actual scene strip has steady brightness and responds to colour changes`);


    const guides = await page.evaluate(async () => {
      const { WaterfallScene } = await import('/src/features/playback/waterfall/rollScene.ts');
      const { voiceRamp } = await import('/src/features/playback/waterfall/waterfallPalette.ts');
      const scene = new WaterfallScene(document.querySelector('canvas')); scene.resize(); scene.setRamps([voiceRamp('#4a6fb3')]);
      scene.setPiece([], [scene.lookAhead * .4]);
      let capturing = false, stats;
      const drawGuides = scene.guides, stroke = scene.ctx.stroke, moveTo = scene.ctx.moveTo, fillRect = scene.ctx.fillRect;
      scene.guides = function() { capturing = true; try { drawGuides.call(this); } finally { capturing = false; } };
      scene.ctx.stroke = function(...args) { if (capturing) stats.strokes++; return stroke.apply(this, args); };
      scene.ctx.moveTo = function(...args) { if (capturing) stats.octaves++; return moveTo.apply(this, args); };
      scene.ctx.fillRect = function(...args) { if (capturing) stats.measures++; return fillRect.apply(this, args); };
      const before = JSON.stringify(scene.projectRoll(scene.keys[0].x, .4));
      const result = [];
      for (const [octaves, measures] of [[true, true], [false, true], [true, false], [false, false]]) {
        stats = { strokes: 0, octaves: 0, measures: 0 };
        scene.setGuides(octaves, measures); scene.render(0);
        if (JSON.stringify(scene.projectRoll(scene.keys[0].x, .4)) !== before) throw new Error('Guide flags changed note geometry');
        result.push({ showOctaves: octaves, showMeasures: measures, ...stats, expectedOctaves: scene.octaveEdges.length, image: scene.sheet.toDataURL() });
      }
      scene.dispose(); return result;
    });
    for (const item of guides) {
      assert.equal(item.strokes, item.showOctaves ? 1 : 0, 'only enabled octave guides are stroked');
      assert.equal(item.octaves, item.showOctaves ? item.expectedOctaves : 0, 'all octave rays are independently toggled');
      assert.equal(item.measures, item.showMeasures ? 3 : 0, 'measure cut and end ticks follow only their own setting');
    }
    assert.equal(new Set(guides.map(item => item.image)).size, 4, 'all four actual rendered images differ');
    console.log(`PASS ${engine}: all four guide combinations independently change actual rendering without changing note geometry`);

    for (const width of [1440, 768, 375]) {
      await page.setViewportSize({ width, height: 900 });
      const geometry = await page.evaluate(async () => {
        const { WaterfallScene } = await import('/src/features/playback/waterfall/rollScene.ts');
        const scene = new WaterfallScene(document.querySelector('canvas'));
        scene.resize();
        const lanes = scene.keys.map(key => key.x);
        const times = [0, scene.lookAhead * .25, scene.lookAhead * .5, scene.lookAhead, scene.lookAhead * 1.035];
        const original = lanes.map(lane => times.map(seconds => scene.projectRoll(lane, seconds)));
        let checked = 0;
        for (const tilt of [-2, -1, -.57, 0, .43, 1, 2]) {
          scene.setTilt(tilt);
          const expectedTilt = Math.max(-1, Math.min(1, tilt));
          if (scene.tilt !== expectedTilt) throw new Error('Tilt must stay within the supported range');
          for (const [column, lane] of lanes.entries()) {
            const strike = scene.projectRoll(lane, 0);
            if (Math.abs(strike.x - lane) > 1e-9 || strike.y !== scene.rail || strike.scale !== 1) throw new Error('A tilted note missed its key');
            for (const [row, seconds] of times.entries()) {
              const point = scene.projectRoll(lane, seconds);
              if (point.y !== original[column][row].y) throw new Error('Tilt changed the playback time mapping');
              if (!(point.scale > .06 && point.scale < 1.22)) throw new Error('Trajectories crossed or spread beyond the checked moderate range');
              if (column && !(point.x > scene.projectRoll(lanes[column - 1], seconds).x)) throw new Error('Piano lanes changed order');
              if (tilt === 0 && (Math.abs(point.x - lane) > 1e-9 || point.scale !== 1)) throw new Error('Vertical trajectories are not parallel');
              if (tilt >= 1 && Math.abs(point.x - original[column][row].x) > 1e-9) throw new Error('From centre no longer matches the original fan');
              checked++;
            }
          }
          const left = scene.projectRoll(lanes[0], scene.lookAhead).x;
          const right = scene.projectRoll(lanes.at(-1), scene.lookAhead).x;
          if (tilt < 0 && !(left < lanes[0] && right > lanes.at(-1))) throw new Error('From sides points in the wrong direction');
          if (tilt > 0 && !(left > lanes[0] && right < lanes.at(-1))) throw new Error('From centre points in the wrong direction');
        }
        scene.dispose();
        return checked;
      });
      console.log(`PASS ${engine}/${width}: ${geometry} actual projection samples, exact key strikes and stable time mapping`);
    }


    for (const [width, height, panelWidth] of [[1440, 900, 288], [1100, 650, 264], [1100, 1800, 264]]) {
      await page.setViewportSize({ width, height });
      const reserve = await page.evaluate(async ({ height, panelWidth }) => {
        const { WaterfallScene } = await import('/src/features/playback/waterfall/rollScene.ts');
        const { voiceRamp } = await import('/src/features/playback/waterfall/waterfallPalette.ts');
        const canvas = document.querySelector('canvas');
        canvas.style.height = `${height}px`;
        const base = new WaterfallScene(canvas); base.resize();
        const reference = Object.fromEntries(['unit', 'rail', 'depth', 'pitch', 'stripY', 'lookAhead', 'nearSpeed'].map(name => [name, base[name]]));
        const oldPositions = base.keys.map(key => [key.x, [.1, .5, reference.lookAhead].map(seconds => base.projectRoll(key.x, seconds).y)]);
        base.dispose();
        canvas.style.height = `${height * innerWidth / (innerWidth - panelWidth)}px`;
        const scene = new WaterfallScene(canvas); scene.resize(height);
        const equal = (a, b, message) => { if (Math.abs(a - b) > 1e-8) throw new Error(`${message}: ${a} versus ${b}`); };
        equal(scene.unit, reference.unit, 'Original drawing units changed');
        equal(scene.depth / scene.pitch, reference.depth / reference.pitch, 'Key proportions changed');
        equal(scene.rail - scene.rollTop, reference.rail, 'Strike line moved relative to the bottom');
        equal(scene.stripY - scene.rollTop, reference.stripY, 'Keyboard strip moved relative to the bottom');
        equal(scene.nearSpeed, reference.nearSpeed, 'Near-key vertical speed changed');
        equal(scene.lookAhead, reference.lookAhead, 'Original time mapping changed');
        if (!(scene.rollTop > 0 && scene.visibleAhead > scene.lookAhead)) throw new Error('No additional future area');
        for (const [lane, ys] of oldPositions) for (const [index, seconds] of [.1, .5, reference.lookAhead].entries()) equal(scene.projectRoll(lane, seconds).y - scene.rollTop, ys[index], 'Existing note vertical position changed');
        for (const tilt of [-1, 0, 1]) {
          scene.setTilt(tilt);
          for (const seconds of [0, scene.lookAhead, scene.visibleAhead, scene.visibleAhead + .16]) {
            let previous = -Infinity;
            for (const key of scene.keys) {
              const point = scene.projectRoll(key.x, seconds);
              if (!(point.scale > 0 && point.x > previous)) throw new Error('Extended trajectories crossed');
              previous = point.x;
            }
          }
        }
        equal(scene.projectRoll(scene.keys[0].x, scene.visibleAhead).y, 0, 'Extended time limit is not the surface top');
        scene.setTilt(0); scene.setRamps([voiceRamp('#4a6fb3')]);
        const future = (scene.lookAhead + scene.visibleAhead) / 2;
        const point = scene.projectRoll(scene.byMidi.get(60).x, future + .1);
        if (!(point.y > 0 && point.y < scene.rollTop)) throw new Error('Future note is not in the extra upper area');
        scene.setPiece([{ pitch: 60, voice: 0, start: future, duration: .3, velocity: .8 }], [future]);
        const rendered = [], rectangles = [];
        const ribbon = scene.ribbon, fillRect = scene.ctx.fillRect;
        scene.ribbon = function(note, ...args) { rendered.push(note.start); return ribbon.call(this, note, ...args); };
        scene.ctx.fillRect = function(...args) { rectangles.push(args); return fillRect.apply(this, args); };
        scene.render(0);
        if (!rendered.includes(future)) throw new Error('Future note was still culled at the old limit');
        const line = scene.projectRoll(0, future);
        if (!rectangles.some(([x, y, w]) => Math.abs(y - line.y) < 1e-8 && w > scene.width / 4)) throw new Error('Future measure line was still culled');
        const pixel = Array.from(scene.ctx.getImageData(Math.round(point.x * scene.sheet.width / scene.width), Math.round(point.y * scene.sheet.height / scene.height), 1, 1).data);
        if (!(pixel[2] > 80)) throw new Error('Future ribbon has no rendered pixels');
        const result = { base: scene.lookAhead, extended: scene.visibleAhead, ratio: scene.depth / scene.pitch, pixel };
        scene.dispose(); canvas.style.height = '100%';
        return result;
      }, { height, panelWidth });
      console.log(`PASS ${engine}/${width}x${height}: preserved keys/near timing, future note and measure pixels beyond ${reserve.base.toFixed(2)}s through ${reserve.extended.toFixed(2)}s`);
    }

    // Mount the actual editor, not a duplicate panel wrapper: state must reach the actual scene.
    const exceptions = [];
    page.on('pageerror', error => exceptions.push(error.message));
    await page.route('**/api/**', route => {
      const url = new URL(route.request().url());
      const body = url.pathname === '/api/drafts' ? [{ draft_id: 'tilt-test', title: 'Tilt study', ref_score_id: null, updated_at: '2026-11-11T00:00:00Z' }] : { items: [], next_cursor: null };
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
    });
    await page.route('**/__tilt_controls_test__', route => route.fulfill({ contentType: 'text/html', body: '<link rel="stylesheet" href="/src/styles/tokens.css"><link rel="stylesheet" href="/src/index.css"><div id="root"></div>' }));
    const width = Number(process.env.TEST_WIDTH || 1440), theme = process.env.TEST_THEME || 'dark';
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ reducedMotion: process.env.REDUCED_MOTION === '1' ? 'reduce' : 'no-preference' });
    await page.goto(`${process.env.VITE_URL || 'http://localhost:5173'}/__tilt_controls_test__`);
    await page.evaluate(async theme => {
      document.documentElement.dataset.theme = theme;
      const Refresh = await import('/@react-refresh');
      Refresh.default.injectIntoGlobalHook(window);
      window.$RefreshReg$ = () => {}; window.$RefreshSig$ = () => type => type;
      window.__vite_plugin_react_preamble_installed__ = true;
      const source = await (await fetch('/src/features/editor/EditorScreen.tsx')).text();
      const reactModule = await import(source.match(/from ["']([^"']*\/react\.js[^"']*)["']/)[1]);
      const React = reactModule.default ?? reactModule;
      const clientModule = await import('/node_modules/.vite/deps/react-dom_client.js');
      const { createRoot } = clientModule.default ?? clientModule;
      const routerModule = await import(source.match(/from ["']([^"']*react-router-dom[^"']*)["']/)[1]);
      const { MemoryRouter, Routes, Route } = routerModule.default ?? routerModule;
      const { useEditor } = await import(source.match(/from ["']([^"']*\/app\/store\.ts[^"']*)["']/)[1]);
      const { useAuthStore } = await import('/src/core/auth/authStore.ts');
      const { fromView } = await import('/src/core/model/fromView.ts');
      const { playback } = await import(source.match(/from ["']([^"']*PlaybackController\.ts[^"']*)["']/)[1]);
      window.testPlayback = playback;
      const view = await (await fetch('/demo-editor-view.json')).json();
      useAuthStore.setState({ status: 'authed', userId: 'me', accessToken: 'isolated-test-only' });
      useEditor.setState({ document: fromView(view, 'tilt-test'), scoreId: 'tilt-test', loading: false, load: async () => {} });
      playback.prepareMap = async () => {
        playback.set({ map: { notes: [21, 24, 36, 48, 60, 72, 84, 96, 108].flatMap((pitch, index) => Array.from({ length: 12 }, (_, n) => ({ sourceId: 'fixture', pitch, startMs: 400 + n * 500, endMs: 700 + n * 500, velocity: 80 + index }))), anchors: [], segments: [], extentMs: 8000, version: 1 }, mapLoading: false });
      };
      const stageSource = await (await fetch(source.match(/from ["']([^"']*WaterfallStage\.tsx[^"']*)["']/)[1])).text();
      const { WaterfallScene } = await import(stageSource.match(/from ["']([^"']*rollScene\.ts[^"']*)["']/)[1]);
      const setTilt = WaterfallScene.prototype.setTilt;
      WaterfallScene.prototype.setTilt = function(value) { window.tiltScene = this; setTilt.call(this, value); };
      const { default: EditorScreen } = await import('/src/features/editor/EditorScreen.tsx');
      createRoot(document.querySelector('#root')).render(React.createElement(MemoryRouter, { initialEntries: ['/edit/tilt-test'] }, React.createElement(Routes, null, React.createElement(Route, { path: '/edit/:draftId', element: React.createElement(EditorScreen) }))));
    }, theme);
    await page.getByRole('radio', { name: 'Waterfall', exact: true }).click();
    await page.getByRole('button', { name: 'Show panel', exact: true }).click();
    const group = page.getByRole('radiogroup', { name: 'Note tilt presets' });
    const slider = page.getByRole('slider', { name: 'Manual tilt' });
    await group.waitFor({ state: 'visible' });
    await page.waitForFunction(() => window.tiltScene?.tilt === 1);
    const octaveControl = page.getByRole('checkbox', { name: 'Octave lines', exact: true });
    const measureControl = page.getByRole('checkbox', { name: 'Measure lines', exact: true });
    assert.equal(await octaveControl.isChecked(), true); assert.equal(await measureControl.isChecked(), true);
    await page.evaluate(() => {
      window.guideFrames = 0; const scene = window.tiltScene, render = scene.render;
      scene.render = function(...args) { window.guideFrames++; return render.apply(this, args); };
    });
    for (const [octaves, measures] of [[false, true], [true, false], [true, true], [false, false]]) {
      const before = await page.evaluate(() => window.guideFrames);
      await octaveControl.setChecked(octaves); await measureControl.setChecked(measures);
      await page.waitForFunction(([octaves, measures, before]) => window.tiltScene.octaveLines === octaves && window.tiltScene.measureLines === measures && window.guideFrames > before, [octaves, measures, before]);
      assert.equal(await octaveControl.isChecked(), octaves); assert.equal(await measureControl.isChecked(), measures);
    }
    await octaveControl.focus(); await octaveControl.press('Space');
    await page.waitForFunction(() => window.tiltScene.octaveLines === true && window.tiltScene.measureLines === false);
    assert.equal(await page.evaluate(() => window.testPlayback.getState().playing), false, 'Space in a checkbox does not start playback');
    console.log(`PASS ${engine}/${width}: guide defaults, four independent settings, paused redraw and native keyboard control`);
    assert.equal(await group.getByRole('radio', { name: 'From centre', exact: true }).getAttribute('aria-checked'), 'true');
    for (const [name, value] of [['Vertical', 0], ['From sides', -1], ['From centre', 1]]) {
      await group.getByRole('radio', { name, exact: true }).hover();
      await group.getByRole('radio', { name, exact: true }).click();
      await page.waitForFunction(value => window.tiltScene.tilt === value, value);
      assert.equal(await slider.inputValue(), String(value * 100));
      await page.waitForFunction(() => {
        const selected = document.querySelector('[aria-label="Note tilt presets"] [aria-checked="true"]');
        const thumb = selected?.querySelector('.choice-thumb');
        if (!thumb) return false;
        const option = selected.getBoundingClientRect(), mark = thumb.getBoundingClientRect();
        const aligned = Math.abs(option.x - mark.x) < .1 && Math.abs(option.y - mark.y) < .1 && Math.abs(option.width - mark.width) < .1;
        window.tiltAlignedFrames = aligned ? (window.tiltAlignedFrames || 0) + 1 : 0;
        return window.tiltAlignedFrames >= 3;
      }, null, { polling: 'raf' });
      if (width >= 768) await page.screenshot({ path: `/private/tmp/waterfall-tilt-${engine}-${width}-${theme}-${value}.png` });
    }
    await slider.focus(); await slider.press('Home'); await slider.press('ArrowRight');
    await page.waitForFunction(() => window.tiltScene.tilt === -.99);
    assert.equal(await group.locator('[aria-checked="true"]').count(), 0, 'a manual value clears the preset');
    assert.equal(await slider.getAttribute('aria-valuetext'), '99% from sides');
    await slider.press('End');
    assert.equal(await group.getByRole('radio', { name: 'From centre', exact: true }).getAttribute('aria-checked'), 'true', 'an exact manual match selects its preset');
    await group.getByRole('radio', { name: 'Vertical', exact: true }).focus();
    await page.keyboard.press('ArrowLeft');
    await page.waitForFunction(() => window.tiltScene.tilt === -1);
    assert.equal(await group.getByRole('radio', { name: 'From sides', exact: true }).evaluate(element => element === document.activeElement), true);
    const rect = await slider.boundingBox();
    await page.mouse.move(rect.x + rect.width * .2, rect.y + rect.height / 2);
    await page.mouse.down();
    for (const fraction of [.25, .75, .1, .9, .37]) await page.mouse.move(rect.x + rect.width * fraction, rect.y + rect.height / 2);
    await page.mouse.up();
    const manual = Number(await slider.inputValue()) / 100;
    await page.waitForFunction(value => window.tiltScene.tilt === value, manual);
    assert.ok(manual > -1 && manual < 1, 'pointer drag actually reached a custom tilt');
    await page.getByRole('button', { name: 'Hide panel', exact: true }).click();
    await page.getByRole('radio', { name: 'Editor', exact: true }).click();
    await page.getByRole('radio', { name: 'Waterfall', exact: true }).click();
    await page.getByRole('button', { name: 'Show panel', exact: true }).click();
    assert.equal(Number(await slider.inputValue()) / 100, manual, 'view and panel switches retain the manual value');
    assert.equal(await octaveControl.isChecked(), true); assert.equal(await measureControl.isChecked(), false, 'view and panel switches retain guide settings');
    await measureControl.check();
    await page.waitForFunction(() => window.tiltScene.measureLines === true);
    await page.waitForFunction(value => window.tiltScene.tilt === value, manual);
    const overflow = await page.locator('.waterfall-tilt').evaluate(section => Array.from(section.querySelectorAll('button,input,output,label')).filter(element => { const r = element.getBoundingClientRect(), p = section.getBoundingClientRect(); return r.left < p.left - 1 || r.right > p.right + 1; }).map(element => element.outerHTML));
    assert.deepEqual(overflow, [], 'all controls fit the panel');
    assert.deepEqual(exceptions, [], 'the actual editor has no runtime errors');
    console.log(`PASS ${engine}/${width}/${theme}: presets, keyboard, rapid pointer drag, exact-match selection and actual editor-to-scene state retention`);

    const quietLeft = await page.evaluate(async () => {
      const rail = document.querySelector('.editor-rail'), app = document.querySelector('.editor-screen'), toggle = document.querySelector('.panel-toggle');
      let min = 1, max = 0, reversals = 0, maxEdgeGap = 0;
      for (const opening of [false, true]) {
        if ((toggle.getAttribute('aria-expanded') === 'true') !== opening) toggle.click();
        let previous = opening ? 0 : 1;
        for (let frame = 0; frame < 60; frame++) {
          await new Promise(requestAnimationFrame);
          const r = rail.getBoundingClientRect(), bounds = app.getBoundingClientRect(), progress = (r.right - bounds.left) / r.width;
          min = Math.min(min, progress); max = Math.max(max, progress);
          if ((opening ? progress - previous : previous - progress) < -.001) reversals++;
          previous = progress;
          if (matchMedia('(min-width:64.0625em)').matches) maxEdgeGap = Math.max(maxEdgeGap, Math.abs(document.querySelector('.waterfall-fit').getBoundingClientRect().left - r.right));
        }
      }
      return { min, max, reversals, maxEdgeGap };
    });
    assert.ok(quietLeft.min >= -.001 && quietLeft.max <= 1.001, JSON.stringify(quietLeft));
    assert.equal(quietLeft.reversals, 0, 'left panel has no recoil or anticipation kick');
    assert.ok(quietLeft.maxEdgeGap < .1, JSON.stringify(quietLeft));
    console.log(`PASS ${engine}/${width}: left panel is monotonic, stays in range and shares its moving edge with the stage`);

    const reserveAudit = await page.evaluate(async () => {
      const canvas = document.querySelector('.waterfall-canvas'), stage = document.querySelector('.waterfall-stage'), fit = document.querySelector('.waterfall-fit');
      const app = document.querySelector('.editor-screen'), toggle = document.querySelector('.panel-toggle');
      let layoutResizes = 0, bufferResizes = 0;
      const observer = new ResizeObserver(() => { layoutResizes++; }); observer.observe(canvas);
      await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame); layoutResizes = 0;
      for (const name of ['width', 'height']) {
        const descriptor = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, name);
        Object.defineProperty(canvas, name, { configurable: true, get() { return descriptor.get.call(this); }, set(value) { bufferResizes++; descriptor.set.call(this, value); } });
      }
      const scene = window.tiltScene;
      const visiblePoints = () => {
        const picture = fit.getBoundingClientRect(), bounds = stage.getBoundingClientRect();
        const panel = document.querySelector('.editor-rail').getBoundingClientRect(), bar = document.querySelector('.editor-bar').getBoundingClientRect();
        const points = new Map();
        const add = (id, x, y) => {
          const screenX = picture.left + x / scene.width * picture.width, screenY = picture.top + y / scene.height * picture.height;
          points.set(id, { x: screenX, y: screenY, visible: screenX >= Math.max(bounds.left, panel.right) && screenX <= bounds.right && screenY >= bar.bottom && screenY <= bounds.bottom });
        };
        for (const key of scene.keys) add(`key-${key.midi}`, key.x, scene.rail + scene.depth * .5);
        for (const [index, note] of scene.notes.entries()) {
          const seconds = note.start - scene.time + note.ribbon * .5;
          if (seconds < 0 || seconds > scene.visibleAhead) continue;
          const point = scene.projectRoll(scene.byMidi.get(note.pitch).x, seconds); add(`note-${index}`, point.x, point.y);
        }
        for (const [index, grain] of scene.grains.entries()) {
          let seconds = (grain.when - scene.time) % 8; if (seconds < 0) seconds += 8;
          if (seconds > scene.visibleAhead) continue;
          const point = scene.projectRoll(grain.u * scene.width, seconds); add(`grain-${index}`, point.x, point.y);
        }
        return points;
      };
      const samples = [];
      let previousPoints = visiblePoints(), maxVisibleStep = 0;
      try {
        for (let frame = 0; frame < 130; frame++) {
          if ([0, 12, 24, 36].includes(frame)) toggle.click();
          await new Promise(requestAnimationFrame);
          const picture = fit.getBoundingClientRect(), bounds = stage.getBoundingClientRect(), matrix = new DOMMatrix(getComputedStyle(fit).transform);
          const reservation = parseFloat(getComputedStyle(app).getPropertyValue('--panel-layout-w'));
          const railBounds = document.querySelector('.editor-rail').getBoundingClientRect(), progress = (railBounds.right - app.getBoundingClientRect().left) / railBounds.width;
          samples.push({ topGap: Math.max(0, picture.top - bounds.top), bottom: Math.abs(picture.bottom - bounds.bottom), right: Math.abs(picture.right - bounds.right), left: Math.abs(picture.left - bounds.left - reservation), aspect: Math.abs(matrix.a - matrix.d), outside: Math.max(0, -progress, progress - 1), x: picture.x });
          const points = visiblePoints();
          for (const [id, point] of points) {
            const previous = previousPoints.get(id);
            if (point.visible && previous?.visible) maxVisibleStep = Math.max(maxVisibleStep, Math.hypot(point.x - previous.x, point.y - previous.y));
          }
          previousPoints = points;
        }
      } finally { observer.disconnect(); delete canvas.width; delete canvas.height; }
      return {
        layoutResizes, bufferResizes, maxVisibleStep, frames: samples.length,
        maxGap: Math.max(...samples.flatMap(sample => [sample.topGap, sample.bottom, sample.right, sample.left])),
        maxAspectError: Math.max(...samples.map(sample => sample.aspect)),
        maxOvershoot: Math.max(...samples.map(sample => sample.outside)),
        maxStep: Math.max(...samples.slice(1).map((sample, index) => Math.abs(sample.x - samples[index].x))),
        keys: scene.keys.length, rollTop: scene.rollTop, baseAhead: scene.lookAhead, visibleAhead: scene.visibleAhead,
        mask: document.querySelector('.waterfall-fade') !== null,
      };
    });
    assert.ok(reserveAudit.maxGap < .1, JSON.stringify(reserveAudit));
    assert.ok(reserveAudit.maxAspectError < 1e-8, 'key proportions stay uniform on every frame');
    assert.ok(reserveAudit.maxOvershoot < .001, 'rapid left-panel reversals stay within their endpoints');
    assert.ok(reserveAudit.maxVisibleStep <= 70, `visible notes/keys/grain exceed the motion limit: ${JSON.stringify(reserveAudit)}`);
    assert.equal(reserveAudit.layoutResizes, 0, 'panel toggles never resize the prepared canvas');
    assert.equal(reserveAudit.bufferResizes, 0, 'panel toggles never reallocate its buffer');
    assert.equal(reserveAudit.keys, 88); assert.equal(reserveAudit.mask, false);
    assert.equal(reserveAudit.rollTop > 0, width > 1024, 'only wide layouts reserve an upper area');
    if (width > 1024) assert.ok(reserveAudit.visibleAhead > reserveAudit.baseAhead, 'wide view has later future notes');
    if (width >= 768) await page.screenshot({ path: `/private/tmp/waterfall-overscan-${engine}-${width}-${theme}.png` });
    console.log(`PASS ${engine}/${width}/${theme}: ${reserveAudit.frames} frames, gap ${reserveAudit.maxGap.toFixed(3)}px, aspect error ${reserveAudit.maxAspectError}, zero canvas resizes, max visible step ${reserveAudit.maxVisibleStep.toFixed(1)}px (bounds ${reserveAudit.maxStep.toFixed(1)}px)`);
    for (const targetWidth of [1100, 900, width]) {
      await page.locator('.panel-toggle').evaluate(button => button.click());
      await page.setViewportSize({ width: targetWidth, height: 900 });
      await page.waitForFunction(() => {
        const fit = document.querySelector('.waterfall-fit').getBoundingClientRect(), stage = document.querySelector('.waterfall-stage').getBoundingClientRect();
        const matrix = new DOMMatrix(getComputedStyle(document.querySelector('.waterfall-fit')).transform);
        return fit.top <= stage.top + .1 && Math.abs(fit.bottom - stage.bottom) < .1 && Math.abs(matrix.a - matrix.d) < 1e-8;
      });
      const result = await page.evaluate(async () => {
        let gap = 0, aspect = 0;
        for (let frame = 0; frame < 35; frame++) {
          await new Promise(requestAnimationFrame);
          const element = document.querySelector('.waterfall-fit'), fit = element.getBoundingClientRect(), stage = document.querySelector('.waterfall-stage').getBoundingClientRect(), matrix = new DOMMatrix(getComputedStyle(element).transform);
          gap = Math.max(gap, fit.top - stage.top, Math.abs(fit.bottom - stage.bottom)); aspect = Math.max(aspect, Math.abs(matrix.a - matrix.d));
        }
        return { gap, aspect };
      });
      assert.ok(result.gap < .1 && result.aspect < 1e-8, `viewport change mid-slide ${targetWidth}: ${JSON.stringify(result)}`);
    }
    assert.deepEqual(exceptions, [], 'viewport/panel changes have no runtime errors');
  } finally { await browser.close(); }
}
