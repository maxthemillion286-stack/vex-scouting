// t143 — v154: goal counts follow the game's rules. A goal holds its count,
// gains a few halves at a time when a robot stacks, and only rarely loses
// some (a descore); a robot in front makes it read low, not high.
import fs from 'fs';
import { boot, settle } from './harness.mjs';
let pass = 0, fail = 0;
const ok = (name, cond, detail) => { if (cond) { pass++; console.log('  ok   ' + name); } else { fail++; console.log('  FAIL ' + name + (detail ? '\n         ' + detail : '')); } };
const src = fs.readFileSync('../src/index.html', 'utf8');
console.log('t143 — v154');
const { win } = await boot();
await settle(win);
const path = s => Array.from(win.eval('vtGoalPath')(s));
const truth = [0, 0, 0, 0, 2, 2, 2, 2, 2, 4, 4, 4, 4, 4, 4, 6, 6, 6, 6, 6, 6, 6, 6, 6];
const seen = truth.slice();
seen[6] = 0; seen[7] = 1;            // a robot in front: two looks read low
seen[12] = 9;                         // one look reads far too high
seen[18] = NaN;                       // the goal out of the picture
const p = path(seen);
ok('reads hidden by a robot in front do not make the count drop', p[6] === 2 && p[7] === 2, p.join(','));
ok('one look far too high does not make a jump', p[12] === 4, p.join(','));
ok('a look of nothing keeps the count', p[18] === 6);
ok('the stacking itself is followed, at the right looks', p[4] === 2 && p[9] === 4 && p[15] === 6 && p[3] === 0, p.join(','));
ok('the count it ends on is right', p[p.length - 1] === 6);
// A real descore: the count drops and stays down.
const des = [4, 4, 4, 4, 4, 4, 4, 1, 1, 1, 1, 1, 1, 1, 1];
const d = path(des);
ok('a descore that holds is followed', d[d.length - 1] === 1 && d[3] === 4, d.join(','));
const blip = [4, 4, 4, 4, 1, 4, 4, 4];
ok('one low look is not a descore', path(blip).every(v => v === 4), path(blip).join(','));
// Fast stacking: a robot that adds a pin a look keeps up.
const fast = [0, 2, 4, 6, 8, 10, 12, 14, 14, 14];
ok('a fast stacker is followed look by look', path(fast).join(',') === fast.join(','), path(fast).join(','));
ok('goals use it, loaders keep the median (they empty as they are used)', /if \(k < 9\) \{\s+const ser = looks\.map/.test(src) && /if \(goals\) \{\s+\/\/ a goal: by the game's rules/.test(src));
ok('every device remakes its matches', /const VT_REMAKE = (15[4-9]|1[6-9]\d|2\d\d);/.test(src));
ok('release is v154 or later', /const APP_BUILD = 'v(1(5[4-9]|[6-9]\d)|[2-9]\d\d)'/.test(src));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
