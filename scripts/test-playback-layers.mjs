import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
if (process.argv.includes('--help')) { console.log('VITE_URL, ENGINE, PLAYWRIGHT_MODULE_PATH'); process.exit(0); }
const playwright = require(process.env.PLAYWRIGHT_MODULE_PATH);
const engine = process.env.ENGINE || 'webkit';
const browser = await playwright[engine].launch({ headless: true });

// The playhead and the washed bar are painted on layers of whole device pixels over the scroll area; the SVG line and rect only say where they stand.
try {
  for (const ratio of [1, 2]) {
    const page = await browser.newPage({ viewport: { width: 1000, height: 700 }, deviceScaleFactor: ratio });
    await page.route('**/__layers_test__', route => route.fulfill({ contentType: 'text/html', body: '<link rel="stylesheet" href="/src/styles/tokens.css"><link rel="stylesheet" href="/src/index.css">'
      + '<style>html,body{margin:0;height:100%;overflow:hidden}</style>'
      + '<div class="canvas-area" style="position:absolute;inset:0"><div class="paper" data-ready="true" style="width:700px;height:1600px"><div class="sheet-pages"><div class="sheet-page" data-waiting="false" style="position:absolute;left:0;top:0;width:700px;height:1600px"></div></div><div class="score-content score-scale" style="transform:scale(.8333);transform-origin:top left;width:900px;height:1800px;position:relative">'
      + '<svg width="900" height="1800" viewBox="0 0 900 1800"><g class="vf-stavenote" data-note-id="n1" style="--voice-color:rgb(42,127,120)"><path d="M200.3 300.4h40.2v20.1h-40.2z" fill="#222"/><path class="vf-ledger" d="M180 330h80" stroke="#222"/></g></svg>'
      + '<svg class="overlay" width="900" height="1800" viewBox="0 0 900 1800"><rect class="playing-wash" x="100" y="200" width="260" height="300"/><line class="cursor" x1="150" y1="200" x2="150" y2="500"/></svg></div></div></div>' }));
    await page.goto(`${process.env.VITE_URL || 'http://localhost:5173'}/__layers_test__`, { waitUntil: 'load' });
    const result = await page.evaluate(async () => {
      const { createPlaybackLayers } = await import('/src/features/editor/PlaybackLayers.ts');
      const area = document.querySelector('.canvas-area');
      const line = document.querySelector('.overlay .cursor');
      const wash = document.querySelector('.playing-wash');
      const paperBefore = document.querySelector('.paper').getBoundingClientRect().top;
      const layers = createPlaybackLayers(area);
      const frame = () => new Promise(resolve => requestAnimationFrame(() => resolve()));
      const strokeOf = canvas => {
        const g = canvas.getContext('2d', { willReadFrequently: true });
        const data = g.getImageData(0, Math.floor(canvas.height * .4), canvas.width, 1).data;
        const columns = [];
        for (let x = 0; x < canvas.width; x++) if (data[x * 4 + 3] > 0) columns.push([x, data[x * 4 + 3]]);
        return columns;
      };
      const lineLayer = () => document.querySelector('.playback-line-layer');
      const washLayer = () => document.querySelector('.playback-wash-layer');
      const widths = [];
      const peaks = [];
      for (let step = 0; step < 40; step++) {
        const x = 150 + step * 1.37;                       // a place that falls between the device pixels, differently in every frame
        for (const name of ['x1', 'x2']) line.setAttribute(name, String(x));
        layers.draw(line, wash, []);
        await frame();
        const columns = strokeOf(lineLayer());
        widths.push(columns.length);
        peaks.push(Math.max(...columns.map(c => c[1])));
      }
      // the layers lie on the scroll area's padding box and give the sheet back its room; they follow the area when it scrolls
      const areaBox = area.getBoundingClientRect();
      const layerBox = lineLayer().getBoundingClientRect();
      const washBox = washLayer().getBoundingClientRect();
      const paperAfter = document.querySelector('.paper').getBoundingClientRect().top;
      // the notes that sound: drawn in the ink of their voice over the engraving's own parts, ledger lines left out, and gone when they stop
      const notesLayer = () => document.querySelector('.playback-notes-layer');
      const inkOf = () => {
        const canvas = notesLayer();
        const data = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, canvas.width, canvas.height).data;
        let minX = Infinity, minY = Infinity, maxX = -1, maxY = -1, count = 0, wrong = 0;
        for (let i = 0; i < data.length; i += 4) {
          if (data[i + 3] < 128) continue;
          const x = (i / 4) % canvas.width, y = Math.floor(i / 4 / canvas.width);
          minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); count++;
          if (Math.abs(data[i] - 42) > 3 || Math.abs(data[i + 1] - 127) > 3 || Math.abs(data[i + 2] - 120) > 3) wrong++;
        }
        return { minX, minY, maxX, maxY, count, wrong, box: canvas.getBoundingClientRect() };
      };
      const part = document.querySelector('.vf-stavenote path').getBoundingClientRect();
      const quiet = (layers.draw(line, wash, []), inkOf().count);
      const sounding = ['n1'];
      layers.draw(line, wash, sounding);
      const first = inkOf();
      const place = (ink) => [ink.minX - (part.left - ink.box.left) * devicePixelRatio, ink.minY - (part.top - ink.box.top) * devicePixelRatio, ink.maxX + 1 - (part.right - ink.box.left) * devicePixelRatio, ink.maxY + 1 - (part.bottom - ink.box.top) * devicePixelRatio];
      const placed = place(first);
      area.scrollTop = 200;
      layers.draw(line, wash, sounding);
      await frame();
      const scrolledPart = document.querySelector('.vf-stavenote path').getBoundingClientRect();
      const scrolledInk = inkOf();
      const scrolledPlace = [scrolledInk.minX - (scrolledPart.left - scrolledInk.box.left) * devicePixelRatio, scrolledInk.minY - (scrolledPart.top - scrolledInk.box.top) * devicePixelRatio];
      layers.draw(line, wash, []);
      const stopped = inkOf().count;
      layers.draw(line, wash, sounding);
      await frame();
      const scrolledBox = lineLayer().getBoundingClientRect();
      // the layers stand on the sheet only where it is ready: not while the paper is unready, not over a page that waits for its drawing
      const paper = document.querySelector('.paper'), page = document.querySelector('.sheet-page');
      const painted = canvas => canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, canvas.width, canvas.height).data.some((value, i) => i % 4 === 3 && value > 0);
      const everything = () => [painted(lineLayer()), painted(washLayer()), painted(notesLayer())];
      layers.draw(line, wash, sounding);
      const ready = everything();
      paper.dataset.ready = 'false';
      layers.draw(line, wash, sounding);
      const unready = everything();
      paper.dataset.ready = 'true';
      page.dataset.waiting = 'true';
      layers.draw(line, wash, sounding);
      const waitingPage = everything();
      page.dataset.waiting = 'false';
      layers.draw(line, wash, sounding);
      const again = everything();
      // the wash: the rect of the anchor, on whole device pixels
      const washPixels = washLayer().getContext('2d', { willReadFrequently: true }).getImageData(0, 0, washLayer().width, washLayer().height).data;
      let inked = 0;
      for (let i = 3; i < washPixels.length; i += 4) if (washPixels[i] > 0) inked++;
      layers.dispose();
      return {
        widths, peaks, ratio: devicePixelRatio,
        sameCorner: [Math.abs(layerBox.x - areaBox.x), Math.abs(layerBox.y - areaBox.y), Math.abs(washBox.x - areaBox.x), Math.abs(washBox.y - areaBox.y)],
        sheetMoved: Math.abs(paperAfter - paperBefore),
        followsScroll: [Math.abs(scrolledBox.x - areaBox.x), Math.abs(scrolledBox.y - areaBox.y)],
        gate: { ready, unready, waitingPage, again }, quiet, placed, wrongColour: first.wrong, noteInk: first.count, scrolledPlace, stopped,
        inked, removed: document.querySelectorAll('.playback-layer').length,
      };
    });
    assert.ok(new Set(result.widths).size === 1 && result.widths[0] >= 2, `at ${result.ratio}x the line is the same whole number of device pixels wide in every frame (${[...new Set(result.widths)]})`);
    assert.ok(new Set(result.peaks).size === 1, `the line is drawn at the same strength wherever it falls (${[...new Set(result.peaks)]})`);
    assert.ok(result.sameCorner.every(value => value < .01), `both layers lie on the scroll area's corner (${result.sameCorner})`);
    assert.ok(result.sheetMoved < .01, 'the layers take no room from the sheet');
    assert.ok(result.followsScroll.every(value => value < .01), 'the layers stay on the visible part of the area when it scrolls');
    assert.ok(result.inked > 1000, 'the washed bar is painted');
    assert.equal(result.quiet, 0, 'nothing is drawn when no note sounds');
    assert.ok(result.noteInk > 200, `the sounding note's part is drawn, ledger line left out (${result.noteInk} px)`);
    assert.equal(result.wrongColour, 0, 'the note takes the ink of its voice');
    assert.ok(result.placed.every(value => Math.abs(value) < 1.5), `the drawn note lies on the engraving's part to the device pixel (${result.placed.map(v => v.toFixed(2))})`);
    assert.ok(result.scrolledPlace.every(value => Math.abs(value) < 1.5), `and still does after the area scrolls (${result.scrolledPlace.map(v => v.toFixed(2))})`);
    assert.equal(result.stopped, 0, 'the notes are taken away when they stop');
    assert.deepEqual(result.gate.ready, [true, true, true], 'a ready sheet has the line, the wash and the notes');
    assert.deepEqual(result.gate.unready, [false, false, false], 'nothing is drawn while the paper is not ready');
    assert.deepEqual(result.gate.waitingPage.slice(0, 2), [false, false], 'the line and the wash are not drawn over a page that waits for its drawing');
    assert.deepEqual(result.gate.again, [true, true, true], 'they come back when the sheet is ready');
    assert.equal(result.removed, 0, 'dispose takes the layers away');
    console.log(`PASS ${engine}@${ratio}x: the playhead is whole device pixels at a steady strength, the layers sit on the area and take no room`);
    await page.close();
  }
} finally {
  await browser.close();
}
