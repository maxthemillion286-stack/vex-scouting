// t144 — v155 (app 2.32): frames the tracker labels itself. Only looks it is
// certain of (four sure robots, two a side, each where the look before had
// it, nothing unsure about), a few a match, never asked about in review,
// trained on but never graded on. Behaviour: desktop/dev/selflabel.py.
import fs from 'fs';
let pass = 0, fail = 0;
const ok = (name, cond, detail) => { if (cond) { pass++; console.log('  ok   ' + name); } else { fail++; console.log('  FAIL ' + name + (detail ? '\n         ' + detail : '')); } };
const app = fs.readFileSync('../desktop/vex_trainer.py', 'utf8'), src = fs.readFileSync('../src/index.html', 'utf8');
console.log('t144 — v155');
ok('only looks the tracker is certain of', /def steady_four\(boxes, before, unsure, w\):/.test(app) && /sorted\(b\[5\] for b in boxes\) != \[1, 1, 2, 2\]/.test(app));
ok('a few a match, spread out, with a ceiling on disk', /AUTO_PER_MATCH, AUTO_GAP, AUTO_MAX = 6, 15, 1500/.test(app) && /auto_room\[0\] > 0/.test(app));
ok('never asked about in review', /if p\.get\('auto'\):\s+# kept only to train on/.test(app));
ok('not-steady frames are not trained on; steady ones first', /p\.get\('steady', 1\)/.test(app) && /steady ones first/.test(app));
ok('grading stays on reviewed frames only', /for name, w, h, boxes in gold:\s+part = 'val' if is_val\(name\) else 'train'/.test(app) && /pseudo\[:2 \* max\(1, counts\['train'\]\)\]/.test(app));
ok('app 2.32 or later', /VERSION = '2\.(3[2-9]|[4-9]\d)'/.test(app));
ok('release is v155 or later', /const APP_BUILD = 'v(1(5[5-9]|[6-9]\d)|[2-9]\d\d)'/.test(src));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
