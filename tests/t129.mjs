// t129 — v139: five pins always gets a figure; the autonomous replay plays in real time.
import fs from 'fs';
import { boot, settle } from './harness.mjs';
let pass = 0, fail = 0;
const ok = (name, cond, detail) => { if (cond) { pass++; console.log('  ok   ' + name); } else { fail++; console.log('  FAIL ' + name + (detail ? '\n         ' + detail : '')); } };
const src = fs.readFileSync('../src/index.html', 'utf8');
console.log('t129 — v139');
const { win } = await boot();
await settle(win);
win.eval('VT_HPP = 2');   // v204: these numbers were written with a pin as two halves
const f = n => win.eval(n);
// "the scoring doesnt show how much anymore for 5 pins"
const rows = [{ ys: 3, cy: 9, vs: 15, vh: 4 }, { ys: 3, cy: 11, vs: 13, vh: 4 }, { ys: 3, cy: 10, vs: 17, vh: 4 }];
const p = f('vtPinLine')(rows, null, true, null);
ok('five pins from its time at the goal (v145: 45 s over 6 pins)', /5 pins in 38 s · 7\.5 s a pin/.test(p.short), p.short);
ok('a real stretch is shown as it is', /5 pins in 34 s$/.test(f('vtPinLine')([{ ys: 4, cy: 9, k10: 30 }, { ys: 4, cy: 9, k10: 34 }], null, true, null).short));
ok('the table does the same', /a pin every \$\{P\.perPin\.toFixed\(1\)\} s at the goal<\/span>/.test(src));
// The autonomous replay (v139) was taken out in v196: "remove the replay autonomous thing … it doesnt work".
const pts = [[0.1, 0.6, 0], [0.2, 0.7, 3], [0.3, 0.8, 6], [0.3, 0.8, 9], [0.3, 0.8, 12], [0.3, 0.8, 15]];
const html = f('vtReportAuto')({ game: { n: 5, replay: { pts, n: 4, of: 5, still: false } }, autoFacts: null }, { auto: [] });
ok('the report says the routine in words, with no replay', !/vr-replay|vtReplayPlay|data-pts=/.test(html) && /Runs the same routine in 4 of 5/.test(html));
ok('release is v139 or later', /const APP_BUILD = 'v(1[3-9]\d|[2-9]\d\d)'/.test(src) && !/const APP_BUILD = 'v13[0-8]'/.test(src));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
