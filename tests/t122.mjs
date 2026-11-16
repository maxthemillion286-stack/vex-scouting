// t122 — v132: slanted plates, a timed pace, old matches read again anywhere,
// a heat map with contrast, and a served page without comments.
//
// The owner sent the first clean frame of a real match (Excalibur 2026) with:
// "use license plates and all cues you cn to figure out qwhich robot is which",
// "why does it need to be reopened on a computer for old matches?", "remove
// comments", and then "the stacking stat seems to be just dividing the points
// by amount of time not actually timing the stacking. this also looks like the
// robot was evereywhere when in realityh this robot likes staying near their
// alliance goals."
import fs from 'fs';
import { boot, settle } from './harness.mjs';
import { build } from '../tools/build.mjs';
let pass = 0, fail = 0;
const ok = (name, cond, detail) => { if (cond) { pass++; console.log('  ok   ' + name); } else { fail++; console.log('  FAIL ' + name + (detail ? '\n         ' + detail : '')); } };
const src = fs.readFileSync('../src/index.html', 'utf8'), served = fs.readFileSync('../index.html', 'utf8'), app = fs.readFileSync('../desktop/vex_trainer.py', 'utf8');
console.log('t122 — v132');
const { win, errors } = await boot();
await settle(win);
const f = n => win.eval(n);

// ── the served page ──
{
  const made = build(src);
  ok('index.html is exactly what src/index.html builds', made.page === served && !made.warn.length, made.warn.join(' | ') || 'run: node tools/build.mjs');
  ok('it has no comments left in its script', !/\n\s*\/\/ /.test(served.slice(served.indexOf('<script>'))) && !/\/\*\*?\s/.test(served.slice(served.indexOf('<script>'))));
  ok('and is much smaller', served.length < 0.72 * src.length, `${served.length} of ${src.length}`);
  ok('names are kept: buttons call functions by name', /function vtReportHtml\(/.test(served) && /function vtReplayPlay\(/.test(served) && /onclick="vtReplayPlay\(this\)"/.test(served));
  ok('the packed page boots clean', errors.length === 0 && typeof win.vtReportHtml === 'function', errors.slice(0, 2).join(' | '));
  ok('the source stays off the public site', /^src\/$/m.test(fs.readFileSync('../.vercelignore', 'utf8')));
}
// ── a slanted plate, from the real frame ──
{
  const fx = JSON.parse(fs.readFileSync('fixtures/plate_tilt.json', 'utf8')), rgb = Buffer.from(fx.rgb, 'base64');
  const rgba = new Uint8ClampedArray(fx.w * fx.h * 4);
  for (let p = 0; p < fx.w * fx.h; p++) { rgba[4 * p] = rgb[3 * p]; rgba[4 * p + 1] = rgb[3 * p + 1]; rgba[4 * p + 2] = rgb[3 * p + 2]; rgba[4 * p + 3] = 255; }
  const tilts = f('vtPlateTilts')(rgba, fx.w, fx.h, 1);
  ok('the plate is found with the way it lies', tilts.length === 1 && Math.abs(tilts[0][2] - 0.838) < 0.01 && tilts[0][3] > 1.3 * tilts[0][4], JSON.stringify(tilts));
  ok('the same as the app finds, to the pixel', tilts[0].every((v, k) => Math.abs(v - fx.tilt[k]) < 1e-6));
  const st = f('vtPlateStrip')(rgba, fx.w, fx.h, tilts[0], 0, 1.3);
  let sum = 0; for (let i = 0; i < st.data.length; i += 4) sum += st.data[i] + st.data[i + 1] + st.data[i + 2];
  ok('and straightens it into the same strip', st.used === fx.used && Math.abs(sum - fx.sum) <= 40 && st.data.length === 160 * 48 * 4, `${st.used} ${fx.used} ${sum} ${fx.sum}`);
  ok('no blue plate is imagined there', f('vtPlateTilts')(rgba, fx.w, fx.h, 2).length === 0);
  // What the reader made of that strip in the app: "8449A". Against its
  // alliance's two teams that is 66449A; the plate's colour narrowed it to two.
  ok('the read the app got from it names 66449A', fx.read === '8449A' && f('vtWhoFromText')(fx.read, ['2499B', '66449A']) === 2);
  ok('a thin or sparse patch is not taken for a plate', (() => { const q = new Uint8ClampedArray(60 * 60 * 4).fill(40); for (let k = 0; k < 60; k++) { const o = (k * 60 + k) * 4; q[o] = 230; q[o + 1] = 20; q[o + 2] = 20; } return f('vtPlateTilts')(q, 60, 60, 1).length === 0; })());
  ok('the tracker tries slanted plates after a level read fails, in the plate\'s colour', /for \(const tilt of vtPlateTilts\(wide, tw, th, col\)\) for \(const flip of \[0, 1\]\) for \(const pad of VT_PLATE_PADS\)/.test(src) && /vtWhoFromText\(got\.text, pair\)/.test(src));
  ok('the app does the same', /for tilt in plate_tilts\(crop, col\):/.test(app) && /who_from_text\(text, pair\)/.test(app) && /PLATE_PADS = \(1\.3, 1\.15\)/.test(app));
}
// ── the pace is timed ──
{
  const C = f('vtPinCycle');
  // driver control from 20 s: pins (two halves) at 30, 42, 50, 64; one in autonomous.
  ok('seconds a pin, from one set-down to the next: the middle value', C([[10, 2], [30, 2], [42, 2], [50, 2], [64, 2]], 20) === 12);
  ok('two pins at once count as two', C([[30, 2], [50, 4], [70, 4]], 20) === 10);
  ok('set-downs a second apart are one', C([[30, 1], [31, 1], [41, 2], [53, 2]], 20) === 12);
  ok('too few to time says nothing', C([[30, 2], [50, 2]], 20) === null && C([], 20) === null);
  ok('it is not time divided by pins', !/stackSec \/ avg/.test(src) && !/105 \/ pins/.test(src) && !/points per 10 s of stacking/.test(src));
}
// ── old matches, wherever the report is opened ──
{
  ok('a summary says which release made it', /rv: VT_REMAKE/.test(src) && f('vtStale')({ ok: 1 }) === true && f('vtStale')({ ok: 1, rv: f('VT_REMAKE') }) === false && f('vtStale')({ ok: 0 }) === false);
  ok('a report with older matches fetches their recordings and reads them again', /vtSumsRefresh\(sums\)\.then\(n => \{ delete host\.dataset\.fresh; if \(n && host\.dataset\.team === num\) vtReportFill\(num\); \}\)/.test(src));
  ok('from the shared store when this device never tracked them', /if \(!rec\) \{ const r = await vtApi\('GET', `\?event=\$\{encodeURIComponent\(ev\)\}&match=\$\{encodeURIComponent\(id\)\}`\)/.test(src));
  ok('each is tried once a visit', /vtRefreshTried\.add\(key\)/.test(src));
  ok('the page no longer says to open a computer', !/open the event on a computer and it happens by itself/.test(src));
}
// ── the heat map shows where it stays ──
{
  // Passes through everywhere (10 a square); lives by its alliance's goals.
  const heat = new Array(64).fill(10); heat[5 * 8 + 1] = 90; heat[6 * 8 + 2] = 80; heat[5 * 8 + 2] = 40;
  const svg = f('vtFieldSvg')(heat, null), cells = [...svg.matchAll(/<rect x="([\d.]+)" y="([\d.]+)" width="25\.0" height="25\.0" opacity="([\d.]+)"/g)];
  ok('squares it only drives through get no colour', cells.length === 3, String(cells.length));
  ok('the busiest is full, the next fainter', cells.some(c => c[3] === '1.00') && cells.some(c => +c[3] < 0.3));
  const flat = f('vtFieldSvg')(new Array(64).fill(10), null);
  ok('evenly everywhere colours nothing', !/height="25\.0" opacity/.test(flat));
  ok('the scale says so', /usual/.test(svg) && /a lot/.test(svg));
}
ok('release is v132 or later', /const APP_BUILD = 'v1[3-9]\d'/.test(src) && !/const APP_BUILD = 'v13[01]'/.test(src));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
