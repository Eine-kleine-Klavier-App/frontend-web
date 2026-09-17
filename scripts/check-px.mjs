#!/usr/bin/env node
// Guard for the "no hardcoded pixels" core rule (AGENTS.md). Scans the stylesheets for `px`
// literals and fails on any outside the allowed contexts. No dependencies.
//
// Allowed, with their reason:
//   - border / outline widths and offsets: hairlines and focus rings are device-pixel crisp by
//     intent (border*, outline*, column-rule*)
//   - box-shadow / text-shadow: the depth ladder's rings and blurs are hairline-scale optics
//   - 1px anywhere (a hairline), and `--press-travel`
//   - stroke widths of SVG paint (stroke-width) — score/overlay optics
//   - a line ending with `/* px: <reason> */` — an explicit, stated exception
//
// Usage: node scripts/check-px.mjs [--report] [files...]   (default: src/**/*.css)
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const args = process.argv.slice(2);
const report = args.includes('--report');
let files = args.filter((a) => !a.startsWith('--'));
if (!files.length) {
  const walk = (dir) =>
    readdirSync(dir).flatMap((n) => {
      const p = join(dir, n);
      return statSync(p).isDirectory() ? walk(p) : p.endsWith('.css') ? [p] : [];
    });
  files = walk(join(ROOT, 'src'));
}

const ALLOWED_PROP = /^\s*(--press-travel|border[\w-]*|outline[\w-]*|column-rule[\w-]*|box-shadow|text-shadow|stroke-width|--elev-[\w-]*|--shadow-[\w-]*)\s*:/;
const PX = /(-?\d*\.?\d+)px\b/g;

// The stylesheet is split into areas by its own section banners; count per area for the report.
function areaOf(banner) {
  if (/Editor|editor|score sheet|deck|dock|inspector|ChoiceGroup|Shared controls|IconButton/.test(banner)) return 'editor+shared';
  return 'browse';
}

let total = 0;
const byArea = {};
for (const file of files) {
  const lines = readFileSync(file, 'utf8').split('\n');
  let area = 'shared';
  let decl = '';
  let inComment = false;
  lines.forEach((line, i) => {
    const banner = line.match(/\/\*\s*[=-]{2,}\s*(.+?)\s*[=-]{2,}/) || line.match(/^\s*(Editor[^*]*|Shared controls[^*]*)$/);
    if (banner) area = areaOf(banner[1]);
    // strip comments (single- and multi-line)
    let code = line;
    if (inComment) {
      const end = code.indexOf('*/');
      if (end < 0) return;
      code = code.slice(end + 2);
      inComment = false;
    }
    const stated = /\/\*\s*px:/.test(code);
    code = code.replace(/\/\*.*?\*\//g, '');
    const open = code.indexOf('/*');
    if (open >= 0) {
      code = code.slice(0, open);
      inComment = true;
    }
    // a declaration may continue over several lines (multi-value shadows); track its property
    const prop = code.match(/^\s*([\w-]+)\s*:/);
    if (prop) decl = code;
    else if (/^\s*[{}]/.test(code) || /[{}]/.test(code)) decl = '';
    const ctx = prop ? code : decl;
    if (stated || ALLOWED_PROP.test(ctx)) return;
    for (const m of code.matchAll(PX)) {
      if (Math.abs(parseFloat(m[1])) === 1 || parseFloat(m[1]) === 0) continue; // hairline / zero
      total++;
      byArea[area] = (byArea[area] ?? 0) + 1;
      if (!report) console.log(`${relative(ROOT, file)}:${i + 1}: ${line.trim()}`);
    }
  });
}
console.log(`px outside allowed contexts: ${total}  ${JSON.stringify(byArea)}`);
process.exit(total ? 1 : 0);
