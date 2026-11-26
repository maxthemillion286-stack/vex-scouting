// t177 — v198: "these stats are absurdly wrong" — the real ones: "4 pin
// autonomous, 5 pins usually takes 25 seconds-ish, scores about 10 pins a
// match". An event's counts are corrected to the owner's real numbers.
import fs from 'fs';
import { boot, settle } from './harness.mjs';
let pass = 0, fail = 0;
const ok = (name, cond, detail) => { if (cond) { pass++; console.log('  ok   ' + name); } else { fail++; console.log('  FAIL ' + name + (detail ? '\n         ' + detail : '')); } };
const src = fs.readFileSync('../src/index.html', 'utf8'), api = fs.readFileSync('../api/tracker.js', 'utf8');
console.log('t177 — v198');
const { win } = await boot();
await settle(win);
win.eval('VT_HPP = 2');   // v204: these numbers were written with a pin as two halves
const From = win.eval('vtCalibFrom'), On = win.eval('vtCalibOn'), Pins = win.eval('vtCoachPins'), Facts = win.eval('vtAutoFacts'), Usual = win.eval('vtUsual'), Cal = win.eval('vtCalib');
// What the tracker saw (the table read 4.8 pins, autonomous 1, 5 pins in 10 s).
const raw = [
  { ys: 6, as: 4, ya: 2, vs: 12, vh: 12 }, { ys: 5, as: 4, ya: 2, vs: 10, vh: 10 },
  { ys: 6, as: 3, ya: 4, vs: 8, vh: 8 }, { ys: 5, as: 5, ya: 0, vs: 10, vh: 10 }, { ys: 4, as: 6, ya: 2, vs: 10, vh: 10 }];
const before = Pins(raw, 1, null);
ok('before: about 4.8 pins, 1 in autonomous, 5 pins in about 10 s', Math.abs(before.pins - 4.8) < 0.01 && Math.round(before.t5) === 10, JSON.stringify(before));
const k = From(raw, { auto: 4, pins: 10, t5: 25 });
ok('factors found for all three', k.kp > 0 && k.ka > 0 && k.kt > 0, JSON.stringify(k));
Cal.set('62000', { ...k, team: '66449A' });
const rows = raw.map(r => On(r, '62000:7'));
const after = Pins(rows, 1, null);
ok('after: 10 pins a match', Math.abs(after.pins - 10) < 0.01, after.pins);
ok('after: 5 pins in 25 s', Math.round(after.t5) === 25, after.t5);
const F = Facts(rows, 1, null), U = Usual(F.pins, F.each);
ok('after: autonomous usually 4', U.n === 4, JSON.stringify(F.each));
ok('another event is left alone', On(raw[0], '61000:3').kp === undefined);
ok('a stream autonomous score does not cut the real numbers back', Facts(rows.map(r => ({ ...r, asa: 5 })), 1, null).each.every(v => v >= 0) && Facts(rows.map(r => ({ ...r, asa: 5 })), 1, null).capped === 0);
ok('factors are kept between 0.2 and 5', From(raw, { auto: 0, pins: 500, t5: 0 }).kp === 5);
ok('the website keeps them, with the admin key', /body\.calib !== undefined/.test(api) && /\['HSET', 'vt:calib', cev/.test(api) && /q\.calib !== undefined/.test(api));
ok('the owner\'s table has the box to set them', /Fix with my real numbers/.test(src) && /mineTeam && lsGet\(VT_PASS_KEY\)/.test(src));
ok('release is v198 or later', /const APP_BUILD = 'v(19[89]|[2-9]\d\d)'/.test(src));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
