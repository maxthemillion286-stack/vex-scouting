// t126 — v136: pins counted on the goals.
//
// The owner: "pins and cups can also only be scored in set spots" (then
// "build"). Pins counted wherever they appear on the field ran high against
// official scores: a pin on the floor or carried past scores nothing. Now
// they are also counted in a column on each of the nine goals, and each
// event's reports use whichever count is closer to the official scores.
import fs from 'fs';
import { boot, settle } from './harness.mjs';
import { validSum } from '../api/tracker.js';
let pass = 0, fail = 0;
const ok = (name, cond, detail) => { if (cond) { pass++; console.log('  ok   ' + name); } else { fail++; console.log('  FAIL ' + name + (detail ? '\n         ' + detail : '')); } };
const src = fs.readFileSync('../src/index.html', 'utf8');
console.log('t126 — v136');
const { win } = await boot();
await settle(win);
const f = n => win.eval(n);
// A field seen straight from above, filling the middle of a 16:9 picture.
const Q = [0.2265625, 0.1111111111111111, 0.7734375, 0.1111111111111111, 0.7734375, 0.8888888888888888, 0.2265625, 0.8888888888888888];
{
  const cols = f('vtGoalColumns')(Q, 0, 16 / 9);
  ok('nine goal columns', cols.length === 9 && cols.every(Boolean));
  const c = cols[8];
  ok('the centre goal stands in the middle of the picture', Math.abs(c.x - 0.5) < 0.01 && Math.abs(c.y - 0.5) < 0.01, JSON.stringify(c));
  ok('red\'s goals are on the left when red is not turned', cols[0].x < 0.5 && cols[1].x < 0.5 && cols[2].x > 0.5 && cols[3].x > 0.5);
  const turned = f('vtGoalColumns')(Q, 2, 16 / 9);
  ok('and on the right when the picture is turned round', turned[0].x > 0.5 && Math.abs(turned[0].x - (1 - cols[0].x)) < 1e-6);
  const W = 960, H = 540, g = cols[0], at = (dx, dy) => ({ x: Math.round((g.x + dx) * W), y: Math.round((g.y + dy) * H) });
  const look = f('vtGoalLook');
  const up = { ...at(0, 0), w: 6, h: 14, area: 70, c: 3 }, high = { ...at(0, -g.up * 0.6), w: 6, h: 14, area: 70, c: 1 };
  const flat = { ...at(0, -0.02), w: 16, h: 5, area: 70, c: 3 }, far = { ...at(0.15, 0), w: 6, h: 14, area: 70, c: 3 }, low = { ...at(0, g.down * 4), w: 6, h: 14, area: 70, c: 3 };
  const r = look([up, high, flat, far, low], cols, W, H);
  ok('an upright half on the goal is counted', r[3][0] > 0.3, String(r[3][0]));
  ok('so is one higher up the stack, in its colour', r[1][0] > 0.3);
  ok('one lying flat is not', look([flat], cols, W, H)[3].every(v => v === 0));
  ok('nor one away from any goal, nor one below the goal\'s foot', look([far, low], cols, W, H).slice(1).every(a => a.every(v => v === 0)));
}
// The pins fixture: the app's recording of a match with pins set down.
{
  const fx = JSON.parse(fs.readFileSync('./fixtures/pins_rec.json', 'utf8'));
  win.__r126 = fx.rec; win.__q126 = { q: fx.quad, by: 'click' };
  const s = win.eval('vtSummarise(__r126, __q126, null)');
  ok('a summary carries both counts', s.pk > 0 && s.gk === s.pk && s.gy !== undefined && s.Ra.oy !== undefined && s.Ra.ys !== undefined, JSON.stringify([s.py, s.gy, s.pk, s.gk]));
  ok('the goal count is never more than the field count by much', s.gy <= s.py + 1 && s.gr <= s.pr + 1 && s.gb <= s.pb + 1, JSON.stringify([s.py, s.gy, s.pr, s.gr, s.pb, s.gb]));
  ok('the server takes it', validSum(JSON.parse(JSON.stringify(s))) === null);
  // Every pin lying flat: the field still counts them, the goals do not.
  const flat = JSON.parse(JSON.stringify(fx.rec)), a = flat.pn;
  for (let i = 0; i + 1 < a.length;) { const n = a[i + 1]; for (let k = 0; k < n; k++) { const o = i + 2 + 6 * k; a[o + 2] = Math.max(a[o + 2], 3 * a[o + 3]); } i += 2 + 6 * n; }
  win.__r126b = flat;
  const s2 = win.eval('vtSummarise(__r126b, __q126, null)');
  ok('pins lying flat count nowhere on the goals', (s2.gy || 0) + (s2.gr || 0) + (s2.gb || 0) < 0.5 && s2.py + s2.pr + s2.pb > 1, JSON.stringify([s2.py, s2.pr, s2.pb, s2.gy, s2.gr, s2.gb]));
}
// ── which count a report uses ──
{
  const P = f('vtPinPick');
  const mk = (i, field, goal, official) => ['900:' + i, { ok: 1, sv: 1, rs: official, bs: 0, pk: 50, py: field / 10, pr: 0, pb: 0, gk: 50, gy: goal / 10, gr: 0, gb: 0,
    Ra: { ys: field / 10, oy: goal / 10, k10: 40, n10: 15 }, Rb: {}, Ba: {}, Bb: {} }];
  // Officially 112 + 12 bonus a match; the field counted ~280, the goals ~110.
  const FV = [230, 280, 330, 250, 310], GV = [108, 113, 110, 116, 111];
  const close = new Map([1, 2, 3, 4, 5].map(i => mk(i, FV[i - 1], GV[i - 1], 124)));
  const got = P(close);
  ok('the goal count is used when it is closer to the official scores', got.pinsFrom === 'goals' && got.get('900:1').Ra.ys === close.get('900:1').Ra.oy && got.get('900:1').Ra.k10 === 15 && got.get('900:1').py === close.get('900:1').gy);
  ok('the original summaries are left alone', close.get('900:1').Ra.ys !== close.get('900:1').Ra.oy);
  ok('the report says so', /Counted on the goals/.test(f('vtPinCheckText')(f('vtPinCheck')(got))));
  const BAD = [40, 300, 90, 200, 60];
  const worse = new Map([1, 2, 3, 4, 5].map(i => mk(i, [110, 118, 113, 108, 115][i - 1], BAD[i - 1], 124)));
  ok('the field count stays when the goal count is further off', P(worse) === worse);
  const old = new Map([1, 2, 3, 4, 5].map(i => { const [k, s] = mk(i, 112, 112, 124); delete s.gk; return [k, s]; }));
  ok('summaries from before have no goal count and are left as they were', P(old) === old);
  const two = new Map([...close, ...[1, 2, 3, 4, 5].map(i => { const [k, s] = mk(i, [110, 118, 113, 108, 115][i - 1], BAD[i - 1], 124); return ['901:' + i, s]; })]);
  const g2 = P(two);
  ok('each event is decided on its own', g2.goalEvents.has('900') && !g2.goalEvents.has('901') && g2.get('901:1').Ra.ys === two.get('901:1').Ra.ys && g2.get('900:1').Ra.ys === two.get('900:1').Ra.oy);
  ok('it is applied where a team\'s matches are fetched', /return vtPinPick\(out\);/.test(src) && /for \(const \[n, m\] of out\) out\.set\(n, vtPinPick\(m\)\);/.test(src));
  ok('every device remakes older summaries for it', /const VT_REMAKE = 1(3[6-9]|[4-9]\d);/.test(src));
}
ok('release is v136 or later', /const APP_BUILD = 'v1[3-9]\d'/.test(src) && !/const APP_BUILD = 'v13[0-5]'/.test(src));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
