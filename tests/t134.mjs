// t134 — v145: stacking timed at the goal. Reported: "the time somehow went
// up for stacking 5 pins even though they stack an average of 5 pins in
// about 20-30 seconds" (it read "about 103 s, from a pin every 21 s"). The
// camera sees new pins only once the robot drives off the stack, so the gaps
// between sightings are mostly driving. Now: time at the goal on the visits
// that added pins, over the pins added.
import fs from 'fs';
import { boot, settle } from './harness.mjs';
let pass = 0, fail = 0;
const ok = (name, cond, detail) => { if (cond) { pass++; console.log('  ok   ' + name); } else { fail++; console.log('  FAIL ' + name + (detail ? '\n         ' + detail : '')); } };
const src = fs.readFileSync('../src/index.html', 'utf8');
console.log('t134 — v145');
const { win } = await boot();
await settle(win);
const f = n => win.eval(n);
const G = [0.17, 0.66], away = { x: 0.6, y: 0.3 }, at = { x: 0.18, y: 0.67 };
// Red robot 0: three visits to the goal, 6 s each (30–36, 60–66, 90–96), driving 24 s between;
// each visit adds two pins (4 halves), seen 3 s after it leaves.
const track = [];
for (let t = 0; t <= 125; t += 0.5) {
  const there = (t >= 30 && t <= 36) || (t >= 60 && t <= 66) || (t >= 90 && t <= 96);
  track.push({ t, s: { 1: [there ? at : away, away], 2: [away, away] } });
}
const r = { c: 1, i: 0 };
for (const t of [39, 69, 99]) f('vtVisitAdd')(r, track, G, t, 4);
f('vtVisitSum')(r);
ok('three visits of 6 s, twelve halves', r.vs === 18 && r.vh === 12, JSON.stringify(r));
ok('3 s a pin while stacking, so five pins in 15 s', f('vtStackPace')([r], 1) === 3);
// two colours seen from one visit count its time once
const r2 = { c: 1, i: 0 };
f('vtVisitAdd')(r2, track, G, 39, 2); f('vtVisitAdd')(r2, track, G, 40, 2);
f('vtVisitSum')(r2);
ok('two sightings from one visit: its time once', r2.vs === 6 && r2.vh === 4, JSON.stringify(r2));
// a robot that was never at that goal gets no time
const r3 = { c: 1, i: 1 };
f('vtVisitAdd')(r3, track, G, 39, 4); f('vtVisitSum')(r3);
ok('no visit, no time', r3.vs === undefined);
ok('too few pins to time: nothing', f('vtStackPace')([{ vs: 6, vh: 4 }], 1) === null);
ok('corrected like the counts', Math.abs(f('vtStackPace')([{ vs: 18, vh: 12 }], 0.5) - 6) < 1e-9);
// in the table and the report
const P = f('vtCoachPins')([{ ys: 6, as: 6, vs: 18, vh: 12 }, { ys: 6, as: 6, vs: 18, vh: 12 }], 1, null);
ok('the table shows five pins at that pace, and says it is at the goal', P.t5 === 15 && P.timed && /a pin every \$\{P\.perPin\.toFixed\(1\)\} s at the goal/.test(src));
const L = f('vtPinLine')([{ ys: 6, vs: 18, vh: 12 }, { ys: 6, vs: 18, vh: 12 }], null, true, null);
ok('the Scoring line too', /5 pins in 15 s · 3\.0 s a pin/.test(L.short), L.short);
ok('the gaps between sightings are no longer used for it', !/\`5 pins in about/.test(src) && !/const cys = mine\.map\(r => r\.cy\)/.test(src));
ok('both pin counts and the trained finder\'s keep the timing; older summaries are made again', /vtVisitAdd\(r, track, at, t, d\)/.test(src) && /vtVisitAdd\(r, track, \[sp\.x, sp\.y\], t, d\)/.test(src) && /vs: 'ovs', vh: 'ovh'/.test(src) && /const VT_REMAKE = 145;/.test(src));
ok('release is v145 or later', /const APP_BUILD = 'v1(4[5-9]|[5-9]\d)'/.test(src));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
