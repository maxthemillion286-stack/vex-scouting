// t132 — v143 (app 2.25): marking pins & cups by clicking. Asked: "can it have
// me select a color and i click a point on the pin and cups".
import fs from 'fs';
let pass = 0, fail = 0;
const ok = (name, cond, detail) => { if (cond) { pass++; console.log('  ok   ' + name); } else { fail++; console.log('  FAIL ' + name + (detail ? '\n         ' + detail : '')); } };
const app = fs.readFileSync('../desktop/vex_trainer.py', 'utf8'), src = fs.readFileSync('../src/index.html', 'utf8');
console.log('t132 — v143');
ok('a click in a dotted box places one of the chosen kind, centred on the click', /else if\(pm&&!onBox\(d\.x0,d\.y0\)\)\{const s=spotAt\(d\.x0,d\.y0\);if\(s\)\{const u=s\[4\]\/3658,w=\(pc===3\?95:70\)\*u,h=\(pc===3\?165:95\)\*u;boxes\.push\(\[d\.x0-w\/2,d\.y0-h\/2,w,h,pc\]\)/.test(app));
ok('sized for where it is: pixels per field width at each spot', /def spot_units\(W, H, q\):/.test(app) && /'spots': \[s \+ \[units\[k\]\] for k, s in enumerate\(spots\)/.test(app));
ok('a click on a box still removes it; a drag still makes an exact box', /if\(pm&&d\.w>=6&&d\.h>=6\)boxes\.push/.test(app) && /boxes\.splice\(k,1\)/.test(app));
ok('a click outside every dotted box says why nothing happened', /Click inside a dotted box: only goals and loaders count\./.test(app));
ok('the help says to pick a colour and click', /click the middle of each pin half/.test(app) && /<kbd>click<\/kbd>place one/.test(app));
ok('release is v143 or later', /const APP_BUILD = 'v1(4[3-9]|[5-9]\d)'/.test(src));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
