// t169 — v184: a skill model (offence and defence, with ranges) and the plan
// for the next match.
import fs from 'fs';
import { boot, settle } from './harness.mjs';
let pass = 0, fail = 0;
const ok = (name, cond, detail) => { if (cond) { pass++; console.log('  ok   ' + name); } else { fail++; console.log('  FAIL ' + name + (detail ? '\n         ' + detail : '')); } };
const src = fs.readFileSync('../src/index.html', 'utf8');
console.log('t169 — v184');
const { win } = await boot();
await settle(win);
const S = win.eval('sim_skill');
// Ten teams; true offence and defence; many random matches; does it find them?
let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const T = Array.from({ length: 10 }, (_, i) => ({ id: 't' + i, off: 10 + 4 * i, def: i === 3 ? 25 : i === 7 ? 15 : 0 }));
const obs = [];
for (let m = 0; m < 160; m++) {
  const p = [...T].sort(() => rnd() - 0.5).slice(0, 4), r = p.slice(0, 2), b = p.slice(2);
  const sc = (a, o) => Math.max(0, Math.round(40 + a[0].off + a[1].off - o[0].def - o[1].def + (rnd() - 0.5) * 16));
  obs.push({ teams: r.map(t => t.id), opp: b.map(t => t.id), score: sc(r, b), w: 1 });
  obs.push({ teams: b.map(t => t.id), opp: r.map(t => t.id), score: sc(b, r), w: 1 });
}
const K = S(obs);
const offs = T.map(t => K.get(t.id).off);
ok('offence comes out in the right order', offs.every((v, i) => i === 0 || v > offs[i - 1] - 3), offs.map(v => v.toFixed(1)).join(' '));
ok('the defender is found: the team that takes most off opponents', [...T].sort((a, b) => K.get(b.id).def - K.get(a.id).def)[0].id === 't3', T.map(t => K.get(t.id).def.toFixed(1)).join(' '));
ok('and the second', [...T].sort((a, b) => K.get(b.id).def - K.get(a.id).def)[1].id === 't7');
ok('ranges narrow with more matches', (() => { const few = S(obs.slice(0, 40)); return few.get('t5').offSd > K.get('t5').offSd; })());
ok('too few matches: no model', S(obs.slice(0, 4)) === null);
const P = win.eval('mdPlanPick');
const role = v => ({ v });
let p = P([role([0.7, 0.1, 0.1, 0.1]), role([0.6, 0.3, 0.05, 0.05])], [role([0.1, 0.1, 0.7, 0.1]), null]);
ok('two stackers: one stacks, the other does its next job', p.a === 0 && p.b !== 0, JSON.stringify(p));
p = P([role([0.5, 0.1, 0.1, 0.3]), role([0.6, 0.2, 0.1, 0.1])], [role([0.1, 0.1, 0.8, 0.0]), role([0.1, 0.1, 0.7, 0.1])]);
ok('against toggle-goers, someone guards the toggle', p.a === 3 || p.b === 3, JSON.stringify(p));
ok('the compare table shows both with their range', /label: 'Adds to its alliance'/.test(src) && /label: 'Takes off opponents'/.test(src));
ok('the next match shows the plan', /<div class="md-plan" id="mdPlan"><\/div>/.test(src) && /With defence counted:/.test(src));

// ── autonomous routes
const AR = win.eval('vtAutoRoutes');
const path = (pts, ya, art) => { const r = { ya, art }; pts.forEach((p, k) => { r['p' + 2 * k] = Math.round(p[0] * 100); r['p' + (2 * k + 1)] = Math.round(p[1] * 100); }); return r; };
const A = [[0.1, 0.8], [0.2, 0.7], [0.3, 0.6], [0.4, 0.5], [0.45, 0.45], [0.5, 0.4]];
const B = [[0.1, 0.2], [0.2, 0.3], [0.3, 0.3], [0.35, 0.3], [0.4, 0.3], [0.4, 0.3]];
const jig = (P, d) => P.map(([x, y]) => [x + d, y - d]);
const rows = [path(A, 8, '13'), path(jig(A, 0.02), 8, '13'), path(jig(A, -0.02), 6, '13'), path(B, 4, '24'), path(jig(B, 0.01), 4, '24'), path([[0.9, 0.9], [0.8, 0.1], [0.1, 0.5], [0.6, 0.6], [0.2, 0.2], [0.7, 0.3]], 2, '3')];
const rt = AR(rows);
ok('two routes found, most used first', rt.length === 2 && rt[0].n === 3 && rt[1].n === 2, JSON.stringify(rt.map(r => [r.n, r.of])));
ok('each with where it starts and its pins', rt[0].pins === 4 && rt[1].pins === 2 && rt[0].start !== undefined, JSON.stringify(rt.map(r => [r.start, r.pins])));
ok('each route gets its own replay in the report', /▶ Play route \$\{RT\.indexOf\(r\) \+ 1\}/.test(src));
ok('release is v184 or later', /const APP_BUILD = 'v1(8[4-9]|9\d)'/.test(src));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
