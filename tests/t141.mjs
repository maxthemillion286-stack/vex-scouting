// t141 — v152 (app 2.31): the stream's own score, as a check and never the
// truth. Owner's concern: "it's up to live match scorers and isn't always
// fully accurate or a event might not choose to do live scoring".
import fs from 'fs';
import { boot, settle } from './harness.mjs';
let pass = 0, fail = 0;
const ok = (name, cond, detail) => { if (cond) { pass++; console.log('  ok   ' + name); } else { fail++; console.log('  FAIL ' + name + (detail ? '\n         ' + detail : '')); } };
const src = fs.readFileSync('../src/index.html', 'utf8'), api = fs.readFileSync('../api/tracker.js', 'utf8'), app = fs.readFileSync('../desktop/vex_trainer.py', 'utf8');
console.log('t141 — v152');
const { win } = await boot();
await settle(win);
const flow = win.eval('vtScoreFlow');
const ph = { start: 0, driver: 15, end: 120 };
// Red scores 10 in auto, then 1 point every 3 s; blue 6 in auto, then steadily, with a descore late.
const line = (rs, bs, opts = {}) => {
  const sc = [];
  for (let t = -3; t <= 135; t += 1) {
    let r = t < 0 ? 0 : t < 15 ? Math.min(10, Math.floor(t)) : 10 + Math.floor((Math.min(t, 120) - 15) / 3);
    let b = t < 0 ? 0 : t < 15 ? Math.min(6, Math.floor(t / 2)) : 6 + Math.floor((Math.min(t, 120) - 15) / 2.5);
    if (t >= 100) b -= 5;
    if (opts.glitch && t === 60) r = 999;
    if (opts.blank && t % 2) r = -1;
    sc.push(Math.round(t * 10), r, b);
  }
  return { sc, rs, bs };
};
const good = line(45, 43);
const f = flow(good, ph);
ok('points are split into autonomous and the thirds of driver control', f && f[0][0] === 10 && f[0].reduce((a, b) => a + b, 0) === 45, JSON.stringify(f));
ok('a descore counts against the third it happened in', f && f[1][3] < f[1][2], JSON.stringify(f && f[1]));
ok('a stream score that did not end on the official final is not used', flow(line(46, 43), ph) === null && flow(line(45, 40), ph) === null);
ok('one misread number does not count', (() => { const g = flow(line(45, 43, { glitch: true }), ph); return g && g[0][1] + g[0][2] + g[0][3] === 35; })());
ok('a score that could hardly be read is not used', flow(line(45, 43, { blank: true }), ph) === null);
ok('no live score shown: nothing', flow({ rs: 45, bs: 43 }, ph) === null && flow({ sc: [], rs: 45, bs: 43 }, ph) === null);
ok('no official score yet: nothing', flow({ ...good, rs: null }, ph) === null);
ok('the summary carries it, marked as from a matching stream score', /\.\.\.\(flow \? \{ sl: 1 \} : \{\}\)/.test(src) && /o\.sa = flow\[k\]\[0\]; o\.s1 = flow\[k\]\[1\]/.test(src));
ok('the report shows it with what it rests on', /function vtReportFlow\(F\)/.test(src) && /only from matches where it ended on the official final, since live scoring can be wrong/.test(src) && /fl\.length >= 3/.test(src));
ok('the server takes it, checked', /'sc'[,\]]/.test(api) && /rec\.sc\.length % 3 === 0/.test(api));
ok('the app finds the score from the official final, and forgets a place that stops matching', /def score_spots\(seen, rs, bs, end\):/.test(app) && /learn\['score'\] = None/.test(app) && /if rs is None or bs is None or rs == bs:/.test(app));
ok('every device remakes its matches', /const VT_REMAKE = (15[2-9]|1[6-9]\d);/.test(src));
ok('release is v152 or later', /const APP_BUILD = 'v1(5[2-9]|[6-9]\d)'/.test(src));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
