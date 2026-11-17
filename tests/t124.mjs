// t124 — v134: the fastest five pins, and the speed work.
//
// Reported: "48 seconds is way too slow for 5 pins, this team has proven to
// stack 2 full 7 pin stacks in under 50 seconds alone". The figure was the
// time from the start of driver control to the fifth pin. Now it is the
// shortest stretch in which five pins went down.
// Asked: "optimize make it fast as possible for everything without a quality
// sacrifice". The app's faster code is checked for identical answers in
// desktop/dev/same.py; here what can be checked from the source.
import fs from 'fs';
import { boot, settle } from './harness.mjs';
let pass = 0, fail = 0;
const ok = (name, cond, detail) => { if (cond) { pass++; console.log('  ok   ' + name); } else { fail++; console.log('  FAIL ' + name + (detail ? '\n         ' + detail : '')); } };
const src = fs.readFileSync('../src/index.html', 'utf8'), app = fs.readFileSync('../desktop/vex_trainer.py', 'utf8');
console.log('t124 — v134');
const { win } = await boot();
await settle(win);
const f = n => win.eval(n);
{
  const W = f('vtFastWindows');
  // Driver control from 20 s. It drives out and collects for 25 s, then puts
  // down a pin (two halves) every 3 s: 45, 48, … — 14 pins by 84 s.
  const ev = []; for (let k = 0; k < 14; k++) ev.push([45 + 3 * k, 2]);
  const w = W(ev, 20);
  ok('five pins after one goes down: 15 s, five cycles of 3', w.k10 === 15, JSON.stringify(w));
  ok('the old figure would have been 37 s', (() => { let s = 0; for (const [t, d] of ev) { s += d; if (s >= 10) return Math.round(t - 20) === 37; } })());
  ok('fourteen pins: from the start of driver control, 64 s', w.k28 === 64);
  ok('more than it set down: not there', w.k34 === undefined && w.k40 === undefined);
  // A slow start then a burst: the burst is what counts.
  const burst = [[30, 2], [50, 2], [70, 2], [71, 2], [72, 2], [73, 2], [74, 2], [100, 2]];
  ok('the fastest stretch, wherever it is', W(burst, 20).k8 === 4 && W(burst, 20).k10 === 24, JSON.stringify(W(burst, 20)));
  ok('set-downs under half a second apart are one', W([[30, 2], [30.3, 2], [33, 2]], 20).k4 === 10);
  ok('it can start at the start of driver control', W([[22, 4]], 20).k4 === 2);
  ok('autonomous is left out', W([[5, 10], [25, 2]], 20).k4 === undefined);
  const F5 = f('vtFastFive');
  ok('five real pins are ten counted halves when the counts are right', F5({ k10: 12, k12: 15 }, 1) === 12);
  ok('when the tracker counts 2.8 for each real half, read the 28 window', F5({ k10: 12, k28: 39 }, 1 / 2.8) === 39);
  ok('between sizes it is read between them', F5({ k8: 10, k10: 14 }, 10 / 9) === 12);
  ok('not enough set down: nothing', F5({ k4: 3 }, 1) === null);
  ok('the usual one is the middle of the matches', f('vtFastFiveOf')([{ k10: 10 }, { k10: 30 }, { k10: 14 }, {}], 1) === 14 && f('vtFastFiveOf')([{ k10: 10 }], 1) === null);
  ok('older summaries are made again on any device to get it', /const VT_REMAKE = 1(3[4-9]|[4-9]\d);/.test(src));
  ok('the report says it is the fastest five', /its fastest five pins usually take/.test(src) && !/five pins down \$\{Math\.round\(t5\)\} s into driver control/.test(src));
  ok('the server takes the new fields', (async () => true)() && /\^\[a-z\]\[a-z0-9\]\{1,3\}\$/.test(fs.readFileSync('../api/tracker.js', 'utf8')));
}
// ── speed ──
{
  ok('per-pixel largest/smallest by three passes, not a reduce along colours', !/\.max\(2\)|\.min\(2\)/.test(app) && /np\.maximum\(np\.maximum\(/.test(app));
  ok('a plate patch is turned by its outline\'s corners only', /cv2\.convexHull/.test(app) && /_TILT_COS/.test(app));
  ok('reads go to the graphics card together', /def read_many\(self, strips, width=160\):/.test(app) && /self\.read_many\(\[l\[1\] for l in lines\], 320\)/.test(app) && /got = self\.read_many\(\[plate_strip/.test(app));
  ok('the vision model and the upload run behind the next match', /behind\.submit\(finish, job, rec, why/.test(app) && /behind\.shutdown\(wait=True\)/.test(app));
  ok('the served page is packed with syntax shortening too, names kept', /minifySyntax: true, minifyIdentifiers: false/.test(fs.readFileSync('../tools/build.mjs', 'utf8')));
}
ok('release is v134 or later', /const APP_BUILD = 'v1[3-9]\d'/.test(src) && !/const APP_BUILD = 'v13[0-3]'/.test(src));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
