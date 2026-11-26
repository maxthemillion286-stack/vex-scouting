// t165 — v179: "6 pin autonomous is crazy high … the most this team can
// score is 4, can it not count it instead of guess".
import fs from 'fs';
import { boot, settle } from './harness.mjs';
let pass = 0, fail = 0;
const ok = (name, cond, detail) => { if (cond) { pass++; console.log('  ok   ' + name); } else { fail++; console.log('  FAIL ' + name + (detail ? '\n         ' + detail : '')); } };
const src = fs.readFileSync('../src/index.html', 'utf8');
console.log('t165 — v179');
const { win } = await boot();
await settle(win);
win.eval('VT_HPP = 2');   // v204: these numbers were written with a pin as two halves
const F = win.eval('vtAutoFacts'), T = win.eval('vtAutoText');
// Four matches; the video counted 12, 8, 12, 4 halves (6, 4, 6, 2 pins).
const raw = [12, 8, 12, 4].map(ya => ({ ya, pya: 0 }));
let t = T(F(raw, 1, null), false);
ok('the middle match, not the most common: usually 4, not 6', /^Usually 4 pins \(2–6\)/.test(t), t);
// The stream showed the alliance scoring 40, 20, 30, 20 in autonomous: at most 8, 4, 6, 4 halves.
const scored = raw.map((r, i) => ({ ...r, asa: [40, 20, 30, 20][i], pya: [0, 0, 6, 0][i] }));
const A = F(scored, 1, null);
ok('never more than its alliance scored, shared with its partner', A.each.join() === '4,2,2,2', A.each.join());
ok('says how many were brought down', A.capped === 3 && A.scored === 4, JSON.stringify([A.capped, A.scored]));
ok('a robot with no stream score is counted as before', F([{ ya: 8 }], 1, null).each[0] === 4);
ok('the report lists each match and what it was checked against', /in its \$\{F\.each\.length\} tracked matches \(\$\{F\.each\.join\(', '\)\}\)/.test(src) && /Held to its alliance's autonomous score on the stream/.test(src));
ok('the team rows carry the alliance\'s autonomous points and the partner\'s count', /asa: sa, pya: ya\(p\.slot === 'a' \? 'b' : 'a'\)/.test(src));
ok('release is v179 or later', /const APP_BUILD = 'v(1(79|[89]\d)|[2-9]\d\d)'/.test(src));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
