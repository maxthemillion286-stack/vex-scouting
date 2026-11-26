// t183 — v204: "4.8 pins a match is absurdly low this team scores around 6-10".
// A stacked pin's lower half sits in the cup below and does not score, so a
// stack of n pins is n + 1 visible halves: pins are halves ÷ 1.2, not ÷ 2.
import fs from 'fs';
import { boot, settle } from './harness.mjs';
let pass = 0, fail = 0;
const ok = (name, cond, detail) => { if (cond) { pass++; console.log('  ok   ' + name); } else { fail++; console.log('  FAIL ' + name + (detail ? '\n         ' + detail : '')); } };
const src = fs.readFileSync('../src/index.html', 'utf8');
console.log('t183 — v204');
const { win } = await boot();
await settle(win);
const Pins = win.eval('vtCoachPins'), Facts = win.eval('vtAutoFacts');
ok('a pin is 1.2 visible halves', win.eval('VT_HPP') === 1.2);
// The Excalibur table: 9.6 halves a match read as 4.8 pins.
const rows = [{ ys: 4, as: 6, ya: 4 }, { ys: 3, as: 6, ya: 4 }, { ys: 4, as: 6, ya: 4 }, { ys: 4, as: 5, ya: 3 }];
const P = Pins(rows, 1, null);
ok('9.5 halves a match is about 8 pins, not 4.75', Math.abs(P.pins - 9.5 / 1.2) < 0.01, P.pins);
ok('the points stay what the halves score', Math.abs(P.points - (15 * 10 + 23 * 5) / 4) < 0.01, P.points);
ok('4 halves in autonomous: 3 pins (a 4-pin autonomous with one half in a cup shows 5)', JSON.stringify(Facts(rows, 1, null).each) === '[3,3,3,3]', JSON.stringify(Facts(rows, 1, null).each));
ok('five pins are timed over their fastest stretch, getting them included', /t5 = vtFastFiveOf\(got, fix\) \|\| \(pace \? 5 \* pace : null\)/.test(src) && /const need = 5 \* VT_HPP/.test(src));
ok('real numbers set calibrate in pins the same way', /\(\(r\.ys \|\| 0\) \+ \(r\.as \|\| 0\)\) \/ VT_HPP\)\);\n\s+if \(seen > 0\) out\.kp/.test(src));
ok('release is v204 or later', /const APP_BUILD = 'v(20[4-9]|2[1-9]\d)'/.test(src));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
