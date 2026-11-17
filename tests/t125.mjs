// t125 — v135: marking pins & cups in the app, and a finder trained on them.
//
// Asked: "how can i make it recognize pin and cups?" then "build it". The
// app's side is tested in desktop/dev/pieces.py (stand-in finder; no GPU
// here); this checks the source and what the server accepts.
import fs from 'fs';
import { validRec } from '../api/tracker.js';
let pass = 0, fail = 0;
const ok = (name, cond, detail) => { if (cond) { pass++; console.log('  ok   ' + name); } else { fail++; console.log('  FAIL ' + name + (detail ? '\n         ' + detail : '')); } };
const app = fs.readFileSync('../desktop/vex_trainer.py', 'utf8'), src = fs.readFileSync('../src/index.html', 'utf8');
console.log('t125 — v135');
const rec = { v: 2, name: 'Q1', red: ['1A', '2A'], blue: ['3A', '4A'], vid: 'abcdefghijk', off: 100, rate: 4, w: 640, h: 360, f: [[0, 0]], tm: [], pn: [], tg: [] };
ok('a recording with cups is accepted', !validRec({ ...rec, cu: [12, 2, 100, 200, 15, 18, 300, 210, 14, 17], pf: 1 }));
ok('bad cups are not', validRec({ ...rec, cu: [1.5] }) === 'bad cups' && validRec({ ...rec, cu: new Array(24001).fill(1) }) === 'bad cups' && validRec({ ...rec, pf: 2 }) === 'bad pin finder');
ok('one box per pin half, in its colour, and cups', /PIECE_NAMES = \('red half', 'blue half', 'yellow half', 'cup'\)/.test(app));
ok('a second review job with the colour finder\'s guesses drawn', /onclick="openReview\(true\)">Mark pins &amp; cups/.test(app) && /pieces_from_colour\(frame, robots\)/.test(app) && /'\/api\/pnext'/.test(app));
ok('keys pick the colour; the wheel zooms', /else if\(pm&&\/\^\[1-4\]\$\/\.test\(e\.key\)\)/.test(app) && /c\.addEventListener\('wheel'/.test(app));
ok('saving robots keeps pin marks, and the other way', /lab_write\(name, skip=bool\(body\.get\('skip'\)\), boxes=boxes\)/.test(app) && /lab_write\(name, pieces=clean_pieces/.test(app) && /lab_write\(name, skip=bool\(lab\.get\('skip'\)\), boxes=boxes\)/.test(app));
ok('it trains from 60 marked frames, even before 150 robots', /PIECE_SIZE, PIECE_NEED, PIECE_CONF = 1280, 60/.test(app) && /if pieces_ok:\s+try:\s+do_train_pieces\(cfg\)/.test(app));
ok('used only when it beats the colour finder and the one in use', /bar = max\(colour\['halves'\]\[2\], cur\['halves'\]\[2\] if cur else 0\)/.test(app) && /use = new\['halves'\]\[2\] > bar/.test(app));
ok('in tracking it gives the colour finder\'s shape, and records cups', /pw, ph_, blobs, cups = eyes\.pieces\.blobs\(frame, boxes\)/.test(app) && /rec\['cu'\] \+= /.test(app));
ok('release is v135 or later', /const APP_BUILD = 'v1[3-9]\d'/.test(src) && !/const APP_BUILD = 'v13[0-4]'/.test(src));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
