// t85 — three things reported together after an event that had just ended:
// teams missing from the list, a schedule that never updated itself, and a
// team left highlighted for no reason.
//
// 1. MISSING TEAMS. The list filtered with
//        (t.grade || '').trim() === grade
//    an exact string match against the dropdown's 'High School'. A team whose
//    grade came back in another case, or did not come back at all — common on a
//    roster that has just been finalised — was dropped from the list entirely,
//    and the count line then reported the smaller number as fact. Nothing on
//    screen said anyone was missing. A blank grade is not evidence of the other
//    grade, so it no longer removes anybody.
//
// 2. A SCHEDULE THAT DID NOT MOVE. Nothing in the app ever refetched anything.
//    Open the Matches view at a running event and it showed the schedule as it
//    was when you opened it, for as long as you left it there. The proxy was
//    already built for this — /matches and /rankings carry a 15s TTL and are
//    excluded from edge caching precisely so a refresh is function-fresh — the
//    client just never asked again.
//
// 3. A RANDOM HIGHLIGHT. Not random: :hover. A touch device has no hover but
//    latches the state onto the last element tapped and holds it until
//    something else is tapped, so the team you opened earlier is still lit when
//    you come back. Every :hover rule is now behind @media (hover: hover).
import fs from 'fs';
import { boot, settle, html, FIXTURES } from './harness.mjs';
let pass = 0, fail = 0;
const ok = (n, c, e) => { c ? (pass++, console.log('  ok   ' + n)) : (fail++, console.log('  FAIL ' + n + (e ? '\n         ' + e : ''))); };
const idx = fs.readFileSync('../index.html', 'utf8');
const src = idx.match(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/)[1];
const iso = ms => new Date(ms).toISOString();
const NOW = Date.now();

console.log('t85 — missing teams, live tracking, the stuck highlight');

// ══ 1. Nobody is dropped for a grade the API did not spell our way ══
const gradeNorm = new Function('g', "return String(g == null ? '' : g).toLowerCase().replace(/\\s+/g, ' ').trim();");
const gradeMatches = new Function('teamGrade', 'want', `
  const n = (g) => String(g == null ? '' : g).toLowerCase().replace(/\\s+/g, ' ').trim();
  const w = n(want); if (!w || w === 'all') return true;
  const g = n(teamGrade); if (!g) return true; return g === w;`);

ok('the helpers exist', /function gradeNorm\(g\)/.test(src) && /function gradeMatches\(teamGrade, want\)/.test(src));
ok('the exact-match filter is gone',
  !/const g = \(t\.grade \|\| t\.grade_level \|\| t\.gradeLevel \|\| ''\)\.trim\(\);/.test(src));
ok('the list filters through it', /teams\.filter\(t => gradeMatches\(gradeOfTeam\(t\), grade\)\)/.test(src));

ok('an exact grade still matches', gradeMatches('High School', 'High School') === true);
ok('the other grade is still excluded', gradeMatches('Middle School', 'High School') === false);
ok('case no longer decides it', gradeMatches('high school', 'High School') === true);
ok('nor does spacing', gradeMatches('  High   School ', 'High School') === true);
ok('a missing grade is kept, not guessed at', gradeMatches(null, 'High School') === true);
ok('an empty grade too', gradeMatches('', 'High School') === true);
ok('"All" keeps everyone', gradeMatches('Middle School', 'All') === true);
ok('so does an unset dropdown', gradeMatches('Middle School', '') === true);
ok('a grade the dropdown does not offer is still excluded when known',
  gradeMatches('College', 'High School') === false);

ok('the count line admits when a grade could not be read',
  /with no grade listed, shown anyway/.test(src));
ok('the ungraded tally is per-event state, reset with the rest',
  /let tournamentUngraded = 0;/.test(src) && /tournamentUngraded = filtered\.filter/.test(src));
ok('the team-number search matches grade the same way',
  /gradeNorm\(o\.value\) === teamGrade/.test(src),
  'an exact compare there put a team on a list filtered to nothing');

// Driven: five teams, three of them with a grade the old filter would reject.
{
  const keep = FIXTURES.teams;
  FIXTURES.teams = [
    { id: 9001, number: '1STPLACE', team_name: 'Rank One', grade: 'High School' },
    { id: 9002, number: '2NDPLACE', team_name: 'Rank Two' },                          // none at all
    { id: 9003, number: '3RDPLACE', team_name: 'Rank Three', grade: 'High School ' }, // trailing space
    { id: 9004, number: '4THPLACE', team_name: 'Rank Four', grade: 'high school' },   // lowercase
    { id: 9005, number: '5THPLACE', team_name: 'Rank Five', grade: 'Middle School' }  // genuinely other
  ];
  const { win, stop } = await boot();
  win.switchTab('tournament');
  await win.loadTournamentTeams(55001, 'Ended Today', null, '', 'RE-V5RC-25-0191');
  await settle(win, 300);
  const h = html(win, 'tournamentResults');
  for (const n of ['1STPLACE', '2NDPLACE', '3RDPLACE', '4THPLACE']) {
    ok(`${n} is on the list`, h.includes(n), 'the old filter dropped it silently');
  }
  ok('a team that really is the other grade is still filtered out', !h.includes('5THPLACE'));
  ok('the count matches what is shown', /4 High School teams registered/.test(h),
    (h.match(/summary-count">([^<]*)</) || [])[1]);
  ok('and it says one had no grade', /1 with no grade listed/.test(h));
  stop();
  FIXTURES.teams = keep;
}

// ══ 2. Live tracking ══
ok('a poll interval is defined', /const RW_LIVE_POLL_MS = 30 \* 1000;/.test(src));
ok('only the views that show live data poll',
  /const RW_LIVE_VIEWS = \['matches', 'teams', 'team'\];/.test(src));
ok('a tick is skipped while the tab is hidden', /if \(document\.hidden\) return;/.test(src));
ok('a tick is skipped once the event is over', /if \(!tournamentIsLive\(\)\) \{ tournamentLiveStop\(\); return; \}/.test(src));
ok('overlapping ticks are refused', /if \(tournamentLiveBusy\) return;/.test(src));
ok('leaving the tournament tab stops it',
  /if \(tabName !== 'tournament'\) tournamentLiveStop\(\);/.test(src));
ok('coming back to the screen catches up early',
  /visibilitychange[\s\S]{0,400}Date\.now\(\) - tournamentLiveAt >= RW_LIVE_POLL_MS/.test(src));
ok('a dropped refresh is noted, not thrown at the user',
  /vsNote\('live', String\(e && e\.message \|\| e\)\)/.test(src),
  'venue wifi drops constantly; the next tick picks it up');
ok('only the caches that go stale are dropped',
  /tournamentMatchCache = null;\s*\n\s*tournamentTeamCache = null;\s*\n\s*tournamentLiveAt/.test(src),
  'rebuilding the rolldown every 30s would cost more than it is worth');
ok('the window is recorded from the detail call the views already make',
  (src.match(/tournamentNoteWindow\(ev/g) || []).length >= 2);
ok('it is cleared when a different event opens',
  /tournamentEventWindow = null;\s*\n\s*tournamentLiveAt = 0;\s*\n\s*tournamentLiveStop\(\);/.test(src));

const isLive = new Function('w', 'now', `
  if (!w || !w.startMs) return false;
  const from = w.startMs - 60 * 60 * 1000;
  const to = (w.endMs || w.startMs) + 25 * 60 * 60 * 1000;
  return now >= from && now <= to;`);
const W = (sh, eh) => ({ startMs: NOW + sh * 3600e3, endMs: NOW + eh * 3600e3 });
ok('an event running right now is live', isLive(W(-4, 4), NOW) === true);
ok('an event that ended three hours ago is still live', isLive(W(-30, -3), NOW) === true,
  'finals and award entry run past the published end time — this is the reported case');
ok('an event that ended last week is not', isLive(W(-192, -168), NOW) === false);
ok('an event starting in ten minutes is live', isLive(W(-0.1, 8), NOW) === true);
ok('an event next month is not', isLive(W(720, 728), NOW) === false);
ok('no window at all is not live', isLive(null, NOW) === false);

// Driven: badge present on a running event, absent once it is over, and a tick
// actually refetches.
{
  const s0 = FIXTURES.event.start, e0 = FIXTURES.event.end;
  FIXTURES.event.start = iso(NOW - 4 * 3600e3);
  FIXTURES.event.end = iso(NOW + 4 * 3600e3);
  const { win, router, stop } = await boot();
  win.switchTab('tournament');
  await win.loadTournamentTeams(55001, 'Live Event', null, '', 'RE-V5RC-25-0191');
  await settle(win, 300);
  ok('a running event shows the LIVE badge on the team list', /t-live/.test(html(win, 'tournamentResults')));
  await win.tournamentGo('matches');
  await settle(win, 250);
  ok('...and on the schedule', /t-live/.test(html(win, 'tournamentResults')));
  const before = router.seen.length;
  await win.tournamentLiveTick(true);
  await settle(win, 250);
  ok('a tick actually refetches', router.seen.length > before,
    `+${router.seen.length - before} requests`);
  stop();

  FIXTURES.event.start = iso(NOW - 8 * 86400e3);
  FIXTURES.event.end = iso(NOW - 7 * 86400e3);
  const done = await boot();
  done.win.switchTab('tournament');
  await done.win.loadTournamentTeams(55001, 'Finished Event', null, '', 'RE-V5RC-25-0191');
  await settle(done.win, 300);
  ok('a finished event shows no badge', !/t-live/.test(html(done.win, 'tournamentResults')));
  const b2 = done.router.seen.length;
  await done.win.tournamentLiveTick();
  await settle(done.win, 200);
  ok('...and refuses to poll', done.router.seen.length === b2, 'a final schedule does not change');
  done.stop();

  FIXTURES.event.start = s0; FIXTURES.event.end = e0;
}

// ══ 3. The highlight that was not random ══
const hoverLines = idx.split('\n').filter(l => /:hover/.test(l));
const unguarded = hoverLines.filter(l => !/@media \(hover: hover\)/.test(l) && !/^\s*\./.test(l) === false
  && !/@media \(hover: hover\)/.test(l));
ok('there are hover rules to guard', hoverLines.length > 20, hoverLines.length + ' found');
const bare = hoverLines.filter(l => !l.includes('@media (hover: hover)') && l.includes('{'));
ok('every self-contained hover rule is behind a real pointer', bare.length === 0,
  bare.slice(0, 4).map(l => l.trim()).join('\n         '));
ok('the reason is written down', /it LATCHES the state onto the last thing/.test(idx));
ok('the tappable ones specifically are covered',
  /@media \(hover: hover\) \{ \.tournament-team-tag:hover/.test(idx) &&
  /@media \(hover: hover\) \{ \.tournament-item:hover/.test(idx) &&
  /@media \(hover: hover\) \{ \.rw-event:hover/.test(idx));
ok('deliberate selection styling is untouched — it is not a hover state',
  /\.tournament-team-tag\.selected \{/.test(idx) &&
  !/@media \(hover: hover\) \{ \.tournament-team-tag\.selected/.test(idx));

// The badge animation has an off switch.
ok('the live dot respects prefers-reduced-motion',
  /@media \(prefers-reduced-motion: reduce\) \{ \.t-live-dot \{ animation: none; \} \}/.test(idx));

// ══ 4. Rank gaps at a mixed-grade event ══
//
// Reported as a follow-up: "when I sort by rank I'm still missing teams 1, 2
// and 9". They were not missing from the data. At a community event both grades
// often play in ONE division, so the division's rankings cover every team while
// the list is filtered to one grade — leaving holes exactly where the other
// grade ranked, and nothing on screen to say so.
//
// Two fixes: the dropdown gains the All Grades option it was missing (the
// filter already understood 'All'), and the list says which ranks it removed.
ok('the dropdown offers All Grades',
  /<option value="All">All Grades<\/option>/.test(idx),
  "gradeMatches already understood 'All'; nothing could select it");
ok('the hidden Scout shim offers it too, so the value survives the hand-off',
  /id="scoutGradeSelect"[^>]*>[\s\S]{0,260}<option value="All">All Grades<\/option>/.test(idx));
ok('the hidden ranks are tracked', /let tournamentHiddenRanks = \[\];/.test(src));
ok('they come from the teams the filter removed, not from a guess',
  /teams\s*\n\s*\.filter\(t => !shown\.has\(t\.id\)\)\s*\n\s*\.map\(t => rankByTeamId\[t\.id\]\?\.eventRank\)/.test(src));
ok('they are listed in rank order', /\.sort\(\(a, b\) => a - b\)/.test(src));
ok('the note names them', /hidden by the GRADE filter/.test(src));
ok('and offers the switch in one tap', /onclick="tournamentShowAllGrades\(\)"/.test(src));
ok('the switch reloads rather than re-rendering a stale cache',
  /function tournamentShowAllGrades\(\)[\s\S]{0,240}tournamentTeamCache = null;[\s\S]{0,60}loadAndRenderTeamList\(\)/.test(src));
ok('a mixed list marks which grade each team is',
  /const mixedGrades = new Set\(cache\.map\(t => t\.grade\)\.filter\(Boolean\)\)\.size > 1;/.test(src) &&
  /class="tt-grade"/.test(src));
ok('"All" is not printed as if it were a grade name',
  /gradeNorm\(tournamentGrade\) === 'all' \? '' : tournamentGrade \+ ' '/.test(src));

// Assigning a value a <select> has no option for blanks it — which is how a
// grade could silently become ''.
ok('a shared helper guards every grade hand-off', /function setSelectValue\(el, value\)/.test(src));
ok('it refuses a value with no matching option', /if \(!opt\) return false;/.test(src));
ok('the two Scout hand-offs use it',
  (src.match(/setSelectValue\(document\.getElementById\('scoutGradeSelect'\), grade\)/g) || []).length === 2);

const setSel = new Function('el', 'value', `
  const n = (g) => String(g == null ? '' : g).toLowerCase().replace(/\\s+/g, ' ').trim();
  if (!el || value == null || value === '') return false;
  const opt = [...el.options].find(o => o.value === value) || [...el.options].find(o => n(o.value) === n(value));
  if (!opt) return false; el.value = opt.value; return true;`);
const fakeSel = (vals) => ({ options: vals.map(v => ({ value: v })), value: vals[0] });
{
  const el = fakeSel(['High School', 'Middle School', 'All']);
  ok('a present value is assigned', setSel(el, 'All') === true && el.value === 'All');
  const el2 = fakeSel(['High School', 'Middle School']);
  ok('an absent value is refused, leaving the select alone',
    setSel(el2, 'All') === false && el2.value === 'High School',
    'the bare assignment set it to "" instead');
  const el3 = fakeSel(['High School', 'Middle School']);
  ok('casing still resolves', setSel(el3, 'middle school') === true && el3.value === 'Middle School');
}

// Under All Grades a single standings call would rank a Middle School team
// against High School.
ok('All Grades reads both sets of world standings',
  /getFullSeasonSkills\(seasonId, 'High School'\)[\s\S]{0,160}getFullSeasonSkills\(seasonId, 'Middle School'\)/.test(src));
ok('...and looks each team up in its own',
  /const book = \(tGrade === 'middle school' && seasonSkillsMs\) \? seasonSkillsMs : seasonSkills;/.test(src));

// Driven: the exact reported shape — mixed grades, one division.
{
  const keepT = FIXTURES.teams, keepD = FIXTURES.event.divisions;
  FIXTURES.teams = [
    { id: 1, number: 'AAA', grade: 'Middle School' },
    { id: 2, number: 'BBB', grade: 'Middle School' },
    { id: 3, number: 'CCC', grade: 'High School' },
    { id: 4, number: 'DDD', grade: 'High School' },
    { id: 9, number: 'III', grade: 'Middle School' }
  ];
  FIXTURES.rankOf = t => t.id;          // rank == id, so the gaps are 1, 2 and 9
  FIXTURES.event.divisions = [{ id: 1, name: null }];

  const { win, stop } = await boot();
  win.switchTab('tournament');
  await win.loadTournamentTeams(55001, 'Maker Faire Day 1', null, '', 'RE-V5RC-25-0191');
  await settle(win, 300);
  let h = html(win, 'tournamentResults');
  ok('the High School view says teams are hidden', /t-hidden-note/.test(h));
  ok('...and names the exact ranks that are gone', /including ranks\s*1, 2, 9/.test(h.replace(/\s+/g, ' ')),
    (h.match(/t-hidden-note">([\s\S]*?)<button/) || [])[1]);

  await win.tournamentShowAllGrades();
  await settle(win, 300);
  h = html(win, 'tournamentResults');
  for (const n of ['AAA', 'BBB', 'CCC', 'DDD', 'III']) {
    ok(`${n} is on the All Grades list`, h.includes('>' + n + '<'));
  }
  ok('the count says all grades', /5 teams registered · all grades/.test(h),
    (h.match(/summary-count">([^<]*)</) || [])[1]);
  ok('each card is marked MS or HS', (h.match(/tt-grade">(MS|HS)</g) || []).length === 5);
  ok('the note is gone, because nothing is hidden any more', !/t-hidden-note/.test(h));
  stop();

  FIXTURES.teams = keepT; FIXTURES.event.divisions = keepD; delete FIXTURES.rankOf;
}

console.log(`\nt85: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
