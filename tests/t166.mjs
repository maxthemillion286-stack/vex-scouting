// t166 — v180: counting pins exactly, part 1: the end of each match made to
// add up to its official score, and the stream's score jumps credited to robots.
import fs from 'fs';
import { boot, settle } from './harness.mjs';
let pass = 0, fail = 0;
const ok = (name, cond, detail) => { if (cond) { pass++; console.log('  ok   ' + name); } else { fail++; console.log('  FAIL ' + name + (detail ? '\n         ' + detail : '')); } };
const src = fs.readFileSync('../src/index.html', 'utf8');
console.log('t166 — v180');
const { win } = await boot();
await settle(win);
const X = win.eval('vtExact');
// Red: 2 robots counted 9 + 7 own halves and 2 + 0 yellow; one in midfield. Official 117.
// Blue: counted 4 + 4 own, 1 yellow; official 60.
const s = { ok: 1, pk: 20, rs: 117, bs: 60, Ra: { as: 9, ys: 2, eg: 1 }, Rb: { as: 7, ys: 0 }, Ba: { as: 4, ys: 1 }, Bb: { as: 4, ys: 0 } };
const x = X(s);
const pts = (o, y, bonus, mid) => 5 * o + 10 * y + bonus + 8 * mid;
ok('red adds up exactly to its official score', x && pts(x.r.own, x.r.y, x.r.bonus, x.r.mid) + x.r.rest === 117 && x.r.rest < 5, JSON.stringify(x));
ok('blue too', x && pts(x.b.own, x.b.y, x.b.bonus, x.b.mid) === 60, JSON.stringify(x));
ok('and close to what was counted', x && Math.abs(x.r.own - 16) <= 3 && Math.abs(x.b.own - 8) <= 3, JSON.stringify(x));
ok('each robot scaled by its alliance', x && Math.abs(x.R - (x.r.own + x.r.y) / 18) < 1e-9);
ok('a match the video barely saw is left alone', X({ ok: 1, pk: 3, rs: 50, bs: 40, Ra: { as: 0, ys: 0 }, Rb: { as: 0, ys: 0 }, Ba: { as: 0, ys: 0 }, Bb: { as: 0, ys: 0 } }) === null);
ok('the bonus goes where the stream showed autonomous was won', (() => { const t = X({ ...s, _x: undefined, R: { sa: 10 }, B: { sa: 30 } }); return t && t.b.bonus === 12 && t.r.bonus === 0; })());
const Fx = win.eval('vtFx');
ok('a robot with an exact fit uses it, not the event\'s correction', Fx({ xf: 0.7 }, 0.4) === 0.7 && Fx({}, 0.4) === 0.4);
ok('the counts everywhere use it', (src.match(/vtFx\(r, fix\)/g) || []).length >= 4);
ok('the report says so', /then made to add up to the official score in \$\{exact\} of/.test(src));

// ── the stream's score, jump by jump
const J = win.eval('vtScoreJumps');
const ph = { start: 10, driver: 25, end: 130 };
// Red's score: 0 until 20 s, 10 from 20 s, 25 from 60 s. Robot a is at goal 9 (0.5,0.5) at 15–20 s; robot b at goal 1 at 55–60 s.
const sc = [];
for (let t = 0; t <= 140; t++) { const r = t < 20 ? 0 : t < 60 ? 10 : 25; sc.push(t * 10, r, 0); }
const track = [];
for (let t = 0; t <= 140; t++) track.push({ t, s: { 1: [t >= 14 && t <= 20 ? { x: 0.5, y: 0.5 } : { x: 0.1, y: 0.1 }, t >= 54 && t <= 60 ? { x: 0.17, y: 0.66 } : { x: 0.9, y: 0.1 }], 2: [null, null] } });
const got = J({ sc }, track, ph);
ok('a score jump goes to the robot at a goal just before it', got && got[1][0].p === 10 && got[1][1].p === 15, JSON.stringify(got && got[1]));
ok('autonomous points are kept apart', got && got[1][0].a === 10 && got[1][1].a === 0);
ok('summaries are made again for it', /const VT_REMAKE = 1(8\d|9\d)/.test(src));
ok('autonomous never above its own share of the stream\'s autonomous points', /Number\.isFinite\(r\.spa\) && h > r\.spa \/ VT_PTS_OWN/.test(src));
ok('the report gives the stream\'s points', /The stream's own score credits it/.test(src));
ok('release is v180 or later', /const APP_BUILD = 'v(1(8\d|9\d)|[2-9]\d\d)'/.test(src));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
