// t142 — v153: lookalikes. Owner: "teams are able to rebuild and the meta
// robot makes a lot of teams look alike but that's where license plates come
// in handy". A look names a robot only within one event, only where no plate
// was read, and only when it is clearer than nine in ten of the robots it
// faced there.
import fs from 'fs';
import { boot, settle } from './harness.mjs';
let pass = 0, fail = 0;
const ok = (name, cond, detail) => { if (cond) { pass++; console.log('  ok   ' + name); } else { fail++; console.log('  FAIL ' + name + (detail ? '\n         ' + detail : '')); } };
const src = fs.readFileSync('../src/index.html', 'utf8'), t113 = fs.readFileSync('t113.mjs', 'utf8');
console.log('t142 — v153');
const match = new Function(t113.slice(t113.indexOf('function match(opts)'), t113.indexOf('const { win, errors }')) + '; return match;')();
const { win } = await boot();
await settle(win);
const A = [0, 0, 12, 10, 0, 0, 0, 0, 3, 3, 1, 1], opp1 = [3, 3, 3, 3, 3, 3, 3, 3, 2, 2, 1, 1], opp2 = [0, 8, 0, 0, 0, 0, 8, 0, 4, 4, 3, 3];
const partner = i => { const g = [0, 0, 0, 0, 0, 0, 0, 0, 4, 4, 2, 2]; g[(i * 3) % 8] = 12; g[(i * 3 + 1) % 8] = 6; if (i % 8 === 2 || (i * 3) % 8 === 2) { g[2] = 0; g[3] = 0; g[6] = 12; } return g; };
const mk = (ev, i, looks, over) => [ev + ':' + i, win.vtSummarise(match({ n: i, v2: true, partnerHome: true, rs: 50, bs: 20, red: ['66449A', 'P' + i], blue: ['B' + i, 'C' + i], looks, ...over }))];
// Distinct robot: named by its look, as before.
const own = new Map([1, 2, 3, 4, 5, 6].map(i => mk('80', i, [A, partner(i), opp1, opp2])));
const p1 = win.vtIdentify('66449A', own);
ok('a robot unlike the others is named by its look', p1.size === 6 && [...p1.values()].every(p => p.how === 'look'), JSON.stringify([...p1.values()]));
// The meta: most of the robots it faces look just like it.
const meta = new Map([1, 2, 3, 4, 5, 6].map(i => mk('81', i, [A, partner(i), A, i % 3 ? A : opp2])));
const p2 = win.vtIdentify('66449A', meta);
ok('when the robots it faces look the same, the look names nothing', p2.size === 0, JSON.stringify([...p2.values()]));
// Plates still settle it there.
const plated = new Map([1, 2, 3, 4, 5, 6].map(i => mk('82', i, [A, partner(i), A, A], { plate: [1, 2, 0, 0] })));
const p3 = win.vtIdentify('66449A', plated);
ok('a plate read still names it among lookalikes', p3.size === 6 && [...p3.values()].every(p => p.how === 'plate'));
ok('and it is the robot the plate was read on', [...plated.keys()].every(k => plated.get(k)['R' + p3.get(k).slot].opp > 0.5));
// A rebuild between events: each event is judged on its own.
const both = new Map([...own, ...meta]);
const p4 = win.vtIdentify('66449A', both);
ok('each event is judged on its own (a rebuild changes the look)', [...p4.keys()].every(k => k.startsWith('80:')) && p4.size === 6);
ok('the guard is in place', /looks like the crowd: not named by its look/.test(src) && /crowd\[Math\.floor\(crowd\.length \* 0\.1\)\]/.test(src));
ok('release is v153 or later', /const APP_BUILD = 'v(1(5[3-9]|[6-9]\d)|[2-9]\d\d)'/.test(src));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
