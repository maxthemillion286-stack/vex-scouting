// t155 — v169 (app 2.44): robots told apart by a fingerprint learned from plate
// reads. Asked for: "a learned this-is-that-robot model". Fingerprints come
// from a pretrained image model in the app (desktop/dev/prints.py).
import fs from 'fs';
import { boot, settle } from './harness.mjs';
let pass = 0, fail = 0;
const ok = (name, cond, detail) => { if (cond) { pass++; console.log('  ok   ' + name); } else { fail++; console.log('  FAIL ' + name + (detail ? '\n         ' + detail : '')); } };
const src = fs.readFileSync('../src/index.html', 'utf8'), api = fs.readFileSync('../api/tracker.js', 'utf8'), app = fs.readFileSync('../desktop/vex_trainer.py', 'utf8');
const t113 = fs.readFileSync('t113.mjs', 'utf8');
console.log('t155 — v169');
const match = new Function(t113.slice(t113.indexOf('function match(opts)'), t113.indexOf('const { win, errors }')) + '; return match;')();
const { win } = await boot();
await settle(win);
// Fingerprints: unit-ish vectors of 24 whole numbers; a few distinct robots.
const fp = seed => { const v = []; for (let k = 0; k < 24; k++) v.push(Math.round(100 * Math.sin(seed * 7.3 + k * 1.7))); return v; };
const put = (r, v) => { v.forEach((x, k) => { r['e' + k] = x + ((k * 13 + x) % 5) - 2; }); };
const A = [0, 0, 12, 10, 0, 0, 0, 0, 3, 3, 1, 1];
// Every robot paints the same colours (the meta), so the colours cannot tell them apart.
const mk = (ev, i, prints, over) => { const s = win.vtSummarise(match({ n: i, v2: true, partnerHome: true, rs: 50, bs: 20, red: ['66449A', 'P' + i], blue: ['B' + i, 'C' + i], looks: [A, A, A, A], ...over })); ['Ra', 'Rb', 'Ba', 'Bb'].forEach((k, j) => s[k] && prints[j] && put(s[k], prints[j])); return [ev + ':' + i, s]; };
const me = fp(1);
const sums = new Map([1, 2, 3, 4, 5, 6].map(i => mk('90', i, [me, fp(10 + i), fp(20 + i), fp(30 + i)])));
const picks = win.vtIdentify('66449A', sums);
ok('robots that look the same in colour are told apart by their fingerprints (never wrongly)', picks.size >= 5 && [...picks.values()].every(p => p.how === 'look' && p.slot === 'a'), JSON.stringify([...picks.values()]));
// The same, but half the robots it faces share its fingerprint (the meta, for real).
const crowd = new Map([1, 2, 3, 4, 5, 6].map(i => mk('91', i, [me, fp(10 + i), me, i % 2 ? me : fp(30 + i)])));
ok('a fingerprint the robots it faces share names nobody', win.vtIdentify('66449A', crowd).size === 0);
// Plates still settle a match.
const plated = new Map([1, 2, 3].map(i => mk('92', i, [me, fp(10 + i), fp(20 + i), fp(30 + i)], { plate: [2, 1, 0, 0] })));
ok('a plate read still decides', [...win.vtIdentify('66449A', plated).values()].every(p => p.how === 'plate'));
// Joining a match's fingerprints to its robots.
const join = win.eval('vtPrintJoin'), rows = { 1: [{}, {}], 2: [{}, {}] };
const slotted = [0, 1, 2, 3].map(t => ({ t, s: { 1: [{ x: 0.2, y: 0.2, seen: true }, { x: 0.8, y: 0.8, seen: true }], 2: [null, null] } }));
const fps = [0, 1, 2, 3].map(t => ({ t, p: { x: 0.21, y: 0.2 }, e: fp(5) }));
join(fps, slotted, rows);
ok('a robot\'s fingerprints in a match are averaged onto it', rows[1][0].e0 === fp(5)[0] && rows[1][1].e0 === undefined);
ok('the server takes them, checked', /rec\.em\.length % 27 === 0/.test(api));
ok('the app makes them from a pretrained image model', /def ensure_embedder\(\):/.test(app) && /YOLO\('yolo11n-cls\.pt'\)/.test(app) && /class Embedder:/.test(app) && /rec\['em'\] \+= \[fr_\[0\], fr_\[2 \+ 10 \* i\], fr_\[3 \+ 10 \* i\]\] \+ e_/.test(app));
ok('every device remakes its matches', /const VT_REMAKE = (169|1[7-9]\d|2\d\d);/.test(src));
ok('release is v169 or later', /const APP_BUILD = 'v(1(69|[7-9]\d)|[2-9]\d\d)'/.test(src));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
