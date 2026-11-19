// t121 — v131: the report says what was asked for, and the app's bar is real.
//
// Asked: "i also dont want to know their autonomous route just the amount of
// pins. and toggles switched to their color. make an actual heatmap and for
// role and stradegy just pu the amount of time scoring on alliance goals,
// neutral goals, and going for toggles, or sitting at their own toggle …
// make the replay auton only for an auto they consistently do, if theres no
// consistent auton then they shouldnt have the rpelay option even availibe
// (completely gone). remove how to use this." and, of the app, "the progress
// bar doesnt move either it needs to be an actual progress bar with estimayted
// countdown."
import fs from 'fs';
import { boot, settle } from './harness.mjs';
let pass = 0, fail = 0;
const ok = (name, cond, detail) => { if (cond) { pass++; console.log('  ok   ' + name); } else { fail++; console.log('  FAIL ' + name + (detail ? '\n         ' + detail : '')); } };
const idx = fs.readFileSync('../src/index.html', 'utf8'), app = fs.readFileSync('../desktop/vex_trainer.py', 'utf8'), api = fs.readFileSync('../api/tracker.js', 'utf8');
console.log('t121 — v131');
const { win } = await boot();
await settle(win);
const f = n => win.eval(n);

// One robot's second-by-second positions through a match, red, own wall left.
const game = (where) => {
  const bins = [];
  for (let t = 0; t <= 125; t++) {
    const p = where(t), far = { x: 0.9, y: 0.9 };
    bins.push({ t, s: { 1: [p, { x: 0.5, y: 0.95 }], 2: [far, { x: 0.95, y: 0.1 }] } });
  }
  return f('vtGame')(bins, { start: 0, driver: 20, end: 125 });
};
{
  // Autonomous by its own wall; then 60 s beside its alliance's goal, 25 s at a
  // neutral one, 20 s on its own toggle.
  const g = game(t => t < 20 ? { x: 0.06, y: 0.6 } : t < 80 ? { x: 0.17, y: 0.7 } : t < 105 ? { x: 0.34, y: 0.2 } : { x: 0.02, y: 0.5 });
  const r = g[1][0];
  ok('time beside its alliance\'s goals is measured', Math.abs(r.ga - 60 / 106) < 0.03, String(r.ga));
  ok('and beside neutral goals', Math.abs(r.gn - 25 / 106) < 0.03, String(r.gn));
  ok('sitting on its own toggle is not counted as goal time', Math.abs(r.th - 21 / 106) < 0.03 && r.ga + r.gn + r.th <= 1.001, String(r.th));
  ok('it starts on the driver-station side', r.sd === 1);
  ok('the partner by a side wall starts on the far side', g[1][1].sd === 2);
  ok('blue is read in its own frame: by its own wall is the driver-station side too', g[2][1].sd === 1, String(g[2][1].sd));
  const cells = Object.keys(r).filter(k => /^g\d+$/.test(k));
  ok('a finer heat grid is kept, empty squares left out', cells.length >= 3 && cells.length < 12 && cells.reduce((a, k) => a + r[k], 0) > 950, cells.join(','));
  ok('the server takes the extra measures', /Object\.keys\(o\)\.length > 200/.test(api) && Object.keys(r).length < 200);
}
// ── toggles turned in autonomous ──
{
  const A = f('vtToggleAuto'), row = (t, v) => [Math.round(t * 10), ...v];
  // wall order: 4 toggles × (red, blue). One is red before the match; by the
  // end of autonomous two are red and one blue.
  const rec = { tg: [].concat(row(-2, [20, 0, 0, 0, 0, 0, 0, 0]), row(15, [20, 0, 22, 1, 0, 19, 0, 0]), row(17, [21, 0, 20, 0, 1, 20, 0, 0]), row(60, [0, 30, 0, 30, 0, 30, 0, 30])) };
  const a = A(rec, { start: 0, driver: 20, end: 125 });
  ok('toggles turned in autonomous are counted per colour, not ones already that colour', a && a[1] === 1 && a[2] === 1, JSON.stringify(a));
  ok('no look at the end of autonomous, no count', A({ tg: row(60, [0, 30, 0, 30, 0, 30, 0, 30]) }, { start: 0, driver: 20, end: 125 }) === null);
}
// ── the autonomous in numbers ──
{
  const F = f('vtAutoFacts'), T = f('vtAutoText');
  const rows = [{ ya: 4, tga: 2, sd: 1 }, { ya: 2, tga: 1, sd: 1 }, { ya: 3, tga: 1, sd: 2 }];
  const a = F(rows, 1, null);
  ok('pins a match, toggles and side', a.pins === 1.5 && Math.abs(a.tog - 4 / 3) < 0.01 && a.near === 2 && a.sideN === 3, JSON.stringify(a));
  ok('the table gets pins and toggles only', T(a, false) === '1.5 pins · 1.3 toggles to its colour', T(a, false));
  ok('the briefing adds the side it starts on', /^Starts on the driver-station side \(2 of 3\) · 1\.5 pins/.test(T(a, true)), T(a, true));
  ok('checked counts are corrected', F(rows, 1, { ok: true, k: 2 }).pins === 3);
  ok('nothing known, nothing said', T(F([{}, {}], 1, null), true) === '');
  ok('the table no longer describes a route', !/Sets down about \$\{P\.auto/.test(idx) && /const auto = vtAutoText\(AF, false\)/.test(idx));
}
// ── the replay: only for a routine ──
{
  const R = f('vtAutoReplay'), H = f('vtReportAuto');
  const row = (pts, j) => { const r = { th: 0.1 }; pts.forEach((p, k) => { r['p' + 2 * k] = Math.round(p[0] * 100) + j; r['p' + (2 * k + 1)] = Math.round(p[1] * 100) - j; }); return r; };
  const A = [[.08, .62], [.15, .66], [.2, .7], [.3, .75], [.34, .8], [.34, .8]], B = [[.3, .1], [.4, .15], [.5, .2], [.5, .3], [.5, .4], [.5, .5]], C = [[.1, .9], [.3, .9], [.6, .9], [.8, .8], [.9, .6], [.9, .4]];
  const same = R([row(A, 0), row(A, 1), row(A, 2), row(A, -1), row(B, 0)]);
  ok('four of five alike is a routine', same && same.n === 4 && same.of === 5 && !same.still && same.pts.length === 6, JSON.stringify(same));
  ok('its points keep their timing', same.pts[1][2] === 3 && same.pts[5][2] === 15 && Math.abs(same.pts[0][0] - 0.085) < 0.01);
  const mixed = R([row(A, 0), row(A, 1), row(B, 0), row(B, 1), row(C, 0)]);
  ok('two and two and one is not', mixed === null);
  ok('two matches are not enough', R([row(A, 0), row(A, 1)]) === null);
  const still = R([0, 1, 2].map(j => row(A.map(() => A[0]), j)));
  ok('staying put is consistent but nothing to replay', still && still.still === true);
  const rep = g => ({ game: g, autoFacts: f('vtAutoFacts')([], 1, null) }), L = { auto: ['Moved in autonomous in 5 of 5 matches.', 'It looks like the same routine every time.'] };
  const yes = H(rep({ n: 5, replay: same }), L), no = H(rep({ n: 5, replay: null }), L), stay = H(rep({ n: 5, replay: still }), L);
  ok('a routine gets a replay button and a moving robot', /vtReplayPlay\(this\)/.test(yes) && /data-pts=/.test(yes) && /class="vr-bot"/.test(yes) && /Runs the same routine in 4 of 5/.test(yes));
  ok('no routine: the replay is not there at all', !/Replay|vr-replay|<svg|animate/.test(no) && /No routine it runs consistently/.test(no), no);
  ok('nor for a robot that does not move', !/vr-replay|animate/.test(stay) && /Stays where it starts/.test(stay));
  ok('the older guess about repeating is not said beside it', !/same routine every time/.test(yes) && /Moved in autonomous in 5 of 5/.test(yes));
}
// ── role and strategy, the heat map, what went ──
{
  const rows = [0, 1, 2].map(() => { const r = { th: 0.1, ts: 0.05, to: 0.05, qh: 0.5, qs: 0.1, qo: 0.1, qm: 0.1, ga: 0.3, gn: 0.2, ca: 2, cw: 1, da: 1, dw: 1, g9: 500, g10: 500 }; for (let k = 0; k < 25; k++) r['h' + k] = 4; return r; });
  const G = f('vtGameLines')(rows, [], true, {});
  ok('the four shares are worked out', Math.abs(G.time.own - 0.3) < 1e-9 && Math.abs(G.time.neutral - 0.2) < 1e-9 && Math.abs(G.time.togs - 0.1) < 1e-9 && Math.abs(G.time.home - 0.1) < 1e-9, JSON.stringify(G.time));
  ok('the heat map uses the finer grid', G.heat.length === 64 && G.heat[9] === 500 && G.heat[0] === 0);
  const html = f('vtReportRole')(G);
  ok('shown as four bars with their shares', (html.match(/vr-time-row/g) || []).length === 4 && /At its alliance’s goals<\/span>.*30%/.test(html) && /Sitting at its own toggle<\/span>.*10%/.test(html), html.slice(0, 300));
  ok('toggle fights sit under strategy now', /Role and strategy/.test(html) && /defended toggle/.test(html));
  const old = f('vtGameLines')(rows.map(r => { const o = { ...r }; delete o.ga; delete o.gn; return o; }), [], true, {});
  ok('matches read before this keep the coarse map and say goal time is coming', old.heat.length === 25 && old.time.own === null && /Goal time appears in a moment/.test(f('vtReportRole')(old)));
  const svg = f('vtFieldSvg')(G.heat, null);
  ok('the map is blurred colour on a drawn field: goals, toggles, a scale', /feGaussianBlur/.test(svg) && (svg.match(/<circle/g) || []).length === 9 && /usual/.test(svg) && /a lot/.test(svg) && (svg.match(/var\(--vr-toggle\)/g) || []).length === 4);
  const full = idx.slice(idx.indexOf('function vtReportHtml('), idx.indexOf('function vtReportHtml(') + 5000);
  ok('no separate Toggles section, no route section, no "How to use this"', !/sec\('Toggles'/.test(full) && !/Autonomous routines/.test(full) && !/How to use this/.test(full));
  ok('summaries from before are made again by themselves', /&& !vtStale\(have\)\) continue;/.test(idx));
}
// ── the app: a bar that measures, and a countdown ──
{
  ok('the work says how far along it is', /def progress\(stage='', done=0, total=0, wait=0, minor=False(, sub='')?\):/.test(app) && /progress\('Tracking matches', done_all, left(, sub=[^)]*)?/.test(app) && /progress\('Training', rounds\['n'\], total_rounds\)/.test(app) && /progress\('Reading the video'/.test(app));
  ok('a download behind the tracking does not take the bar', /minor and _PROG\['hold'\]/.test(app) && /progress\('Downloading the video', done, total, minor=True\)/.test(app));
  ok('the time left comes from the pace so far', /left = \(total - done\) \* \(now - first\[0\]\) \/ \(done - first\[1\]\)/.test(app) && /'progress': job\.progress\(\)/.test(app));
  ok('those lines never reach the log', /if line\.startswith\('@@P '\):\s+self\.note\(line\[4:\]\)\s+continue/.test(app));
  ok('the window shows share, count and time left', /function left\(s\)/.test(app) && /about '\+\(m<90/.test(app) && /working out the time left/.test(app));
  ok('waiting for work shows no bar, and when it looks again', /progress\('Waiting for the website to send work', wait=60\)/.test(app) && /checks again in '\+P\.wait/.test(app) && /\.bar\.idle\{display:none\}/.test(app));
  ok('the made-up 8% is gone', !/st\.busy\?'8%'/.test(app));
}
ok('release is v131 or later', /const APP_BUILD = 'v1[3-9]\d'/.test(idx) && !/const APP_BUILD = 'v130'/.test(idx));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
