// t170 — v185 (app 2.52): the robot finder teaching itself. (Ask, added in
// v185, was taken out again in v190 at the owner's request.)
import fs from 'fs';
let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log('  ok   ' + name); } else { fail++; console.log('  FAIL ' + name); } };
const src = fs.readFileSync('../src/index.html', 'utf8'), app = fs.readFileSync('../desktop/vex_trainer.py', 'utf8'), api = fs.readFileSync('../api/tracker.js', 'utf8');
console.log('t170 — v185 / v190');
ok('the robot finder looks again at the frames it was sure of, mirrored too', /def teacher_look\(eyes, frame\)/.test(app) && /kept, dropped = teach_again\(\)/.test(app));
ok('its check is there', fs.existsSync('../desktop/dev/teach.py'));
ok('Ask is gone: no tab, no questions kept on the website, nothing in the app', !/btn\('ask', 'Ask'\)/.test(src) && !/function tAsk/.test(src) && !/vt:ask/.test(api) && !/def ask_answer|def ask_relay|ASK_ORIGINS/.test(app));
ok('app 2.55 or later', /VERSION = '2\.(5[5-9]|[6-9]\d)'/.test(app));
ok('release is v190 or later', /const APP_BUILD = 'v(19\d|[2-9]\d\d)'/.test(src));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
