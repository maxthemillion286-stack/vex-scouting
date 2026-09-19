// t94 — the Simulator's tools moved into the event they were always about.
//
// The Simulator wanted four team numbers, two opponents and a candidate list
// typed in before it would tell you anything. Inside an event none of that is
// necessary: the roster, the seeds, the schedule and the ratings are all
// already loaded. So the tools moved to where the data is, and the Simulator
// tab became Event Scout, which is the one that really is about events you
// have NOT opened.
//
//   match prediction  → every unplayed match, everywhere, behind one toggle
//   pick list         → TOURNAMENT ▸ PICK LIST, run automatically
//   bracket odds      → TOURNAMENT ▸ BRACKET, projected before elims start
//   manual matchup    → kept, behind the pick list's mode switch
import fs from 'fs';
import { boot, settle, html, FIXTURES } from './harness.mjs';
let pass = 0, fail = 0;
const ok = (n, c, e) => { c ? (pass++, console.log('  ok   ' + n)) : (fail++, console.log('  FAIL ' + n + (e ? '\n         ' + e : ''))); };
const idx = fs.readFileSync('../index.html', 'utf8');
const src = idx.match(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/)[1];

console.log('t94 — the Simulator moves into the Tournament');

// ══ 1. One prediction layer, one toggle ════════════════════════════════════
console.log('\n· the shared layer');
ok('ratings for the open event are fetched in one place', /async function tRatings\(setStatus\)/.test(src));
ok('and a single predictor serves every view', /function tPredict\(R, redNums, blueNums, seed\)/.test(src));
ok('it refuses when too few teams have played',
  /if \(rated < 2\) return null;/.test(src),
  'a probability from nothing is worse than no probability');
ok('the ratings Map is read by STRING id',
  /const tRatingOf = \(R, id\) => \(R && R\.ratings\.get\(String\(id\)\)\) \|\| 0;/.test(src),
  'the Map is keyed by strings and the roster holds numbers; Map.get is type-strict');
ok('...and the roster goes through the same conversion',
  /const tIds = list => list\.map\(t => String\(t\.id\)\);/.test(src));
ok('the toggle is a switch, not a link that looks like a tab',
  /function tPredSwitch\(\)/.test(src) &&
  /role="switch" aria-checked=/.test(src));
ok('...drawn from the theme\'s own greys, so it inherits every theme',
  /\.t-switch-track \{[^}]*var\(--card2\)/.test(idx) &&
  !/\.t-switch[^{]*\{[^}]*#[0-9a-f]{3,6}/i.test(idx));
ok('...and it sits beside SCOUT in the summary, on every view',
  (idx.match(/\$\{tPredSwitch\(\)\}/g) || []).length >= 8,
  (idx.match(/\$\{tPredSwitch\(\)\}/g) || []).length + ' summaries');
ok('it is out of the tab strip', !/tPredButton/.test(src) && !/t-nav-link t-pred/.test(idx));
ok('turning it re-renders whichever view is open',
  /if \(tournamentView\) tournamentGo\(tournamentView\);/.test(src));
ok('the three bands mean the same thing everywhere', /const tPredClass = p =>/.test(src));
// v67 gated the pick list on the switch as well; v68 took that back. Every
// other view has real results to show and the model is an overlay on them —
// this one IS the model, so gating it leaves an empty screen asking to be
// switched on. The switch governs the overlays.
ok('the pick list is not gated on the switch',
  !/if \(!tShowPred\) \{[\s\S]{0,300}behind the same switch/.test(src),
  'gating a view that is entirely a projection leaves nothing behind');
ok('...and it says why, where the next person will look',
  /this one IS the model, so gating it leaves an\n  \/\/ empty screen/.test(src));
ok('the views that DO have results underneath are still gated',
  /if \(tShowPred && rows\.some\(r => !r\.played\)\) \{/.test(src) &&
  /\} else if \(!tShowPred\) \{[\s\S]{0,200}Turn on <strong>PREDICTIONS/.test(src));
ok('the pick list mode is a small control on the alliance-size row',
  /strongest team left\.<\/span>\$\{modeSel\}<\/div>/.test(src) && !/pk-modes/.test(idx),
  'it was a full-width bar above everything');
ok('...pushed to the far end of it', /\.pk-mode-wrap \{ margin-left: auto;/.test(idx));

// ══ 2. Every unplayed match carries a number ═══════════════════════════════
console.log('\n· predictions on the event-wide match list');
ok('the ratings are only built when the toggle asks',
  /if \(tShowPred && rows\.some\(r => !r\.played\)\) \{/.test(src),
  'building them walks every match at the event');
{
  const keep = FIXTURES.playedThrough;
  FIXTURES.playedThrough = 4;              // quals 1-4 played, 5-6 to come
  const { win, errors, stop } = await boot();
  win.switchTab('tournament');
  await win.loadTournamentTeams(55001, 'Bots @ Bristol', 9001, '66449A', 'RE-V5RC-25-0191');
  await settle(win, 800);
  await win.tournamentGo('matches'); await settle(win, 900);
  let h = html(win, 'tournamentResults');
  ok('an unplayed match says "upcoming" until asked', (h.match(/t-pending/g) || []).length >= 2);
  ok('...and carries no number yet', !/class="t-pred /.test(h));
  win.tTogglePred(); await settle(win, 2200);
  h = html(win, 'tournamentResults');
  ok('with the toggle on every unplayed match is modelled',
    (h.match(/class="t-pred /g) || []).length >= 2,
    (h.match(/class="t-pred /g) || []).length + ' modelled');
  ok('...and none still say "upcoming"', !/t-pending/.test(h));
  const shown = [...h.matchAll(/class="t-pred [^"]*"[^>]*>(\d+)%/g)].map(m => Number(m[1]));
  ok('the numbers are probabilities, not noise',
    shown.length > 0 && shown.every(v => v >= 0 && v <= 100), shown.join(' '));
  ok('a played match still shows its real score', /t-dash/.test(h));
  ok('nothing threw', errors.length === 0, errors.join('\n'));
  stop();
  FIXTURES.playedThrough = keep;
}

// ══ 3. The pick list, run for the event ════════════════════════════════════
console.log('\n· TOURNAMENT ▸ PICK LIST');
ok('it is a view of the event, in the nav', /\$\{btn\('picklist', 'Pick List'\)\}/.test(src));
ok('and it is routed', /if \(view === 'picklist'\) return renderTournamentPickList\(\);/.test(src));
ok('alliances are projected the way selection actually runs',
  /function tProjectAlliances\(seeds, R, size\)/.test(src) &&
  /const captain = left\.shift\(\);/.test(src),
  'captains are the top seeds still unpicked; each takes the strongest left');
ok('the baseline matches the Simulator\'s own',
  /const benchMean = med \* 2, benchStd = R\.globalStd \|\| 10;/.test(src));
{
  const keepT = FIXTURES.teams, keepP = FIXTURES.playedThrough;
  FIXTURES.playedThrough = 4;
  FIXTURES.teams = [...FIXTURES.teams,
    { id: 9004, number: '777Z', team_name: 'Zed', grade: 'High School' },
    { id: 9005, number: '555A', team_name: 'Five', grade: 'High School' },
    { id: 9006, number: '888B', team_name: 'Eight', grade: 'High School' },
    { id: 9007, number: '999C', team_name: 'Nine', grade: 'High School' },
    { id: 9008, number: '222D', team_name: 'Two', grade: 'High School' }];
  const { win, errors, stop } = await boot();
  win.switchTab('tournament');
  await win.loadTournamentTeams(55001, 'Bots @ Bristol', 9001, '66449A', 'RE-V5RC-25-0191');
  await settle(win, 800);
  await win.tournamentGo('picklist'); await settle(win, 3000);
  // Driven with the switch OFF, which is the default — the pick list must
  // still project, because projecting is all it does.
  ok('the switch is off', win.document.querySelector('#tournamentResults .t-switch')
    .getAttribute('aria-checked') === 'false');
  let h = html(win, 'tournamentResults');
  ok('it runs without anything being typed in', (h.match(/class="pk-row/g) || []).length >= 4,
    (h.match(/class="pk-row/g) || []).length + ' rows');
  ok('every alliance is a captain and a pick', /class="pk-plus">\+</.test(h));
  const wins = [...h.matchAll(/class="pk-win[^"]*">(\d+)%/g)].map(m => Number(m[1]));
  ok('each pairing gets a real number, not zero',
    wins.length >= 4 && wins.some(v => v > 0) && wins.every(v => v >= 0 && v <= 100),
    wins.join(' '));
  ok('...and they are not all identical, which is what a failed rating lookup looks like',
    new Set(wins).size > 1, wins.join(' '));
  ok('it says where the focused team lands', /class="pk-you"/.test(h));
  ok('alliance size can be changed', (h.match(/class="pk-size/g) || []).length >= 3);
  ok('team numbers in it open their card', /class="mt-team" onclick="scoutTeam\(/.test(h));

  // The manual matchup, behind the mode switch.
  ok('manual is not the default', /let tPickMode = 'auto';/.test(src));
  win.tSetPickMode('manual'); await settle(win, 900);
  ok('switching mode gives four inputs',
    ['pkR1', 'pkR2', 'pkB1', 'pkB2'].every(id => win.document.getElementById(id)));
  win.document.getElementById('pkR1').value = '66449A';
  win.document.getElementById('pkB1').value = '12345B';
  await win.tRunManualMatch(); await settle(win, 900);
  const mh = html(win, 'tournamentResults');
  const pct = [...mh.matchAll(/pk-mr-pct">([\d.]+)%/g)].map(m => Number(m[1]));
  ok('a manual matchup still simulates', pct.length === 2, pct.join(' / '));
  ok('...and the two sides sum to about 100',
    pct.length === 2 && Math.abs(pct[0] + pct[1] - 100) < 0.5, pct.join(' + '));
  ok('nothing threw', errors.length === 0, errors.join('\n'));
  stop();
  FIXTURES.teams = keepT; FIXTURES.playedThrough = keepP;
}

// ══ 4. The bracket, before eliminations start ══════════════════════════════
console.log('\n· TOURNAMENT ▸ BRACKET, projected');
ok('championship odds are rendered from one helper', /function tOddsBlock\(alliances, label\)/.test(src));
ok('the modelled alliances are shared with the pick list', /function tModelledAlliances\(R\)/.test(src));
// Retargeted in v72: the projected bracket became a tree, so the pairing is
// now taken over the BRACKET SLOTS rather than the alliance count — a
// 6-alliance field plays inside 8 slots and seeds 1 and 2 get byes. The
// concern is unchanged: seed 1 meets the lowest seed and the top two can only
// meet in the final.
ok('the projected bracket uses the standard seed pairing',
  /const slots = sim_bracketSlots\(n\);/.test(src) && /const order = sim_seedOrder\(slots\);/.test(src),
  'seed 1 meets the lowest seed; the top two can only meet in the final');
{
  const keepT = FIXTURES.teams, keepP = FIXTURES.playedThrough;
  FIXTURES.playedThrough = 4;       // no eliminations yet
  FIXTURES.teams = [...FIXTURES.teams,
    { id: 9004, number: '777Z', team_name: 'Zed', grade: 'High School' },
    { id: 9005, number: '555A', team_name: 'Five', grade: 'High School' },
    { id: 9006, number: '888B', team_name: 'Eight', grade: 'High School' },
    { id: 9007, number: '999C', team_name: 'Nine', grade: 'High School' },
    { id: 9008, number: '222D', team_name: 'Two', grade: 'High School' }];
  const { win, errors, stop } = await boot();
  win.switchTab('tournament');
  await win.loadTournamentTeams(55001, 'Bots @ Bristol', 9001, '66449A', 'RE-V5RC-25-0191');
  await settle(win, 800);
  await win.tournamentGo('bracket'); await settle(win, 2600);
  let h = html(win, 'tournamentResults');
  ok('with predictions off it says how to turn them on, rather than dead-ending',
    /Turn on <strong>PREDICTIONS/.test(h));
  ok('...and keeps the nav either way', /t-nav/.test(h));
  win.tTogglePred(); await settle(win, 3200);
  h = html(win, 'tournamentResults');
  // Retargeted in v72. This used to check for the flat list's heading; the
  // projected bracket is now the same tree the played one uses, so the check
  // is for the tree.
  ok('a bracket is drawn before eliminations exist',
    /bracket-wrapper/.test(h) && /bracket-round-label/.test(h) && /Finals/.test(h));
  ok('with championship odds', /Championship odds, projected/.test(h));
  const odds = [...h.matchAll(/bo-pct">([\d.]+)%/g)].map(m => Number(m[1]));
  ok('one row per alliance', odds.length >= 4, odds.length + ' rows');
  ok('the odds sum to about 100', Math.abs(odds.reduce((a, b) => a + b, 0) - 100) < 1.5,
    odds.join(' + ') + ' = ' + odds.reduce((a, b) => a + b, 0).toFixed(1));
  ok('and it says plainly that selection will differ', /Real selection will differ/.test(h));
  ok('nothing threw', errors.length === 0, errors.join('\n'));
  stop();
  FIXTURES.teams = keepT; FIXTURES.playedThrough = keepP;
}

// ══ 5. The Simulator tab is Event Scout now ════════════════════════════════
console.log('\n· the old Simulator tab');
ok('it is labelled Event Scout', /<div class="section-label">Event Scout/.test(idx));
ok('the sub-navigation is gone', !/sim-subnav/.test(idx) && !/simmode-/.test(idx));
ok('so are the four typed match inputs', !/id="simRed1"/.test(idx) && !/id="simBlue1"/.test(idx));
ok('so is the typed pick list', !/id="simPickYou"/.test(idx) && !/id="simPickCandidates"/.test(idx));
ok('so is the typed bracket', !/id="bracketInputArea"/.test(idx) && !/brk_s/.test(idx));
ok('Event Scout itself still works', /onclick="runEventScout\(\)"/.test(idx) && /async function runEventScout/.test(src));
for (const fn of ['runSimulation', 'runPickList', 'runBracket', 'simMode', 'bracketReadInput',
                  'bracketBuildInput', 'pickLoadAndRank', 'bracketClear', 'clearSimulation',
                  'sim_render', 'sim_runMonteCarlo']) {
  ok(`${fn} went with the UI it served`, !new RegExp('\\b' + fn + '\\b').test(src));
}
ok('the remembered sub-mode is cleared rather than left to rot',
  /lsRemove\('vex_sim_mode'\);/.test(src));
ok('the maths the new views need is still there',
  ['sim_buildRatingsFromEvent', 'sim_allianceStats', 'sim_matchupProb', 'sim_bracket', 'sim_seedOrder']
    .every(f => new RegExp('function ' + f + '\\(').test(src)));

{
  const { win, errors, stop } = await boot();
  win.switchTab('simulator');
  await settle(win, 400);
  ok('the tab still opens', win.document.getElementById('tab-simulator').classList.contains('active'));
  ok('...with the Event Scout controls on it', !!win.document.getElementById('simEscoutYou'));
  ok('nothing threw at boot', errors.length === 0, errors.join('\n'));
  stop();
}

console.log(`\nt94: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
