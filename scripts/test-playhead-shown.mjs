import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const playwright = process.env.PLAYWRIGHT_MODULE_PATH ? require(process.env.PLAYWRIGHT_MODULE_PATH) : await import('playwright');
const engine = process.env.ENGINE || 'chromium';
const browser = await playwright[engine].launch({ headless: true });
const base = process.env.VITE_URL || 'http://localhost:5173';

// The playback line is there while the sound plays or is held, and not while the transport is stopped with the square.
try {
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${base}/demo-editor.html?view=demo-editor-view&clock=1&playing=0`);
  await page.waitForSelector('.vf-stavenote', { timeout: 30000 });
  await page.waitForTimeout(1500);
  const line = () => page.evaluate(() => ({ line: document.querySelectorAll('svg.overlay line.cursor-grab').length }));
  const act = (name) => page.evaluate(async (name) => { const { playback } = await import('/src/core/playback/PlaybackController.ts'); await playback[name](); }, name);
  assert.equal((await line()).line, 0, 'a stopped transport shows no line on entry');
  await act('play');
  await page.waitForTimeout(400);
  assert.equal((await line()).line, 1, 'the line is there while the sound plays');
  await act('pause');
  await page.waitForTimeout(400);
  assert.equal((await line()).line, 1, 'the line stays while the sound is held');
  await act('stop');
  await page.waitForTimeout(400);
  assert.equal((await line()).line, 0, 'the square takes the line away');
  assert.deepEqual(errors, []);
  console.log('PASS the playback line shows while playing or paused, not when stopped');
} finally {
  await browser.close();
}
