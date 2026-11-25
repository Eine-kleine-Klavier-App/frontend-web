import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
if (process.argv.includes('--help')) {
  console.log('VITE_URL, ENGINE, PLAYWRIGHT_MODULE_PATH, PLAYWRIGHT_CHROMIUM_EXECUTABLE');
  process.exit(0);
}
const playwright = process.env.PLAYWRIGHT_MODULE_PATH ? require(process.env.PLAYWRIGHT_MODULE_PATH) : await import('playwright');
const engine = process.env.ENGINE || 'webkit';
const executablePath = engine === 'chromium' ? process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE : undefined;
const args = engine === 'chromium' ? ['--autoplay-policy=no-user-gesture-required'] : [];
const browser = await playwright[engine].launch({ headless: true, args, ...(executablePath ? { executablePath } : {}) });

// What may a sound that is stopped or torn down do, in times the largest step between two samples that the sound already
// made while it was playing (a fade only scales the signal down, a cut makes a step as big as the signal itself).
const STEP_LIMIT = 2;
// And how long it takes to go down to silence at the least (three blocks of 128 frames at 48 kHz).
const FADE_MIN_MS = 8;

try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/__exit_click__', (route) => route.fulfill({ contentType: 'text/html', body: '<title>exit click</title>' }));
  await page.goto(new URL('/__exit_click__', process.env.VITE_URL || 'http://localhost:5173').href);
  const results = await page.evaluate(async () => {
    const { ServerPlaybackController } = await import('/src/core/playback/PlaybackController.ts');
    const { ScoreNavigation } = await import('/src/core/navigation/ScoreNavigation.ts');
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const until = async (condition, message) => {
      const end = performance.now() + 15000;
      while (!condition()) {
        if (performance.now() > end) throw Error(message);
        await wait(10);
      }
    };
    const note = (pitch) => ({ sourceId: `n${pitch}`, pitch, startMs: 0, keyReleaseMs: 5500, endMs: 5500, velocity: 110 });
    const map = {
      version: 1, extentMs: 6000, anchors: [{ carrierId: 'c', startMs: 0, endMs: 6000 }],
      segments: [{ startBeats: 0, endBeats: 12, startMs: 0, endMs: 6000, moments: [{ beats: 0, timeMs: 0 }, { beats: 12, timeMs: 6000 }] }],
      pedals: [{ downMs: 0, upMs: 5500 }], notes: [note(36), note(48), note(60)],
    };
    const meterCode = `class StepMeter extends AudioWorkletProcessor {
      last = 0;
      process(inputs) {
        // A disconnected input has no channel: that is silence, and the step down to it counts.
        const samples = inputs[0]?.[0] ?? new Float32Array(128);
        let step = 0, peak = 0;
        for (const sample of samples) { step = Math.max(step, Math.abs(sample - this.last)); peak = Math.max(peak, Math.abs(sample)); this.last = sample; }
        this.port.postMessage({ time: currentTime, step, peak });
        return true;
      }
    } registerProcessor('step-meter', StepMeter);`;
    const meterUrl = URL.createObjectURL(new Blob([meterCode], { type: 'text/javascript' }));

    const scenarios = {
      // The editor starts its leave animation: Stop; the screen is torn down later.
      'stop, then teardown': async (controller, at) => {
        at.push(['stop', performance.now()]);
        controller.stop();
        await wait(300);
        at.push(['teardown', performance.now()]);
        controller.bindDraft(null);
      },
      // The screen is torn down while it still sounds.
      'teardown while sounding': async (controller, at) => {
        at.push(['teardown', performance.now()]);
        controller.bindDraft(null);
      },
    };

    const results = [];
    for (const [name, leave] of Object.entries(scenarios)) {
      const navigation = new ScoreNavigation();
      const previewStub = { async prepare() {}, async unlock() {}, close() {}, release() {}, bindDraft() {}, invalidate() {}, async preview() {} };
      const controller = new ServerPlaybackController({ async map() { return map; }, async previewCarrier() { throw Error('not used'); } }, previewStub, undefined, navigation);
      controller.bindDraft('test');
      navigation.setTotalBeats(12);
      const completed = controller.play().catch(() => {});
      await until(() => controller.getState().playing, `${name}: play did not start`);
      const context = controller.player.context;
      await context.audioWorklet.addModule(meterUrl);
      const meter = new AudioWorkletNode(context, 'step-meter');
      const records = [];
      meter.port.onmessage = ({ data }) => records.push(data);
      controller.player.gain.connect(meter);
      meter.connect(context.destination);
      await wait(600);
      const sounding = records.filter((row) => row.peak > 0.001);
      if (!sounding.length) throw Error(`${name}: the output was silent before leaving`);
      const leaveTime = context.currentTime;
      const marks = [];
      await leave(controller, marks);
      await wait(250);
      await completed;
      const before = records.filter((row) => row.time < leaveTime && row.time >= leaveTime - 0.3);
      const after = records.filter((row) => row.time >= leaveTime);
      const normal = Math.max(...before.map((row) => row.step));
      let worst = { step: 0, time: 0 };
      for (const row of after) if (row.step > worst.step) worst = row;
      // A step to silence can hide at a zero crossing, so the length of the way down is measured too: blocks between the
      // leaving and the first silent one that are neither at the playing level nor silent.
      const peakBefore = Math.max(...before.map((row) => row.peak));
      const silent = after.findIndex((row) => row.peak < 1e-4);
      const down = after.slice(0, silent < 0 ? after.length : silent).filter((row) => row.peak < 0.9 * peakBefore && row.peak > 0.05 * peakBefore);
      results.push({
        name, normal, peakBefore, fadeMs: Math.round(down.length * 128 / context.sampleRate * 1000),
        worst: worst.step, worstAfterMs: Math.round((worst.time - leaveTime) * 1000), ratio: worst.step / normal,
        lastSoundMs: Math.round(((after.filter((row) => row.peak > 1e-4).at(-1)?.time ?? leaveTime) - leaveTime) * 1000),
      });
    }
    URL.revokeObjectURL(meterUrl);
    return results;
  });
  for (const row of results) {
    console.log(`${row.name}: normal step ${row.normal.toFixed(5)} (peak ${row.peakBefore.toFixed(3)}), worst step after leaving ${row.worst.toFixed(5)} at +${row.worstAfterMs} ms (${row.ratio.toFixed(2)}x), way down ${row.fadeMs} ms, sound until +${row.lastSoundMs} ms`);
  }
  assert.deepEqual(errors, []);
  for (const row of results) {
    assert.ok(row.ratio <= STEP_LIMIT, `${row.name}: the output steps ${row.ratio.toFixed(2)}x its normal step at +${row.worstAfterMs} ms`);
    assert.ok(row.fadeMs >= FADE_MIN_MS, `${row.name}: the sound was cut, it went down in ${row.fadeMs} ms`);
  }
  console.log(`exit click test passed (${engine})`);
} finally {
  await browser.close();
}
