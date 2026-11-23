// t176 — v197 (app 2.56): "ive sent an event to the tracker before and its
// taken multiple days … and its still not done".
import fs from 'fs';
let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log('  ok   ' + name); } else { fail++; console.log('  FAIL ' + name); } };
const app = fs.readFileSync('../desktop/vex_trainer.py', 'utf8'), src = fs.readFileSync('../src/index.html', 'utf8');
console.log('t176 — v197');
ok('a match that could not be tracked gets two goes, then is left out', /JOB_TRIES = 2/.test(app) && /tries\.get\('%s:%s' % \(ev, j\['id'\]\), 0\) >= JOB_TRIES/.test(app) && /tries\[k_\] = tries\.get\(k_, 0\) \+ 1/.test(app));
ok('an event whose matches are all tracked or given up is finished', /def finish_events\(site, per_ev, tries\):/.test(app) && /site\.post\(\{'jobs': \{'ev': str\(ev\), 'done': True\}\}/.test(app));
ok('its check is there', fs.existsSync('../desktop/dev/tries.py'));
ok('app 2.56 or later', /VERSION = '2\.(5[6-9]|[6-9]\d)'/.test(app));
ok('release is v197 or later', /const APP_BUILD = 'v(19[7-9]|[2-9]\d\d)'/.test(src));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
