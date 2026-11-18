// t130 — v140: pins and cups counted on the goals and loaders by the app's
// trained finder. The owner: "it doesnt need to track stuff on the field only
// in the goals for pin and cups. maybe matchloader too to count matchload
// speeds." The app sends `gs`: per second, for 13 spots, red/blue/yellow
// halves and cups.
import fs from 'fs';
import { boot, settle } from './harness.mjs';
import { validRec } from '../api/tracker.js';
let pass = 0, fail = 0;
const ok = (name, cond, detail) => { if (cond) { pass++; console.log('  ok   ' + name); } else { fail++; console.log('  FAIL ' + name + (detail ? '\n         ' + detail : '')); } };
const src = fs.readFileSync('../src/index.html', 'utf8'), app = fs.readFileSync('../desktop/vex_trainer.py', 'utf8');
console.log('t130 — v140');
const { win } = await boot();
await settle(win);
const f = n => win.eval(n);
const S = 13;
// A match: driver control from 15 s, ends at 120 s. Looks every second.
const ph = { start: 0, driver: 15, end: 120 };
// counts(t) → 13 × [r, b, y, cups]
const build = counts => { const gs = []; for (let t = 0; t <= 124; t++) { gs.push(t * 10); for (const c of counts(t)) gs.push(...c); } return gs; };
const empty = () => Array.from({ length: S }, () => [0, 0, 0, 0]);
// Red robot A parks at red's first goal (0.17, 0.66) from 20 s and stacks a yellow half every 4 s from 30 s (8 halves) and a cup at 40 s;
// red robot B sits at red's top-left loader (0.02, 0.02) taking a piece every 3 s from 60 to 75 s.
const at = (x, y) => ({ x, y, seen: true });
const track = [];
for (let t = 0; t <= 124; t += 0.5) track.push({ t, s: { 1: [t >= 20 ? at(0.18, 0.68) : at(0.1, 0.5), t >= 55 && t <= 80 ? at(0.05, 0.06) : at(0.3, 0.4)], 2: [at(0.8, 0.5), at(0.9, 0.9)] } });
const counts = t => {
  const c = empty();
  c[0][2] = Math.max(0, Math.min(8, Math.floor((t - 30) / 4) + 1));
  if (t >= 40) c[0][3] = 1;
  c[9][3] = Math.max(0, 10 - Math.max(0, Math.floor((t - 60) / 3) + 1));     // ten cups in the loader, one out every 3 s from 60 s
  c[9][3] = t < 60 ? 10 : Math.max(5, c[9][3]);
  if (t === 50 || t === 51) c[0][2] = 0;                                        // a robot in front for two looks
  c[12] = [-1, -1, -1, -1];                                                      // a loader off the picture
  return c;
};
const rec = { gs: build(counts) };
ok('the server takes it', !validRec({ v: 2, name: 'Q1', red: ['1A', '2A'], blue: ['3A', '4A'], vid: 'abcdefghijk', off: 0, rate: 4, w: 640, h: 360, f: [[0, 0]], tm: [], pn: [], tg: [], gs: rec.gs }));
ok('but not a broken one', validRec({ v: 2, name: 'Q1', red: [], blue: [], vid: 'abcdefghijk', off: 0, rate: 4, w: 640, h: 360, f: [[0, 0]], tm: [], pn: [], tg: [], gs: [1, 2, 3] }) === 'bad goal counts');
const Z = f('vtSpotCount')(rec, 0, track, ph);
const A = Z.robots[1][0], B = Z.robots[1][1];
ok('the robot at the goal gets its eight yellow halves', A.ys === 8 && A.as === 0, JSON.stringify(A));
ok('and the cup', A.cp === 1);
ok('two looks hidden behind a robot change nothing', A.kn === 0 && A.ys === 8);
ok('a pin every 4 s while stacking, timed', A.cy === 8, String(A.cy));
ok('the robot at its loader took five pieces', B.ld === 5, JSON.stringify(B));
ok('one every 3 s', B.lds === 3, String(B.lds));
ok('the other alliance gets none of it', Z.robots[2].every(r => r.ys + r.as + r.cp + r.ld === 0));
ok('what is on the goals at the end: 8 yellow halves, 1 cup', Z.py === 8 && Z.pr === 0 && Z.cups === 1, JSON.stringify([Z.py, Z.pr, Z.pb, Z.cups]));
ok('yellow by quadrant for the toggles to share out', Z.yq.reduce((a, b) => a + b, 0) === 8);
// The same match seen with the field turned round: spot 0 is then blue's corner of the picture; positions follow.
const T2 = track.map(b => ({ t: b.t, s: b.s }));
const Z2 = f('vtSpotCount')(rec, 2, T2.map(b => ({ t: b.t, s: { 1: b.s[1].map(p => p && { ...p, x: 1 - p.x, y: 1 - p.y }), 2: b.s[2] } })), ph);
ok('turned round, the same goal is found again', Z2.robots[1][0].ys === 8, JSON.stringify(Z2.robots[1][0]));
// A blip: one look of 3 extra halves, then back.
const blip = { gs: build(t => { const c = empty(); if (t === 70) c[4][2] = 3; return c; }) };
ok('a single odd look is not a pin', f('vtSpotCount')(blip, 0, track, ph).robots[1].every(r => r.ys === 0));
ok('too few looks: nothing', f('vtSpotCount')({ gs: rec.gs.slice(0, 53 * 5) }, 0, track, ph) === null);
// ── into the summary and the report ──
ok('the summary takes it in place of the colour count on the goals, with cups and loads', /const Z = rec\.gs && rec\.gs\.length \? vtSpotCount\(rec, turnK, track, ph\) : null;/.test(src) && /row\.cp = r1\(q\.cp\); row\.kn = r1\(q\.kn\); row\.ld = q\.ld;/.test(src));
const L = f('vtPinLine')([{ ys: 4, cy: 9, k10: 30, cp: 2 }, { ys: 4, cy: 9, k10: 34, cp: 1 }], null, true, null);
ok('the Scoring line gains cups', /· 1\.5 cups ·/.test(L.short), L.short);
ok('a Match loads line', /\['Match loads', b\.load\]/.test(src) && /a match\$\{gaps\.length \? ` · one every/.test(src));
ok('every device remakes older summaries', /const VT_REMAKE = 1(4\d|[5-9]\d);/.test(src));
// ── the app ──
ok('the app looks only at goal and loader spots', /SPOTS = \[/.test(app) && /def spot_boxes\(W, H, q(, placed=None)?\):/.test(app) && /def find_spots\(self, frame, spots\):/.test(app));
ok('the same 13 spots, in the same order, on both sides', (() => { const m = [...app.slice(app.indexOf('SPOTS = ['), app.indexOf('N_GOALS')).matchAll(/\((0\.\d+), (0\.\d+), 0\.\d+, 0\.\d+, 0\.\d+\)/g)].map(x => [+x[1], +x[2]]); const w = f('VT_SPOTS_RAW'); return m.length === 13 && m.every((p, k) => p[0] === w[k][0] && p[1] === w[k][1]); })());
ok('it trains on the spots cut out and enlarged', /cv2\.imwrite\(os\.path\.join\(root, 'images', part, stem \+ '\.jpg'\), frame\[y0:y1, x0:x1\]/.test(app) && /PIECE_SIZE, PIECE_NEED, PIECE_CONF = 320, 60/.test(app));
ok('it counts every second once in use', /if eyes\.pieces is not None and quad and t >= spot_at \+ 1/.test(app) && /rec\['gs'\] \+= /.test(app));
ok('review shows the spots and only asks for what is in them', /strokeStyle='#ffd23f';for\(const s of cur\.spots/.test(app) && /pieces_from_colour\(frame, robots, spots\)/.test(app));
ok('release is v140 or later', /const APP_BUILD = 'v1[4-9]\d'/.test(src));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
