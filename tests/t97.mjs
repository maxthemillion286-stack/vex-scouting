// t97 — the bracket is a bracket.
//
// Asked for directly: "for the bracket in tournament i want it to look like a
// literal bracket that we previously had just with the ability to predicate."
//
// Before eliminations start the view used to render a FLAT LIST of first-round
// pairings. It answered one question — who do I open against — and left the
// shape of the event invisible. A bracket drawn as a list is not a bracket.
//
// Two halves, then:
//   · the projected bracket is the same tree the played one uses — columns,
//     round labels, .bracket-match boxes, and SVG connector lines through them
//   · the played bracket predicts the slots nobody has played yet
//
// And one thing that is easy to get wrong and impossible to see: the tree is
// laid out over BRACKET SLOTS, not over the alliance count. Six alliances play
// inside eight slots, and seeds 1 and 2 get byes. Get that wrong and the
// pairings are nonsense while still looking plausible.
import fs from 'fs';
import { boot, settle, html, FIXTURES } from './harness.mjs';
let pass = 0, fail = 0;
const ok = (n, c, e) => { c ? (pass++, console.log('  ok   ' + n)) : (fail++, console.log('  FAIL ' + n + (e ? '\n         ' + e : ''))); };

const idx = fs.readFileSync('../index.html', 'utf8');
const src = idx.match(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/)[1];
const css = idx.slice(0, idx.indexOf('</style>'));

console.log('t97 — the projected bracket is a tree, and the played one predicts');

// ══ 1. The shape is computed apart from the markup ══════════════════════════
console.log('\n· the tree');
ok('the tree is built by a function of its own', /function tProjectedBracket\(alliances\)/.test(src),
  'shape and markup in one function cannot be checked separately');
ok('it is laid out over bracket SLOTS, not the alliance count',
  /const slots = sim_bracketSlots\(n\);/.test(src) && /const order = sim_seedOrder\(slots\);/.test(src));
ok('a slot past the end of the field is a bye',
  /order\.map\(i => i < n \? \{ seed: i \+ 1, a: alliances\[i\] \} : null\)/.test(src));
ok('rounds are named from how many matches they hold',
  /T_ROUND_BY_MATCHES/.test(src) && /1: 'Finals'/.test(src) && /4: 'Quarterfinals'/.test(src));
ok('the flat list it replaced is gone', !/First round, if seeding held/.test(idx));

// ══ 2. It renders as a tree, in a browser-shaped DOM ════════════════════════
console.log('\n· drawn before eliminations start');
{
  const keepT = FIXTURES.teams, keepP = FIXTURES.playedThrough;
  FIXTURES.playedThrough = 4;                    // no eliminations yet
  // Twelve teams → six modelled alliances → an eight-slot bracket with two
  // byes, which is the case the slot arithmetic exists for.
  FIXTURES.teams = [...FIXTURES.teams,
    { id: 9004, number: '777Z', team_name: 'Zed',   grade: 'High School' },
    { id: 9005, number: '555A', team_name: 'Five',  grade: 'High School' },
    { id: 9006, number: '888B', team_name: 'Eight', grade: 'High School' },
    { id: 9007, number: '999C', team_name: 'Nine',  grade: 'High School' },
    { id: 9008, number: '222D', team_name: 'Two',   grade: 'High School' },
    { id: 9009, number: '333E', team_name: 'Three', grade: 'High School' },
    { id: 9010, number: '444F', team_name: 'Four',  grade: 'High School' },
    { id: 9011, number: '666G', team_name: 'Six',   grade: 'High School' },
    { id: 9012, number: '111H', team_name: 'One',   grade: 'High School' }];
  const { win, errors, stop } = await boot();
  win.switchTab('tournament');
  await win.loadTournamentTeams(55001, 'Bots @ Bristol', 9001, '66449A', 'RE-V5RC-25-0191');
  await settle(win, 800);
  await win.tournamentGo('bracket'); await settle(win, 2600);
  if (!win.tShowPred) { win.tTogglePred(); await settle(win, 3400); }

  const doc = win.document;
  const cols = [...doc.querySelectorAll('#tournamentResults .bracket-column')];
  ok('it draws columns, not rows', cols.length >= 3, cols.length + ' columns');
  const labels = cols.map(c => (c.querySelector('.bracket-round-label') || {}).textContent);
  ok('every column is a named round', labels.every(Boolean), JSON.stringify(labels));
  ok('the last column is the Finals', labels[labels.length - 1] === 'Finals', JSON.stringify(labels));
  // Each round holds half as many slots as the one before it. That is the
  // whole definition of a bracket, and the only check that would notice the
  // tree being built over the wrong count.
  const per = cols.map(c => c.querySelectorAll('.bracket-match').length);
  ok('each round is half the one before it',
    per.every((n, i) => i === 0 || n === per[i - 1] / 2), per.join(' → '));
  ok('the Finals is one match', per[per.length - 1] === 1, per.join(' → '));
  ok('two alliances of six get a bye',
    doc.querySelectorAll('#tournamentResults .bracket-bye-match').length === 2,
    doc.querySelectorAll('#tournamentResults .bracket-bye-match').length + ' byes');

  // Every match shows two sides whose chances add to 100.
  const played = [...doc.querySelectorAll('#tournamentResults .bracket-proj-match')];
  ok('every projected match has two sides', played.length > 0
    && played.every(m => m.querySelectorAll('.bracket-side').length === 2), played.length + ' matches');
  const sums = played.map(m => [...m.querySelectorAll('.bracket-proj-pct')]
    .reduce((t, e) => t + parseFloat(e.textContent), 0));
  ok('the two sides of a match add up to 100', sums.every(s => Math.abs(s - 100) <= 1), sums.join(', '));
  ok('exactly one side per match is favoured', played.every(m =>
    m.querySelectorAll('.bracket-side.favoured').length === 1));
  // The alliance carrying the focus team is marked, wherever it appears.
  ok('your own alliance is marked', doc.querySelectorAll('#tournamentResults .bracket-side.mine').length > 0);

  // The lines. Without these it is three columns floating apart — which is
  // exactly what shipped the first time, because the projected branch never
  // called the painter.
  ok('the connector overlay exists', !!doc.querySelector('#tournamentResults .bracket-svg-overlay'));
  ok('both branches paint through one helper', /function bracketPaint\(\)/.test(src));
  ok('the projected branch paints too',
    /resultsEl\.innerHTML = ph;\s*\n\s*bracketPaint\(\);/.test(src));

  // Said once, above the tree — v71's rule about unlabelled numbers.
  const h = html(win, 'tournamentResults');
  ok('the percentages are explained once', /chance of winning <strong>that match<\/strong>/.test(h));
  ok('and the later rounds are called a projection of the path',
    /a projection of the path, not of the winner/.test(h));
  ok('championship odds still sit below it', /Championship odds, projected/.test(h));
  ok('nothing threw', errors.length === 0, errors.join('\n'));
  stop();
  FIXTURES.teams = keepT; FIXTURES.playedThrough = keepP;
}

// ══ 3. The played bracket predicts what is left ═════════════════════════════
console.log('\n· a bracket part-way through');
ok('one helper decides whether a slot shows a number',
  /function bracketPred\(R, redTeams, blueTeams, salt\)/.test(src),
  'the single match and the best-of-3 must not disagree');
ok('it is gated on the switch', /if \(!tShowPred \|\| !R\) return null;/.test(src));
ok('a 0-0 that never started is not a result',
  /const played = sim_matchPlayed\(redA, blueA, match\);/.test(src));
ok('a series stops predicting once a game is in',
  /const anyPlayed = gameRows\.some\(g => g\.played\);/.test(src)
  && /const p = anyPlayed \? null : bracketPred\(/.test(src));
{
  const keep = FIXTURES.elimPending;
  FIXTURES.elimPending = 1;         // a final scheduled and not played
  const { win, errors, stop } = await boot();
  win.switchTab('tournament');
  await win.loadTournamentTeams(55001, 'Bots @ Bristol', 9001, '66449A', 'RE-V5RC-25-0191');
  await settle(win, 800);
  await win.tournamentGo('bracket'); await settle(win, 2400);

  const finalOf = () => [...win.document.querySelectorAll('#tournamentResults .bracket-match')]
    .find(m => /F #1/.test(m.textContent));
  let f = finalOf();
  ok('the unplayed final is in the bracket', !!f, 'fixture did not produce it');
  ok('with the switch off it shows no number', !!f && !/\d+%/.test(f.textContent),
    f && f.textContent.replace(/\s+/g, ' ').trim());

  win.tTogglePred(); await settle(win, 3400);
  f = finalOf();
  const pcts = f ? [...f.querySelectorAll('.bracket-proj-pct')].map(e => parseFloat(e.textContent)) : [];
  ok('with it on, both sides carry one', pcts.length === 2, JSON.stringify(pcts));
  ok('and they add to 100', pcts.length === 2 && Math.abs(pcts[0] + pcts[1] - 100) <= 1, pcts.join(' + '));
  ok('the label says what the number is', !!f && /chance to win/.test(f.textContent),
    f && f.textContent.replace(/\s+/g, ' ').trim());
  // The played rounds must be untouched: real scores, real winners.
  ok('played matches still show their scores',
    /\b143\b/.test(html(win, 'tournamentResults')));
  ok('and still mark the winner',
    win.document.querySelectorAll('#tournamentResults .bracket-side.winner').length >= 2);
  ok('nothing threw', errors.length === 0, errors.join('\n'));
  stop();
  FIXTURES.elimPending = keep;
}

// ══ 4. Watching what already happened ═══════════════════════════════════════
//
// Asked for directly: "for the bracket can you make a way to play the matches
// that happened in eliminations". The match list has had a ▶ since v40; the
// bracket — the view you actually open to see how a run went — had none.
console.log('\n· playing the elimination matches');
ok('one builder makes the buttons', /function bracketPlayButtons\(games\)/.test(src),
  'the single match and the best-of-3 must not grow separate copies');
ok('only played games get one', /\.filter\(g => g && g\.played && g\.id != null\)/.test(src));
ok('it reuses the match list\'s jump, not a second implementation',
  /bracketPlayButtons[\s\S]{0,700}jumpToMatch\('\$\{ev\}'/.test(src));
// v58's rule: the browser decodes entities BEFORE the JS parses, so anything
// interpolated into an inline onclick goes through teamAttr, not esc.
ok('the ids in the onclick are stripped, not merely escaped',
  /const ev = teamAttr\(tournamentEventId\);/.test(src)
  && /teamAttr\(g\.id\)/.test(src)
  && /const team = teamAttr\(tournamentFocusTeamNumber \|\| ''\);/.test(src));
{
  const keepP = FIXTURES.elimPending, keepB = FIXTURES.elimBestOf3;
  FIXTURES.elimPending = 1;       // a final scheduled, not played
  FIXTURES.elimBestOf3 = 1;       // QF #4 goes three games
  const { win, errors, stop } = await boot();
  win.switchTab('tournament');
  await win.loadTournamentTeams(55001, 'Bots @ Bristol', 9001, '66449A', 'RE-V5RC-25-0191');
  await settle(win, 800);
  await win.tournamentGo('bracket'); await settle(win, 2400);
  const doc = win.document;

  const boxFor = re => [...doc.querySelectorAll('#tournamentResults .bracket-match')]
    .find(m => re.test(m.textContent));
  const single = boxFor(/R16 #7/);
  const series = boxFor(/QF #4/);
  const pending = boxFor(/F #1/);

  ok('a played single match offers one button', !!single
    && single.querySelectorAll('.bracket-play').length === 1,
    single && single.querySelectorAll('.bracket-play').length + ' buttons');
  ok('and it is not numbered', !!single && !single.querySelector('.bracket-play-n'));
  ok('a best-of-3 offers one per game', !!series
    && series.querySelectorAll('.bracket-play').length === 3,
    series && series.querySelectorAll('.bracket-play').length + ' buttons');
  ok('numbered 1, 2, 3', !!series
    && [...series.querySelectorAll('.bracket-play-n')].map(e => e.textContent).join('') === '123');
  // Three buttons pointing at one match would be the easy bug here.
  {
    const ids = series ? [...series.querySelectorAll('.bracket-play')]
      .map(b => (b.getAttribute('onclick').match(/'(\d+)', '[^']*'\)/) || [])[1]) : [];
    ok('each game points at its own match', new Set(ids).size === 3, ids.join(', '));
  }
  ok('an unplayed match offers none', !!pending
    && pending.querySelectorAll('.bracket-play').length === 0);
  ok('the series label still shows who won it', !!series && /2-1/.test(series.textContent),
    series && series.textContent.replace(/\s+/g, ' ').trim());

  // End to end: pressing it leaves the Tournament tab for the Jumper.
  const before = win.document.querySelector('.tab-btn.active').dataset.tab;
  single.querySelector('.bracket-play').click();
  await settle(win, 600);
  const after = win.document.querySelector('.tab-btn.active').dataset.tab;
  ok('pressing one opens the Jumper', before === 'tournament' && after === 'rewatch',
    `${before} → ${after}`);
  ok('with the event carried over',
    (win.document.getElementById('rwEventInput') || {}).value === 'Bots @ Bristol');
  ok('and the team, so the Jumper can filter to its matches',
    (win.document.getElementById('rwTeamInput') || {}).value === '66449A');
  ok('nothing threw', errors.length === 0, errors.join('\n'));
  stop();
  FIXTURES.elimPending = keepP; FIXTURES.elimBestOf3 = keepB;
}
{
  // Nothing in a projected bracket has been played, so nothing offers a button.
  const keepP = FIXTURES.playedThrough;
  FIXTURES.playedThrough = 4;
  const { win, stop } = await boot();
  win.switchTab('tournament');
  await win.loadTournamentTeams(55001, 'Bots @ Bristol', 9001, '66449A', 'RE-V5RC-25-0191');
  await settle(win, 800);
  await win.tournamentGo('bracket'); await settle(win, 2400);
  if (!win.tShowPred) { win.tTogglePred(); await settle(win, 3400); }
  ok('a projected bracket offers nothing to watch',
    win.document.querySelectorAll('#tournamentResults .bracket-play').length === 0);
  stop();
  FIXTURES.playedThrough = keepP;
}
{
  const rule = (css.match(/\.bracket-match-label \{([^}]*)\}/) || [])[1] || '';
  ok('the label strip makes room for the buttons',
    /display: flex/.test(rule) && /space-between/.test(rule), rule);
  ok('the label yields before the buttons do',
    /\.bracket-label-text \{[^}]*text-overflow: ellipsis/.test(css)
    && /\.bracket-plays \{[^}]*flex-shrink: 0/.test(css));
}

// ══ 5. The projected sides are styled, not coloured red and blue ════════════
console.log('\n· the look');
// Alliances that have not been picked yet have no colour. Painting them red
// and blue would claim an assignment the event has not made.
{
  const rule = (css.match(/\.bracket-side\.bracket-proj \{([^}]*)\}/) || [])[1] || '';
  ok('a projected side has no alliance colour', /background: transparent/.test(rule), rule);
  ok('the favoured side is the one that carries a surface',
    /\.bracket-side\.bracket-proj\.favoured \{[^}]*background: var\(--card2\)/.test(css));
  ok('your own alliance keeps the accent rule it has everywhere else',
    /\.bracket-side\.bracket-proj\.mine[^{]*\{[^}]*inset 3px 0 0 var\(--accent\)/.test(css));
}
ok('the key is prose, in the body face',
  /\.bracket-key \{[^}]*font-family: var\(--body\)/.test(css)
  && /\.bracket-key \{[^}]*line-height: 1\.5/.test(css));
ok('the key leaves room before the odds below it',
  /\.bracket-key \{[^}]*margin: 10px 0 \d\dpx/.test(css));
ok('the percentages align digit for digit',
  /\.bracket-proj-pct \{[^}]*tabular-nums/.test(css));

console.log(`\nt97: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
