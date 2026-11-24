// t178 — v199 (app 2.57): "middle mouse button should pan in the mark cups
// and pins and stuff and not act as a click".
import fs from 'fs';
let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log('  ok   ' + name); } else { fail++; console.log('  FAIL ' + name); } };
const app = fs.readFileSync('../desktop/vex_trainer.py', 'utf8'), src = fs.readFileSync('../src/index.html', 'utf8');
console.log('t178 — v199');
ok('the middle button pans the marking picture', /c\.onmousedown=e=>\{if\(e\.button===1\)\{panStart\(e,\$\('cw'\)\);return\}if\(e\.button!==0\)return;/.test(app));
ok('and on the field marking', /fc\.onmousedown=async e=>\{if\(e\.button===1\)/.test(app));
ok('only the left button finishes a mark', /window\.onmouseup=e=>\{if\(!drag\|\|\(e&&e\.button!==0\)\)return;/.test(app));
ok('the help says so', /hold the middle mouse button and drag to move around/.test(app));
ok('its check is there', fs.existsSync('../desktop/dev/pan.js'));
ok('app 2.57 or later', /VERSION = '2\.(5[7-9]|[6-9]\d)'/.test(app));
ok('release is v199 or later', /const APP_BUILD = 'v(199|[2-9]\d\d)'/.test(src));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
