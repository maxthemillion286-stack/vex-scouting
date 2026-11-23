// t172 — v193: the same numbers on every device: the owner's own copies are
// shown on the owner's computer and sent up; other browsers show the
// website's (the owner's) copies.
import fs from 'fs';
import { boot, settle } from './harness.mjs';
let pass = 0, fail = 0;
const ok = (name, cond, detail) => { if (cond) { pass++; console.log('  ok   ' + name); } else { fail++; console.log('  FAIL ' + name + (detail ? '\n         ' + detail : '')); } };
const src = fs.readFileSync('../src/index.html', 'utf8');
console.log('t172 — v193');
const { win } = await boot();
await settle(win);
const T = win.eval('vtTakeServer');
win.eval(`lsSet(VT_PASS_KEY, '')`);
ok('elsewhere (no admin key): the website\'s copy over one made in this browser', T({ rv: 181, x: 1 }, { rv: 181, x: 2 }) && T({ rv: 181 }, { rv: 169 }));
ok('but a newer one made here stays (the website has older counting)', !T({ rv: 169 }, { rv: 181 }));
win.eval(`lsSet(VT_PASS_KEY, 'k')`);
ok('on the owner\'s computer: its own, on a tie', !T({ rv: 181, x: 1 }, { rv: 181, x: 2 }));
ok('the website\'s only when it is newer counting', T({ rv: 190 }, { rv: 181 }));
win.eval(`window.__posts = []; vtApi = async (m, q, b) => { if (m === 'POST') window.__posts.push(b); return { ok: true, body: {} }; };`);
const S = (rv, x) => ({ sv: win.eval('VT_SUM_V'), ok: 1, rv, x });
const out = new win.Map([['55001:1', S(181, 1)], ['55001:2', S(181, 2)], ['55001:3', S(169, 3)], ['55001:4', S(181, 4)]]);
win.eval('vtSumsShareUp')(out, { '55001:2': S(181, 9), '55001:3': S(181, 3), '55001:4': S(181, 4) });
const sent = win.__posts.map(b => b.ev + ':' + b.id).sort().join();
ok('the owner\'s copies missing on the website, or different there, are sent up; same or older are not', sent === '55001:1,55001:2', sent);
win.eval(`lsSet(VT_PASS_KEY, '')`); win.__posts.length = 0;
win.eval('vtSumsShareUp')(new win.Map([['55001:9', S(181, 1)]]), {});
ok('nothing is sent without the admin key', win.__posts.length === 0);
ok('both ways of reading a team use it', (src.match(/vtTakeServer\(s, /g) || []).length >= 2 && (src.match(/vtSumsShareUp\(/g) || []).length >= 3);
ok('release is v193 or later', /const APP_BUILD = 'v(19[3-9]|[2-9]\d\d)'/.test(src));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
