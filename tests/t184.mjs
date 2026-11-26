// t184 — v205: the game's rules, checked against the Override manual.
import fs from 'fs';
import { boot, settle } from './harness.mjs';
let pass = 0, fail = 0;
const ok = (name, cond, detail) => { if (cond) { pass++; console.log('  ok   ' + name); } else { fail++; console.log('  FAIL ' + name + (detail ? '\n         ' + detail : '')); } };
const src = fs.readFileSync('../src/index.html', 'utf8');
console.log('t184 — v205');
const { win } = await boot();
await settle(win);
const Key = win.eval('tRankKey'), Climb = win.eval('tClimb'), Exact = win.eval('vtExact');
// <T13>: averages per match played.
const a = { wins: 4, losses: 0, ties: 0, wp: 8, ap: 20, sp: 100 }, b = { wins: 4, losses: 2, ties: 0, wp: 9, ap: 30, sp: 200 };
ok('ranked on Win Points a match, not in total: 4–0 is ahead of 4–2 with an AWP', Key(a)[0] === 2 && Key(b)[0] === 1.5);
ok('averages given by RobotEvents read as averages', Key({ wins: 4, losses: 2, ties: 0, wp: 1.5, ap: 5, sp: 33.3 })[0] === 1.5);
const rows = [
  { team: { id: 1, name: 'A' }, rank: 1, wins: 3, losses: 0, ties: 0, wp: 6, ap: 30, sp: 90 },
  { team: { id: 2, name: 'B' }, rank: 2, wins: 4, losses: 2, ties: 0, wp: 8, ap: 30, sp: 90 },
];
const c = Climb(rows, 2);
ok('the climb counts a team with fewer matches by its average', c && c.now === 2, JSON.stringify(c));
// AP is autonomous points, not AWPs; an AWP says nothing of autonomous wins.
ok('Autonomous Points are not read as AWPs', !/rankingAwpCount \+= r\.ap/.test(src) && /rankingApTotal \/ 10 \/ totalRankedMatches/.test(src) && !/won auton in every match they earned AWP/.test(src));
// <SG9>: nobody touches the other alliance's own goals.
ok('only an alliance\'s robots are credited on its own goals', /const only = sp\.g === 0 \|\| sp\.g === 1 \? 1 : sp\.g === 2 \|\| sp\.g === 3 \? 2 :/.test(src));
// <SC5>: unowned yellow scores nothing; the fit does not cut it from the robots' pins.
const S = { ok: 1, pk: 30, rs: 42, bs: 0, Ra: { as: 6, ys: 6 }, Rb: { as: 0, ys: 0 }, Ba: { as: 0, ys: 0 }, Bb: { as: 0, ys: 0 } };
const x = Exact(S);
ok('yellow seen but not in the score stays the robots\' (it was unowned)', x && Math.abs(x.R - 1) < 1e-9, JSON.stringify(x));
ok('release is v205 or later', /const APP_BUILD = 'v(20[5-9]|2[1-9]\d)'/.test(src));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
