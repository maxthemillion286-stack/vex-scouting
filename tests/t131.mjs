// t131 — v141: the goals and loaders are dragged onto the real ones.
// Reported with a picture: "these are very clearly not the goals..." —
// worked out from four hand-clicked corners and the manual's drawing, the
// goal columns landed beside the goals.
import fs from 'fs';
import { boot, settle } from './harness.mjs';
let pass = 0, fail = 0;
const ok = (name, cond, detail) => { if (cond) { pass++; console.log('  ok   ' + name); } else { fail++; console.log('  FAIL ' + name + (detail ? '\n         ' + detail : '')); } };
const src = fs.readFileSync('../src/index.html', 'utf8'), api = fs.readFileSync('../api/tracker.js', 'utf8'), app = fs.readFileSync('../desktop/vex_trainer.py', 'utf8');
console.log('t131 — v141');
const { win } = await boot();
await settle(win);
const f = n => win.eval(n);
const Q = [0.2156, 0.2112, 0.8, 0.2112, 0.8594, 0.767, 0.0625, 0.7837];
const g = Array.from({ length: 18 }, (_, i) => 0.1 + 0.04 * i), l = [0.05, 0.1, 0.95, 0.1, 0.97, 0.9, 0.03, 0.9];
// saving keeps them; marking only the corners again keeps them too
await f('vtFieldSet')('abcdefghijk', Q, 'click', { g, l });
let F = (await f('vtFieldsLocal')())['abcdefghijk'];
ok('the goals and loaders are saved with the corners', F.g.length === 18 && F.l.length === 8 && Math.abs(F.g[0] - 0.1) < 1e-9);
await f('vtFieldSet')('abcdefghijk', Q.map(v => v + 0.001), 'click');
F = (await f('vtFieldsLocal')())['abcdefghijk'];
ok('marking the corners again keeps them', F.g && F.g.length === 18 && Math.abs(F.q[0] - 0.2166) < 1e-6);
ok('the server takes them, and checks them', /pts\(f\.g, 9\)/.test(api) && /pts\(f\.l, 4\)/.test(api) && /\.\.\.\(f\.g \? \{ g: f\.g \} : \{\}\)/.test(api));
// the colour count's goal columns stand where the goals were placed
const placed = [];
f('VT_SPOTS_RAW').slice(0, 9).forEach((p, k) => placed.push(0.12 + 0.08 * k, 0.4 + 0.02 * k));
const plain = f('vtGoalColumns')(Q, 0, 16 / 9), moved = f('vtGoalColumns')(Q, 0, 16 / 9, placed);
ok('a placed goal\'s column stands on it', Math.abs(moved[0].x - placed[0]) < 1e-9 && Math.abs(moved[0].y - placed[1]) < 1e-9);
ok('its size still comes from the field', Math.abs(moved[0].scale - plain[0].scale) < 1e-6);
const turned = f('vtGoalColumns')(Q, 2, 16 / 9, placed);
ok('turned round, each goal still finds its own placed spot', turned.every(c => placed.some((v, i) => i % 2 === 0 && Math.abs(c.x - v) < 1e-9)));
ok('placing is the second step of marking the field', /vtMarkSpots\(lay, String\(cal\.videoId\), pts, String\(ctx\.eventId\)\);/.test(src) && /vtMarkSpots\(lay, String\(cal\.videoId\), guess\.q, String\(ctx\.eventId\)\);/.test(src));
ok('circles to drag, yellow for goals and pink for loaders, with Done and Skip', /drag each circle onto the bottom of its real one/.test(src) && /id="vtSpotsDone"/.test(src) && /id="vtSpotsSkip"/.test(src) && /svg\.onpointermove/.test(src));
ok('the app looks exactly where they were placed', /def spot_boxes\(W, H, q, placed=None\):/.test(app) && /spot_boxes\(frame\.shape\[1\], frame\.shape\[0\], quad, placed_for\(job\['vid'\]\)\)/.test(app) && /_QUADS\[job\['vid'\]\] = \{'q': quads\[job\['vid'\]\], 'g': fld\.get\('g'\), 'l': fld\.get\('l'\)(, 'at': time\.time\(\))?\}/.test(app));
ok('and asks the website again after ten minutes, in case they were placed since', /time\.time\(\) - f\.get\('at', 0\) < 600/.test(app));
ok('placing the goals redoes the summaries from that stream', f('vtQuadMark')({ q: Q, by: 'click' }) !== f('vtQuadMark')({ q: Q, by: 'click', g }));
ok('release is v141 or later', /const APP_BUILD = 'v1(4[1-9]|[5-9]\d)'/.test(src));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
