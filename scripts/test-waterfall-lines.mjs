import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
if (process.argv.includes('--help')) { console.log('VITE_URL, ENGINE, PLAYWRIGHT_MODULE_PATH'); process.exit(0); }
const playwright = require(process.env.PLAYWRIGHT_MODULE_PATH);
const engine = process.env.ENGINE || 'webkit';
const browser = await playwright[engine].launch({ headless: true });

// The measure lines stand on their own canvas, one pixel per device pixel, on whole rows, so that a frame draws a line the same way wherever it falls.
for (const ratio of [1, 2]) {
  const page = await browser.newPage({ viewport: { width: 1000, height: 700 }, deviceScaleFactor: ratio });
  await page.route('**/__lines_test__', route => route.fulfill({ contentType: 'text/html', body: '<link rel="stylesheet" href="/src/styles/tokens.css"><link rel="stylesheet" href="/src/index.css">'
    + '<style>html,body{margin:0;height:100%;overflow:hidden}.waterfall-stage{position:absolute;inset:0}</style>'
    + '<div class="waterfall-stage"><div class="waterfall-fit" style="height:100%"></div></div>' }));
  await page.goto(`${process.env.VITE_URL || 'http://localhost:5173'}/__lines_test__`, { waitUntil: 'load' });
  const result = await page.evaluate(async () => {
    const { WaterfallScene } = await import('/src/features/playback/waterfall/rollScene.ts');
    const { voiceRamp } = await import('/src/features/playback/waterfall/waterfallPalette.ts');
    const fit = document.querySelector('.waterfall-fit');
    const make = (name, style = '') => { const canvas = document.createElement('canvas'); canvas.className = name; if (style) canvas.setAttribute('style', style); fit.append(canvas); return canvas; };
    const roll = make('waterfall-canvas');
    const keyboard = make('waterfall-keyboard-canvas', 'position:absolute;left:0;bottom:0;display:block;width:100%');
    const sky = make('waterfall-sky');
    const lines = make('waterfall-lines');
    const scene = new WaterfallScene(roll, undefined, keyboard, { sky, lines });
    scene.setRamps([voiceRamp('#4a6fb3')]);
    // the dust is drawn on the same canvas under the lines; it is left out here so that only the line is counted
    scene.setBackgroundDust(false);
    scene.setPiece([{ pitch: 60, start: 1, duration: .5, sustainDuration: .5, voice: 0, velocity: .8 }], [0, 2, 4, 6, 8, 10, 12, 14]);
    const pixelRatio = window.devicePixelRatio;
    scene.resizeTo({ width: fit.clientWidth, height: fit.clientHeight, viewportHeight: fit.clientHeight, pixelRatio });
    const box = lines.getBoundingClientRect();
    const exact = { width: Math.abs(box.width * pixelRatio - lines.width), height: Math.abs(box.height * pixelRatio - lines.height) };
    const g = lines.getContext('2d', { willReadFrequently: true });
    const column = Math.floor(lines.width / 2);
    const frames = [];
    for (let frame = 0; frame < 40; frame++) {
      scene.render(.3 + frame / 60);
      const alpha = g.getImageData(column, 0, 1, lines.height).data;
      const rows = [];
      for (let y = 0; y < lines.height; y++) if (alpha[y * 4 + 3] > 0) rows.push([y, alpha[y * 4 + 3]]);
      frames.push(rows);
    }
    const top = roll.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, roll.width, 1).data;
    let clear = 0;
    for (let x = 0; x < roll.width; x++) if (top[x * 4 + 3] === 0) clear++;
    return { exact, frames, rollClear: clear / roll.width };
  });
  assert.ok(result.exact.width < .01 && result.exact.height < .01, `at ${ratio}x the guide canvas is shown at exactly one pixel per device pixel (${JSON.stringify(result.exact)})`);
  assert.ok(result.rollClear > .9, `the roll canvas is transparent where nothing is drawn, so the lines show through (${result.rollClear})`);
  // The line that is nearest the middle of the roll: its rows are whole, as many in every frame, and its brightness only follows the slow depth ramp.
  const thickness = result.frames.map(rows => rows.length).filter(count => count > 0);
  assert.ok(thickness.length > 30, 'a measure line is on the roll in nearly every frame');
  assert.ok(Math.max(...thickness) <= 2 * ratio + 1, `a line is about one css pixel thick (${Math.max(...thickness)} rows at ${ratio}x)`);
  const peaks = result.frames.map(rows => Math.max(0, ...rows.map(([, alpha]) => alpha))).filter(alpha => alpha > 0);
  const mean = peaks.reduce((a, b) => a + b, 0) / peaks.length;
  assert.ok(Math.max(...peaks) - Math.min(...peaks) <= .12 * mean, `the line's brightness only follows the depth ramp, it does not flicker (${Math.min(...peaks)}..${Math.max(...peaks)} of ${mean.toFixed(0)})`);
  console.log(`PASS ${engine}@${ratio}x: the measure lines are on whole device rows at a steady brightness`);
  await page.close();
}
await browser.close();
