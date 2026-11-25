import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
if (process.argv.includes('--help')) { console.log('VITE_URL, ENGINE, PLAYWRIGHT_MODULE_PATH'); process.exit(0); }
const playwright = require(process.env.PLAYWRIGHT_MODULE_PATH);
const engine = process.env.ENGINE || 'webkit';
const browser = await playwright[engine].launch({ headless: true });

// The glow of the ribbons is baked once for a stretch of the piece and then only moved with the notes (see kb: waterfall-halo-strip).
try {
  const page = await browser.newPage({ viewport: { width: 1000, height: 700 }, deviceScaleFactor: 1 });
  await page.route('**/__halo_test__', route => route.fulfill({ contentType: 'text/html', body: '<link rel="stylesheet" href="/src/styles/tokens.css"><link rel="stylesheet" href="/src/index.css">'
    + '<style>html,body{margin:0;height:100%;overflow:hidden}.waterfall-stage{position:absolute;inset:0}</style><div class="waterfall-stage"><div class="waterfall-fit" style="height:100%"></div></div>' }));
  await page.goto(`${process.env.VITE_URL || 'http://localhost:5173'}/__halo_test__`, { waitUntil: 'load' });
  const result = await page.evaluate(async () => {
    const { WaterfallScene } = await import('/src/features/playback/waterfall/rollScene.ts');
    const { voiceRamp } = await import('/src/features/playback/waterfall/waterfallPalette.ts');
    const fit = document.querySelector('.waterfall-fit');
    let seed = 7;
    const random = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
    const notes = Array.from({ length: 900 }, () => {
      const duration = .1 + random() * 1.6;
      return { pitch: 36 + Math.floor(random() * 56), start: random() * 60, duration, sustainDuration: duration, voice: random() < .5 ? 0 : 1, velocity: .8 };
    });
    const make = () => {
      const canvases = ['waterfall-canvas', 'waterfall-keyboard-canvas', 'waterfall-sky', 'waterfall-lines'].map(name => {
        const canvas = document.createElement('canvas');
        canvas.className = name;
        if (name === 'waterfall-keyboard-canvas') canvas.setAttribute('style', 'position:absolute;left:0;bottom:0;display:block;width:100%');
        fit.append(canvas);
        return canvas;
      });
      const scene = new WaterfallScene(canvases[0], undefined, canvases[1], { sky: canvases[2], lines: canvases[3] });
      scene.setRamps([voiceRamp('#4a6fb3'), voiceRamp('#b3683a')]);
      scene.setPiece(notes, []);
      scene.resizeTo({ width: fit.clientWidth, height: fit.clientHeight, viewportHeight: fit.clientHeight, pixelRatio: 1 });
      return scene;
    };
    // The strip's rows, by global row, read back from the canvas.
    const rowsOf = (scene, from, to) => {
      const strip = scene.halo;
      const g = strip.canvas.getContext('2d', { willReadFrequently: true });
      const rows = new Map();
      for (let row = from; row < to; row++) rows.set(row, Array.from(g.getImageData(0, strip.baseTop - 1 - row, strip.columns, 1).data));
      return rows;
    };

    // 1. Slices have no seams: a strip baked by walking forward in small steps equals one baked in a single stretch after a seek.
    const walked = make();
    for (let time = 10; time <= 14; time += .05) walked.render(time);
    const seeked = make();
    seeked.render(14);
    const lo = Math.max(walked.halo.validLo, seeked.halo.validLo);
    const hi = Math.min(walked.halo.validHi, seeked.halo.validHi);
    const a = rowsOf(walked, lo, hi);
    const b = rowsOf(seeked, lo, hi);
    // The two bakes lay their slices on different rows, so a cell on the edge of a silhouette can fall either side of a threshold: a seam would
    // show as a run of rows with a different alpha, a rounding as a few pixels.
    let inked = 0;
    let changed = 0;
    for (const [row, bytes] of a) {
      const other = b.get(row);
      for (let i = 0; i < bytes.length; i += 4) {
        if (bytes[i + 3] > 0 || other[i + 3] > 0) inked++;
        if (Math.abs(bytes[i + 3] - other[i + 3]) > 16) changed++;
      }
    }

    // 2. The work in a frame is bounded: playing on, only the rows that time uses up are baked.
    const playing = make();
    for (let frame = 0; frame < 30; frame++) playing.render(20 + frame / 60);
    const before = playing.halo.slices;
    for (let frame = 30; frame < 90; frame++) playing.render(20 + frame / 60);
    const baked = playing.halo.slices - before;
    const rowsUsed = 1 / playing.halo.rowSeconds * 1.5;

    // 3. The strip is dropped when what it was made from changes, and the per-frame glow stands in while the roll is tilted.
    const edited = make();
    edited.render(20);
    const hadStrip = !!edited.halo;
    edited.setPiece(notes.slice(1), []);
    const droppedForNotes = edited.halo === undefined;
    edited.render(20);
    edited.setRamps([voiceRamp('#112233'), voiceRamp('#b3683a')]);
    const droppedForColours = edited.halo === undefined;
    edited.setTilt(.5);
    edited.render(20);
    const tiltedHasNoStrip = edited.halo === undefined;
    return { rowsCompared: a.size, inked, changed, baked, rowsUsed, slice: 32, hadStrip, droppedForNotes, droppedForColours, tiltedHasNoStrip };
  });
  assert.ok(result.rowsCompared > 100 && result.inked > 5000, `enough glow to compare (${result.rowsCompared} rows, ${result.inked} pixels with light)`);
  assert.ok(result.changed <= result.inked * .003, `a strip baked in small steps equals one baked in a single stretch: slices have no seams (${result.changed} of ${result.inked} pixels differ by more than 16 in alpha)`);
  assert.ok(result.baked <= Math.ceil(result.rowsUsed / result.slice) + 3, `a second of playing bakes only what time uses up (${result.baked} slices for about ${result.rowsUsed.toFixed(0)} rows)`);
  assert.ok(result.hadStrip && result.droppedForNotes && result.droppedForColours, 'the strip is dropped when the notes or the colours change');
  assert.ok(result.tiltedHasNoStrip, 'a tilted roll draws the glow per frame');
  console.log(`PASS ${engine}: the baked glow has no seams, bakes only what time uses up, and is dropped when its inputs change`);
  await page.close();
} finally {
  await browser.close();
}
