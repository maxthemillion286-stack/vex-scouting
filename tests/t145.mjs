// t145 — v156 (app 2.33): the review screen sized by the picture itself, a
// loading line instead of a black box, and garbled pictures set aside.
// Reported with two screenshots: an empty black box, then a 300×150 box of
// yellow streaks. Behaviour: desktop/dev/window.py.
import fs from 'fs';
let pass = 0, fail = 0;
const ok = (name, cond, detail) => { if (cond) { pass++; console.log('  ok   ' + name); } else { fail++; console.log('  FAIL ' + name + (detail ? '\n         ' + detail : '')); } };
const app = fs.readFileSync('../desktop/vex_trainer.py', 'utf8'), src = fs.readFileSync('../src/index.html', 'utf8');
console.log('t145 — v156');
ok('the canvas takes the picture\'s own size', /const W=img\.naturalWidth\|\|cur\.w,H=img\.naturalHeight\|\|cur\.h;/.test(app) && /c\.width=W;c\.height=H;c\.style\.visibility=''/.test(app));
ok('boxes follow if the saved size was different', /if\(cur\.w&&cur\.w!==W\)\{const k=W\/cur\.w;/.test(app));
ok('a loading line, not a black box', (app.match(/\$\('revLeft'\)\.textContent='Loading the next frame…';c\.style\.visibility='hidden';/g) || []).length === 2);
ok('a garbled picture is not kept, not tracked, and set aside in review', /def looks_broken\(frame\):/.test(app) && /if looks_broken\(frame\):\s+return/.test(app) && /if looks_broken\(frame\):\s+# garbled by the decoder/.test(app) && /lab_write\(name, skip=True, boxes=\[\], broken=True\)/.test(app));
ok('app 2.33 or later', /VERSION = '2\.(3[3-9]|[4-9]\d)'/.test(app));
ok('release is v156 or later', /const APP_BUILD = 'v(1(5[6-9]|[6-9]\d)|[2-9]\d\d)'/.test(src));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
