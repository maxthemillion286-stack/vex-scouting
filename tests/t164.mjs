// t164 — v178 (app 2.48): "let the vision model review first too for cups and pins".
import fs from 'fs';
let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log('  ok   ' + name); } else { fail++; console.log('  FAIL ' + name); } };
const app = fs.readFileSync('../desktop/vex_trainer.py', 'utf8'), src = fs.readFileSync('../src/index.html', 'utf8');
console.log('t164 — v178');
ok('each goal and loader shown to the model, cut out and enlarged', /def spots_picture\(frame, spots\)/.test(app) && /def vlm_pieces_frame\(cfg, name\)/.test(app));
ok('marked for you only where it and the guesses agree on every spot', /if got\['agree'\]:\s+lab_write\(name, pieces=clean_pieces\(got\['pieces'\]\), pskip=False, pby='vlm'\)/.test(app));
ok('its marks never grade a finder', /is_val\(m\[0\]\) and pieces_by_person\(m\[0\]\)/.test(app) && /is_val\(name\) and pieces_by_person\(name\)/.test(app));
ok('the window has the button', /start\('vpieces'\)/.test(app));
ok('its check is there', fs.existsSync('../desktop/dev/vpieces.py'));
ok('app 2.48 or later', /VERSION = '2\.(4[8-9]|[5-9]\d)'/.test(app));
ok('release is v178 or later', /const APP_BUILD = 'v(1(7[8-9]|[89]\d)|[2-9]\d\d)'/.test(src));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
