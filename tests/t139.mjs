// t139 — v150 (app 2.29): unsure boxes carry on missing robots; slots are
// built with the whole match in hand; paths smoothed without lag.
// Asked: "build it all" (from: use faint boxes that continue a path, solve the
// whole match at once, smoothing both ways).
import fs from 'fs';
import { boot, settle } from './harness.mjs';
let pass = 0, fail = 0;
const ok = (name, cond, detail) => { if (cond) { pass++; console.log('  ok   ' + name); } else { fail++; console.log('  FAIL ' + name + (detail ? '\n         ' + detail : '')); } };
const src = fs.readFileSync('../src/index.html', 'utf8'), api = fs.readFileSync('../api/tracker.js', 'utf8'), app = fs.readFileSync('../desktop/vex_trainer.py', 'utf8');
console.log('t139 — v150');
const { win } = await boot();
await settle(win);
const slots = win.eval('vtSlots'), frames = win.eval('vtFrames'), sure = win.eval('vtSure');

// A red robot drives right; from 4 s to 7 s it is behind a goal and the
// finder sees it only faintly. The other three robots stand still.
const mk = weakToo => {
  const F = [];
  for (let k = 0; k <= 48; k++) {
    const t = k / 4, x = 0.1 + 0.06 * t, hidden = t >= 4 && t < 7;
    const pts = [{ x: 0.8, y: 0.2, c: 2 }, { x: 0.8, y: 0.8, c: 2 }, { x: 0.2, y: 0.9, c: 1 }];
    if (!hidden) pts.push({ x, y: 0.4, c: 1 });
    const f = { t, pts };
    if (hidden && weakToo) f.weak = [{ x: x + 0.005, y: 0.405, c: 1, weak: true }, { x: 0.5, y: 0.95, c: 1, weak: true }];
    F.push(f);
  }
  return F;
};
const seenIn = (out, lo, hi) => [0, 1].map(i => out.filter(r => r.t >= lo && r.t < hi && r.s[1][i] && r.s[1][i].seen && Math.abs(r.s[1][i].y - 0.4) < 0.03).length);
const without = seenIn(slots(mk(false)), 4, 7), withWeak = seenIn(slots(mk(true)), 4, 7);
ok('a robot seen only faintly behind a goal is still followed', Math.max(...withWeak) >= 10 && Math.max(...without) === 0, JSON.stringify({ without, withWeak }));
const w = slots(mk(true));
const driving = [0, 1].find(i => w.filter(r => r.s[1][i] && r.s[1][i].x > 0.6).length > 3);
ok('on the same track as before and after', driving !== undefined && w.filter(r => r.t >= 4 && r.t < 7 && r.s[1][driving] && r.s[1][driving].seen).length >= 10);
ok('a faint box somewhere else is not taken for anything', !w.some(r => [0, 1].some(i => r.s[1][i] && r.s[1][i].seen && Math.abs(r.s[1][i].y - 0.95) < 0.01)));

// Faint boxes never start a track of their own.
const ghost = [];
for (let k = 0; k <= 40; k++) ghost.push({ t: k / 4, pts: [{ x: 0.2, y: 0.2, c: 1 }, { x: 0.8, y: 0.8, c: 2 }], weak: [{ x: 0.6, y: 0.3, c: 1, weak: true }] });
const g = slots(ghost);
ok('faint boxes alone never make a robot', !g.some(r => [0, 1].some(i => r.s[1][i] && Math.abs(r.s[1][i].x - 0.6) < 0.02)));

// Recordings: boxes below the threshold go to `weak`, not counted anywhere.
const rec = { v: 2, h: 360, cf: 45, f: [] };
for (let k = 0; k < 60; k++) rec.f.push([k * 2.5, 2, 100, 100, 40, 40, 90, 1, 0, 0, 0, 0, 400, 200, 40, 40, 30, 2, 0, 0, 0, 0]);
const fr = frames(rec, null, {});
ok('unsure boxes in a recording are kept apart', fr.frames.every(f => f.pts.length === 1 && f.weak && f.weak.length === 1));
ok('and never counted as robots seen', win.eval('vtRecStats')(rec).blue === 0 && win.eval('vtRecStats')(rec).red === 60);
ok('older recordings (no threshold) are read as before', frames({ ...rec, cf: undefined }, null, {}).frames.every(f => f.pts.length === 2 && !f.weak));
ok('a box is sure unless below the threshold', sure(rec, rec.f[0], 2) && !sure(rec, rec.f[0], 12) && sure({ v: 2 }, rec.f[0], 12));

// Whole match: a short stray piece that would need a robot to cross the field
// in a blink is left out instead of being put in a slot.
const stray = [];
for (let k = 0; k <= 80; k++) {
  const t = k / 4, pts = [{ x: 0.2 + 0.01 * t, y: 0.3, c: 1 }, { x: 0.3, y: 0.7 + 0.005 * t, c: 1 }, { x: 0.9, y: 0.5, c: 2 }, { x: 0.9, y: 0.1, c: 2 }];
  stray.push({ t, pts });
}
// The first robot vanishes for 1.5 s and a short piece appears far away then, as if it had jumped there.
for (const f of stray) if (f.t >= 10 && f.t < 11.5) { f.pts.splice(0, 1); f.pts.push({ x: 0.95, y: 0.95, c: 1 }); }
const so = slots(stray);
ok('a short piece that would mean teleporting is left out', !so.some(r => [0, 1].some(i => r.s[1][i] && r.s[1][i].seen && r.s[1][i].x > 0.9)), JSON.stringify(so.filter(r => r.t >= 10 && r.t < 11.5).map(r => r.s[1].map(p => p && p.x.toFixed(2)))));

// Smoothing: wobble comes out, a quick move does not lag.
const wob = [];
for (let k = 0; k <= 40; k++) { const t = k / 4; wob.push({ t, pts: [{ x: (t < 5 ? 0.3 : 0.6) + (k % 2 ? 0.008 : -0.008), y: 0.5, c: 1 }, { x: 0.9, y: 0.9, c: 2 }] }); }
const wo = slots(wob), path = wo.map(r => r.s[1][0] || r.s[1][1]).filter(p => p && p.seen);
const still = path.filter(p => p.t >= 1 && p.t <= 4).map(p => p.x), spread = Math.max(...still) - Math.min(...still);
ok('a box\'s wobble is smoothed out', spread < 0.012, spread.toFixed(4));
const after = path.find(p => p.t === 5);
ok('a quick move is not dragged behind', after && after.x > 0.58, JSON.stringify(after));

ok('the app records unsure boxes, marked', /unsure = sorted\(\(b for b in every if PROPOSE <= b\[4\] < cut and robot_like\(b\) and all\(iou\(b, k\) < 0\.3 for k in boxes\)\)/.test(app) && /rec\['cf'\] = cf/.test(app));
ok('the server takes the threshold, checked', /'cf'[,\]]/.test(api) && /rec\.cf >= 1 && rec\.cf <= 100/.test(api));
ok('the fastest normal drive is the limit', /600 rpm on 2\.75 in wheels, is 7\.2 ft\/s/.test(src));
ok('every device remakes its matches', /const VT_REMAKE = (1[5-9]\d);/.test(src));
ok('app 2.29 or later', /VERSION = '2\.(29|[3-9]\d)'/.test(app));
ok('release is v150 or later', /const APP_BUILD = 'v1([5-9]\d)'/.test(src));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
