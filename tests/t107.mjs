// t107 — v84: autonomous points (AP) in a team's event rating.
import fs from 'fs';
import { boot, settle, html, FIXTURES } from './harness.mjs';

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '\n         ' + detail : '')); }
};
const idx = fs.readFileSync('../index.html', 'utf8');
console.log('t107 — v84: AP in the rating');

const { win, errors } = await boot();
const row = (id, ap, w, l) => ({ team: { id }, ap, wins: w, losses: l, ties: 0 });
const fresh = () => new Map([['1', 50], ['2', 50], ['3', 50], ['4', 50], ['5', 30], ['6', 70]]);

{
  const r = fresh();
  const out = win.sim_applyAP(r, [row(1, 48, 6, 0), row(2, 24, 3, 3), row(3, 0, 0, 6), row(4, 24, 3, 3), row(5, 24, 3, 3), row(6, 24, 3, 3)]);
  ok('the team that keeps winning autonomous is rated higher', r.get('1') > 50, String(r.get('1')));
  ok('the one that never does, lower', r.get('3') < 50, String(r.get('3')));
  ok('a team on the event average does not move', Math.abs(r.get('2') - 50) < 1e-9);
  ok('it reports AP per match', out.rate.get('1') === 8 && out.rate.get('3') === 0);
  ok('and how many teams it adjusted', out.used === 6);
  const spread = Math.sqrt([50, 50, 50, 50, 30, 70].reduce((a, v) => a + (v - 50) ** 2, 0) / 6);
  ok('never by more than its weight of the spread', Math.abs(r.get('1') - 50) <= 0.15 * spread * 2 + 1e-9, `${r.get('1') - 50} vs ${0.15 * spread * 2}`);
  ok('the weight is a nudge', /const SIM_AP_WEIGHT = 0\.15;/.test(idx));
}
{
  const few = fresh(), many = fresh();
  const others = [row(2, 8, 2, 2), row(3, 8, 2, 2), row(4, 8, 2, 2), row(5, 8, 2, 2), row(6, 8, 2, 2)];
  win.sim_applyAP(few, [row(1, 8, 1, 0), ...others]);
  win.sim_applyAP(many, [row(1, 64, 8, 0), ...others]);
  ok('one match of evidence moves a team less than eight', few.get('1') - 50 < many.get('1') - 50 && few.get('1') > 50,
    `${few.get('1')} vs ${many.get('1')}`);
}
{
  const r = fresh();
  win.sim_applyAP(r, [row(1, 12, 3, 3), row(2, 12, 3, 3), row(3, 12, 3, 3), row(4, 12, 3, 3)]);
  ok('everyone on the same AP changes nothing', [...r.values()].join() === [...fresh().values()].join());
  const r2 = fresh();
  win.sim_applyAP(r2, [row(1, 12, 3, 3), row(2, 0, 3, 3)]);
  ok('too few ranked teams changes nothing', [...r2.values()].join() === [...fresh().values()].join());
  const r3 = fresh();
  const out = win.sim_applyAP(r3, [{ team: { id: 1 }, wins: 3, losses: 0 }, row(2, NaN, 3, 3), null, row(3, 5, 0, 0)]);
  ok('rows with no AP, or no matches, are skipped without a crash', out.used === 0 && [...r3.values()].join() === [...fresh().values()].join());
  const r4 = fresh();
  win.sim_applyAP(r4, [row(1, 999, 1, 0), row(2, 4, 3, 3), row(3, 4, 3, 3), row(4, 4, 3, 3), row(5, 4, 3, 3), row(6, 4, 3, 3)]);
  ok('an extreme value is capped', Number.isFinite(r4.get('1')) && r4.get('1') - 50 < 5, String(r4.get('1')));
}
// The whole pipeline, with AP in the event's rankings.
{
  FIXTURES.wideRoster = 12;
  win.switchTab('tournament');
  await win.loadTournamentTeams(55001, 'Bots @ Bristol Signature Event', 9001, '66449A', 'RE-V5RC-25-0191');
  await settle(win, 300);
  const R = await win.sim_buildRatingsFromEvent({ id: 55001, divisions: [{ id: 1 }, { id: 2 }] }, null);
  ok('the event rating carries the AP maps', R.apRate instanceof win.Map && R.apAdj instanceof win.Map && typeof R.apUsed === 'number');
  ok('the spread is measured before the adjustment', idx.indexOf('sim_residualStd(observations, ratings)') < idx.indexOf('ap = sim_applyAP(ratings, ranks)'));
  ok('the pick list explains the adjustment when one was made', /Ratings include a small adjustment for autonomous points/.test(idx));
  ok('the rankings are asked for alongside the matches', /const rankLists = divisions\.map\(div => tDivRankings\(event\.id, div\.id\)/.test(idx));
  FIXTURES.wideRoster = undefined;
}
ok('no errors', errors.length === 0, errors.join('\n'));
win.close();
console.log(`\nt107: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
