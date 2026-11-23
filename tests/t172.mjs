// t172 — v191: "i looked at my website on my friends pc and the stats are
// completely different": the newer summary wins, and summaries only on the
// owner's computer are sent up.
import fs from 'fs';
import { boot, settle } from './harness.mjs';
let pass = 0, fail = 0;
const ok = (name, cond, detail) => { if (cond) { pass++; console.log('  ok   ' + name); } else { fail++; console.log('  FAIL ' + name + (detail ? '\n         ' + detail : '')); } };
const src = fs.readFileSync('../src/index.html', 'utf8');
console.log('t172 — v191');
const { win } = await boot();
await settle(win);
const W = win.eval('vtSumWins');
ok('the website\'s copy wins over an older one here', W({ rv: 181 }, { rv: 169 }));
ok('and on a tie (so every device agrees)', W({ rv: 181 }, { rv: 181 }));
ok('a newer one made here is kept', !W({ rv: 169 }, { rv: 181 }));
win.eval(`window.__posts = []; vtApi = async (m, q, b) => { if (m === 'POST') window.__posts.push(b); return { ok: true, body: {} }; };`);
const out = new win.Map([['55001:1', { rv: 181 }], ['55001:2', { rv: 181 }], ['55001:3', { rv: 169 }]]);
win.eval(`lsSet(VT_PASS_KEY, '')`);
win.eval('vtSumsShareUp')(out, { '55001:2': { rv: 169 }, '55001:3': { rv: 181 } });
ok('without the admin key nothing is sent', win.__posts.length === 0);
win.eval(`lsSet(VT_PASS_KEY, 'k')`);
win.eval('vtSumsShareUp')(out, { '55001:2': { rv: 169 }, '55001:3': { rv: 181 } });
const sent = win.__posts.map(b => b.ev + ':' + b.id).sort().join();
ok('with it, the ones missing or older on the website are sent up, nothing else', sent === '55001:1,55001:2', sent);
ok('both ways of reading a team use it', (src.match(/vtSumWins\(s, /g) || []).length >= 2 && (src.match(/vtSumsShareUp\(/g) || []).length >= 3);
ok('release is v191 or later', /const APP_BUILD = 'v(19[1-9]|[2-9]\d\d)'/.test(src));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
