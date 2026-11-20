// t163 — v177 (app 2.47): "fix the automatically finding field and goal
// locations". A field finder trained on the owner's own field marks.
import fs from 'fs';
let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log('  ok   ' + name); } else { fail++; console.log('  FAIL ' + name); } };
const app = fs.readFileSync('../desktop/vex_trainer.py', 'utf8'), src = fs.readFileSync('../src/index.html', 'utf8');
console.log('t163 — v177');
ok('a keypoint model: four corners, nine goals, four loaders', /FIELD_KP = 4 \+ 13/.test(app) && /newest_yolo\(YOLO, 'yolo11n-pose\.pt'\)/.test(app));
ok('learned from every marked stream\'s saved frames, the camera followed', /def field_examples\(/.test(app) && /geo = frame_geom\(n\)/.test(app));
ok('tested on whole streams it never saw', /Whole streams are held back for testing/.test(app));
ok('"Find it for me" asks it first, the vision model only without it', /t = trained_find_field\(frame\)/.test(app) && /return self\._send\(200, find_field\(cfg, name\)\)/.test(app));
ok('it learns again by itself every few streams marked', /job\.start\('field', \['--field-finder', '--auto'\]\)/.test(app));
ok('its check is there', fs.existsSync('../desktop/dev/fieldfinder.py'));
ok('app 2.47 or later', /VERSION = '2\.(4[7-9]|[5-9]\d)'/.test(app));
ok('release is v177 or later', /const APP_BUILD = 'v1(7[7-9]|[89]\d)'/.test(src));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
