// t181 — v202 (app 2.60): practice goals for the pin finder, stacks counted by
// height, looks laid over each other, and who carried the pins.
import fs from 'fs';
import { boot, settle } from './harness.mjs';
let pass = 0, fail = 0;
const ok = (name, cond, detail) => { if (cond) { pass++; console.log('  ok   ' + name); } else { fail++; console.log('  FAIL ' + name + (detail ? '\n         ' + detail : '')); } };
const src = fs.readFileSync('../src/index.html', 'utf8'), api = fs.readFileSync('../api/tracker.js', 'utf8'), app = fs.readFileSync('../desktop/vex_trainer.py', 'utf8');
console.log('t181 — v202');
const { win } = await boot();
await settle(win);
const Drop = win.eval('vtCarryDrop');
const A = { c: 1, i: 0 }, B = { c: 1, i: 1 };
const carried = { 1: [[[40, 4], [42, 4], [44, 4], [46, 0], [47, 0]], [[40, 0], [42, 0], [44, 0], [46, 0]]], 2: [[], []] };
ok('two robots at a goal: the one whose load went down put the pins on', Drop(carried, [A, B], 46) === A);
ok('the other way round too', Drop({ 1: [carried[1][1], carried[1][0]], 2: [[], []] }, [A, B], 46) === B);
ok('nobody\'s load went down: no say', Drop({ 1: [[[40, 0], [46, 0]], [[40, 0], [46, 0]]], 2: [[], []] }, [A, B], 46) === null);
ok('both went down: no say', Drop({ 1: [carried[1][0], carried[1][0]], 2: [[], []] }, [A, B], 46) === null);
ok('one robot near: nothing to decide', Drop(carried, [A], 46) === null);
ok('the recordings keep each robot\'s load and the tracks carry it', /carry_\.set\(a\[i\] \+ '\|' \+ a\[i \+ 1\] \+ '\|' \+ a\[i \+ 2\], a\[i \+ 3\]\)/.test(src) && /carried\[c\]\[i\]\.push\(\[p\.t, p\.cr\]\)/.test(src) && /vtSpotCount\(rec, turnK, track, ph, \(?rec\.cr && rec\.cr\.length\)?.*slotted\.carried : null\)/.test(src));
ok('the server keeps it', /'ge', 'pe', 'cr'[,\]]/.test(api) && /rec\.cr\.length % 4 === 0/.test(api));
ok('the app: practice goals for the pin finder, damaged like a stream', /def piece_practice\(marked, n, seed=7\):/.test(app) && /def stream_damage\(img, rng\):/.test(app) && /build_pieces_dataset\(marked, int\(cfg\.get\('piece_synth', PIECE_SYNTH\)\)\)/.test(app));
ok('the app: stacks counted by height, looks laid over each other, loads on robots', /def by_height\(found, sb, geom\):/.test(app) && /def laid_over\(mem, k, crop, keep=4\):/.test(app) && /def carried\(self, frame, boxes\):/.test(app) && /rec\['cr'\] \+= \[fr_\[0\], fr_\[2 \+ 10 \* i\], fr_\[3 \+ 10 \* i\], n_\]/.test(app));
ok('summaries are made again', /const VT_REMAKE = 2(0[2-9]|[1-9]\d)/.test(src));
ok('app 2.60 or later', /VERSION = '2\.([6-9]\d)'/.test(app));
ok('release is v202 or later', /const APP_BUILD = 'v(20[2-9]|2[1-9]\d)'/.test(src));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
