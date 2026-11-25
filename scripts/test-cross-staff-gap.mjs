import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { PLAYWRIGHT_MODULE_PATH, ENGINE = 'chromium', VITE_URL = 'http://localhost:5173' } = process.env;
assert.ok(PLAYWRIGHT_MODULE_PATH, 'Set PLAYWRIGHT_MODULE_PATH to the installed Playwright package.');
const { [ENGINE]: engine } = require(PLAYWRIGHT_MODULE_PATH);

// A triplet under a beam that spans the staves stands in the gap between them: it must not count as the reach of one staff, or the gap follows it
// and grows on every pass (40 passes took the staves 5000 units apart on the Ori medley). The fixture is four bars of it, laid out as the strip
// of notes lays them out (one long system); without the bridge the staves stand 4500 units apart.
const browser = await engine.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(`${VITE_URL}/demo-practice.html?view=demo-cross-staff`);
  await page.locator('.practice-strip-sheet svg .vf-stave').first().waitFor({ timeout: 60000 });
  await page.waitForTimeout(2500);
  const layout = await page.evaluate(() => {
    const sheet = document.querySelector('.practice-strip-sheet');
    const rows = [...new Set(Array.from(sheet.querySelectorAll('svg .vf-stave')).map((stave) => Math.round(stave.getBBox().y)))].sort((a, b) => a - b);
    return { rows, tuplets: sheet.querySelectorAll('.vf-tuplet').length, height: parseFloat(sheet.style.height) };
  });
  assert.ok(layout.tuplets > 0, 'the fixture has a tuplet');
  assert.equal(layout.rows.length, 2, `one treble and one bass staff (rows ${layout.rows.join(', ')})`);
  const gap = layout.rows[1] - layout.rows[0];
  assert.ok(gap < 400 && layout.height < 800, `the staves stand close together (gap ${gap}, sheet ${layout.height} units tall)`);
  console.log(`PASS ${ENGINE}: a triplet under a beam across the staves does not grow the gap (${gap} units)`);
} finally {
  await browser.close();
}
