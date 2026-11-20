// t153 — v167: predictions use what the newer tracking measures, and the pick
// list says how each partner plays and how it fits. Asked for: "match
// predictions and a pick list".
import fs from 'fs';
import { boot, settle } from './harness.mjs';
let pass = 0, fail = 0;
const ok = (name, cond, detail) => { if (cond) { pass++; console.log('  ok   ' + name); } else { fail++; console.log('  FAIL ' + name + (detail ? '\n         ' + detail : '')); } };
const src = fs.readFileSync('../src/index.html', 'utf8');
console.log('t153 — v167');
const { win } = await boot();
await settle(win);
const score = win.eval('sim_trackScore'), roleOf = win.eval('tRoleOf'), fit = win.eval('tRoleFit');
// Six teams; only the newer measures known. Team F stacks the most and fastest.
const mk = (pins, auto, vs) => Array.from({ length: 4 }, () => ({ ys: pins, as: pins, ya: auto, vs, vh: 8 }));
const rows = new Map([['A', mk(2, 1, 40)], ['B', mk(3, 1, 36)], ['C', mk(4, 2, 30)], ['D', mk(5, 2, 26)], ['E', mk(6, 3, 22)], ['F', mk(9, 5, 14)]]);
const sc = score(rows);
ok('teams with only the newer measures are scored', sc.size === 6, JSON.stringify([...sc]));
ok('the most pins, autonomous and fastest stacking scores highest', [...sc.entries()].sort((a, b) => b[1] - a[1])[0][0] === 'F' && sc.get('A') < sc.get('C'));
ok('older measures still count where known', (() => { const r = new Map([...rows].map(([k, v]) => [k, v.map(x => ({ ...x, act: k === 'A' ? 9 : 1, ap: 1, stp: 1 }))])); const s2 = score(r); return s2.get('A') > sc.get('A'); })());
ok('too few teams with any measure: nothing', score(new Map([['A', mk(2, 1, 40)]])).size === 0);
const stacker = roleOf(Array.from({ length: 3 }, () => ({ ga: 0.5, gn: 0.1, ts: 0, to: 0.02, th: 0.02 })));
const guard = roleOf(Array.from({ length: 3 }, () => ({ ga: 0.05, gn: 0.05, ts: 0.1, to: 0.1, th: 0.4 })));
ok('how a team plays, from its tracked matches', stacker && stacker.label === 'stacks on its goals' && guard && guard.label === 'guards its toggle', JSON.stringify([stacker, guard]));
ok('a stacker and a guard fit; two stackers do not', fit(stacker, guard) > 0.5 && fit(stacker, stacker) < 0.01);
ok('too few tracked matches: no role', roleOf([{ ga: 0.5 }]) === null);
ok('the pick list shows it and breaks near ties with it', /Mostly \$\{esc\(c\.role\.label\)\}/.test(src) && /b\.win \+ T_FIT_PTS \* \(b\.fit \|\| 0\)/.test(src) && /const T_FIT_PTS = 3;/.test(src));
ok('the note on video says what it now includes', /pins a match, autonomous pins, how fast it stacks/.test(src));
ok('release is v167 or later', /const APP_BUILD = 'v1(6[7-9]|[7-9]\d)'/.test(src));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
