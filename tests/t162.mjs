// t162 — v176 (app 2.46): "any way to make the tracking process faster".
import fs from 'fs';
let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log('  ok   ' + name); } else { fail++; console.log('  FAIL ' + name); } };
const app = fs.readFileSync('../desktop/vex_trainer.py', 'utf8'), src = fs.readFileSync('../src/index.html', 'utf8');
console.log('t162 — v176');
ok('one pool of workers for the whole job', /pool = ProcessPoolExecutor\(max_workers=workers\)/.test(app) && !/with ProcessPoolExecutor\(max_workers=min\(workers, len\(chunks\)\)\) as pool/.test(app));
ok('the vision model only where plates did not settle who is who', /def trim_shots\(rec, shots\)/.test(app) && /shots = trim_shots\(rec, rec\.pop\('_shots', \[\]\)\)/.test(app));
ok('where the time went is said at the end', /Where the time went \(all workers together\)/.test(app));
ok('its check is there', fs.existsSync('../desktop/dev/speed.py'));
ok('app 2.46 or later', /VERSION = '2\.(4[6-9]|[5-9]\d)'/.test(app));
ok('release is v176 or later', /const APP_BUILD = 'v(1(7[6-9]|[89]\d)|[2-9]\d\d)'/.test(src));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
