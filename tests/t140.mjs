// t140 — v151 (app 2.30): more looks at the moments that decide things, never
// fewer than usual. Asked: "some teams do things faster than 4 times a second
// … could you keep it as 4 times a second and still increase the other metric".
// Behaviour: desktop/dev/burst.py (6 a second normally, about 10 while robots
// touch, never fewer anywhere, extra looks dropped first at the ceiling).
import fs from 'fs';
let pass = 0, fail = 0;
const ok = (name, cond, detail) => { if (cond) { pass++; console.log('  ok   ' + name); } else { fail++; console.log('  FAIL ' + name + (detail ? '\n         ' + detail : '')); } };
const app = fs.readFileSync('../desktop/vex_trainer.py', 'utf8'), src = fs.readFileSync('../src/index.html', 'utf8');
console.log('t140 — v151');
ok('the usual rate stays the least', /LOOKS_PER_SEC = 6 [^\n]*never fewer/.test(app) && /now_step = burst_step if t < burst_until else step/.test(app));
ok('twice as often at a goal or with robots touching, for 1.5 s after', /BURST_PER_SEC, BURST_HOLD = 12, 1\.5/.test(app) && /def key_moment\(boxes, goals\):/.test(app) && /if not away and key_moment\(boxes, goal_boxes\):/.test(app));
ok('goals are where the camera now puts them', /cur_quad, cur_placed, spots, goal_boxes = nq,/.test(app));
ok('at the website\'s ceiling the extra looks go first', /extra\.add\(len\(rec\['f'\]\)\)/.test(app) && /the website's ceiling: extra looks go first, evenly/.test(app));
ok('app 2.30 or later', /VERSION = '2\.(3\d|[4-9]\d)'/.test(app));
ok('release is v151 or later', /const APP_BUILD = 'v(1(5[1-9]|[6-9]\d)|[2-9]\d\d)'/.test(src));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
