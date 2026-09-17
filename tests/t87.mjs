// t87 — the team's own page: how far they got.
//
// Asked for from a RobotEvents screenshot: "when I type in 66449a in events and
// click that event it shows me this". That lands on the focused-team view, so
// that is where the three pieces go — a score-by-match chart, the W/L already
// on every row, and a Best result panel.
//
// The score-by-match chart that shipped alongside this was removed in v52 at
// the user's request; what it taught the codebase lives on in the phone rules
// below, which it is what surfaced.
import fs from 'fs';
import { boot, settle, html, FIXTURES } from './harness.mjs';
let pass = 0, fail = 0;
const ok = (n, c, e) => { c ? (pass++, console.log('  ok   ' + n)) : (fail++, console.log('  FAIL ' + n + (e ? '\n         ' + e : ''))); };
const idx = fs.readFileSync('../index.html', 'utf8');
const src = idx.match(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/)[1];

console.log('t87 — best result, and the team page on a phone');

// ── 1. Best result ──
// md_bestResult is taken off the real page rather than sliced out of the
// source. HANDOFF §7: every extraction in this repo has gone stale the moment
// the function gained a dependency, and this one needs detectRoundFromMatch.
const PAGE = await boot();
const best = PAGE.win.md_bestResult;
const mk = (name, mine, theirs, t) => ({ raw: { name, round: /^Q/i.test(name) ? 2 : 5 }, name,
  played: true, myScore: mine, oppScore: theirs, time: t });

ok('a semifinal loss is reported as Semifinals', (() => {
  const r = best([mk('Qualification 1', 101, 91, 1), mk('R16 #7-1', 143, 5, 2),
                  mk('QF #4-1', 113, 57, 3), mk('SF #2-1', 8, 135, 4)]);
  return r && r.label === 'Semifinals' && r.won === false && r.elim;
})());
ok('winning the final is CHAMPION', (() => {
  const r = best([mk('SF #2-1', 90, 10, 3), mk('Final #1', 120, 80, 4)]);
  return r && r.champion && r.label === 'CHAMPION';
})());
ok('losing the final is Finals, not champion', (() => {
  const r = best([mk('Final #1', 80, 120, 4)]);
  return r && !r.champion && r.label === 'Finals';
})());
ok('a team that never reached eliminations says so', (() => {
  const r = best([mk('Qualification 1', 101, 91, 1), mk('Qualification 2', 99, 90, 2)]);
  return r && r.label === 'QUALIFICATION ONLY' && r.elim === false;
})());
ok('an event with nothing played yet has no best result',
  best([{ raw: { name: 'Qualification 1' }, played: false }]) === null);
ok('the later match of the furthest round is the one reported', (() => {
  const r = best([mk('SF #2-1', 90, 10, 3), mk('SF #2-2', 40, 95, 5)]);
  return r && r.name === 'SF #2-2' && r.won === false;
})());
PAGE.stop();

// ── 3. The headline strip ──
ok('rank, record and best result sit together at the top',
  /<div class="md-headline">\$\{rankCard\}\$\{recordCard\}\$\{bestCard\}<\/div>/.test(src));
ok('the old rank badge at the bottom is gone',
  !/tournament-rank-badge/.test(src), 'it stated the same number twice');
ok('champion is marked out', /md-stat\$\{bestRes\.champion \? ' is-champion' : ''\}/.test(src));
ok('the projection block only shows while matches remain',
  /if \(quals\.length && remaining\.length\) \{/.test(src),
  'once final it restated the headline number in 28px type underneath it');
// Schedule favourability — "SCHEDULE FAVORABILITY: AVERAGE · avg opponent
// alliance 56 TS vs event average 54 (+1.9)" — was removed in v64. It was a
// derived number nobody asked a question of, printed under a card that already
// said the useful things.
ok('schedule favourability is gone, computation and all',
  !/favorTag|favorDetail|favorBand/.test(src) && !/SCHEDULE FAVORABILITY/.test(idx));
ok('...and the projection block no longer needs an else',
  /if \(quals\.length && remaining\.length\) \{[\s\S]{0,420}\}\s*\n\s*\n\s*\/\/ Live pace banner/.test(src),
  'the only other branch existed to keep favourability on screen');

// ── 4. Driven ──
{
  const { win, errors, stop } = await boot();
  win.switchTab('tournament');
  await win.loadTournamentTeams(55001, 'Maker Faire OC - MS/HS - Day 1', 9001, '66449A', 'RE-V5RC-25-0191');
  await settle(win, 400);
  const h = html(win, 'tournamentResults');

  ok('the headline strip renders', /md-headline/.test(h));
  ok('...with the rank', /Rank<\/div>\s*<div class="md-stat-value">#1/.test(h), h.slice(h.indexOf('md-headline'), h.indexOf('md-headline') + 200));
  ok('...the qualification record', /Qualification record<\/div>\s*<div class="md-stat-value">6–0/.test(h));
  ok('...and how far they got', /Best result<\/div>\s*<div class="md-stat-value">Semifinals/.test(h));
  ok('the run is named', /SF #2-1 · lost/.test(h));

  ok('the record is stated once, not twice',
    (h.match(/6–0/g) || []).length === 1, (h.match(/6–0/g) || []).length + ' times');
  ok('every match still carries its W/L', (h.match(/match-outcome win/g) || []).length === 8);

  // ── Every team number in a row opens that team's card (v65) ──
  const nums = [...win.document.querySelectorAll('#tournamentResults .mt-team')];
  ok('both alliances are clickable, not just yours', nums.length >= 8, nums.length + ' numbers');
  ok('...including opponents',
    nums.some(e => !e.classList.contains('match-team-self')),
    'the interesting question about an opponent is who they are');
  const opp = nums.find(e => !e.classList.contains('match-team-self'));
  const want = opp.textContent.trim().toUpperCase();
  opp.click();
  await settle(win, 1800);
  ok('clicking one lands on its card',
    win.document.getElementById('tab-scout').classList.contains('active') &&
    win.document.getElementById('detailTeamInput').value.toUpperCase() === want,
    want + ' -> ' + win.document.getElementById('detailTeamInput').value);
  ok('...and the card actually rendered',
    (win.document.getElementById('detailResults').innerHTML || '').length > 1000);

  // ── The prediction on a match already played (v65) ──
  //
  // mm.win is computed for EVERY match, played or not — an unplayed row has
  // always shown it where a played row shows WIN or LOSS. The toggle puts it
  // next to what actually happened, which is the only way to see whether the
  // model is worth trusting at this event.
  win.switchTab('tournament');
  await win.tournamentGo('team');
  await settle(win, 600);
  let th = html(win, 'tournamentResults');
  ok('the toggle is offered once there are played matches with a prediction',
    /PREDICTIONS/.test(th));
  ok('nothing is shown until it is asked for', !/match-pred/.test(th));
  win.tTogglePred();
  await settle(win, 700);
  th = html(win, 'tournamentResults');
  ok('turning it on puts a prediction on each played row',
    (th.match(/match-pred/g) || []).length >= 8,
    (th.match(/match-pred/g) || []).length + ' shown');
  ok('...and marks the toggle as on', /btn-secondary is-on/.test(th));
  ok('the choice survives a reload', win.localStorage.getItem('vex_show_pred') === '1');
  win.tTogglePred();
  await settle(win, 700);
  ok('and it turns back off', !/match-pred/.test(html(win, 'tournamentResults')));
  ok('and the loss is marked', /match-outcome loss/.test(h));
  ok('nothing threw', errors.length === 0, errors.join('\n'));
  stop();
}

// An event still in progress: no best result yet, and the projection stays.
{
  const keep = FIXTURES.event.start, keepE = FIXTURES.event.end;
  FIXTURES.event.start = new Date(Date.now() + 40 * 86400e3).toISOString();
  FIXTURES.event.end = new Date(Date.now() + 41 * 86400e3).toISOString();
  FIXTURES.unplayed = true;   // a schedule, no scores
  const { win, stop } = await boot();
  win.switchTab('tournament');
  await win.loadTournamentTeams(55001, 'Future Event', 9001, '66449A', 'RE-V5RC-25-0191');
  await settle(win, 400);
  const h = html(win, 'tournamentResults');
  ok('an event with nothing played claims no best result', !/Best result/.test(h));
  stop();
  FIXTURES.event.start = keep; FIXTURES.event.end = keepE; delete FIXTURES.unplayed;
}

console.log(`\nt87: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
