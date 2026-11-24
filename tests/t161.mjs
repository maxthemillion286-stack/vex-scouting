// t161 — v175: "wayy too complicated needs to be more bullet points way
// simpler and clear info that directly relates to their scoring strategy".
import fs from 'fs';
import { boot, settle } from './harness.mjs';
let pass = 0, fail = 0;
const ok = (name, cond, detail) => { if (cond) { pass++; console.log('  ok   ' + name); } else { fail++; console.log('  FAIL ' + name + (detail ? '\n         ' + detail : '')); } };
const src = fs.readFileSync('../src/index.html', 'utf8');
console.log('t161 — v175');
const { win } = await boot();
await settle(win);
const P = win.eval('vtPinLine');
const row = (ys, as, vs, vh) => ({ ys, as, vs, vh });
const mine = [row(6, 2, 30, 6), row(8, 0, 30, 5), row(7, 1, 30, 5)], others = [row(2, 1), row(3, 0), row(2, 2)];
const L = P(mine, others, true, { ok: true, k: 1, n: 8, err: 0.22, raw: 1 });
const B = L.bullets || [];
console.log(B.map(b => '      · ' + b).join('\n'));
ok('short points, one thing each', B.length >= 4 && B.every(b => b.length < 110), String(B.length));
ok('in whole pins, not halves', /^Scores about 4 pins a match\.$/.test(B[0]) && !B.some(b => /halves|\d\.\d/.test(b)), B[0]);
ok('what it goes for', B.some(b => /^Goes for yellow pins/.test(b)));
ok('how fast it stacks', B.some(b => /^Stacks a pin about every \d+ s at a goal/.test(b)));
ok('against the robots it played', B.some(b => /^Scores more than the robots it plays against/.test(b)));
ok('how sure, in one line', /checked against 8 official scores: usually within 22%/.test(B[B.length - 1]));
ok('the report shows them as a list', /<div class="vr-h">How it scores<\/div><ul class="vr-list">\$\{rep\.pins\.bullets\.map/.test(src));
ok('release is v175 or later', /const APP_BUILD = 'v(1(7[5-9]|[89]\d)|[2-9]\d\d)'/.test(src));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
