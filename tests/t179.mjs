// t179 — v200 (app 2.58): "is there a way i can press a refresh button in
// the app to update it" — an Update button.
import fs from 'fs';
let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log('  ok   ' + name); } else { fail++; console.log('  FAIL ' + name); } };
const app = fs.readFileSync('../desktop/vex_trainer.py', 'utf8'), src = fs.readFileSync('../src/index.html', 'utf8');
console.log('t179 — v200');
ok('the window has an Update button', /id="updBtn" onclick="updateApp\(\)"/.test(app) && /async function updateApp\(\)/.test(app));
ok('the newest program comes from the website, checked before it replaces this one', /def fetch_update\(cfg, path=None\):/.test(app) && /compile\(src, 'vex_trainer\.py', 'exec'\)/.test(app) && /os\.replace\(tmp, path\)/.test(app));
ok('not while training; tracking is stopped and starts again', /if busy and busy != 'track':/.test(app));
ok('it restarts in the same black window with the same address, and the window reloads', /VT_TOKEN=token, VT_PORT=/.test(app) && /subprocess\.call\(\[sys\.executable, os\.path\.abspath\(__file__\)\], env=env\)/.test(app) && /if\(updating&&st\.version===updating\)\{location\.reload\(\)/.test(app));
ok('its check is there', fs.existsSync('../desktop/dev/update.py'));
ok('app 2.58 or later', /VERSION = '2\.(5[8-9]|[6-9]\d)'/.test(app));
ok('release is v200 or later', /const APP_BUILD = 'v(2\d\d)'/.test(src));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
