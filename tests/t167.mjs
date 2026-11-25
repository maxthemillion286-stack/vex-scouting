// t167 — v181 (app 2.49): counting pins exactly, part 2.
import fs from 'fs';
import { boot, settle } from './harness.mjs';
let pass = 0, fail = 0;
const ok = (name, cond, detail) => { if (cond) { pass++; console.log('  ok   ' + name); } else { fail++; console.log('  FAIL ' + name + (detail ? '\n         ' + detail : '')); } };
const app = fs.readFileSync('../desktop/vex_trainer.py', 'utf8'), src = fs.readFileSync('../src/index.html', 'utf8');
console.log('t167 — v181');
const { win } = await boot();
await settle(win);
// One tall yellow patch on a goal: five halves high, but narrow (a side hidden).
const L = win.eval('vtGoalLook'), MM = win.eval('VT_FIELD_MM');
const cols = [{ x: 0.5, y: 0.8, hw: 0.05, up: 0.6, down: 0.02, scale: 0.4 }];
const W = 640, H = 360, px = 0.4 * W, tall = 82.5 / MM * px * 0.9;
const got = L([{ x: 320, y: 288, w: 4, h: 5 * tall, area: 4 * 5 * tall, c: 3 }], cols, W, H)[3][0];
ok('a merged stack is counted by its height, not its area', Math.abs(got - 5) < 0.01, String(got));
const one = L([{ x: 320, y: 288, w: 40 / MM * px, h: tall, area: 0.75 * (40 / MM * px) * tall, c: 3 }], cols, W, H)[3][0];
ok('one half still by its area', Math.abs(one - 1) < 0.05, String(one));
ok('summaries are made again for it', /const VT_REMAKE = (1(8[1-9]|9\d)|2\d\d)/.test(src));
ok('the app: a goal behind a robot is not counted that look', /def blocked\(sb, boxes, most=0\.35\)/.test(app));
ok('the app: sharper downloads when asked', /hp = 1080 if load_config\(\)\.get\('sharp'\) else 720/.test(app));
ok('the app: the stack reader, practice stacks, looks laid over each other', /class StackReader/.test(app) && /def stack_practice\(marked, n/.test(app) && /np\.median\(np\.stack\(last\), axis=0\)/.test(app));
ok('the app: used only when it wins its test', /use = mine > best_other/.test(app) && /def stack_ready\(\):/.test(app));
ok('its check is there', fs.existsSync('../desktop/dev/stack.py'));
ok('app 2.49 or later', /VERSION = '2\.(49|[5-9]\d)'/.test(app));
ok('release is v181 or later', /const APP_BUILD = 'v(1(8[1-9]|9\d)|[2-9]\d\d)'/.test(src));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
