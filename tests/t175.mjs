// t175 — v196: "remove the replay autonomous thing in the website … it doesnt work".
import fs from 'fs';
let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log('  ok   ' + name); } else { fail++; console.log('  FAIL ' + name); } };
const src = fs.readFileSync('../src/index.html', 'utf8');
console.log('t175 — v196');
ok('no replay button anywhere in the report', !/onclick="vtReplayPlay/.test(src) && !/class="vr-replay"/.test(src));
ok('release is v196 or later', /const APP_BUILD = 'v(19[6-9]|[2-9]\d\d)'/.test(src));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
