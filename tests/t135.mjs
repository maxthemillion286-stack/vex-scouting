// t135 — v146: "it just says its not timed yet now". The My team table read
// summaries made before the timing existed (only the report remade them), and
// the goal count dropped the field count's time at the goal.
import fs from 'fs';
import { boot, settle } from './harness.mjs';
let pass = 0, fail = 0;
const ok = (name, cond, detail) => { if (cond) { pass++; console.log('  ok   ' + name); } else { fail++; console.log('  FAIL ' + name + (detail ? '\n         ' + detail : '')); } };
const src = fs.readFileSync('../src/index.html', 'utf8');
console.log('t135 — v146');
const { win } = await boot();
await settle(win);
const f = n => win.eval(n);
ok('the table remakes older matches and draws itself again', /if \(!host\.dataset\.fresh( && \[\.\.\.sums\.values\(\)\]\.some\(vtStale\))?\) \{\s+host\.dataset\.fresh = '1';\s+vtSumsRefresh\(sums\)\.then\(n => \{ delete host\.dataset\.fresh; if \(n\) \{[^}]*vtCoachFill\(num(, id)?\);/.test(src));
ok('and says why a time is missing', /its matches are being read again/.test(src) && /too few pins seen being stacked/.test(src));
// the goal count wins but has no timing of its own: the field count's stays
const mk = (i, field, goal) => ['900:' + i, { ok: 1, sv: 1, rs: 124, bs: 0, pk: 50, py: field / 10, pr: 0, pb: 0, gk: 50, gy: goal / 10, gr: 0, gb: 0, Ra: { ys: field / 10, oy: goal / 10, vs: 20, vh: 8 }, Rb: {}, Ba: {}, Bb: {} }];
const FV = [230, 280, 330, 250, 310], GV = [108, 113, 110, 116, 111];
const got = f('vtPinPick')(new Map([1, 2, 3, 4, 5].map(i => mk(i, FV[i - 1], GV[i - 1]))));
ok('the goal count is used', got.pinsFrom === 'goals');
ok('and the time at the goal is kept', got.get('900:1').Ra.vs === 20 && got.get('900:1').Ra.vh === 8);
const own = f('vtPinPick')(new Map([1, 2, 3, 4, 5].map(i => { const [k, s] = mk(i, FV[i - 1], GV[i - 1]); s.Ra.ovs = 12; s.Ra.ovh = 6; return [k, s]; })));
ok('its own timing is used when it has one', own.get('900:1').Ra.vs === 12 && own.get('900:1').Ra.vh === 6);
ok('the robot that stacked may stand up to half a field width from where the pins show up', /let k0 = -1, best = 0\.5;/.test(src));
ok('every device remakes older summaries', /const VT_REMAKE = (14[6-9]|1[5-9]\d);/.test(src));
ok('release is v146 or later', /const APP_BUILD = 'v1(4[6-9]|[5-9]\d)'/.test(src));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
