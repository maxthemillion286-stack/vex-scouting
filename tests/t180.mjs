// t180 — v201 (app 2.59): end-of-match read, score jumps matched to the pins
// seen going on (the display is late or missing), autonomous from clear matches.
import fs from 'fs';
import { boot, settle } from './harness.mjs';
let pass = 0, fail = 0;
const ok = (name, cond, detail) => { if (cond) { pass++; console.log('  ok   ' + name); } else { fail++; console.log('  FAIL ' + name + (detail ? '\n         ' + detail : '')); } };
const src = fs.readFileSync('../src/index.html', 'utf8'), api = fs.readFileSync('../api/tracker.js', 'utf8'), app = fs.readFileSync('../desktop/vex_trainer.py', 'utf8');
console.log('t180 — v201');
const { win } = await boot();
await settle(win);
const J = win.eval('vtScoreJumps'), Share = win.eval('vtEndShare'), Read = win.eval('vtEndRead'), Facts = win.eval('vtAutoFacts'), Clear = win.eval('vtClearOf');
const ph = { start: 0, driver: 15, end: 120 };
// Robot red 0 stands at a goal (0.17, 0.66) the whole match; red 1 elsewhere.
const track = [];
for (let t = 0; t <= 130; t++) track.push({ t, s: { 1: [{ x: 0.17, y: 0.66 }, { x: 0.5, y: 0.9 }], 2: [null, null] } });
const sc = (pts) => { const a = []; for (let t = 0; t <= 130; t++) { const v = pts.filter(p => p[0] <= t).reduce((m, p) => p[1], 0); a.push(t * 10, v, 0); } return a; };
// The display went up by 5 at 60 s, fifteen seconds late; the camera saw red 1 put pins on at 46 s.
const rec = { sc: sc([[60, 5]]) };
const evs = [[46, 1, 1, 1]];
const a = J(rec, track, ph, evs, [5, 0]);
ok('a late score jump goes to the robot the camera saw scoring, not the one near a goal when it changed', a && a[1][1].p === 5 && a[1][0].p === 0, JSON.stringify(a && a[1]));
const b = J(rec, track, ph, [], [5, 0]);
ok('with no pins seen, closeness to a goal still decides', b && b[1][0].p === 5, JSON.stringify(b && b[1]));
ok('a display that never moved is not used', J({ sc: sc([]) }, track, ph, evs, [40, 0]) === null);
ok('a display far from the official final is not used', J(rec, track, ph, evs, [60, 0]) === null);
const c = J({ sc: sc([[18, 10]]) }, track, ph, [[12, 1, 0, 2]], [10, 0]);
ok('a jump shown after autonomous for pins set down in it counts as autonomous', c && c[1][0].a === 10, JSON.stringify(c && c[1]));
// The end-of-match read.
const r1 = { as: 4 }, r2 = { as: 2 };
Share([{ r: r1, d: 4 }, { r: r2, d: 2 }], 3, 'as');
ok('halves short of the end read are shared among those seen scoring there', Math.abs(r1.as - 6) < 1e-9 && Math.abs(r2.as - 3) < 1e-9, JSON.stringify([r1, r2]));
const r3 = { as: 4 }; Share([{ r: r3, d: 4 }], 0.5, 'as');
ok('under a half of difference changes nothing', r3.as === 4);
const ge = [1200]; for (let k = 0; k < 13; k++) ge.push(k, -1, 2, 0);
const E = Read({ ge }, 13);
ok('the end read is read per goal and colour', E && E[3][0] === 3 && E[3][1] === null && E[3][2] === 2);
ok('a clear credit: no other robot near', Clear(track, 0.17, 0.66, 10, 1, 1, 0, 8) === true && Clear(track, 0.5, 0.9, 10, 1, 1, 1, 8) === true && Clear(track, 0.33, 0.78, 10, 1, 1, 0, 8) === false);
// Autonomous: two clear matches of 4 pins, one where it was not clear (2 halves seen).
const F = Facts([{ ya: 8, yac: 1 }, { ya: 8, yac: 0.9 }, { ya: 2, yac: 0.2 }], 1, null);
ok('a match where autonomous was not seen clearly takes the clear ones\' usual', JSON.stringify(F.each) === '[4,4,4]' && F.pattern === 2, JSON.stringify(F.each));
ok('with fewer than two clear matches nothing is changed', JSON.stringify(Facts([{ ya: 8, yac: 1 }, { ya: 2, yac: 0.2 }], 1, null).each) === '[4,1]');
ok('the server keeps the end read', /'ge', 'pe'\]/.test(api) && /rec\.ge\.length === 53/.test(api));
ok('the app reads the end of the match', /def end_read_pack\(end_t, looks, S\):/.test(app) && /rec\['ge'\] = end_read_pack/.test(app) && /END_READ_SEC, END_READ_EVERY, END_GUESS = 8, 0\.5, 127/.test(app));
ok('summaries are made again', /const VT_REMAKE = 2(0[1-9]|[1-9]\d)/.test(src));
ok('app 2.59 or later', /VERSION = '2\.(59|[6-9]\d)'/.test(app));
ok('release is v201 or later', /const APP_BUILD = 'v(20[1-9]|2[1-9]\d)'/.test(src));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
