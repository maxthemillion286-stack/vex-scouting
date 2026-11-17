// t133 — v144 (app 2.26): the review screen never sits as an empty black box.
// Reported with a screenshot: robot review open, picture area black, no counter.
import fs from 'fs';
let pass = 0, fail = 0;
const ok = (name, cond, detail) => { if (cond) { pass++; console.log('  ok   ' + name); } else { fail++; console.log('  FAIL ' + name + (detail ? '\n         ' + detail : '')); } };
const app = fs.readFileSync('../desktop/vex_trainer.py', 'utf8'), src = fs.readFileSync('../src/index.html', 'utf8');
console.log('t133 — v144');
ok('a failing request answers with what went wrong instead of dropping the connection', /def do_GET\(self\):\s+# Anything that goes wrong[\s\S]{0,200}return self\._get\(\)\s+except Exception as e:/.test(app) && /def do_POST\(self\):\s+try:\s+return self\._post\(\)/.test(app));
ok('the window shows it, with Try again', /function revTrouble\(t\)/.test(app) && /if\(cur\.error\)\{revTrouble\('Could not load a frame: '\+cur\.error\);return\}/.test(app) && /catch\(e\)\{revTrouble\('The app did not answer/.test(app));
ok('a frame whose picture is missing is set aside and the next one comes', /img\.onerror=\(\)=>\{const id=cur\.id;revTrouble\('The picture for this frame is missing/.test(app) && /setTimeout\(\(\)=>nextFrame\(\),1200\)/.test(app));
ok('both review jobs load pictures the same way', (app.match(/loadFrame\(\)\}/g) || []).length === 2);
ok('release is v144 or later', /const APP_BUILD = 'v1(4[4-9]|[5-9]\d)'/.test(src));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
