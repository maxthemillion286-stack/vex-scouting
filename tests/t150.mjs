// t150 — v164 (app 2.40): the vision model as a reviewer and a field finder;
// boxes standing off the field left out. Asked: "build as much and utilize as
// much as you can with it as long as its reasonable", and people being boxed
// as robots. Behaviour (against a stand-in model): desktop/dev/vlm.py.
import fs from 'fs';
let pass = 0, fail = 0;
const ok = (name, cond, detail) => { if (cond) { pass++; console.log('  ok   ' + name); } else { fail++; console.log('  FAIL ' + name + (detail ? '\n         ' + detail : '')); } };
const app = fs.readFileSync('../desktop/vex_trainer.py', 'utf8'), src = fs.readFileSync('../src/index.html', 'utf8');
console.log('t150 — v164');
ok('tracking drops boxes standing off the marked field', /def on_field\(b, inv, W, H\):/.test(app) && /boxes = \[b for b in boxes if on_field\(b, field_inv\[1\], w, h\)\]/.test(app));
ok('and so does the website, for matches already tracked', /const M = VT_FIELD_MARGIN, onField = p =>/.test(src) && /f\.pts = f\.pts\.filter\(onField\)/.test(src) && /const VT_REMAKE = (16[4-9]|1[7-9]\d);/.test(src));
ok('the vision model reviews waiting frames: robot or not, and robots missed', /def vlm_review_frame\(cfg, name\):/.test(app) && /def do_vreview\(cfg, limit=400\):/.test(app) && /'missed'/.test(app));
ok('where it and the finder agree, the frame is labelled, trained on but never graded on', /lab_write\(name, skip=False, boxes=keep, by='vlm'\)/.test(app) && /\(lab\.get\('by'\) == 'vlm'\) != vlm/.test(app) && /reviewed\(vlm=True\)\[:3 \* max\(1, counts\['train'\]\)\]/.test(app));
ok('where it does not, review opens with its changes and they come first', /boxes, said = \[b\[:4\] \+ \[1\.0\] for b in keep\], \{'removed': gone, 'added': len\(p\['vlm'\]\.get\('missed', \[\]\)\)\}/.test(app) && /\(100 if p\.get\('vlm'\) and not vlm_verdict\(p\['vlm'\]\)\[1\] else 0\)/.test(app));
ok('it finds the field: corners, goals, loaders, for the person to check', /def vlm_find_field\(cfg, name\):/.test(app) && /function findField\(\)/.test(app) && /Find it for me/.test(app));
ok('buttons in the window', /start\('vreview'\)/.test(app) && /Let the vision model review first/.test(app));
ok('app 2.40 or later', /VERSION = '2\.(4\d|[5-9]\d)'/.test(app));
ok('release is v164 or later', /const APP_BUILD = 'v(1(6[4-9]|[7-9]\d)|[2-9]\d\d)'/.test(src));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
