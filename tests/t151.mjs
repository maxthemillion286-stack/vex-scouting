// t151 — v165 (app 2.41): the pins & cups screen, simplified. Reported: "make
// marking pins and cups simple as possible it feels crammed and too much stuff".
import fs from 'fs';
let pass = 0, fail = 0;
const ok = (name, cond, detail) => { if (cond) { pass++; console.log('  ok   ' + name); } else { fail++; console.log('  FAIL ' + name + (detail ? '\n         ' + detail : '')); } };
const app = fs.readFileSync('../desktop/vex_trainer.py', 'utf8'), src = fs.readFileSync('../src/index.html', 'utf8');
console.log('t151 — v165');
ok('a row of four big colour buttons, nothing else beside them but one link', /<div class="pbar" id="pBar"/.test(app) && /Boxes in the wrong place\?<\/a>/.test(app) && !/id="pKeys"/.test(app));
ok('the fixes stay hidden until asked for (or the frame needs them)', /<span id="pFix" style="display:none">/.test(app) && /\$\('pFix'\)\.style\.display=\(cur\.spots\|\|\[\]\)\.length\?'none':''/.test(app));
ok('one line of help, the rest behind Help', /<details class="phelp"><summary>Help<\/summary>/.test(app));
ok('the picture is quieter: no robot outlines, faint goal boxes', !/for\(const r of cur\.robots\|\|\[\]\)x\.strokeRect/.test(app) && /x\.globalAlpha=gm\?1:0\.3/.test(app));
ok('app 2.41 or later', /VERSION = '2\.(4[1-9]|[5-9]\d)'/.test(app));
ok('release is v165 or later', /const APP_BUILD = 'v(1(6[5-9]|[7-9]\d)|[2-9]\d\d)'/.test(src));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
