// t156 — v170 (app 2.45): the tracker's table on every team's scout card,
// phones included; review only asks about frames that need a person.
// Reported: "on phone i cant see the your robot as the tracker sees it for my
// team or others", and "why does it have me review so many frames still?"
// (behaviour of the second: desktop/dev/reviewq.py).
import fs from 'fs';
import { boot, settle } from './harness.mjs';
let pass = 0, fail = 0;
const ok = (name, cond, detail) => { if (cond) { pass++; console.log('  ok   ' + name); } else { fail++; console.log('  FAIL ' + name + (detail ? '\n         ' + detail : '')); } };
const src = fs.readFileSync('../src/index.html', 'utf8'), app = fs.readFileSync('../desktop/vex_trainer.py', 'utf8');
const t113 = fs.readFileSync('t113.mjs', 'utf8');
console.log('t156 — v170');
const match = new Function(t113.slice(t113.indexOf('function match(opts)'), t113.indexOf('const { win, errors }')) + '; return match;')();
const { win } = await boot();
await settle(win);
const sums = new Map([1, 2, 3, 4].map(i => ['77:' + i, win.vtSummarise(match({ n: i, v2: true, rs: 50, bs: 20, red: ['8838C', 'P' + i], blue: ['B' + i, 'C' + i] }))]));
win.vtTeamSums = async () => sums;
win.eval('vtTeamSums = window.vtTeamSums');
win.eval('vsEventRecord = async () => [{ name: "Test Event", start: "2026-11-01" }]');
const host = win.document.createElement('div');
host.id = 'vtCoachCard'; host.dataset.team = '8838C';
win.document.body.appendChild(host);
await win.eval('vtCoachFill')('8838C', 'vtCoachCard');
ok('any team\'s scout card gets the table', /8838C, as the tracker sees it/.test(host.textContent) && host.querySelector('.vt-coach-table'), host.textContent.slice(0, 200));
ok('with its event and matches', /Test Event/.test(host.textContent));
ok('it is put on every scout card, for phones too', /<div id="vtCoachCard" data-team=/.test(src) && /vtCoachFill\(d\.team\.number, 'vtCoachCard'\)/.test(src));
ok('the table already lays out for a phone', /\.vt-coach-table tr \{ display: grid; grid-template-columns: repeat\(3, 1fr\)/.test(src));
ok('on your own team it still says "Your robot"', /\$\{mineTeam \? 'Your robot' : esc\(num\)\}, as the tracker sees it/.test(src));
ok('review does not ask about frames the finder was plainly sure of', /_SURE\[0\] \+= 1/.test(app) && /Only frames the finder is unsure about/.test(app));
ok('the robot finder trains from 100 reviewed frames', /TRAIN_MIN = 100/.test(app));
ok('the vision model reviews new frames by itself after tracking, when on', /do_vreview\(cfg, limit=200\)/.test(app));
ok('app 2.45 or later', /VERSION = '2\.(4[5-9]|[5-9]\d)'/.test(app));
ok('release is v170 or later', /const APP_BUILD = 'v1([7-9]\d)'/.test(src));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
