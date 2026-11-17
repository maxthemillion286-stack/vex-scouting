// t128 — v138: drawings show on phones. Reported: "some things dont show up on
// mobile like the heatmap". Safari does not resolve CSS variables written as
// SVG attributes (fill="var(--x)"), so those shapes had no colour there.
import fs from 'fs';
let pass = 0, fail = 0;
const ok = (name, cond, detail) => { if (cond) { pass++; console.log('  ok   ' + name); } else { fail++; console.log('  FAIL ' + name + (detail ? '\n         ' + detail : '')); } };
const src = fs.readFileSync('../src/index.html', 'utf8'), served = fs.readFileSync('../index.html', 'utf8');
console.log('t128 — v138');
const bad = src.match(/\s[a-z-]+="var\(--[^"]*\)"/g) || [];
ok('no attribute is a CSS variable', bad.length === 0, bad.slice(0, 5).join(' '));
ok('nor in the page as served', !/\s(fill|stroke|stop-color|font-family)="var\(/.test(served));
ok('the heat map colours by style', /style="fill:var\(--vr-heat\)"/.test(src) && /style="stop-color:var\(--vr-heat\)"/.test(src));
ok('report columns fit a narrow phone', /minmax\(min\(300px, 100%\), 1fr\)/.test(src));
ok('release is v138 or later', /const APP_BUILD = 'v1[3-9]\d'/.test(src) && !/const APP_BUILD = 'v13[0-7]'/.test(src));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
