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

const { voiceRamp, rgba } = load('src/features/playback/waterfall/waterfallPalette.ts', {
  '@/core/model/voiceColors': load('src/core/model/voiceColors.ts'),
  '@/ui/cssToken': { readCssToken: () => '' },
});

// A voice colour keeps its own hue: the brightest channel of the ramp is the voice's brightest channel.
const hue = ([r, g, b]) => (r >= g && r >= b ? 'r' : g >= b ? 'g' : 'b');
for (const [hex, dominant] of [['#4a6fb3', 'b'], ['#2f8579', 'g'], ['#b3683a', 'r']]) {
  const ramp = voiceRamp(hex);
  assert.equal(hue(ramp.near), dominant, `${hex}: near keeps the voice hue`);
  assert.equal(hue(ramp.glow), dominant, `${hex}: glow keeps the voice hue`);
  for (const channel of [...ramp.near, ...ramp.far, ...ramp.glow]) assert.ok(channel >= 0 && channel <= 255, `${hex}: channels stay in range`);
}
assert.deepEqual(Array.from(voiceRamp('#0d1211').near), [13, 18, 17], 'the near colour is the chosen RGB');
assert.deepEqual(Array.from(voiceRamp('#0d1211').glow), [13, 18, 17], 'the glow starts from the chosen RGB');
assert.deepEqual(Array.from(voiceRamp('#ff0000').far), [255, 128, 0], 'the far edge keeps the 30-degree hue shift');
for (const stop of ['near', 'far', 'glow']) {
  assert.notDeepEqual(Array.from(voiceRamp('#123456')[stop]), Array.from(voiceRamp('#2468ac')[stop]), 'value changes each stop at the same hue and saturation');
  assert.notDeepEqual(Array.from(voiceRamp('#0000ff')[stop]), Array.from(voiceRamp('#8080ff')[stop]), 'saturation changes each stop at the same hue and value');
  assert.deepEqual(Array.from(voiceRamp('#808080')[stop]), [128, 128, 128], 'a grey stays grey');
  assert.deepEqual(Array.from(voiceRamp('#202020')[stop]), [32, 32, 32], 'a darker grey stays darker');
}
assert.equal(rgba([300, -5, 10.4], 2), 'rgba(255,0,10,1)', 'rgba clamps its channels and its alpha');
console.log('PASS voice colour → ramp follows hue, saturation and value');

const { waterfallNotes, waterfallBars } = load('src/features/playback/waterfall/waterfallNotes.ts', {
  '@/core/model/contexts': { measureBeats: (signature) => signature.beats * 4 / signature.beatValue },
  '@/core/navigation/ScoreNavigation': { timeInSegment: (segment, beats) => segment.startMs + (beats - segment.startBeats) / (segment.endBeats - segment.startBeats) * (segment.endMs - segment.startMs) },
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


const {
  prepareWaterfallWindow, waterfallRasterRatio, waterfallSurfaceRatios, waterfallWindowId, WaterfallWindowCache,
} = load('src/features/playback/waterfall/waterfallFrameCache.ts');
const source = {
  bars: [0, 2, 4, 6, 8],
  extent: 9,
  starts: new Float64Array([0, 1, 1.5, 4, 6, 8]),
  latestExpiry: new Float64Array([7, 7, 7, 7, 7.5, 8.5]),
  pedalStarts: new Float64Array([1.5, 6, 7]),
};
assert.equal(waterfallWindowId(source, 4), 2);
assert.equal(waterfallWindowId(source, 3.9999), 1);
const held = prepareWaterfallWindow(source, 2, 1.2);
assert.equal(held.noteFrom, 0, 'a long note is still included after its starting measure');
assert.equal(held.noteTo, 5, 'notes within the visibility horizon are included');
assert.equal(held.pedalFrom, 0, 'the preceding pedal is included');
assert.equal(held.pedalTo, 2, 'the pedal crossing the next boundary is retained');
assert.equal(prepareWaterfallWindow(source, 4, 1.2).noteFrom, 5);
const cache = new WaterfallWindowCache();
cache.moveTo(8, 30);
assert.deepEqual(Array.from(cache.missing(8)), [8, 9, 10, 11, 12, 13, 14, 15]);
cache.add(Array.from({ length: 31 }, (_, id) => ({ ...held, id })));
assert.ok(cache.get(3) && cache.get(18), 'five bars behind and ten ahead are resident');
assert.equal(cache.get(2), undefined);
assert.equal(cache.get(19), undefined);
cache.moveTo(28, 30);
assert.equal(cache.get(8), undefined, 'a long seek drops the old window');
assert.deepEqual(Array.from(cache.missing(28)), [28, 29, 30, 27, 26, 25, 24, 23]);
cache.clear();
for (const [width, height, dpr] of [[1440, 1125, 2], [1100, 1800, 3], [768, 900, 2], [393, 852, 3], [1440, 1125, 1]]) {
  const ratio = waterfallRasterRatio(width, height, dpr);
  assert.ok(ratio > 0 && ratio <= dpr);
  assert.ok(Math.round(width * ratio) * Math.round(height * ratio) <= 1_073_741, 'the single canvas respects the raster budget');
  const keyboardHeight = height * .24;
  const rollHeight = height * .78;
  const split = waterfallSurfaceRatios(width, rollHeight, keyboardHeight, dpr);
  const area = (regionHeight, scale) => Math.round(width * scale) * Math.round(regionHeight * scale);
  assert.ok(area(rollHeight, split.roll) + area(keyboardHeight, split.keyboard) <= 1_280_000,
    'the two regions share a single backing store budget');
  assert.ok(split.keyboard >= split.roll && split.keyboard <= dpr, 'the keys get priority within the screen density');
}
console.log('PASS conservative measure data, bounded worker requests and raster budget');

async function checkRecordedWaterfall(browser, engine, cases) {
  const origin = process.env.VITE_URL || 'http://localhost:5173';
  const size = {
    width: Number(process.env.WATERFALL_PERF_WIDTH || 1440),
    height: Number(process.env.WATERFALL_PERF_HEIGHT || 900),
  };
  const seconds = Number(process.env.WATERFALL_PERF_SECONDS || 25);
  const traceDirectory = process.env.WATERFALL_PERF_TRACE_DIR;
  if (traceDirectory) fs.mkdirSync(traceDirectory, { recursive: true });
  const misses = [];
  for (const { title, file, startMs, seekMs } of cases) {
    const fixture = JSON.parse(fs.readFileSync(file, 'utf8'));
    const page = await browser.newPage({ viewport: size, deviceScaleFactor: 2 });
    page.setDefaultTimeout(45000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => {
      const probe = window.waterfallTiming = { samples: [], windowBatches: 0, webglRequests: 0, active: false };
      const nativeContext = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (kind, ...options) {
        if (/webgl/i.test(kind)) {
          probe.webglRequests++;
          return null;
        }
        return nativeContext.call(this, kind, ...options);
      };
      const nativeWorker = window.Worker;
      window.Worker = class extends nativeWorker {
        constructor(url, options) {
          super(url, options);
          if (!String(url).includes('WaterfallPrerender')) return;
          this.addEventListener('message', ({ data }) => {
            if (Array.isArray(data.windows)) probe.windowBatches++;
          });
        }
      };
    });
    await page.route('**/api/**', route => {
      const url = new URL(route.request().url());
      if (url.pathname === '/api/auth/refresh') return route.fulfill({ status: 401, json: {} });
      if (url.pathname.endsWith('/playback/map')) return route.fulfill({ json: fixture.map });
      if (url.pathname === '/api/scores/waterfall-timing') return route.fulfill({
        json: {
          id: 'waterfall-timing', title, composer: null, author_id: null, author_name: null,
          is_public: true, updated_at: '2026-11-19T00:00:00Z', document: fixture.view,
        },
      });
      return route.fulfill({ json: { items: [], next_cursor: null } });
    });
    await page.route('**/WaterfallStage.tsx*', async route => {
      const response = await route.fetch();
      const source = await response.text();
      const clock = 'const playhead = () => Math.max(0, navigation.getTimeMs());';
      const tick = 'const tick = () => {';
      assert.ok(source.includes(clock) && source.includes(tick), 'the probe reads the audible clock and the frame callback');
      await route.fulfill({ response, body: source
        .replace(clock, clock + ' window.waterfallTiming.playback=playback; window.waterfallTiming.navigation=navigation;')
        .replace(tick, tick + ' if(window.waterfallTiming.active){window.waterfallTiming.tick=window.waterfallTiming.tickStart=performance.now();}') });
    });
    await page.route('**/rollScene.ts*', async route => {
      const response = await route.fetch();
      const source = await response.text();
      const entry = /render\(timeSeconds, prepared\) \{/;
      assert.ok(entry.test(source));
      await route.fulfill({ response, body: source.replace(entry, match => match + `
        const probe = globalThis.waterfallTiming;
        const rendering = probe?.active && this.canvas.classList?.contains('waterfall-canvas');
        const started = rendering ? performance.now() : 0;
        const audible = rendering ? probe.navigation.getTimeMs() : 0;
        try {
      `).replace(
        '}, lights);',
        '}, lights); } finally { if(rendering) probe.samples.push({at:performance.now(), tick:probe.tick, start:started, audio:audible, time:timeSeconds*1000, prepared:!!prepared, playing:probe.playback.getState().playing}); }',
      ) });
    });
    const button = (name) => page.getByRole('button', { name, exact: true });
    const seek = (milliseconds) => page.evaluate(async (time) => {
      const { beatAtTime } = await import('/src/core/navigation/ScoreNavigation.ts');
      const { playback, navigation } = window.waterfallTiming;
      playback.seek(beatAtTime(navigation.getState().map, time));
    }, milliseconds);

    try {
      await page.goto(origin + '/scores/waterfall-timing');
      await page.getByRole('radio', { name: 'Waterfall', exact: true }).click();
      await page.waitForFunction(() => document.querySelector('.editor-screen.is-waterfall') && window.waterfallTiming.navigation?.getState().map);
      if (await button('Show panel').isVisible()) await button('Show panel').click();
      await page.getByRole('radio', { name: 'Vertical', exact: true }).click();
      if (await button('Hide panel').isVisible()) await button('Hide panel').click();
      await button('Play from line').click();
      await page.waitForFunction(() => window.waterfallTiming.playback.getState().playing);
      await seek(startMs);
      await page.waitForFunction(time => {
        const { playback, navigation } = window.waterfallTiming;
        return playback.getState().playing && Math.abs(navigation.getTimeMs() - time) < 750;
      }, startMs);
      await page.evaluate(() => {
        window.waterfallTiming.samples.length = 0;
        window.waterfallTiming.active = true;
      });
      await page.waitForTimeout(seconds * 1000);
      const run = await page.evaluate(() => {
        const probe = window.waterfallTiming;
        probe.active = false;
        return { samples: probe.samples.slice(), windowBatches: probe.windowBatches, webglRequests: probe.webglRequests };
      });
      assert.ok(run.samples.length >= 2);
      assert.ok(run.samples.every(sample => sample.playing), 'the dense clip keeps playing throughout the timing sample');
      assert.ok(run.samples.at(-1).audio - run.samples[0].audio >= (seconds - 0.5) * 1000,
        'the timing sample covers the requested interval on the audible clock');
      const gaps = run.samples.slice(1).map((sample, i) => sample.at - run.samples[i].at);
      const duplicates = run.samples.slice(1).filter((sample, i) => sample.time <= run.samples[i].time).length;
      const fps = 1000 * gaps.length / (run.samples.at(-1).at - run.samples[0].at);
      const longest = Math.max(...gaps);
      if (traceDirectory) {
        const name = title.toLowerCase().replace(/[^a-z0-9]+/g, '-');
        fs.writeFileSync(path.join(traceDirectory, `${engine}-${size.width}x${size.height}-${name}.json`), JSON.stringify(run));
      }
      assert.deepEqual(errors, []);
      assert.equal(run.webglRequests, 0, 'the app runs and draws without requesting a WebGL context');
      assert.ok(run.windowBatches > 0 && run.samples.some(sample => sample.prepared), 'the scene consumes cached measure data');
      assert.equal(duplicates, 0, 'a presented frame never repeats or rewinds during continuous playback');
      assert.ok(run.samples.every(({ time, audio }) => time <= audio + 1), 'visual events never precede the audible clock');
      const renderTimes = run.samples.map(sample => sample.at - sample.start).sort((a, b) => a - b);
      const p95 = renderTimes[Math.floor((renderTimes.length - 1) * .95)];
      console.log(`Waterfall cadence ${engine}/${size.width}×${size.height} ${title}: ${fps.toFixed(2)} FPS, max display ${longest.toFixed(1)}ms, render p95 ${p95.toFixed(1)}ms`);

      await page.evaluate(() => {
        window.waterfallTiming.samples.length = 0;
        window.waterfallTiming.active = true;
      });
      await seek(seekMs);
      await page.waitForFunction(time => window.waterfallTiming.samples.some(frame =>
        frame.playing && Math.abs(frame.time - time) < 300), seekMs);
      const handoff = await page.evaluate(time => {
        const probe = window.waterfallTiming;
        probe.active = false;
        return probe.samples.find(frame => frame.playing && Math.abs(frame.time - time) < 300);
      }, seekMs);
      assert.ok(handoff.audio - handoff.time >= -1 && handoff.audio - handoff.time < 34, 'cold seek publishes the new position in sync');
      await page.evaluate(() => {
        window.waterfallTiming.samples.length = 0;
        window.waterfallTiming.active = true;
      });
      await button('Pause playback').click();
      await page.waitForFunction(() => window.waterfallTiming.playback.getState().paused);
      const heldMs = await page.evaluate(() => window.waterfallTiming.navigation.getTimeMs());
      await page.waitForTimeout(120);
      const held = await page.evaluate(() => window.waterfallTiming.samples.at(-1));
      assert.ok(held && Math.abs(held.time - heldMs) < 1, 'paused pose matches the held PCM position');
      await button('Resume playback').click();
      await page.waitForFunction(time => window.waterfallTiming.samples.some(frame => frame.playing && frame.time > time), heldMs);
      const resumed = await page.evaluate(time => {
        const probe = window.waterfallTiming;
        probe.active = false;
        return probe.samples.find(frame => frame.playing && frame.time > time);
      }, heldMs);
      assert.ok(resumed.audio - resumed.time >= -1 && resumed.audio - resumed.time < 18,
        'the first moving pose uses the resumed audio clock');
      await page.getByRole('radio', { name: 'Score', exact: true }).click();
      if (fps < 59.5 || longest > 25 || p95 > 1000 / 60) {
        const index = gaps.indexOf(longest);
        const previous = run.samples[index], next = run.samples[index + 1];
        misses.push({ title, fps: fps.toFixed(2), maximumMs: longest, renderP95Ms: p95, previous, next });
      }
    } finally {
      await page.close();
    }
  }
  assert.deepEqual(misses, [], 'every played canvas interval stays within the presentation deadline');
}

if (process.env.WATERFALL_PERF_FIXTURES) {
  const playwright = require(process.env.PLAYWRIGHT_MODULE_PATH);
  const engine = process.env.ENGINE || 'webkit';
  const browser = await playwright[engine].launch({
    headless: true,
    ...(engine === 'chromium' ? {
      args: process.env.WATERFALL_SOFTWARE === '1' ? ['--disable-gpu'] : ['--use-angle=metal', '--enable-gpu'],
    } : {}),
  });
  try {
    await checkRecordedWaterfall(browser, engine, JSON.parse(process.env.WATERFALL_PERF_FIXTURES));
  } finally {
    await browser.close();
  }
}

if (process.env.PLAYWRIGHT_MODULE_PATH && !process.env.WATERFALL_PERF_FIXTURES) {
  const playwright = require(process.env.PLAYWRIGHT_MODULE_PATH), engine = process.env.ENGINE || 'webkit';
  const browser = await playwright[engine].launch({ headless: true, ...(engine === 'chromium' && process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });
  try {
    const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
    await page.route('**/__strip_test__', route => route.fulfill({ contentType: 'text/html', body: '<link rel="stylesheet" href="/src/styles/tokens.css"><style>html,body{margin:0;height:100%;overflow:hidden}canvas{width:100%;height:100%;display:block}</style><canvas></canvas>' }));
    await page.goto(`${process.env.VITE_URL || 'http://localhost:5173'}/__strip_test__`, { waitUntil: 'load' });
    const result = await page.evaluate(async () => {
      const { WaterfallScene } = await import('/src/features/playback/waterfall/rollScene.ts');
      const scene = new WaterfallScene(document.querySelector('canvas'));
      const { voiceRamp } = await import('/src/features/playback/waterfall/waterfallPalette.ts');
      scene.setRamps([voiceRamp('#4a6fb3')]);
      scene.resize(); scene.setPiece([], [0, 2, 4, 4.4]);
      const strip = () => {
        const row = scene.ctx.getImageData(0, Math.floor(scene.stripY * scene.canvas.height / scene.height), scene.canvas.width, 1);
        return Array.from(row.data).filter((_, channel) => channel % 4 !== 3);
      };
      const fields = [0, .081, .5, 2.081, 4.036, 4.3].map(time => { scene.render(time); return strip(); });
      scene.setStripLight('#39724a'); scene.render(4.3); const changed = strip();
      scene.dispose();
      return { fields, changed };
    });
    assert.ok(result.fields[0].some(channel => channel > 0), 'the actual strip was rendered');
    for (let offset = 0; offset < result.fields[0].length; offset += 3) {
      const [r, g, b] = result.fields[0].slice(offset, offset + 3);
      assert.ok(Math.max(r, g, b) - Math.min(r, g, b) <= 6, 'the visible lower strip is neutral by default');
    }
    for (const field of result.fields) assert.deepEqual(field, result.fields[0], 'strip light stays constant across measure starts and seeks');
    assert.notDeepEqual(result.changed, result.fields[0], 'strip colour is still adjustable');
    console.log(`PASS ${engine}: actual scene strip has steady brightness and responds to colour changes`);


    const pedalLight = await page.evaluate(async () => {
      const { WaterfallScene } = await import('/src/features/playback/waterfall/rollScene.ts');
      const { voiceRamp } = await import('/src/features/playback/waterfall/waterfallPalette.ts');
      const scene = new WaterfallScene(document.querySelector('canvas'));
      scene.resize();
      scene.setStripLight('#404040');
      scene.setRamps([voiceRamp('#d75734'), voiceRamp('#416cea')]);
      const note = (pitch, voice) => ({ pitch, voice, start: 1.1, duration: .2, sustainDuration: .9, velocity: 1 });
      const warm = note(60, 0);
      const cool = note(67, 1);
      scene.setPiece([warm, cool], [], [{ down: 1, up: 2 }]);
      let keys = [];
      const draw = scene.stage.draw;
      scene.stage.draw = function(context, frame, lights) {
        keys = lights;
        return draw.call(this, context, frame, lights);
      };
      const rowAt = y => Array.from(scene.ctx.getImageData(0,
        Math.floor(y * scene.canvas.height / scene.height), scene.canvas.width, 1).data);
      const sample = pitch => {
        const x = scene.byMidi.get(pitch).x * scene.canvas.width / scene.width;
        const offset = 4 * Math.floor(x);
        return rowAt(scene.stripY).slice(offset, offset + 3);
      };
      const outsideIndicator = () => [scene.rail + 1.05 * scene.depth,
        scene.stripY - .045 * scene.depth, scene.stripY + .045 * scene.depth].map(rowAt);
      const before = time => {
        scene.render(time);
        return rowAt(scene.stripY);
      };
      const idle = before(.95);
      const held = before(1.65);
      const warmColor = sample(warm.pitch);
      const coolColor = sample(cool.pitch);
      const overlap = sample(64);
      const fullyReleased = keys.length === 2 && keys.every(key => key.press === 0);
      const release = before(2.09);
      const after = before(2.3);
      const seekBack = before(1.65);
      const aroundHeld = outsideIndicator();
      scene.setPiece([warm, cool], []);
      const noPedal = before(1.65);
      const aroundIdle = outsideIndicator();
      scene.dispose();
      return { idle, held, warmColor, coolColor, overlap, fullyReleased, release, after, seekBack,
        noPedal, aroundHeld, aroundIdle };
    });
    const brightness = field => field.reduce((sum, value) => sum + value, 0);
    assert.ok(pedalLight.fullyReleased, 'pedal light does not hold the key down after note-off');
    assert.ok(pedalLight.warmColor[0] > pedalLight.warmColor[2], 'lower note lights its region in its own colour');
    assert.ok(pedalLight.coolColor[2] > pedalLight.coolColor[0], 'higher note lights its region in its own colour');
    assert.ok(pedalLight.overlap[0] > pedalLight.coolColor[0] && pedalLight.overlap[2] > pedalLight.warmColor[2], 'overlapping voices blend at the notes between them');
    assert.ok(brightness(pedalLight.held) > brightness(pedalLight.release) && brightness(pedalLight.release) > brightness(pedalLight.idle), 'pedal release fades to the idle light');
    assert.deepEqual(pedalLight.after, pedalLight.idle, 'the strip returns to its base colour after release');
    assert.deepEqual(pedalLight.seekBack, pedalLight.held, 'seeking back into the pedal reconstructs the same lit strip');
    assert.notDeepEqual(pedalLight.held, pedalLight.noPedal, 'the indicator still shows the pedal');
    assert.deepEqual(pedalLight.aroundHeld, pedalLight.aroundIdle, 'the lower indicator cannot light the fronts or the surrounding bed');

    const keyLighting = await page.evaluate(async () => {
      const { WaterfallScene } = await import('/src/features/playback/waterfall/rollScene.ts');
      const { voiceRamp } = await import('/src/features/playback/waterfall/waterfallPalette.ts');
      const { BLACK_KEY_WIDTH } = await import('/src/features/playback/waterfall/waterfallProportions.ts');
      const { CONTACT_LIGHT_ROWS, CONTACT_LIGHT_STOPS } = await import('/src/features/playback/waterfall/keyStage.ts');
      const scene = new WaterfallScene(document.querySelector('canvas'));
      scene.resize();
      scene.setRamps([voiceRamp('#416cea')]);

      const measureShadow = (direction, depth) => {
        const emitter = -2 * direction;
        const samples = Array.from({length: 98}, (_, index) => {
          const x = (.02 + index * .01) * direction;
          return { x, shade: scene.stage.castShadow((x - emitter) * direction, -x * direction, depth, 0, 0) };
        });
        const sum = samples.reduce((total, sample) => total + sample.shade, 0);
        return {
          center: samples.reduce((total, sample) => total + sample.x * sample.shade, 0) / sum,
          peak: Math.max(...samples.map(sample => sample.shade)),
          step: Math.max(...samples.slice(1).map((sample, index) => Math.abs(sample.shade - samples[index].shade))),
        };
      };
      const castGeometry = [-1, 1].map(direction => ({ direction,
        heel: measureShadow(direction, 3.05), toe: measureShadow(direction, 4.6),
      }));

      const black = scene.byMidi.get(61).x;
      const white = scene.byMidi.get(64).x;
      const cap = [black + .17 * scene.pitch, scene.rail + .23 * scene.depth];
      const attackEdge = [black, scene.rail + .04 * scene.depth];
      const neighbour = [black + .72 * scene.pitch, scene.rail + .24 * scene.depth];
      const deep = [black + .52 * scene.pitch, scene.rail + .75 * scene.depth];
      const shallow = [deep[0], scene.rail + .15 * scene.depth];
      const below = [black + .17 * scene.pitch, scene.rail + .83 * scene.depth];
      const strip = [black, scene.stripY];
      const pixel = ([x, y]) => {
        const column = Math.floor(x * scene.canvas.width / scene.width);
        const row = Math.floor(y * scene.canvas.height / scene.height);
        return Array.from(scene.ctx.getImageData(column, row, 1, 1).data).slice(0, 3);
      };
      const frame = time => {
        scene.render(time);
        const pixels = { cap: pixel(cap), attackEdge: pixel(attackEdge), neighbour: pixel(neighbour), shallow: pixel(shallow),
          deep: pixel(deep), below: pixel(below), strip: pixel(strip) };
        const keyboardPixel = (offset, fraction) => pixel([black + offset * scene.pitch, scene.rail + fraction * scene.depth]);
        const depth = Array.from({length: 81}, (_, index) => .4 + index / 200);
        const blackToe = depth.findLast(fraction => Math.max(...keyboardPixel(.14, fraction)) < 60);
        const whiteShoulders = [.72, .76, .8].flatMap(distance => [-.27, -.14, .14, .27].map(offset => keyboardPixel(offset, distance)));
        const neutralCap = [.24, .5, .76].map(distance => [-.15, 0, .15].map(offset =>
          pixel([white + offset * scene.pitch, scene.rail + distance * scene.depth]).reduce((sum, channel) => sum + channel, 0) / 3));
        const seam = [-.32, .08, .32, .5].map(offset => pixel([black + offset * scene.pitch, scene.rail + .025 * scene.pitch]));
        const crest = pixel([black, scene.rail - .14 * scene.pitch]);
        const ridge = Array.from(scene.ridgeField);
        const tipDirectLight = [CONTACT_LIGHT_ROWS - 1, 2 * CONTACT_LIGHT_ROWS - 1].flatMap(row =>
          Array.from(scene.contactPixels.slice(4 * row * CONTACT_LIGHT_STOPS, 4 * (row + 1) * CONTACT_LIGHT_STOPS))
            .filter((_, column) => column % 4 !== 3));
        return { ...pixels, blackToe, whiteShoulders, neutralCap, ridge, seam, crest, tipDirectLight };
      };

      const note = { pitch: 61, voice: 0, start: 1, duration: .22, sustainDuration: .22, velocity: .9 };
      const pedal = { down: .8, up: 2.4 };
      scene.setPiece([note], []);
      const idle = frame(.6);
      const beforeStrike = frame(.96);
      const pressed = frame(1.06);
      const released = frame(1.45);
      const longAfter = frame(3.2);
      const { sprites } = scene.stage;
      // The atlas holds four white shapes (a notch for a black key on the left, the right, both or none), then the black key.
      const poses = sprites.length / 5;
      const frontY = sprite => scene.rail + (sprite.toe + sprite.frontBottom) / 2;
      const sampleKey = pitch => {
        const key = scene.byMidi.get(pitch);
        const shape = key.black ? 4 : (scene.byMidi.get(pitch - 1)?.black ? 1 : 0) + (scene.byMidi.get(pitch + 1)?.black ? 2 : 0);
        const first = shape * poses;
        const rest = sprites[first];
        const down = sprites[first + poses - 1];
        scene.setPiece([{ ...note, pitch }], []);
        scene.render(1.12);
        // A pressed key is cut where the released one ends, so its front is sampled between its toe and that line.
        const position = [key.x, scene.rail + (down.toe + rest.frontBottom) / 2];
        const below = [key.x, scene.rail + rest.frontBottom + .02 * scene.depth];
        const pressedBelow = pixel(below);
        const lit = pixel(position);
        const frontProfile = sprite => [.21, sprite.recess, .84].map(at =>
          pixel([key.x, scene.rail + sprite.toe + (sprite.frontBottom - sprite.toe) * at]));
        const capPosition = [key.x, scene.rail + down.y + .67 * down.length];
        const heldCap = pixel(capPosition);
        const faceRows = Array.from({ length: 9 }, (_, row) =>
          [key.x, scene.rail + down.toe + (rest.frontBottom - down.toe) * (row / 8 - .12)]);
        const pressedFace = faceRows.map(pixel);
        scene.render(1.175);
        const returningCap = pixel(capPosition);
        scene.render(1.45);
        const released = pixel(position);
        const releasedFace = faceRows.map(pixel);
        scene.render(.6);
        const idleBelow = pixel(below);
        const restingRecess = key.black ? [] : frontProfile(rest);
        const gaps = [];
        if (!key.black) {
          const g = scene.ctx;
          g.save();
          g.resetTransform();
          for (const sprite of [rest, down]) {
            const samples = [[sprite.cover, sprite.y + .78 * sprite.length], ...[.15, .5, .85].map(at =>
              [sprite.front, sprite.toe + at * (sprite.frontBottom - sprite.toe)])];
            for (const [path, y] of samples) {
              let low = 0;
              let high = .5 * scene.pitch;
              for (let index = 0; index < 12; index++) {
                const mid = (low + high) / 2;
                if (g.isPointInPath(path, mid, y)) low = mid;
                else high = mid;
              }
              gaps.push(1 - 2 * low / scene.pitch);
            }
          }
          g.restore();
        }
        return {
          lit, released, idle: pixel(position), travel: (down.toe - rest.toe) / scene.depth,
          restingRecess, gaps,
          thickness: (rest.frontBottom - rest.toe) / scene.depth,
          pressedBelow, idleBelow,
          restingFace: pixel([key.x, frontY(rest)]),
          cap: pixel([key.x, scene.rail + rest.toe - .04 * scene.depth]),
          heldCap, returningCap, restingCap: pixel(capPosition),
          pressedFace, releasedFace, idleFace: faceRows.map(pixel),
        };
      };
      const blackPress = sampleKey(61);
      const whitePress = sampleKey(64);
      scene.render(1.12);
      const adjacentBlack = pixel([scene.byMidi.get(63).x, scene.rail + scene.depth * .46]);
      const adjacentWhite = pixel([white, scene.rail + scene.depth * .46]);
      scene.render(.6);
      const blackWidth = scene.byMidi.get(61).width / scene.pitch;
      const idleBlack = pixel([black, scene.rail + scene.depth * .46]);
      const railWash = [.04, .45].map(depth => pixel([white, scene.rail + scene.depth * depth]));

      scene.setPiece([{ ...note, sustainDuration: 1.4 }], [], [pedal]);
      const pedalWithoutNotes = frame(.95);
      const pedalPressed = frame(1.06);
      const pedalHeld = frame(1.45);
      const pedalSeekBack = frame(1.06);
      const pedalSeekForward = frame(1.45);

      scene.setPiece([{ ...note, duration: 0, sustainDuration: 1.4 }], [], [pedal]);
      const pedalOnly = frame(1.06);
      const receiver = scene.byMidi.get(62).x;
      const stop = Math.round(receiver / scene.width * (CONTACT_LIGHT_STOPS - 1));
      const incomingFrom = (pitch) => {
        scene.setPiece(pitch.map(pitch => ({ ...note, pitch })), []);
        scene.render(1.06);
        const samples = CONTACT_LIGHT_STOPS * CONTACT_LIGHT_ROWS;
        return [0, samples].map(start => Array.from(scene.contactPixels.slice((start + stop) * 4, (start + stop) * 4 + 4)));
      };
      const fromLeft = incomingFrom([60]);
      const fromRight = incomingFrom([64]);
      const chord = incomingFrom([60, 64]);
      const receiverX = receiver / scene.width * 255;
      const blue = voiceRamp('#416cea');
      const amber = voiceRamp('#d75734');
      scene.setRamps([blue, amber]);
      const mixSpot = [receiver, scene.rail + scene.depth * .42];
      scene.setPiece([], []);
      scene.render(1.06);
      const untreated = pixel(mixSpot);
      scene.setPiece([{ ...note, pitch: 60, voice: 1 }, { ...note, pitch: 64 }], []);
      scene.render(1.06);
      const mixed = pixel(mixSpot);

      scene.setPiece([
        { ...note, pitch: 60, voice: 1, duration: .6 },
        { ...note, pitch: 62 },
        { ...note, pitch: 64, voice: 1, duration: .6 },
        { ...note, pitch: 67, voice: 1, duration: .6 },
      ], []);
      const capPixels = (pitch, time) => {
        scene.render(time);
        const center = scene.byMidi.get(pitch).x;
        return [.52, .61, .71, .79, .87].flatMap(depth => [-.28, -.14, 0, .14, .28].map(across =>
          pixel([center + across * scene.pitch, scene.rail + depth * scene.depth])));
      };
      const chordCaps = () => [capPixels(62, 1.12), capPixels(69, 1.12), capPixels(62, 1.4)];
      const withShadows = chordCaps();
      const castShadow = scene.stage.castShadow;
      scene.stage.castShadow = () => 0;
      const withoutShadows = chordCaps();
      scene.stage.castShadow = castShadow;
      const occlusion = withShadows.map((cap, index) => Math.max(...cap.flatMap((rgb, pixelIndex) =>
        rgb.map((value, channel) => withoutShadows[index][pixelIndex][channel] - value))));

      let repeatLight;
      const draw = scene.stage.draw;
      scene.stage.draw = function (context, frame, lights) {
        repeatLight = lights.find(light => light.midi === note.pitch);
        return draw.call(this, context, frame, lights);
      };
      const next = { ...note, start: 1.22, voice: 1, velocity: 0.36 };
      scene.setPiece([{ ...note, velocity: 1 }, next], []);
      scene.render(1.26);
      const repeat = Array.from(repeatLight.rgb);
      scene.render(1.20);
      const original = Array.from(repeatLight.rgb);
      scene.render(1.26);
      const reconstructed = Array.from(repeatLight.rgb);
      scene.dispose();
      return { idle, beforeStrike, pressed, released, longAfter, blackPress, whitePress, blackWidth, BLACK_KEY_WIDTH, idleBlack, railWash, adjacentBlack, adjacentWhite, pedalWithoutNotes, pedalPressed, pedalHeld, pedalSeekBack, pedalSeekForward, pedalOnly, fromLeft, fromRight, chord, receiverX, repeat, original, reconstructed, untreated, mixed, castGeometry, occlusion, amber: amber.glow, blue: blue.glow };
    });
    assert.ok(Math.min(...keyLighting.idle.seam[2]) >= 65, 'the underlay lights the gap at the rear of the keys');
    assert.ok(Math.max(...keyLighting.idle.seam[2]) - Math.min(...keyLighting.idle.seam[2]) <= 10, 'the gap cover is neutral when idle');
    assert.ok(Math.min(...keyLighting.idle.strip) >= 115, 'the lower strip is visibly lit by default');
    assert.ok(Math.max(...keyLighting.idle.strip) - Math.min(...keyLighting.idle.strip) <= 8, 'the visible lower strip is white at rest');
    assert.ok(keyLighting.pressed.strip[2] > keyLighting.pressed.strip[0] + 18, 'the actual lower strip picks up the voice even without the pedal');
    assert.deepEqual(keyLighting.released.strip, keyLighting.idle.strip, 'the lower strip returns to white without sustain');
    assert.notDeepEqual(keyLighting.idle.crest, keyLighting.longAfter.crest, 'the upper wave moves with score time');
    assert.ok(keyLighting.pressed.crest[2] > keyLighting.pressed.crest[0] + 8, 'the upper wave picks up the voice colour');
    assert.ok(Math.max(...keyLighting.pedalHeld.seam[2]) - Math.min(...keyLighting.pedalHeld.seam[2]) <= 10, 'the upper seam returns to neutral during pedal sustain');
    assert.ok(Math.abs(keyLighting.idle.blackToe - (.5 + 2.96) / 5) <= .015,
      `the black front reaches down to where the white head begins: ${keyLighting.idle.blackToe}`);
    for (const frame of [keyLighting.idle, keyLighting.pressed]) {
      assert.ok(frame.whiteShoulders.every(pixel => Math.max(...pixel) >= 70),
        'the white surfaces stay continuous on both sides of the black key seam');
    }
    assert.ok(Math.max(...keyLighting.idleBlack) <= 32, 'the resting black cap remains near-black away from the rail');
    assert.ok(keyLighting.adjacentBlack[2] < keyLighting.adjacentWhite[2] * .55,
      'a neighbouring voice leaves the unpressed black cap visibly darker than the struck white cap');
    assert.ok(keyLighting.railWash[0][0] > keyLighting.railWash[1][0] + 10,
      'the idle strip lights the white cap from its rear edge');
    assert.ok(Math.abs(keyLighting.blackWidth - keyLighting.BLACK_KEY_WIDTH) < .0001,
      'the black note lane and key share the measured width');
    assert.ok(keyLighting.blackPress.travel > .01 && keyLighting.whitePress.travel > keyLighting.blackPress.travel,
      `the white nose dips further than the raised black nose (${keyLighting.whitePress.travel}, ${keyLighting.blackPress.travel})`);
    assert.deepEqual(keyLighting.beforeStrike.ridge, keyLighting.idle.ridge,
      'an approaching note leaves the rail emission unchanged until contact');
    const front = keyLighting.whitePress;
    assert.ok(front.thickness >= .09 && front.thickness <= .12,
      `the grey resting front is about one tenth of the white cap depth (${front.thickness})`);
    assert.ok(front.restingFace[1] >= front.cap[1] * .4 && front.restingFace[1] <= front.cap[1] * .65,
      `the front is shaded as a distinct surface (${front.restingFace}, ${front.cap})`);
    assert.deepEqual(front.pressedBelow, front.idleBelow,
      'a pressed key sinks into the bed: nothing of it shows below where the released key ends');
    assert.deepEqual(front.releasedFace, front.idleFace, 'the whole white front returns to its idle pixels');
    const luminance = ([r, g, b]) => .2126 * r + .7152 * g + .0722 * b;
    assert.ok(front.gaps.every(gap => gap >= .03 && gap <= .04) && Math.max(...front.gaps) - Math.min(...front.gaps) < .001,
      `the white-key groove is the same width at all heights and poses (${front.gaps})`);
    // A pressed key's inset sinks below the bed with the rest of its front, so only the resting front shows it.
    const [upper, recess, lower] = front.restingRecess.map(luminance);
    assert.ok(recess + 5 < Math.min(upper, lower), `the inset stays in shade between its lips (${upper}, ${recess}, ${lower})`);
    for (const key of [keyLighting.blackPress, keyLighting.whitePress]) {
      // A lit cap takes its voice's colour at full value: it is measured by its colour and its value, not its luminance,
      // which is lower for a saturated colour than for a pale one of the same value.
      const chroma = pixel => Math.max(...pixel) - Math.min(...pixel);
      const [held, returning, resting] = [key.heldCap, key.returningCap, key.restingCap].map(chroma);
      assert.ok(held - resting >= 40 && held > returning && returning > resting && Math.max(...key.heldCap) >= Math.max(...key.restingCap),
        `own light colours the cap and fades during release (colour ${held}, ${returning}, ${resting}; caps ${key.heldCap}, ${key.returningCap}, ${key.restingCap})`);
      if (key === keyLighting.whitePress) {
        // A pressed white front glows in its voice's colour, like the front end of its top.
        assert.ok(chroma(key.lit) - chroma(key.restingFace) >= 40,
          `the pressed white front takes its voice's colour (${key.lit}, ${key.restingFace})`);
      } else {
        assert.ok(luminance(key.lit) - luminance(key.restingFace) >= 48,
          `the pressed front carries visibly brighter light (${key.lit}, ${key.restingFace})`);
        assert.ok(key.lit[2] > key.lit[0] + 25, 'the pressed voice coats the front face');
      }
      assert.deepEqual(key.released, key.idle, 'the front face returns to rest after release');
    }
    assert.ok(keyLighting.pressed.cap[2] > keyLighting.idle.cap[2] + 10, 'the depressed black key lights up');
    assert.ok(keyLighting.pressed.neighbour[2] > keyLighting.idle.neighbour[2] + 4, 'its light spreads sideways near the strike edge');
    assert.ok(keyLighting.pressed.deep[2] > keyLighting.idle.deep[2] + 5, 'a black strike reaches the nearby white key at three quarters depth');
    const shallowGain = keyLighting.pressed.shallow[2] - keyLighting.idle.shallow[2];
    const deepGain = keyLighting.pressed.deep[2] - keyLighting.idle.deep[2];
    assert.ok(shallowGain >= 12 && deepGain >= shallowGain * .68,
      `the voice washes down the same white key from rail to tip (${shallowGain}, ${deepGain})`);
    assert.ok(keyLighting.idle.neutralCap.every(row => Math.max(...row) - Math.min(...row) <= 25),
      `an idle cap has no diagonal brightness band across its face (${JSON.stringify(keyLighting.idle.neutralCap)})`);
    assert.ok(keyLighting.pressed.attackEdge[2] - keyLighting.idle.attackEdge[2] >= 85,
      'the physical black key retains a bright flash next to the strike rail');
    assert.deepEqual(keyLighting.repeat, keyLighting.amber, 'a quiet repeat uses the new voice even while the louder note releases');
    assert.deepEqual(keyLighting.original, keyLighting.blue, 'rewinding before the repeat restores the original voice');
    assert.deepEqual(keyLighting.reconstructed, keyLighting.repeat, 'seeking into a repeat reconstructs its light exactly');
    assert.ok(keyLighting.pressed.tipDirectLight.every(channel => channel === 0), 'direct black-key light falls off at the front, independently of the lower strip');
    for (const sample of [keyLighting.released, keyLighting.longAfter, keyLighting.pedalHeld, keyLighting.pedalOnly]) {
      for (const spot of ['cap', 'attackEdge', 'neighbour', 'shallow', 'deep', 'below']) {
        assert.deepEqual(sample[spot], keyLighting.idle[spot], 'the RGB returns to idle without a physical key press');
      }
    }
    assert.ok(keyLighting.fromLeft[0][2] > 0 && keyLighting.fromLeft[1][2] === 0, 'C4 reaches D4 as light from the left');
    assert.ok(keyLighting.fromRight[1][2] > 0 && keyLighting.fromRight[0][2] === 0, 'E4 reaches D4 as light from the right');
    assert.ok(keyLighting.chord[0][2] > 0 && keyLighting.chord[1][2] > 0, 'a chord retains both directions');
    for (const { direction, heel, toe } of keyLighting.castGeometry) {
      assert.ok((toe.center - heel.center) * direction > .12, 'a shadow angles away from either side of its raised caster');
      // The light hangs above the pressed key, so a black key's shadow is short: it is there at the heel and fades
      // towards the front of the white key through a continuous penumbra.
      assert.ok(heel.peak > .12 && toe.peak < heel.peak * .8 && toe.step < .025,
        `the shadow falls off through a continuous penumbra (heel ${heel.peak}, toe ${toe.peak}, step ${toe.step})`);
    }
    assert.ok(keyLighting.mixed[0] > keyLighting.untreated[0] + 5 &&
      keyLighting.mixed[2] > keyLighting.untreated[2] + 5, 'both voice colors visibly reach the white key between two shadows');
    const [ownOcclusion, passiveOcclusion, releasedOcclusion] = keyLighting.occlusion;
    assert.equal(ownOcclusion, 0, 'a luminous cap has no cast shadow from another key');
    assert.ok(passiveOcclusion > 5 && releasedOcclusion > 5,
      `unlit receivers still show a shadow during the chord and after release (${passiveOcclusion}, ${releasedOcclusion})`);
    assert.ok(keyLighting.chord[0][3] < keyLighting.receiverX && keyLighting.chord[1][3] > keyLighting.receiverX, 'a chord does not collapse its sources into an average');
    assert.ok(keyLighting.pedalPressed.ridge.some(channel => channel > 0), 'a physical attack lights the ridge');
    assert.deepEqual(keyLighting.pedalHeld.ridge, keyLighting.pedalWithoutNotes.ridge, 'the ridge returns to idle during sustain after the key returns');
    assert.deepEqual(keyLighting.pedalOnly.ridge, keyLighting.pedalWithoutNotes.ridge, 'a sustained note without a physical attack does not light the ridge');
    assert.deepEqual(keyLighting.pedalSeekBack, keyLighting.pedalPressed, 'seeking backward restores exactly the strike frame');
    assert.deepEqual(keyLighting.pedalSeekForward, keyLighting.pedalHeld, 'seeking forward restores exactly the released frame');
    assert.ok(keyLighting.pedalHeld.strip[2] > keyLighting.pedalWithoutNotes.strip[2], 'the strip still carries the held note after its key is released');
    console.log('PASS Canvas 2D pixels: key light stops at the cap and goes out with the key; pedal light stays independent');

    const strikeReaction = await page.evaluate(async () => {
      const { WaterfallScene } = await import('/src/features/playback/waterfall/rollScene.ts');
      const { voiceRamp } = await import('/src/features/playback/waterfall/waterfallPalette.ts');
      const scene = new WaterfallScene(document.querySelector('canvas'));
      scene.resize();
      scene.setRamps([voiceRamp('#ee822d')]);
      const note = { pitch: 64, voice: 0, start: 1, duration: .31, sustainDuration: 1.2, velocity: .95 };
      const x = scene.byMidi.get(note.pitch).x;
      const g = scene.ctx;
      const renderContact = scene.contact;
      let outline;
      scene.contact = function(...args) {
        let points = [];
        const { beginPath, moveTo, lineTo, stroke } = g;
        g.beginPath = function() { points = []; return beginPath.call(this); };
        g.moveTo = function(x, y) { points.push([x, y]); return moveTo.call(this, x, y); };
        g.lineTo = function(x, y) { points.push([x, y]); return lineTo.call(this, x, y); };
        g.stroke = function(...args) {
          if (points.length > 30 && points[0][0] === 0 && points.at(-1)[0] === scene.width) outline = points;
          return stroke.apply(this, args);
        };
        try {
          return renderContact.apply(this, args);
        } finally {
          Object.assign(g, { beginPath, moveTo, lineTo, stroke });
        }
      };
      const capture = time => {
        outline = undefined;
        scene.render(time);
        const closest = across => outline.reduce((best, point) =>
          Math.abs(point[0] - across) < Math.abs(best[0] - across) ? point : best);
        const center = closest(x)[1];
        const wing = closest(x + .92 * scene.pitch);
        const column = Math.floor(wing[0] * scene.canvas.width / scene.width);
        const row = Math.floor(wing[1] * scene.canvas.height / scene.height);
        const rgb = Array.from(g.getImageData(column, row, 1, 1).data).slice(0, 3);
        const rippleEnergy = Array.from(scene.ridgeRippleField, strength => Math.abs(strength));
        const total = rippleEnergy.reduce((sum, strength) => sum + strength, 0);
        const distance = rippleEnergy.reduce((sum, strength, index) =>
          sum + strength * Math.abs(x - index * scene.width / (rippleEnergy.length - 1)), 0);
        return { center, wing: wing[1], rgb, ripple: total ? distance / total / scene.pitch : 0 };
      };
      const times = [.955, 1.048, 1.18, 1.64];
      const untouched = times.map(capture);
      scene.setPiece([note], [], [{ down: .85, up: 2 }]);
      const reacted = times.map(capture);
      scene.dispose();
      return { untouched, reacted, scale: Math.max(.78, Math.min(2.75, scene.pitch / 10.8)) };
    });
    const [idleApproach, idleAttack, , idleRelease] = strikeReaction.untouched;
    const [approach, attack, held, released] = strikeReaction.reacted;
    assert.equal(approach.center, idleApproach.center, 'an approaching ribbon does not bend the strip');
    assert.ok(idleAttack.center - attack.center > .80 * strikeReaction.scale,
      `the strip rises visibly at contact (${idleAttack.center - attack.center})`);
    assert.ok(attack.rgb[0] > attack.rgb[2] + 20, `the core near the note takes the warm voice colour (${attack.rgb})`);
    assert.ok(held.ripple > attack.ripple + .35, `the ripple travels outward (${attack.ripple}, ${held.ripple})`);
    assert.equal(released.center, idleRelease.center, 'the strip returns to its rest outline while the pedal remains down');
    assert.equal(released.ripple, 0, 'there is no ripple after the physical release');
    assert.ok(Math.abs(released.rgb[0] - released.rgb[2]) <= 12, 'the strip returns to neutral after the physical release');
    console.log(`PASS ${engine}: the upper strip changes colour and shape on contact, then returns to rest`);

    const visibility = await page.evaluate(async () => {
      const { WaterfallScene } = await import('/src/features/playback/waterfall/rollScene.ts');
      const { voiceRamp } = await import('/src/features/playback/waterfall/waterfallPalette.ts');
      const scene = new WaterfallScene(document.querySelector('canvas'));
      scene.resize();
      scene.setRamps([voiceRamp('#4a6fb3')]);
      const note = (pitch, start, duration, sustainDuration = duration) => ({ pitch, start, duration, sustainDuration, voice: 0, velocity: .8 });
      const expired = Array.from({ length: 1200 }, (_, index) => note(48, index * .05, .02));
      const first = note(60, 80, 22);
      const sustained = note(64, 90, .5, 10);
      const coming = note(67, 101, 1);
      scene.setPiece([...expired, first, sustained, coming, note(72, 123, 1)], []);
      const at = time => {
        const [start, end] = scene.noteWindow(time);
        const pitches = scene.notes.slice(start, end).filter(note => note.expiresAt >= time).map(note => note.pitch);
        return { start, end, pitches };
      };
      const late = at(101);
      const early = at(0);
      const after = at(107);
      scene.setTilt(-1);
      const start = scene.visibleAhead * .92;
      const farLeft = note(21, start, .2);
      const center = note(60, start, .2);
      scene.setPiece([farLeft, center], []);
      const painted = [];
      const stroke = scene.ctx.stroke;
      scene.ctx.stroke = function(...args) { painted.push(1); return stroke.apply(this, args); };
      for (const pitch of [21, 60]) {
        painted.length = 0;
        scene.ribbon(scene.notes.find(note => note.pitch === pitch), -start, scene.byMidi.get(pitch));
        if ((painted.length > 0) !== (pitch === 60)) throw new Error('Ribbon was incorrectly culled at the side of the screen');
      }
      scene.dispose();
      return { late, early, after };
    });
    assert.deepEqual(visibility.late, { start: 1200, end: 1203, pitches: [60, 64, 67] });
    assert.equal(visibility.early.start, 0, 'seek back reopens the old range');
    assert.ok(visibility.early.pitches.length > 0, 'seek back restores notes');
    assert.deepEqual(visibility.after.pitches, [], 'expired intervals are absent');
    console.log(`PASS ${engine}: the visible range survives long notes, sustain, seek and horizontal culling`);

    const lengths = await page.evaluate(async () => {
      const { WaterfallScene } = await import('/src/features/playback/waterfall/rollScene.ts');
      const { voiceRamp } = await import('/src/features/playback/waterfall/waterfallPalette.ts');
      const scene = new WaterfallScene(document.querySelector('canvas'));
      scene.resize();
      scene.setTilt(0);
      scene.setRamps([voiceRamp('#416cea')]);
      const note = (pitch, start) => ({ pitch, start, duration: 0.5, sustainDuration: 0.5, velocity: 0.8, voice: 0 });
      scene.setPiece([note(60, 1), note(64, 1), note(60, 1.5)], []);
      const measure = (pitch, notes, time) => {
        const g = scene.ctx;
        const key = scene.byMidi.get(pitch);
        g.resetTransform();
        g.fillStyle = '#000';
        g.fillRect(0, 0, scene.canvas.width, scene.canvas.height);
        g.setTransform(scene.canvas.width / scene.width, 0, 0, scene.canvas.height / scene.height, 0, 0);
        for (const note of notes) scene.ribbon(note, time - note.start, key);
        const x = Math.round(key.x * scene.canvas.width / scene.width);
        const rgba = g.getImageData(x, 0, 1, scene.canvas.height).data;
        const bands = [];
        for (let y = 0; y < scene.canvas.height; y++) {
          if (rgba[y * 4 + 2] <= 152) continue;
          const band = bands.at(-1);
          if (band?.bottom === y - 1) band.bottom = y;
          else bands.push({ top: y, bottom: y });
        }
        return bands;
      };
      const repeated = scene.notes.filter(note => note.pitch === 60);
      const single = scene.notes.filter(note => note.pitch === 64);
      const matching = [measure(60, repeated.slice(0, 1), .65), measure(64, single, .65)];
      const pair = measure(60, repeated, .65);
      const noteWidth = scene.byMidi.get(60).width * .84 * scene.canvas.width / scene.width;
      const center = scene.byMidi.get(60).x * scene.canvas.width / scene.width;
      const ribbon = pair[1];
      const middle = Math.floor((ribbon.top + ribbon.bottom) / 2);
      const at = (offset, y = middle) => Array.from(scene.ctx.getImageData(
        Math.round(center + offset * noteWidth), y, 1, 1).data).slice(0, 3);
      const body = at(0);
      const surfaceColors = [-.1, .36].map(offset => at(offset));
      const halo = [.59, .77, 1.08, 1.45].map(offset => at(offset)[2]);
      const sides = [.24, .5, .76].flatMap(fraction => {
        const y = Math.round(ribbon.top + (ribbon.bottom - ribbon.top) * fraction);
        return [-.59, .59].map(offset => at(offset, y)[2]);
      });
      const nextToCap = Math.max(1, Math.round(noteWidth * .09));
      const pastCap = Math.max(nextToCap + 1, Math.round(noteWidth * .30));
      const topHalo = [nextToCap, pastCap].map(offset => at(0, pair[0].top - offset)[2]);
      const bottomHalo = [nextToCap, pastCap].map(offset => at(0, ribbon.bottom + offset)[2]);
      const gapBlue = at(0, Math.floor((pair[0].bottom + ribbon.top) / 2))[2];
      scene.ribbon({ ...repeated[1], pitch: 62 }, .65 - repeated[1].start, scene.byMidi.get(62));
      const betweenLanes = Math.round((center + scene.byMidi.get(62).x * scene.canvas.width / scene.width) / 2);
      const laneGapBlue = Array.from(scene.ctx.getImageData(betweenLanes, middle, 1, 1).data)[2];
      const brief = { ...scene.notes[0], pitch: 60, duration: .022 };
      const strike = measure(60, [brief], brief.start)[0];
      const strikeY = scene.rail * scene.canvas.height / scene.height;
      const yScale = scene.canvas.height / scene.height;
      const depthColor = (voice, distance) => {
        const duration = .24;
        const positioned = { ...repeated[0], voice, start: distance - duration / 2, duration };
        measure(60, [positioned], 0);
        return at(0, Math.floor((scene.rail - distance * scene.nearSpeed) * yScale));
      };
      scene.setRamps([voiceRamp('#416cea'), voiceRamp('#dd8037')]);
      const depthColors = [0, 1].map(voice => [.78, .12].map(fraction => depthColor(voice, fraction * scene.visibleAhead)));
      scene.dispose();
      return { matching, pair, strike, strikeY, noteWidth, body, surfaceColors, halo, sides, topHalo, bottomHalo, gapBlue, laneGapBlue, depthColors };
    });
    const first = lengths.matching[0][0];
    assert.ok(first && first.bottom - first.top > 20, 'the compared ribbons have visible pixels');
    assert.deepEqual(lengths.matching[0], lengths.matching[1],
      'a repeat leaves the same displayed length as an equal note without a repeat');
    assert.equal(lengths.pair.length, 2, 'the successive ribbons are separated by a dark band');
    const gap = lengths.pair[1].top - lengths.pair[0].bottom - 1;
    assert.ok(gap >= 1 && gap <= lengths.noteWidth / 3 + 1, `visible ribbon gap is ${gap}px`);
    const [red, green, blue] = lengths.body;
    assert.ok(blue >= 235 && green >= 145 && blue - red >= 35, `the body glows in its voice colour (${lengths.body})`);
    const [innerHalo, outerHalo, tailHalo, background] = lengths.halo;
    assert.ok(innerHalo > blue * .45 && innerHalo < blue * .75 && innerHalo > outerHalo &&
      outerHalo > tailHalo && tailHalo > background, `the side glow is visible and softly fades (${lengths.halo})`);
    assert.ok(lengths.sides.every(value => value > blue * .5 && value < blue * .75),
      `both sides glow through the middle of the note (${lengths.sides})`);
    assert.ok([lengths.topHalo, lengths.bottomHalo].every(([edge, fade]) => edge > blue * .2 &&
      fade < edge && edge < blue * .8), `the halo also falls off beyond both caps (${lengths.topHalo}, ${lengths.bottomHalo})`);
    const [litCore, shoulder] = lengths.surfaceColors;
    assert.ok(luminance(litCore) > luminance(shoulder) + 4,
      `the ribbon has an emissive core across its width (${litCore}, ${shoulder})`);
    for (const [distant, close] of lengths.depthColors) {
      assert.ok(luminance(close) > luminance(distant) + 28,
        `the same note brightens with height relative to the keys (${distant}, ${close})`);
    }
    const [warmDistant, warmClose] = lengths.depthColors[1];
    assert.ok(warmClose[1] - warmDistant[1] >= 38 && warmClose[0] > warmClose[2] + 30,
      `a warm voice shifts toward golden light near the keys (${warmDistant}, ${warmClose})`);
    assert.ok(lengths.strike?.bottom > lengths.strike?.top, 'the gap leaves even a short note visible');
    assert.ok(Math.abs(lengths.strike.bottom - lengths.strikeY) < 2, 'a short note still reaches the strike rail');
    console.log(`PASS ${engine}: repeated notes have a default visual gap and short notes align with the strike rail`);

    const grooves = await page.evaluate(async () => {
      const { WaterfallScene } = await import('/src/features/playback/waterfall/rollScene.ts');
      const { voiceRamp } = await import('/src/features/playback/waterfall/waterfallPalette.ts');
      const results = [];
      for (const [width, height] of [[1440, 760], [1100, 650], [768, 900], [375, 700]]) {
        const roll = document.createElement('canvas');
        const keyboard = document.createElement('canvas');
        document.body.append(roll, keyboard);
        const scene = new WaterfallScene(roll, undefined, keyboard);
        scene.resizeTo({ width, height, viewportHeight: height, pixelRatio: 2 });
        scene.setTilt(0);
        scene.setRamps([voiceRamp('#416cea')]);
        scene.setPiece([], []);
        scene.render(0.1);
        const g = keyboard.getContext('2d');
        const row = Math.round(keyboard.height * .72);
        const data = g.getImageData(0, row, keyboard.width, 1).data;
        const luma = Array.from({ length: keyboard.width }, (_, x) => .2126 * data[x * 4] + .7152 * data[x * 4 + 1] + .0722 * data[x * 4 + 2]);
        const local = (x, reach) => {
          const near = luma.slice(Math.max(0, x - reach), Math.min(luma.length, x + reach + 1)).sort((a, b) => a - b);
          return near[near.length >> 1];
        };
        const found = [];
        let current;
        for (let x = 0; x < luma.length; x++) {
          if (luma[x] >= local(x, 10) - 14) continue;
          if (current && current.end === x - 1) current.end = x;
          else found.push(current = { start: x, end: x });
        }
        const areas = found.slice(1, -1).map(({ start, end }) => {
          let area = 0;
          for (let x = start - 3; x <= end + 3; x++) area += Math.max(0, local(x, 12) - luma[x]);
          return area;
        });
        results.push({ width, count: areas.length, keyPixels: keyboard.width / 52, spread: Math.max(...areas) / Math.min(...areas) });
        scene.dispose();
        roll.remove();
        keyboard.remove();
      }
      return results;
    });
    for (const { width, count, keyPixels, spread } of grooves) {
      assert.equal(count, 51, `every groove between the white keys is found at ${width}px`);
      assert.ok(Number.isInteger(keyPixels), `a white key spans whole keyboard pixels at ${width}px (${keyPixels})`);
      assert.ok(spread < 1.03, `all grooves between the white keys are drawn alike at ${width}px (darkest/lightest ${spread.toFixed(3)})`);
    }
    console.log(`PASS ${engine}: all 51 grooves between white keys are the same on the keyboard raster at 1440, 1100, 768 and 375`);

    const repeats = await page.evaluate(async () => {
      const { WaterfallScene } = await import('/src/features/playback/waterfall/rollScene.ts');
      const { voiceRamp } = await import('/src/features/playback/waterfall/waterfallPalette.ts');
      const roll = document.createElement('canvas');
      const keyboard = document.createElement('canvas');
      document.body.append(roll, keyboard);
      const scene = new WaterfallScene(roll, undefined, keyboard);
      scene.resizeTo({ width: 1000, height: 700, viewportHeight: 700, pixelRatio: 1 });
      scene.setRamps([voiceRamp('#416cea')]);
      // Three notes on one key, each ending exactly where the next one starts.
      scene.setPiece([1, 1.25, 1.5].map(start => ({ pitch: 60, start, duration: .25, sustainDuration: .25, velocity: .8, voice: 0 })), []);
      let lit;
      const draw = scene.stage.draw;
      scene.stage.draw = function (context, frame, lights) {
        lit = lights.find(light => light.midi === 60);
        return draw.call(this, context, frame, lights);
      };
      const at = time => {
        lit = undefined;
        scene.render(time);
        return lit ? { press: lit.press, light: lit.light } : { press: 0, light: 0 };
      };
      const result = { held: at(1.1), beforeSecond: at(1.2499), startingSecond: at(1.28), beforeThird: at(1.4999), startingThird: at(1.53) };
      scene.dispose();
      roll.remove();
      keyboard.remove();
      return result;
    });
    assert.ok(repeats.held.press > .95, `a held key is fully down (${repeats.held.press})`);
    for (const key of ['beforeSecond', 'beforeThird']) {
      assert.ok(repeats.held.press - repeats[key].press > .9 && repeats[key].press * repeats[key].light < .05,
        `a repeated key is back up and its direct light is out before the next attack (${key}: press ${repeats[key].press})`);
    }
    for (const key of ['startingSecond', 'startingThird']) {
      assert.ok(repeats[key].press > .3, `the repeat presses the key down again (${key}: ${repeats[key].press})`);
    }
    console.log(`PASS ${engine}: a repeated key rises and its light goes out before every next attack`);

    const clockSteps = await page.evaluate(async () => {
      const { ServerPlaybackController } = await import('/src/core/playback/PlaybackController.ts');
      const { ScoreNavigation } = await import('/src/core/navigation/ScoreNavigation.ts');
      const navigation = new ScoreNavigation();
      // The audio clock moves in render-quantum steps of 5.33 ms; frames come every 16.7 ms.
      const quantum = 128 / 48000 * 1000;
      let audioMs = 5000;
      const player = { positionMs: () => audioMs, sampleRate: 48000, async prepare() {}, async unlock() {}, async pause() { return audioMs; }, stop() {}, dispose() {} };
      const controller = new ServerPlaybackController({ map: async () => ({}) }, { async prepare() {}, async unlock() {}, release() {}, close() {}, bindSource() {}, invalidate() {} }, undefined, navigation);
      controller.player = player;
      controller.state = { ...controller.state, playing: true };
      const steps = [];
      let last;
      await new Promise(resolve => {
        let origin;
        const loop = frameTime => {
          origin ??= frameTime;
          audioMs = 5000 + Math.floor((frameTime - origin) / quantum) * quantum;
          const shown = navigation.getTimeMs();
          if (last !== undefined) steps.push(shown - last.shown - (frameTime - last.frame));
          last = { shown, frame: frameTime };
          if (steps.length < 120) requestAnimationFrame(loop);
          else resolve();
        };
        requestAnimationFrame(loop);
      });
      return steps.slice(5);
    });
    const spread = Math.max(...clockSteps.map(Math.abs));
    assert.ok(spread < 3, `the visible clock follows the frame rate although the audio clock moves in quanta (largest deviation ${spread.toFixed(2)} ms)`);
    console.log(`PASS ${engine}: the visible clock moves evenly with the frames while the audio clock steps`);

    const heldPicture = await page.evaluate(async () => {
      const { ServerPlaybackController } = await import('/src/core/playback/PlaybackController.ts');
      const { ScoreNavigation } = await import('/src/core/navigation/ScoreNavigation.ts');
      const navigation = new ScoreNavigation();
      let audioMs = 5000;
      let pausedAt = 0;
      const player = {
        positionMs: () => audioMs, sampleRate: 48000, async prepare() {}, async unlock() {}, stop() {}, dispose() {},
        async pause() { audioMs = pausedAt; return pausedAt; },
        async resume() { return audioMs; },
      };
      const controller = new ServerPlaybackController({ map: async () => ({}) }, { async prepare() {}, async unlock() {}, release() {}, close() {}, bindSource() {}, invalidate() {} }, undefined, navigation);
      controller.player = player;
      controller.request = new AbortController();
      controller.state = { ...controller.state, playing: true };
      navigation.update({ timeMs: 5000 });
      let shown = 0;
      await new Promise(resolve => {
        let origin;
        let frames = 0;
        const loop = frameTime => {
          origin ??= frameTime;
          audioMs = 5000 + (frameTime - origin);
          shown = navigation.getTimeMs();
          if (++frames < 40) requestAnimationFrame(loop);
          else resolve();
        };
        requestAnimationFrame(loop);
      });
      // The sound stops a little behind the last picture; the picture must stand where it was drawn.
      pausedAt = shown - 29;
      controller.pause();
      await new Promise(resolve => setTimeout(resolve, 20));
      const paused = controller.getState();
      const rest = navigation.getTimeMs();
      const resuming = controller.play();
      const resumed = navigation.getTimeMs();
      await resuming;
      return { shown, flags: [paused.paused, paused.playing], stored: navigation.getState().timeMs, rest, resumed };
    });
    assert.deepEqual(heldPicture.flags, [true, false], 'the transport is held after the pause');
    assert.equal(heldPicture.rest, heldPicture.shown, `a pause leaves the picture where its last frame drew it (${heldPicture.shown} -> ${heldPicture.rest})`);
    assert.equal(heldPicture.stored, heldPicture.shown, 'the stored position is the picture position, not the sound position');
    assert.equal(heldPicture.resumed, heldPicture.shown, 'a resume goes on from the held picture until the sound moves');
    console.log(`PASS ${engine}: pause and resume keep the picture where it stood`);

    const clock = await page.evaluate(async () => {
      const { MediaClock, onAnimationFrame, frameTimeMs } = await import('/src/core/playback/MediaClock.ts');
      const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
      const result = {};
      // After a start the picture waits while the sound stands and moves on from where it stood.
      const waiting = new MediaClock();
      await frame();
      const start = waiting.at(2000);
      await frame();
      const held = waiting.at(2000);
      await frame();
      const moved = waiting.at(2030);
      await frame();
      result.waits = [start, held, moved, waiting.at(2047)];
      // A sound ahead of the picture is caught up by running a little faster, never by a step.
      const steady = new MediaClock();
      await frame();
      steady.at(3000);
      await frame();
      steady.at(3017);
      await frame();
      const aheadAt = steady.at(3074);
      const aheadFrom = frameTimeMs();
      await frame();
      result.steer = (steady.at(3091) - aheadAt) / (frameTimeMs() - aheadFrom);
      const media = new MediaClock();
      await frame();
      result.first = media.at(1000) - 1000;
      result.sameFrame = media.at(1030) === media.at(1030);
      await frame();
      result.small = media.at(1000 + 16.7 + 2) - (1000 + 16.7);
      await frame();
      result.snap = media.at(9000) - 9000;
      media.reset();
      await frame();
      result.afterReset = media.at(4000) - 4000;
      media.setOutputDelay(40);
      await frame();
      result.delayed = media.at(5000) - (5000 - 40);
      media.setOutputDelay(0);
      let calls = 0;
      const request = window.requestAnimationFrame;
      window.requestAnimationFrame = callback => { calls++; return request.call(window, callback); };
      const frames = [0, 0];
      const stops = [onAnimationFrame(() => frames[0]++), onAnimationFrame(() => frames[1]++)];
      await frame();
      await frame();
      stops.forEach(stop => stop());
      const before = calls;
      await new Promise(resolve => setTimeout(resolve, 80));
      window.requestAnimationFrame = request;
      result.listeners = frames;
      result.loopStopped = calls === before;
      return result;
    });
    const [waitStart, waitHeld, waitMoved, waitNext] = clock.waits;
    assert.ok(waitStart === 2000 && waitHeld === 2000 && waitMoved === 2000 && waitNext > waitMoved && waitNext - waitMoved < 40,
      `the picture waits with the sound and moves on from where it stood (${clock.waits})`);
    assert.ok(clock.steer > 1 && clock.steer <= 1.1 + 1e-9,
      `a sound ahead is caught up by a slightly faster picture, never a step (speed ${clock.steer})`);
    assert.ok(Math.abs(clock.first) < 1e-6, 'the first reading is the sound itself');
    assert.ok(clock.sameFrame, 'every reader inside one frame sees the same time');
    assert.ok(Math.abs(clock.small) < 3, `a small difference is absorbed (${clock.small})`);
    assert.ok(Math.abs(clock.snap) < 1e-6, 'a jump of the sound is followed at once');
    assert.ok(Math.abs(clock.afterReset) < 1e-6, 'after a reset the clock starts from the sound');
    assert.ok(Math.abs(clock.delayed) < 1e-6, 'a set audio delay moves the picture back by that much');
    assert.ok(clock.listeners.every(count => count >= 1) && clock.loopStopped, `listeners share one frame loop that stops with the last one (${clock.listeners})`);
    console.log(`PASS ${engine}: the media clock follows the sound, snaps on a jump, keeps a delay and shares one frame loop`);

    const widths = await page.evaluate(async () => {
      const { WaterfallScene } = await import('/src/features/playback/waterfall/rollScene.ts');
      const { voiceRamp } = await import('/src/features/playback/waterfall/waterfallPalette.ts');
      const result = {};
      for (const [label, pitch] of [['white', 72], ['black', 73]]) {
        const scene = new WaterfallScene(document.querySelector('canvas'));
        scene.resize();
        scene.setTilt(0);
        scene.setRamps([voiceRamp('#e8651e')]);
        scene.setPiece([{ pitch, start: 1, duration: 2.5, sustainDuration: 2.5, velocity: .8, voice: 0 }], []);
        scene.render(1.4);
        const canvas = scene.canvas;
        const g = scene.ctx;
        const pixelsPerUnit = canvas.width / scene.width;
        const key = scene.byMidi.get(pitch);
        const centre = Math.round(key.x * pixelsPerUnit);
        const column = g.getImageData(centre, 0, 1, canvas.height).data;
        const luma = (data, at) => data[at * 4] * .2126 + data[at * 4 + 1] * .7152 + data[at * 4 + 2] * .0722;
        let top = -1;
        let bottom = -1;
        for (let y = 0; y < canvas.height; y++) {
          if (luma(column, y) <= 90) continue;
          if (top < 0) top = y;
          bottom = y;
        }
        const row = g.getImageData(0, Math.round(top + (bottom - top) * .45), canvas.width, 1).data;
        const inside = luma(row, centre);
        let edge = centre;
        while (luma(row, edge) > inside * .6) edge++;
        result[label] = { width: 2 * (edge - centre) / pixelsPerUnit, profile: [2, 4, 6, 8].map(pixels => 100 * luma(row, Math.round(edge + pixels * pixelsPerUnit)) / inside) };
        scene.dispose();
      }
      return result;
    });
    assert.ok(widths.white.width > widths.black.width * 1.3, `a white-key ribbon is clearly wider than a black-key one (${widths.white.width}, ${widths.black.width})`);
    widths.white.profile.forEach((white, index) => {
      assert.ok(Math.abs(white - widths.black.profile[index]) <= 6,
        `the halo has the same strength ${[2, 4, 6, 8][index]} px beside a white-key and a black-key ribbon (${white.toFixed(0)}% and ${widths.black.profile[index].toFixed(0)}%)`);
    });
    for (const label of ['white', 'black']) {
      const { profile } = widths[label];
      assert.ok(profile[0] > 15 && profile.every((value, index) => index === 0 || value <= profile[index - 1] + 1),
        `the halo beside a ${label}-key ribbon is visible and only falls off, with no ledge (${profile.map(value => value.toFixed(0))})`);
    }
    console.log(`PASS ${engine}: the halo reaches the same distance beside narrow and wide ribbons`);

    const overlap = await page.evaluate(async () => {
      const { WaterfallScene } = await import('/src/features/playback/waterfall/rollScene.ts');
      const { voiceRamp } = await import('/src/features/playback/waterfall/waterfallPalette.ts');
      const scene = new WaterfallScene(document.querySelector('canvas'));
      scene.resize();
      scene.setTilt(0);
      scene.setRamps([voiceRamp('#7d9be8'), voiceRamp('#e8a65e')]);
      // A long note of one voice with a short note of another over it: the halo beside them has to change colour, not switch.
      scene.setPiece([
        { pitch: 62, start: 1, duration: 4, sustainDuration: 4, velocity: .8, voice: 0 },
        { pitch: 62, start: 2, duration: .6, sustainDuration: .6, velocity: .8, voice: 1 },
      ], []);
      scene.render(0.4);
      const canvas = scene.canvas;
      const g = scene.ctx;
      const pixelsPerUnit = canvas.width / scene.width;
      const centre = Math.round(scene.byMidi.get(62).x * pixelsPerUnit);
      const luma = (data, at) => data[at * 4] * .2126 + data[at * 4 + 1] * .7152 + data[at * 4 + 2] * .0722;
      const column = g.getImageData(centre, 0, 1, canvas.height).data;
      let top = -1;
      let bottom = -1;
      for (let y = 0; y < canvas.height; y++) {
        if (luma(column, y) <= 90) continue;
        if (top < 0) top = y;
        bottom = y;
      }
      const row = g.getImageData(0, Math.round(top + (bottom - top) * .1), canvas.width, 1).data;
      const inside = luma(row, centre);
      let edge = centre;
      while (luma(row, edge) > inside * .6) edge++;
      // Only the stretch of the roll above the strike rail, where the ribbons are; below it are the keys.
      const length = Math.round((bottom - top) * .65);
      const beside = g.getImageData(edge + Math.round(3 * pixelsPerUnit), top, 1, length).data;
      // The colour alone (blue against red), so a speck of dust or a change of strength does not count.
      const blueness = [];
      for (let y = 0; y < length; y++) blueness.push(beside[y * 4 + 2] - beside[y * 4]);
      const step = Math.max(...blueness.slice(1).map((value, index) => Math.abs(value - blueness[index])));
      scene.dispose();
      return { step, spread: Math.max(...blueness) - Math.min(...blueness) };
    });
    assert.ok(overlap.spread > 20, `the halo beside two overlapping notes shows both voices (${overlap.spread})`);
    assert.ok(overlap.step < 6, `the halo changes colour beside two overlapping notes without a step (${overlap.step})`);
    console.log(`PASS ${engine}: the halo blends the colours of two overlapping notes`);

    const joins = await page.evaluate(async () => {
      const { WaterfallScene } = await import('/src/features/playback/waterfall/rollScene.ts');
      const { voiceRamp } = await import('/src/features/playback/waterfall/waterfallPalette.ts');
      const roll = document.createElement('canvas');
      document.body.append(roll);
      const scene = new WaterfallScene(roll);
      scene.resizeTo({ width: 1440, height: 760, viewportHeight: 760, pixelRatio: 2 });
      scene.setTilt(0);
      scene.setRamps([voiceRamp('#6f7ee8')]);
      const note = (pitch, start, duration) => ({ pitch, start, duration, sustainDuration: duration, velocity: .8, voice: 0 });
      // Three notes stacked on one key, the same on the next white key, and a lone note of the same length far away.
      scene.setPiece([60, 62].flatMap(pitch => [1, 1.5, 2].map(start => note(pitch, start, .5))).concat(note(72, 1, .5)), []);
      scene.render(.2);
      const g = scene.ctx;
      const pixelsPerUnit = scene.canvas.width / scene.width;
      const luma = (x, y) => {
        const data = g.getImageData(Math.round(x), Math.round(y), 1, 1).data;
        return data[0] * .2126 + data[1] * .7152 + data[2] * .0722;
      };
      const runs = x => {
        const data = g.getImageData(Math.round(x), 0, 1, Math.round(scene.rail * pixelsPerUnit)).data;
        const found = [];
        for (let y = 0; y < data.length / 4; y++) {
          if (data[y * 4] * .2126 + data[y * 4 + 1] * .7152 + data[y * 4 + 2] * .0722 <= 100) continue;
          if (found.at(-1)?.[1] === y - 1) found.at(-1)[1] = y;
          else found.push([y, y]);
        }
        return found;
      };
      const stacked = scene.byMidi.get(60).x * pixelsPerUnit;
      const next = scene.byMidi.get(62).x * pixelsPerUnit;
      const lone = scene.byMidi.get(72).x * pixelsPerUnit;
      // The short bright edge at the strike rail is not a ribbon.
      const stack = runs(stacked).filter(([top, bottom], _, all) => bottom - top > (all[0][1] - all[0][0]) / 2);
      const single = runs(lone)[0];
      // The nearest ribbons: the lanes lean together with height, so only there are they far enough apart.
      const [before, nearest] = stack.slice(-2);
      const gap = (before[1] + nearest[0]) / 2;
      const half = (nearest[0] - before[1]) / 2;
      const middle = Math.round((nearest[0] + nearest[1]) / 2);
      const body = luma(stacked, middle);
      // The ribbons lean with depth, so the lanes are found from the pixels of the row.
      const row = g.getImageData(0, middle, scene.canvas.width, 1).data;
      const bodies = [];
      for (let x = 0; x < scene.canvas.width; x++) {
        if (row[x * 4] * .2126 + row[x * 4 + 1] * .7152 + row[x * 4 + 2] * .0722 <= body * .8) continue;
        if (bodies.at(-1)?.[1] === x - 1) bodies.at(-1)[1] = x;
        else bodies.push([x, x]);
      }
      const [left, right, alone] = bodies;
      // The lanes are a few pixels apart: the glow across the whole gap against the pixels at the same distances beside the lone ribbon.
      const across = Array.from({ length: right[0] - left[1] - 1 }, (_, index) => luma(left[1] + 1 + index, middle));
      const beside = across.map((_, index) => luma(alone[1] + 1 + Math.min(index, across.length - 1 - index), middle));
      const mean = values => values.reduce((sum, value) => sum + value, 0) / values.length;
      return {
        body,
        // between two ribbons, and the same distance beyond the end of a lone one
        gap: luma(stacked, gap), beyondEnd: luma(lone, single[1] + half),
        // between two lanes, and the same distance beside a lone ribbon
        lanes: mean(across), beside: mean(beside), debug: JSON.stringify({ bodies, across, beside, middle }),
      };
    });
    assert.ok(Math.abs(joins.gap - joins.beyondEnd) <= joins.body * .1,
      `the glow between two ribbons is the glow the nearer one gives alone: it neither adds up nor is dimmed (${joins.gap.toFixed(0)} against ${joins.beyondEnd.toFixed(0)} of ${joins.body.toFixed(0)})`);
    assert.ok(Math.abs(joins.lanes - joins.beside) <= joins.body * .1,
      `the same between two lanes (${joins.lanes.toFixed(0)} against ${joins.beside.toFixed(0)} of ${joins.body.toFixed(0)}) ${joins.debug}`);
    console.log(`PASS ${engine}: glows of close ribbons neither add up nor dim each other`);


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
          for (const key of [scene.keys[0], scene.byMidi.get(61), scene.keys.at(-1)]) {
            const duration = .25;
            const length = scene.projectRoll(key.x, 0).y - scene.projectRoll(key.x, duration).y;
            const half = key.width * .42;
            for (const seconds of times) {
              const near = scene.projectRoll(key.x, seconds, -half);
              const far = scene.projectRoll(key.x, seconds, half);
              const end = scene.projectRoll(key.x, seconds + duration);
              if (Math.abs(far.x - near.x - 2 * half) > 1e-8) throw new Error('A falling note changed width');
              if (Math.abs(near.y - end.y - length) > 1e-8) throw new Error('A falling note changed length or speed');
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
      console.log(`PASS ${engine}/${width}: ${geometry} actual projection samples, constant note dimensions and exact key strikes`);
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
        scene.setPiece([{ pitch: 60, voice: 0, start: future, duration: .3, sustainDuration: .3, velocity: .8 }], [future]);
        const rendered = [], rectangles = [];
        const shape = scene.ribbonShape, fillRect = scene.ctx.fillRect;
        scene.ribbonShape = function(note, ...args) { rendered.push(note.start); return shape.call(this, note, ...args); };
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
      const { navigation } = await import(source.match(/from ["']([^"']*ScoreNavigation\.ts[^"']*)["']/)[1]);
      window.testNavigation = navigation;
      const createdWorkers = new WeakSet();
      const workerProbe = { generations: [], arrivals: [], displayed: [], fail: null, delayUntil: 0 };
      window.waterfallWorkerProbe = workerProbe;
      const postMessage = Worker.prototype.postMessage;
      Worker.prototype.postMessage = function(data, ...args) {
        if (data?.type === 'configure' && data.source?.bars) {
          workerProbe.generations.push(data.generation);
          if (!createdWorkers.has(this)) {
            createdWorkers.add(this);
            this.addEventListener('message', ({ data }) => {
              if (Array.isArray(data.windows)) workerProbe.arrivals.push(...data.windows);
            });
            workerProbe.fail = () => this.dispatchEvent(new Event('error', { cancelable: true }));
          }
        }
        if (data?.type === 'prepare' && createdWorkers.has(this) && performance.now() < workerProbe.delayUntil) {
          window.setTimeout(() => postMessage.call(this, data, ...args), workerProbe.delayUntil - performance.now());
          return;
        }
        return postMessage.call(this, data, ...args);
      };
      const view = await (await fetch('/demo-editor-view.json')).json();
      useAuthStore.setState({ status: 'authed', userId: 'me', accessToken: 'isolated-test-only' });
      useEditor.setState(state => ({
        gateway: { ...state.gateway, load: async () => fromView(view, 'tilt-test') },
      }));
      playback.prepareMap = async () => {
        navigation.update({ map: { notes: [21, 24, 36, 48, 60, 72, 84, 96, 108].flatMap((pitch, index) => Array.from({ length: 12 }, (_, n) => ({ sourceId: 'fixture', pitch, startMs: 400 + n * 500, keyReleaseMs: 700 + n * 500, endMs: 700 + n * 500, velocity: 80 + index }))), pedals: [{ downMs: 400, upMs: 1600 }], anchors: [], segments: [], extentMs: 8000, version: 1 } });
        playback.set({ mapLoading: false });
      };
      const stageSource = await (await fetch(source.match(/from ["']([^"']*WaterfallStage\.tsx[^"']*)["']/)[1])).text();
      const { WaterfallScene } = await import(stageSource.match(/from ["']([^"']*rollScene\.ts[^"']*)["']/)[1]);
      const renderScene = WaterfallScene.prototype.render;
      WaterfallScene.prototype.render = function(time, prepared) {
        const result = renderScene.call(this, time, prepared);
        workerProbe.displayed.push({ time, prepared: !!prepared, audio: navigation.getTimeMs() });
        return result;
      };
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
    await page.waitForFunction(() => window.tiltScene?.pedals[0]?.down === .4 && window.tiltScene?.pedals[0]?.up === 1.6);
    await page.waitForFunction(() => getComputedStyle(document.querySelector('.desk')).visibility === 'hidden');
    if (width === 1440) {
      const switchView = (name) => page.getByRole('radio', { name, exact: true }).click();
      await switchView('Score');
      await page.waitForFunction(() => getComputedStyle(document.querySelector('.desk')).visibility === 'visible');
      await switchView('Waterfall');
      await page.waitForFunction(() => {
        const desk = getComputedStyle(document.querySelector('.desk'));
        const stage = getComputedStyle(document.querySelector('.waterfall-stage'));
        return stage.opacity === '1' && desk.opacity === '0' && desk.visibility === 'hidden';
      });
      assert.equal(await page.locator('.desk .canvas-area').count(), 1, 'the hidden engraving stays mounted on a reversed transition');
    }
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
    await page.getByRole('radio', { name: 'Score', exact: true }).click();
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
      const canvas = document.querySelector('.waterfall-canvas'), keyboard = document.querySelector('.waterfall-keyboard-canvas');
      const stage = document.querySelector('.waterfall-stage'), fit = document.querySelector('.waterfall-fit');
      const app = document.querySelector('.editor-screen'), toggle = document.querySelector('.panel-toggle');
      let layoutResizes = 0, bufferResizes = 0;
      const observer = new ResizeObserver(() => { layoutResizes++; }); observer.observe(canvas); observer.observe(keyboard);
      await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame); layoutResizes = 0;
      for (const surface of [canvas, keyboard]) {
        for (const name of ['width', 'height']) {
          const descriptor = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, name);
          Object.defineProperty(surface, name, { configurable: true, get() { return descriptor.get.call(this); }, set(value) { bufferResizes++; descriptor.set.call(this, value); } });
        }
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
          const seconds = note.start - scene.time + note.duration * .5;
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
          const rollBox = canvas.getBoundingClientRect(), keyboardBox = keyboard.getBoundingClientRect();
          samples.push({ topGap: Math.max(0, picture.top - bounds.top), bottom: Math.abs(picture.bottom - bounds.bottom), right: Math.abs(picture.right - bounds.right), left: Math.abs(picture.left - bounds.left - reservation), aspect: Math.abs(matrix.a - matrix.d), outside: Math.max(0, -progress, progress - 1), x: picture.x,
            seam: rollBox.bottom - keyboardBox.top, edgeDifference: Math.abs(rollBox.left - keyboardBox.left) + Math.abs(rollBox.right - keyboardBox.right) });
          const points = visiblePoints();
          for (const [id, point] of points) {
            const previous = previousPoints.get(id);
            if (point.visible && previous?.visible) maxVisibleStep = Math.max(maxVisibleStep, Math.hypot(point.x - previous.x, point.y - previous.y));
          }
          previousPoints = points;
        }
      } finally {
        observer.disconnect();
        for (const surface of [canvas, keyboard]) { delete surface.width; delete surface.height; }
      }
      return {
        layoutResizes, bufferResizes, maxVisibleStep, frames: samples.length,
        maxGap: Math.max(...samples.flatMap(sample => [sample.topGap, sample.bottom, sample.right, sample.left])),
        maxAspectError: Math.max(...samples.map(sample => sample.aspect)),
        maxOvershoot: Math.max(...samples.map(sample => sample.outside)),
        maxStep: Math.max(...samples.slice(1).map((sample, index) => Math.abs(sample.x - samples[index].x))),
        keys: scene.keys.length, rollTop: scene.rollTop, baseAhead: scene.lookAhead, visibleAhead: scene.visibleAhead,
        mask: document.querySelector('.waterfall-fade') !== null,
        minOverlap: Math.min(...samples.map(sample => sample.seam)),
        edgeDifference: Math.max(...samples.map(sample => sample.edgeDifference)),
        keyboardDensity: keyboard.width / canvas.width,
        rasterPixels: canvas.width * canvas.height + keyboard.width * keyboard.height,
      };
    });
    assert.ok(reserveAudit.maxGap < .1, JSON.stringify(reserveAudit));
    assert.ok(reserveAudit.maxAspectError < 1e-8, 'key proportions stay uniform on every frame');
    assert.ok(reserveAudit.maxOvershoot < .001, 'rapid left-panel reversals stay within their endpoints');
    assert.ok(reserveAudit.maxVisibleStep <= 70, `visible notes/keys/grain exceed the motion limit: ${JSON.stringify(reserveAudit)}`);
    assert.equal(reserveAudit.layoutResizes, 0, 'panel toggles never resize the prepared canvas');
    assert.equal(reserveAudit.bufferResizes, 0, 'panel toggles never reallocate its buffer');
    assert.ok(reserveAudit.minOverlap > 0 && reserveAudit.edgeDifference < .03, 'the keyboard and roll stay aligned throughout panel motion');
    assert.ok(reserveAudit.keyboardDensity >= 1 && reserveAudit.rasterPixels <= 1_280_000,
      'the live keyboard has priority within the shared raster budget');
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
    // A slow data worker gates audio; the same renderer uses the in-page index after worker failure.
    if (await page.evaluate(() => typeof Worker !== 'undefined')) {
      await page.waitForFunction(() => window.waterfallWorkerProbe.arrivals.length > 0, null, { timeout: 12000 });
      await page.evaluate(() => {
        const probe = window.waterfallWorkerProbe;
        probe.delayUntil = performance.now() + 380;
        probe.cancelPreparation = new AbortController();
        const targetMap = { ...window.testNavigation.getState().map };
        window.testNavigation.update({ map: targetMap });
        window.testPlayback.set({ loading: true, seekBeats: 4 });
        const ready = window.testPlayback.frameBuffer.prepare(targetMap, 5000, probe.cancelPreparation.signal);
        if (!ready) throw new Error('Expected a wait for the distant frame window');
        const repeat = window.testPlayback.frameBuffer.prepare(window.testNavigation.getState().map, 5000, probe.cancelPreparation.signal);
        if (repeat !== ready) throw new Error('A repeated call must wait for the same frame window');
        ready.then(() => { probe.prepared = true; });
      });
      const loader = page.getByRole('status').filter({ hasText: 'Preparing frames' });
      await loader.waitFor({ state: 'visible' });
      const dots = loader.locator('[aria-hidden="true"] > span');
      if (process.env.REDUCED_MOTION === '1') {
        assert.deepEqual(await dots.evaluateAll(nodes => nodes.map(node => node.getAnimations().length)), [0, 0, 0]);
      } else {
        await page.waitForFunction(() => {
          const dot = Array.from(document.querySelectorAll('.waterfall-message [role="status"]'))
            .find(status => status.textContent.includes('Preparing frames'))?.querySelector('[aria-hidden="true"] > span');
          return dot && dot.getAnimations().length > 0 && Number(getComputedStyle(dot).opacity) > .35;
        });
      }
      await page.waitForFunction(() => window.waterfallWorkerProbe.prepared === true);
      await page.evaluate(() => {
        window.testTimeMs = 5000;
        window.testNavigation.getTimeMs = () => window.testTimeMs;
        window.testPlayback.set({ playing: true, loading: false, seekBeats: null });
      });
      await loader.waitFor({ state: 'detached' });
      await page.waitForFunction(() => window.waterfallWorkerProbe.displayed.some(draw =>
        draw.prepared && Math.abs(draw.time - 5) < .034 && draw.audio === 5000));
      await page.evaluate(() => {
        window.waterfallWorkerProbe.fail();
        window.testTimeMs = 500;
      });
      await page.waitForFunction(() => Math.abs((window.waterfallWorkerProbe.displayed.at(-1)?.time ?? 0) - .5) < .034);
      await page.evaluate(() => {
        window.testTimeMs = 13;
        window.testPlayback.set({ playing: false });
      });
      await page.waitForFunction(() => window.waterfallWorkerProbe.displayed.at(-1)?.time === .013);
      console.log(`PASS ${engine}: draws a ready measure window, recovers from worker failure and seeks exactly`);
    }
    await page.evaluate(() => { window.testNavigation.update({ timeBeats: 2 }); window.testPlayback.set({ playing: true }); });
    assert.equal(await page.locator('.desk .cursor').count(), 0, 'the hidden score has no active playback cursor');
    await page.getByRole('radio', { name: 'Score', exact: true }).click();
    await page.locator('.desk .cursor').waitFor({ state: 'attached' });
    await page.getByRole('radio', { name: 'Waterfall', exact: true }).click();
    await page.locator('.desk .cursor').waitFor({ state: 'detached' });
    assert.deepEqual(exceptions, [], 'viewport/panel changes have no runtime errors');
  } finally { await browser.close(); }
}
