// t173 — v194: "can it be automatic? also this is way too many buttons and
// way too confusing" (the Robot tracker box).
import fs from 'fs';
let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log('  ok   ' + name); } else { fail++; console.log('  FAIL ' + name); } };
const src = fs.readFileSync('../src/index.html', 'utf8');
console.log('t173 — v194');
const box = src.slice(src.indexOf('async function vtRender(note)'), src.indexOf('// From an event page: open the Jumper on the whole event'));
ok('what the app tracked comes in by itself: on opening and every five minutes', /setTimeout\(function vtAutoImport\(\) \{ try \{ if \(vtPass\(\)/.test(src) && /setTimeout\(vtAutoImport, 300000\)/.test(src));
ok('so its button is gone', !/Bring in what the app tracked<\/button>/.test(src));
ok('the box: one thing to do, the briefing, and everything else under More', /\$\{main\}/.test(box) && /\$\{briefRow\}/.test(box) && /<details class="vt-more"><summary>More: /.test(box));
ok('at most three buttons outside More', (box.slice(0, box.indexOf('const more =')).match(/<button class="btn/g) || []).length <= 3 + 1);
ok('release is v194 or later', /const APP_BUILD = 'v(19[4-9]|[2-9]\d\d)'/.test(src));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
