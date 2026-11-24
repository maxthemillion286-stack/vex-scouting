// t147 — v158 (app 2.34): one bar for the whole tracking job. Reported: "the
// progress bar isnt total progress but progress of the task it has on hand".
// Behaviour: desktop/dev/bar.py (the real do_jobs loop with stand-in workers).
import fs from 'fs';
let pass = 0, fail = 0;
const ok = (name, cond, detail) => { if (cond) { pass++; console.log('  ok   ' + name); } else { fail++; console.log('  FAIL ' + name + (detail ? '\n         ' + detail : '')); } };
const app = fs.readFileSync('../desktop/vex_trainer.py', 'utf8'), src = fs.readFileSync('../src/index.html', 'utf8');
console.log('t147 — v158');
ok('the bar is the whole job, set before the first download', /_PROG\['all'\] = \('Tracking matches', 0, left\)/.test(app) && /job_bar\('Getting the first video'\)/.test(app));
ok('a download is named under it, never takes it over', /_PROG\['dl'\] = '%s · %d%%'/.test(app) && /next video: /.test(app));
ok('each worker says how far through each match it is', /def share_set\(key, frac\):/.test(app) && /share_set\(job\.get\('id'\), min\(0\.98,/.test(app));
ok('the bar moves between batches, not only when one is in', /fwait\((pending|set\(inflight\)), timeout=(1\.5|timeout), return_when=FIRST_COMPLETED\)/.test(app) && /part = sum\(share\.values\(\)\)/.test(app));
ok('the window shows the step beside the stage', /P\.stage\+\(P\.sub\?' · '\+P\.sub:''\)/.test(app));
ok('with nothing to mark pins and cups on, the window says why (no reviewed frames, or which streams need their field marked)', /def pieces_why\(site=None\):/.test(app) && /Pc\.why\.unmarked/.test(app) && /\$\('bPcs'\)\.disabled=Pc\.counted!==false&&!Pc\.left/.test(app));
ok('app 2.34 or later', /VERSION = '2\.(3[4-9]|[4-9]\d)'/.test(app));
ok('release is v158 or later', /const APP_BUILD = 'v(1(5[8-9]|[6-9]\d)|[2-9]\d\d)'/.test(src));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
