// t152 — v166 (app 2.42): pins & cups marking helped. Asked for: "pre-fill pin
// marks from a quick-trained finder" and "pick the most useful frames to mark".
// Behaviour (including a real, short training run): desktop/dev/helper.py.
import fs from 'fs';
let pass = 0, fail = 0;
const ok = (name, cond, detail) => { if (cond) { pass++; console.log('  ok   ' + name); } else { fail++; console.log('  FAIL ' + name + (detail ? '\n         ' + detail : '')); } };
const app = fs.readFileSync('../desktop/vex_trainer.py', 'utf8'), src = fs.readFileSync('../src/index.html', 'utf8');
console.log('t152 — v166');
ok('a marking helper is trained after 20 marked frames and every 20 after', /HELPER_START, HELPER_EVERY, HELPER_ROUNDS = 20, 20, 30/.test(app) && /def do_quick_pieces\(cfg\):/.test(app) && /job\.start\('helper', \['--quick-pieces'\]\)/.test(app));
ok('it only draws guesses; tracking keeps the finder that won its test', /def guess_source\(\):/.test(app) && /pfinder\(src\[1\]\)\(frame, spots\)/.test(app));
ok('the most useful frames come first: the finder\'s doubts, and streams marked least', /def frame_interest\(name, finder, robots\):/.test(app) && /def rank_pieces\(queue, budget=120\):/.test(app) && /q = rank_pieces\(q\)/.test(app));
ok('the window says what draws the guesses', /Guesses drawn by: /.test(app));
ok('app 2.42 or later', /VERSION = '2\.(4[2-9]|[5-9]\d)'/.test(app));
ok('release is v166 or later', /const APP_BUILD = 'v(1(6[6-9]|[7-9]\d)|[2-9]\d\d)'/.test(src));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
