// t154 — v168 (app 2.43): positions mapped through the camera's lens. Asked
// for: "straighten the camera lens". The lens is worked out by the app
// (desktop/dev/lens.py: a real frame bent by known amounts, found again).
import fs from 'fs';
import { boot, settle } from './harness.mjs';
let pass = 0, fail = 0;
const ok = (name, cond, detail) => { if (cond) { pass++; console.log('  ok   ' + name); } else { fail++; console.log('  FAIL ' + name + (detail ? '\n         ' + detail : '')); } };
const src = fs.readFileSync('../src/index.html', 'utf8'), api = fs.readFileSync('../api/tracker.js', 'utf8'), app = fs.readFileSync('../desktop/vex_trainer.py', 'utf8');
console.log('t154 — v168');
const { win } = await boot();
await settle(win);
const map = win.eval('vtFieldMap'), undo = win.eval('vtLensUndo'), homo = win.eval('vtHomography');
const q = [0.066, 0.80, 0.86, 0.78, 0.81, 0.21, 0.21, 0.21], ka = 9 / 16, k = 0.12;
// The same field seen through a lens: its corners where the lens puts them.
const lensDo = (x, y) => { let xd = x, yd = y; for (let i = 0; i < 12; i++) { const nx = (xd - 0.5) * 2, ny = (yd - 0.5) * 2 * ka, s = 1 + k * (nx * nx + ny * ny); xd = 0.5 + (x - 0.5) / s; yd = 0.5 + (y - 0.5) / s; } return [xd, yd]; };
const qb = []; for (let i = 0; i < 8; i += 2) qb.push(...lensDo(q[i], q[i + 1]));
const f = map({ q: qb, k, ka }), plain = map({ q }), h = homo(q);
ok('without a lens it maps as before', plain(0.4, 0.5).every((v, i) => Math.abs(v - h(0.4, 0.5)[i]) < 1e-12));
const pts = [[0.3, 0.6], [0.5, 0.4], [0.75, 0.7]];
ok('a point seen through the lens lands where the same point without it does', pts.every(([x, y]) => { const [xd, yd] = lensDo(x, y), a = f(xd, yd), b = h(x, y); return Math.abs(a[0] - b[0]) < 1e-4 && Math.abs(a[1] - b[1]) < 1e-4; }));
ok('mapping it as if there were no lens would put it elsewhere', pts.some(([x, y]) => { const [xd, yd] = lensDo(x, y), a = homo(qb)(xd, yd), b = h(x, y); return Math.hypot(a[0] - b[0], a[1] - b[1]) > 0.005; }));
ok('every position the tracker maps goes through it', /const toField = quad && quad\.q \? vtFieldMap\(quad\) : null;/.test(src) && /toField = vtFieldMap\(quad\);/.test(src));
ok('the website asks once a visit for a lens found after its copy of the mark', /vtLensAsked\.has\(vid\)/.test(src));
ok('the server keeps it, checked', /f\.k >= -0\.5 && f\.k <= 0\.5/.test(api) && /\{ k: f\.k, ka: f\.ka \}/.test(api));
ok('the app works it out from the marked picture and keeps it with the mark', /def estimate_lens\(frame, q, strict=True\):/.test(app) && /lens_save\(cfg, job\['vid'\], fld, k,/.test(app) && /field\['k'\], field\['ka'\] = round\(k, 4\)/.test(app));
ok('every device remakes its matches', /const VT_REMAKE = (16[8-9]|1[7-9]\d);/.test(src));
ok('release is v168 or later', /const APP_BUILD = 'v1(6[8-9]|[7-9]\d)'/.test(src));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
