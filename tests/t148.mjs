// t148 — v159 (app 2.36): marking the field in the app. Asked: "can i mark the
// field in the app??". End to end in a browser: desktop/dev/fieldmark
// (server.py <frame.jpg>, then node browser.cjs <url>).
import fs from 'fs';
let pass = 0, fail = 0;
const ok = (name, cond, detail) => { if (cond) { pass++; console.log('  ok   ' + name); } else { fail++; console.log('  FAIL ' + name + (detail ? '\n         ' + detail : '')); } };
const app = fs.readFileSync('../desktop/vex_trainer.py', 'utf8'), src = fs.readFileSync('../src/index.html', 'utf8');
console.log('t148 — v159');
ok('a button for each stream that needs it, under pins & cups', /onclick="openField\(/.test(app) && /Mark the field: /.test(app));
ok('on one of that stream\'s saved frames, a reviewed wide one first', /def field_frame\(vid(, want=None)?\):/.test(app) && /score = \(0 if lab\.get\('skip'\) else 1, len\(/.test(app));
ok('four corners, then the goals and loaders to drag', /def first_spots\(q\):/.test(app) && /F\.spots\.forEach\(\(p,k\)=>/.test(app) && /fc\.onmousemove=/.test(app));
ok('saved to the website like a mark made there, with the moment it shows', /def save_field\(cfg, body\):/.test(app) && /r = Site\(cfg\)\.post\(\{'field': field\}\)/.test(app) && /field\['t'\] = round\(float\(t\), 1\)/.test(app));
ok('frames now keep the moment they were taken', /p\['t'\] = round\(float\(at\), 1\)/.test(app) && /keep_frame\(frame, every, job\['vid'\], hard, steady, at=t\)/.test(app));
ok('the server takes the same fields from the app', /f\.t >= 0 && f\.t <= 200000/.test(fs.readFileSync('../api/tracker.js', 'utf8')));
ok('a button is not rebuilt under the mouse every second', /function setHtml\(id,h\)/.test(app) && /setHtml\('pcsN',/.test(app));
ok('app 2.36 or later', /VERSION = '2\.(3[6-9]|[4-9]\d)'/.test(app));
ok('release is v159 or later', /const APP_BUILD = 'v(1(59|[6-9]\d)|[2-9]\d\d)'/.test(src));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
