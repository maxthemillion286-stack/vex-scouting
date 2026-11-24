// t158 — v172: "get rid of scroll bar at bottom" of the tracker table.
import fs from 'fs';
let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log('  ok   ' + name); } else { fail++; console.log('  FAIL ' + name); } };
const src = fs.readFileSync('../src/index.html', 'utf8');
console.log('t158 — v172');
ok('the table\'s box never scrolls sideways', /\.cmp-wrap\.vt-coach-wrap \{ overflow-x: hidden; \}/.test(src) && /<div class="cmp-wrap vt-coach-wrap"><table class="cmp-table vt-coach-table">/.test(src));
ok('its cells wrap', /\.vt-coach-table th, \.vt-coach-table td \{ white-space: normal; \}/.test(src));
ok('release is v172 or later', /const APP_BUILD = 'v(1(7[2-9]|[89]\d)|[2-9]\d\d)'/.test(src));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
