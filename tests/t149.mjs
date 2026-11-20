// t149 — v160 (app 2.37): pins & cups only on goals and loaders, on boxes that
// follow the camera. Reported: "its automatically marking ones on the loose
// field though, make it so i only have to mark towers and loaders", then,
// with a picture, "yellow boxes also arent correct". Behaviour:
// desktop/dev/spots.py (a real frame, panned and zoomed; a close-up).
import fs from 'fs';
let pass = 0, fail = 0;
const ok = (name, cond, detail) => { if (cond) { pass++; console.log('  ok   ' + name); } else { fail++; console.log('  FAIL ' + name + (detail ? '\n         ' + detail : '')); } };
const app = fs.readFileSync('../desktop/vex_trainer.py', 'utf8'), src = fs.readFileSync('../src/index.html', 'utf8');
console.log('t149 — v160');
ok('a piece is on a goal when it touches the base or the stack on it, however it leans (v2.39)', /def stacked\(pieces, k, sb\):/.test(app) && /if near\(b, base\) or any\(near\(b, g\) for g in got\):/.test(app));
ok('the guesses and the trained finder use it; a person\'s marks in a box are the truth', /return keep_stacked\(out, spots\) if spots is not None else out/.test(app) && /out \+= stacked\(found, k, sb\)/.test(app) && /if in_spots\(b, sb\) >= 0\], sb\)\)/.test(app));
ok('loader boxes are small, goal boxes wide enough for a leaning stack', /\(0\.02, 0\.02, 0\.035, 0\.12, 0\.025\)/.test(app) && /\(0\.17, 0\.66, 0\.11, 0\.30, 0\.03\)/.test(app));
ok('clicks only land in a goal or loader box', /function spotAt\(x0,y0\)\{return \(cur\.spots\|\|\[\]\)\.find\(s=>x0>=s\[0\]/.test(app));
ok('each frame\'s goals follow the camera from the picture the field was marked on', /def frame_spots\(name, frame=None, W=None, H=None\):/.test(app) && /spots = frame_spots\(name\)/.test(app) && /sb = frame_spots\(name\)/.test(app));
ok('that picture is kept when the field is marked in the app', /refs\[vid\] = \{'id': fid, 'q': field\['q'\](\[:8\])?\}/.test(app) && /id:F\.id,q,/.test(app));
ok('the field can be marked again on the frame being marked', /(Boxes off\? )?Mark the field on this picture/.test(app) && /openField\(cur\.id\.replace/.test(app));
ok('pin and cup boxes are a set size; dragging one moves it, a click removes it', /function sizedBox\(px,py,s\)/.test(app) && /if\(!d\.moved\)\{boxes\.splice\(d\.k,1\)\}/.test(app));
ok('goals and loaders dragged on a frame, size kept, saved for the stream', /function moveGoals\(\)/.test(app) && /def move_spots\(cfg, body\):/.test(app) && /if u\.path == '\/api\/fmove':/.test(app));
ok('app 2.37 or later', /VERSION = '2\.(3[7-9]|[4-9]\d)'/.test(app));
ok('release is v161 or later', /const APP_BUILD = 'v1(6[1-9]|[7-9]\d)'/.test(src));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
