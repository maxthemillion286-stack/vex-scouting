// t81 — the Teams tab loads its own data, and never shows another event's.
//
// Reported from a phone: "I typed in my team number and looked at the teams of
// an event I signed up to and it showed no teams — I had to manually go to the
// event."
//
// Two separate defects, both in the same variable.
//
// 1. NOT LOADED. Entering an event by team number is a different door from
//    entering it by name or SKU. The team-number door calls
//    renderEventTeamMatchesView() and goes straight to that team's matches —
//    it never runs loadAndRenderTeamList(), which is the only thing that fills
//    tournamentTeamCache. Pressing "Teams" then called renderTournamentTeams()
//    directly, which renders the cache and nothing else, so the tab drew an
//    empty grid under "0 High School teams registered". Every OTHER sub-view
//    (matches, skills, awards) already lazy-loads on a null cache; teams alone
//    assumed someone else had done the work. §11 exactly: a path that returns
//    before reaching the code that would have worked.
//
// 2. THE PREVIOUS EVENT'S TEAMS. tournamentTeamCache was module-level and was
//    NOT reset in loadTournamentTeams() alongside the match/skills/awards/
//    rolldown caches. So open event A by name, then search a team number and
//    open event B: the Teams tab showed A's teams under B's name — worse than
//    empty, because it looks right.
//
// And the reason an empty list is plausible even when loading works: the GRADE
// dropdown defaults to High School, so a Middle School team opening its own
// event filters every team out. A team-number search knows the grade outright.
import fs from 'fs';
let pass = 0, fail = 0;
const ok = (n, c, e) => { c ? (pass++, console.log('  ok   ' + n)) : (fail++, console.log('  FAIL ' + n + (e ? '\n         ' + e : ''))); };
const idx = fs.readFileSync('../index.html', 'utf8');
const src = idx.match(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/)[1];

console.log('t81 — the Teams tab loads, and belongs to the event on screen');

// ── 1. null means "not loaded", [] means "loaded and empty" ──
ok('the cache starts as null, not an empty array',
  /let tournamentTeamCache = null;/.test(src),
  '[] is indistinguishable from "this event has no teams"');
ok('the distinction is written down', /null means NOT LOADED YET/.test(src));

// ── 2. Opening any event clears it ──
const load = src.slice(src.indexOf('async function loadTournamentTeams'),
                       src.indexOf('// Renders match list for the focused team'));
ok('loadTournamentTeams exists', load.length > 200);
for (const c of ['tournamentMatchCache', 'tournamentSkillsCache', 'tournamentAwardsCache',
                 'tournamentRolldownCache', 'tournamentTeamCache']) {
  ok(`${c} is reset when a new event opens`, new RegExp(c + ' = null;').test(load));
}

// ── 3. The Teams tab loads on demand, like its siblings ──
const go = src.slice(src.indexOf('function tournamentGo(view)'),
                     src.indexOf('function tournamentGo(view)') + 700);
ok('the teams route loads when the cache is empty',
  /view === 'teams'[\s\S]{0,120}tournamentTeamCache \? renderTournamentTeams\(\) : loadAndRenderTeamList\(\)/.test(go));
ok('it still just re-renders when the cache is warm',
  /tournamentTeamCache \? renderTournamentTeams\(\)/.test(go),
  'reloading on every tab press would refetch rankings for every division');

// The decision itself.
const route = new Function('cache', "return cache ? 'render' : 'load';");
ok('arriving from a team-number search loads', route(null) === 'load');
ok('an event that genuinely has no teams does not reload', route([]) === 'render');
ok('a warm cache renders', route([{ number: '66449A' }]) === 'render');

// ── 4. The renderer cannot be handed a null ──
const render = src.slice(src.indexOf('function renderTournamentTeams()'),
                         src.indexOf('function onTournamentTeamClick'));
ok('the render reads through a guarded local',
  /const cache = tournamentTeamCache \|\| \[\];/.test(render));
ok('nothing spreads the raw global any more',
  !/\[\.\.\.tournamentTeamCache\]/.test(render) && !/tournamentTeamCache\.map/.test(render));

// ── 5. An empty list explains itself instead of being a dead end ──
ok('the empty case renders through the normal path',
  /tournamentTeamCache = \[\];[\s\S]{0,300}renderTournamentTeams\(\);/.test(src),
  'a bare message stranded you with no nav back to Matches');
ok('the bare early-return message is gone',
  !/No \$\{grade\} teams found at this event\./.test(src));
ok('the empty state says which grade it filtered on',
  /No \$\{esc\(tournamentGrade\)\} teams are registered at this event\./.test(render),
  'escaped since t91 — the message itself is unchanged');
ok('it names the grade dropdown as the likely cause',
  /switch GRADE at the top/.test(render));
ok('it counts the teams the filter removed',
  /let tournamentTeamsOtherGrades = 0;/.test(src) &&
  /tournamentTeamsOtherGrades = teams\.length;/.test(src));
ok('the count is cleared when the filter did not empty the list',
  /tournamentTeamsOtherGrades = 0;/.test(src.slice(src.indexOf('async function loadAndRenderTeamList'))),
  'a stale count would blame the grade filter on an unrelated event');
ok('the nav is still rendered when the list is empty',
  /\$\{tournamentNav\('teams'\)\}/.test(render));

// Bulk actions over nothing are meaningless.
ok('COPY ALL is hidden when there is nothing to copy',
  /teams\.length === 0 \? '' : `\s*<button class="btn btn-secondary" onclick="copyTournamentTeams/.test(render));
ok('SCOUT ALL 0 is not offered', /teams\.length === 0 \? '' : teams\.length <= 150/.test(render));
ok('the click-to-scout hint is hidden too',
  /teams\.length === 0 \? '' : `\s*<div class="info-bar">/.test(render));

// ── 6. A team-number search knows the grade — it should use it ──
const find = src.slice(src.indexOf('async function findTournament'),
                       src.indexOf('// Selection set for tournament teams'));
ok('the grade select is set from the team that was searched',
  /const teamGrade = gradeOfTeam\(team\);/.test(find));
ok('it is only set to a value the dropdown actually has',
  /\.find\(o => gradeNorm\(o\.value\) === teamGrade\)/.test(find) &&
  /gradeSel\.value = opt\.value;/.test(find),
  'assigning an absent value silently blanks a <select>');
// t85 covers why the compare is normalised: an exact one missed a grade the API
// spelled differently and left the team on a list filtered to nothing.
ok('the match is not decided by casing',
  /gradeNorm\(o\.value\)/.test(find));
ok('the change event fires so the styled select repaints',
  /gradeSel\.dispatchEvent\(new Event\('change', \{ bubbles: true \}\)\)/.test(find));

const pick = new Function('teamGrade', 'options', 'current',
  "return (teamGrade && options.includes(teamGrade)) ? teamGrade : current;");
const OPTS = ['High School', 'Middle School'];
ok('a Middle School team flips the dropdown off the High School default',
  pick('Middle School', OPTS, 'High School') === 'Middle School',
  'this is the case that filtered every team out of the list');
ok('a High School team leaves it alone', pick('High School', OPTS, 'High School') === 'High School');
ok('a grade the dropdown does not offer is ignored, not assigned',
  pick('College', OPTS, 'High School') === 'High School');
ok('a team with no grade recorded changes nothing',
  pick('', OPTS, 'Middle School') === 'Middle School');

// ── 7. Actually run the renderer ──
//
// This used to pull renderTournamentTeams() out with `new Function` and inject
// the globals it touches by hand. That broke on every release that gave the
// function one more global to read — four times — and each break was the TEST
// being stale, never the code. The harness runs the real page, so the list of
// globals stops being this file's problem.
{
  const { boot, settle, html, FIXTURES, pickGrade } = await import('./harness.mjs');

  // Loaded and empty: the state that used to render a bare grid with no
  // explanation and no way back.
  //
  // Reaching it now takes a DELIBERATE filter — since v49 an event that is
  // entirely one grade opens on that grade, so it can no longer look empty by
  // accident. That is the point of the change, and this still has to work for
  // the case where someone asks for a grade nobody at the event is in.
  {
    const keep = FIXTURES.teams;
    FIXTURES.teams = [{ id: 9003, number: '12345B', team_name: 'Middle Bots', grade: 'Middle School' }];
    const { win, stop } = await boot();
    win.switchTab('tournament');
    await win.loadTournamentTeams(55001, 'Bots @ Bristol', null, '', 'RE-V5RC-25-0191');
    await settle(win, 300);
    ok('an all-Middle-School event opens on Middle School, not empty',
      win.document.getElementById('tournamentGradeSelect').value === 'Middle School' &&
      html(win, 'tournamentResults').includes('12345B'));
    await pickGrade(win, 'High School');
    const h = html(win, 'tournamentResults');
    ok('rendered empty: says which grade it filtered on', /No High School teams are registered/.test(h));
    ok('rendered empty: points at the GRADE dropdown', /switch GRADE at the top/.test(h));
    ok('rendered empty: counts the teams in the other grade', /1 team in the other grade/.test(h));
    ok('rendered empty: the nav survives, so it is not a dead end', /t-nav/.test(h));
    ok('rendered empty: does not offer SCOUT ALL 0', !/SCOUT ALL 0/.test(h));
    ok('rendered empty: does not offer COPY ALL', !/COPY ALL/.test(h));
    ok('rendered empty: drops the click-to-scout hint', !/Click to scout/.test(h));
    stop();
    FIXTURES.teams = keep;
  }

  // Loaded and populated.
  {
    const { win, stop } = await boot();
    win.switchTab('tournament');
    await win.loadTournamentTeams(55001, 'Bots @ Bristol', null, '', 'RE-V5RC-25-0191');
    await settle(win, 300);
    const h = html(win, 'tournamentResults');
    ok('rendered warm: the teams are listed', /66449A/.test(h));
    ok('rendered warm: SCOUT ALL is offered', /SCOUT ALL \d/.test(h));
    ok('rendered warm: no empty-state message', !/are registered at this event/.test(h));
    stop();
  }

  // The shape the original bug produced: the Teams tab reached with nothing
  // loaded. It must load rather than render an empty grid.
  {
    const { win, stop } = await boot();
    win.switchTab('tournament');
    await win.loadTournamentTeams(55001, 'Bots @ Bristol', 9001, '66449A', 'RE-V5RC-25-0191');
    await settle(win, 200);
    await win.tournamentGo('teams');
    await settle(win, 300);
    ok('an unloaded Teams tab loads instead of rendering nothing',
      /66449A/.test(html(win, 'tournamentResults')));
    stop();
  }
}

console.log(`\nt81: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
