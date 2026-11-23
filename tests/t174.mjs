// t174 — v195: eliminations listed in the order they were played.
import fs from 'fs';
let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log('  ok   ' + name); } else { fail++; console.log('  FAIL ' + name); } };
const src = fs.readFileSync('../src/index.html', 'utf8');
console.log('t174 — v195');
ok('the Jumper sorts eliminations by when they were played', (src.match(/groups\.Elimination\.sort\(\(a, b\) => \(a\.t == null \? Infinity : a\.t\)/g) || []).length === 2);
ok('release is v195 or later', /const APP_BUILD = 'v(19[5-9]|[2-9]\d\d)'/.test(src));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
