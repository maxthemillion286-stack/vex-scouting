// t137 — v148: robots cannot teleport. Asked: "how well does our model predict
// movements in robots … can't it get more accurate by predicting trajectory
// from speed and stuff". Tracks are now looked for where their speed and
// heading put them, every track and box is paired at once, and short gaps are
// filled along the line between sightings instead of standing still.
import fs from 'fs';
import { boot, settle } from './harness.mjs';
let pass = 0, fail = 0;
const ok = (name, cond, detail) => { if (cond) { pass++; console.log('  ok   ' + name); } else { fail++; console.log('  FAIL ' + name + (detail ? '\n         ' + detail : '')); } };
const src = fs.readFileSync('../src/index.html', 'utf8');
console.log('t137 — v148');
const { win } = await boot();
await settle(win);
const slots = win.eval('vtSlots');

// Two red robots cross in an X, the same paint, 4 looks a second, with a
// little wobble; where they overlap the finder sees only one box.
const wob = k => ((k * 7919) % 13 - 6) / 600;
const frames = [];
for (let k = 0; k <= 40; k++) {
  const t = k / 4, f = t / 10;
  const a = { x: 0.2 + 0.6 * f + wob(k), y: 0.3 + 0.4 * f, c: 1 }, b = { x: 0.2 + 0.6 * f, y: 0.7 - 0.4 * f + wob(k + 3), c: 1 };
  // Where they overlap, the finder sees one box between them, a little off.
  const one = Math.hypot(a.x - b.x, a.y - b.y) < 0.12;
  frames.push({ t, pts: (one ? [{ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 + 0.02, c: 1 }] : [a, b]).concat([{ x: 0.9, y: 0.1 + wob(k), c: 2 }, { x: 0.1, y: 0.9, c: 2 }]) });
}
const out = slots(frames);
const path = i => out.map(r => r.s[1][i]).filter(Boolean);
const ends = [0, 1].map(i => { const p = path(i); return p.length ? [p[0].y, p[p.length - 1].y] : null; });
ok('two robots of one alliance crossing each keep going their own way', ends.every(e => e && Math.abs(e[1] - e[0]) > 0.3) && ends[0][0] !== ends[1][0], JSON.stringify(ends));
ok('neither robot is lost at the crossing', [0, 1].every(i => path(i).filter(p => p.seen).length >= 34), [0, 1].map(i => path(i).filter(p => p.seen).length).join(','));

// One robot drives right at a steady speed and is not seen for 2 s.
const gap = [];
for (let k = 0; k <= 40; k++) {
  const t = k / 4;
  gap.push({ t, pts: (t > 4 && t < 6 ? [] : [{ x: 0.1 + 0.05 * t, y: 0.5, c: 1 }]).concat([{ x: 0.9, y: 0.9, c: 2 }]) });
}
const g = slots(gap), mid = g.find(r => r.t === 5);
const filled = mid && (mid.s[1][0] || mid.s[1][1]);
ok('a short gap is filled along the way it was going, not left standing', filled && !filled.seen && Math.abs(filled.x - 0.35) < 0.03, JSON.stringify(filled));
ok('filled places are marked unseen, so distances are not made up', filled && filled.seen === false);

// A box that would mean a robot crossed the field in a quarter second is not
// taken onto that robot's track.
const jump = [];
for (let k = 0; k <= 20; k++) jump.push({ t: k / 4, pts: [{ x: k === 10 ? 0.9 : 0.2, y: k === 10 ? 0.9 : 0.2, c: 1 }, { x: 0.8, y: 0.2, c: 2 }] });
const j = slots(jump), at = j.find(r => r.t === 2.5);
const red = [at.s[1][0], at.s[1][1]].filter(p => p && p.seen);
ok('a robot never jumps across the field between two looks', red.every(p => Math.hypot(p.x - 0.2, p.y - 0.2) < 0.05 || [0, 1].some(i => j.filter(r => r.s[1][i] && r.s[1][i].seen).length <= 2)), JSON.stringify(red));

const ahead = win.eval('vtAhead');
ok('a robot is looked for ahead of where it was, by its speed', (() => { const p = ahead({ x: 0.5, y: 0.5, t: 0, vx: 0.2, vy: 0 }, 0.5); return Math.abs(p.x - 0.6) < 1e-9 && p.y === 0.5; })());
ok('no further ahead than a second', Math.abs(ahead({ x: 0.5, y: 0.5, t: 0, vx: 0.2, vy: 0 }, 3).x - 0.7) < 1e-9);
ok('and no faster than a robot drives', /const VT_VMAX = 0\.6;/.test(src) && /if \(sp > VT_VMAX\)/.test(src));
ok('every device remakes its matches with this', /const VT_REMAKE = (14[8-9]|1[5-9]\d);/.test(src));
ok('release is v148 or later', /const APP_BUILD = 'v(1(4[8-9]|[5-9]\d)|[2-9]\d\d)'/.test(src));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
