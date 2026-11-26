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
win.eval('VT_HPP = 2');   // v204: these numbers were written with a pin as two halves
const P = win.eval('mdPlanPick');
const role = v => ({ v });
let p = P([role([0.7, 0.1, 0.1, 0.1]), role([0.6, 0.3, 0.05, 0.05])], [role([0.1, 0.1, 0.7, 0.1]), null]);
ok('two stackers: one stacks, the other does its next job', p.a === 0 && p.b !== 0, JSON.stringify(p));
p = P([role([0.5, 0.1, 0.1, 0.3]), role([0.6, 0.2, 0.1, 0.1])], [role([0.1, 0.1, 0.8, 0.0]), role([0.1, 0.1, 0.7, 0.1])]);
ok('against toggle-goers, someone guards the toggle', p.a === 3 || p.b === 3, JSON.stringify(p));
ok('the skill rows were taken out again (v187)', !/label: 'Adds to its alliance'/.test(src) && !/function sim_skill/.test(src));
ok('the next match shows the plan', /<div class="md-plan" id="mdPlan"><\/div>/.test(src));

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
ok('no route replays (taken out in v196)', !/▶ Play route/.test(src));
ok('release is v184 or later', /const APP_BUILD = 'v(1(8[4-9]|9\d)|[2-9]\d\d)'/.test(src));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
