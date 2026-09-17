// t91 — fewer round trips, and text from the API is not markup.
//
// TWO THINGS, from an optimise-and-find-bugs pass.
//
// SPEED. Opening an event and walking Teams → Matches → the team view asked the
// API for the SAME event detail five times and every division's rankings three
// times. The proxy caches, so the answers were cheap — but the client still paid
// a round trip for each, and on venue wifi the round trip IS the cost. The
// Jumper has had a per-event memo since v30; the Tournament tab never did.
//
// Two loops were also `for` with an await inside, which is serial:
//   · per-division rankings — ten round trips end to end at Worlds
//   · per-team skills in the Simulator — ONE REQUEST PER TEAM, so an 80-team
//     event spent eighty round trips in series, behind a checkbox
//
// SAFETY. Team names, event names and award titles are typed by people — a team
// enters its own name when it registers — and every one went into innerHTML
// raw. A team called `<img src=x onerror=…>` would have run that in the browser
// of anyone opening an event it attended, with the page's localStorage and its
// /api/proxy session in reach.
import fs from 'fs';
import { boot, settle, html, FIXTURES } from './harness.mjs';
let pass = 0, fail = 0;
const ok = (n, c, e) => { c ? (pass++, console.log('  ok   ' + n)) : (fail++, console.log('  FAIL ' + n + (e ? '\n         ' + e : ''))); };
const idx = fs.readFileSync('../index.html', 'utf8');
const src = idx.match(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/)[1];

console.log('t91 — round trips, and API text as markup');

// ── 1. The memo ──
ok('the tournament tab has a per-event memo', /function tMemoReset\(eventId\)/.test(src));
ok('it is scoped to one event id', /if \(tMemoKey !== String\(eventId\)\) \{ tMemoKey = String\(eventId\); tMemo = \{\}; \}/.test(src));
ok('it REFUSES to answer for any other event',
  /if \(String\(eventId\) !== tMemoKey\) return fn\(\);/.test(src),
  'sim_buildRatingsFromEvent walks events the Tournament tab never opened');
ok('a failed lookup is not memoised', /fn\(\)\.catch\(e => \{ delete tMemo\[key\]; throw e; \}\)/.test(src));
ok('it is reset when an event opens', /tMemoReset\(eventId\);/.test(src));
ok('only the live half is dropped on a refresh',
  /if \(\/\^\(rank\|matches\):\/\.test\(k\)\) delete tMemo\[k\]/.test(src),
  'divisions, roster and dates do not change while you watch');
ok('the ratings snapshot goes with them',
  /_evCache\.delete\(Number\(tMemoKey\)\)/.test(src),
  'it is built FROM those matches and keeps its own 60s cache');
ok('the REFRESH button reaches past the memo',
  /function tournamentRefreshNow\(\)[\s\S]{0,140}tMemoDropLive\(\)/.test(src) &&
  /onclick="tournamentRefreshNow\(\)"/.test(src));
ok('the bracket stopped fetching the event detail by hand',
  !/eventDetailRes/.test(src), 'it was a raw fetch of what every other view memoises');

// ── 2. The serial loops ──
ok('rankings load in parallel',
  /await sim_pool\(divisions, async div => \{[\s\S]{0,200}tDivRankings\(eventId, div\.id\)/.test(src),
  'ten divisions at Worlds were ten round trips end to end');
ok('...and still report progress', /LOADING RANKINGS — \$\{\+\+loaded\}\/\$\{divisions\.length\} DIVISIONS/.test(src));
// The per-team skills loop this used to guard lived inside runSimulation's
// "include robot skills" path. v66 moved match prediction into the Tournament
// tab, where the event's ratings are already built, and runSimulation went with
// the typed-in Simulator. There is no per-team skills fetch left to parallelise.
ok('the per-team skills loop went with the feature that owned it',
  !/seenIds/.test(src) && !/PULLING ROBOT SKILLS/.test(src),
  'it was runSimulation\'s, and runSimulation is gone');
ok('...and the loop it was fixed from has not come back anywhere',
  !/for \(const \w+ of \w+\) \{[\s\S]{0,140}await apiGet\(`\/teams\//.test(src));
ok('no `for` loop is left awaiting an apiGet per item',
  !/for \(const tid of seenIds\) \{[\s\S]{0,120}await apiGet/.test(src));

// ── 2b. Work that was done twice ──
ok('a season of skills standings shares its in-flight promise',
  /const skillsInflight = \{\};[\s\S]{0,400}skillsInflight\[cacheKey\] = getFullSeasonSkillsUncached/.test(src),
  'ten thousand rows fetched and aggregated once per concurrent caller');
ok('...and lets go when it settles, so a failure is not sticky',
  /\.finally\(\(\) => \{ delete skillsInflight\[cacheKey\]; \}\)/.test(src));
ok('the resolved value is still returned straight away',
  /if \(skillsCache\[cacheKey\]\) return Promise\.resolve\(skillsCache\[cacheKey\]\);/.test(src));

// The service worker's API cache had no ceiling.
{
  const sw = fs.readFileSync('../sw.js', 'utf8');
  ok('the API cache is capped', /const API_CACHE_MAX = \d+;/.test(sw),
    'it grew until the browser evicted the origin, app shell included');
  ok('...oldest first', /keys\.slice\(0, keys\.length - API_CACHE_MAX\)/.test(sw));
  ok('...and only the API cache, never the app shell',
    /if \(cacheName !== API_CACHE \|\| trimming\) return;/.test(sw));
  ok('the trim runs after a write, not on a timer',
    /cache\.put\(request, copy\)\.then\(\(\) => trim\(cache, cacheName\)\)/.test(sw));
}

// ── 3. Escaping ──
ok('an escaper exists', /const esc = \(v\) => String\(v == null \? '' : v\)/.test(src));
ok('it covers all five', ['&amp;', '&lt;', '&gt;', '&quot;', '&#39;'].every(e => src.includes(e)));
const esc = new Function('v', "return String(v == null ? '' : v).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\"/g,'&quot;').replace(/'/g,'&#39;');");
ok('a tag becomes text', esc('<img src=x onerror=alert(1)>') === '&lt;img src=x onerror=alert(1)&gt;');
ok('ampersands go first, so nothing double-escapes', esc('R&D <b>') === 'R&amp;D &lt;b&gt;');
ok('null is empty, not "null"', esc(null) === '' && esc(undefined) === '');
ok('an ordinary name is untouched', esc('Rolling Robots Ravens') === 'Rolling Robots Ravens');

ok('a separate rule for inline handlers', /const teamAttr = \(n\) =>/.test(src));
ok('...because entities decode BEFORE the JavaScript parses',
  /decodes entities BEFORE the JavaScript is parsed/.test(src),
  'esc() is the wrong tool there — an escaped quote comes back as a quote');
const teamAttr = new Function('n', "return String(n == null ? '' : n).replace(/[^A-Za-z0-9-]/g,'');");
ok('a real team number survives', teamAttr('66449A') === '66449A');
ok('a quote cannot close the handler', teamAttr("6A',alert(1),'") === '6Aalert1');
ok('every inline team number goes through it',
  (src.match(/teamAttr\(/g) || []).length >= 8,
  'the scout buttons, the skills rows, the team tags, the ladder');
ok('and a looser rule for arguments that hold a space or a comma',
  /const listAttr = \(v\) =>[\s\S]{0,120}\[\^A-Za-z0-9 ,-\]/.test(src),
  'a grade level and the comma-joined SCOUT ALL list');
ok('nothing interpolates a raw team number into a handler any more',
  !/onclick="[a-zA-Z]+\('\$\{(tournamentFocusTeamNumber|teamNumbers\.join|tournamentGrade|_grade)/.test(src));

// ── 3b. The strings a STRANGER picks ──
//
// Most of these are typed by the team or the event partner. One is not: the
// self-check prints the titles of the YouTube videos auto-find refused, and
// anyone can upload a video with any title they like and a name close enough
// to an event to come back in that search. That one is remote, not stored.
ok('a refused video title is escaped before it is printed',
  /rw-check-\$\{c\.state\}[\s\S]{0,90}\$\{esc\(c\.text\)\}/.test(src),
  'a YouTube title is chosen by whoever uploaded the video');
ok('the event name heading every tournament view is escaped',
  !/tournament-summary-name">\$\{tournamentEventName\}/.test(src) &&
  /tournament-summary-name">\$\{esc\(tournamentEventName\)\}/.test(src));
ok('award titles are escaped', /\$\{esc\(a\.title\)\}/.test(src));
ok('so is the qualification line built from them', /\$\{esc\(r\.qual\.text\)\}/.test(src));
ok('and the robot name a team types in at registration',
  /\$\{esc\(t\.robot_name\)\}/.test(src) && /esc\(team\.robot_name\)/.test(src));
ok('no JSON.stringify relies on a hand-rolled &quot; pass any more',
  !/JSON\.stringify\([^)]*\)\.replace\(\/"\/g, '&quot;'\)/.test(src),
  'esc() covers & as well, which that pass did not');

// ── 4. Driven: the payload must render as text ──
{
  const keep = FIXTURES.teams;
  const PAYLOAD = '<img src=x onerror="window.__XSS=1">';
  FIXTURES.teams = [
    { id: 9001, number: '66449A', team_name: PAYLOAD, grade: 'High School' },
    { id: 9002, number: '1234X', team_name: 'Ordinary "quoted" name', grade: 'High School' }
  ];
  const { win, errors, stop } = await boot();
  win.switchTab('tournament');
  await win.loadTournamentTeams(55001, PAYLOAD, null, '', 'RE-V5RC-25-0191');
  await settle(win, 400);
  const h = html(win, 'tournamentResults');

  ok('the payload did not execute', !win.__XSS);
  ok('no raw tag reached the DOM', !/<img src=x/.test(h));
  ok('it is visible as text instead', h.includes('&lt;img src=x'));
  ok('an ordinary name still reads normally',
    [...h.matchAll(/class="tt-name">([^<]*)</g)].some(m => m[1] === 'Ordinary "quoted" name'),
    [...h.matchAll(/class="tt-name">([^<]*)</g)].map(m => m[1]).join(' | '));
  const evName = win.document.querySelector('.tournament-summary-name');
  ok('the event name is rendered at all', !!evName, 'the summary header is missing');
  ok('an event name carrying a payload is safe too',
    !!evName && !evName.querySelector('img') && evName.textContent.includes('<img src=x'),
    evName ? evName.innerHTML : '(no header)');

  await win.tournamentGo('matches');
  await settle(win, 300);
  ok('the matches view is clean', !/<img src=x/.test(html(win, 'tournamentResults')));
  ok('nothing threw', errors.length === 0, errors.join('\n'));
  stop();
  FIXTURES.teams = keep;
}

// ── 4b. Every string the API hands back, poisoned at once ──
//
// The regex checks above only find the sites somebody thought to look at. This
// one puts the payload in EVERY string field of every fixture, walks every
// Tournament view, and then asks the DOM — not the source — whether a live
// element was ever built. A render site missed in the sweep fails here.
{
  const keepT = FIXTURES.teams, keepE = FIXTURES.event, keepA = FIXTURES.awards;
  const P = '<img src=x onerror="window.__XSS=1">';
  FIXTURES.teams = [
    { id: 9001, number: '66449A', team_name: P, robot_name: P, grade: 'High School',
      location: { city: P, region: P, country: P } },
    { id: 9003, number: '12345B', team_name: P, robot_name: P, grade: 'Middle School',
      location: { city: P, region: P, country: P } }
  ];
  FIXTURES.event = { ...keepE, name: P, location: { region: P },
    divisions: [{ id: 1, name: P }, { id: 2, name: P }] };
  FIXTURES.awards = [
    { id: 7001, title: P, event: { id: 55001, name: P },
      teamWinners: [{ team: { id: 9001, number: '66449A', name: '66449A' } }],
      qualifications: [P] }
  ];

  const { win, errors, stop } = await boot();
  win.switchTab('tournament');
  await win.loadTournamentTeams(55001, P, 9001, '66449A', 'RE-V5RC-25-0191');
  await settle(win, 400);

  const views = ['teams', 'matches', 'team', 'awards', 'skills'];
  const dirty = [];
  for (const v of views) {
    try { await win.tournamentGo(v); } catch (e) { errors.push(v + ': ' + e.message); }
    await settle(win, 400);
    const injected = win.document.querySelectorAll('#tournamentResults img, #tournamentResults script');
    if (injected.length) dirty.push(v + ' (' + injected.length + ')');
  }
  ok('no tournament view builds an element out of API text', dirty.length === 0, dirty.join(', '));
  ok('every view still rendered something',
    (html(win, 'tournamentResults') || '').length > 100);

  // The other three tabs, same poison.
  const anyImg = () => [...win.document.querySelectorAll('img')]
    .map(el => (el.parentElement && el.parentElement.className) || '?');

  win.switchTab('scout');
  const ti = win.document.getElementById('detailTeamInput');
  if (ti) ti.value = '66449A';
  try { await win.scoutTeams(); } catch (e) { errors.push('scout: ' + e.message); }
  await settle(win, 700);
  ok('the scout card is clean', anyImg().length === 0, anyImg().join(', '));
  ok('...and it did render', (html(win, 'detailResults') || '').length > 1000);

  // Where the Simulator's match mode went: alliance labels and team numbers
  // are built into markup here, so this is the surface that needs the check.
  win.switchTab('tournament');
  try { await win.tournamentGo('picklist'); } catch (e) { errors.push('picklist: ' + e.message); }
  await settle(win, 2200);
  ok('the pick list is clean', anyImg().length === 0, anyImg().join(', '));
  ok('...and it did render', /pk-row|t-empty/.test(html(win, 'tournamentResults') || ''));

  win.switchTab('rewatch');
  const rt = win.document.getElementById('rwTeamInput');
  if (rt) rt.value = '66449A';
  try { await win.rewatchLoadTeam(); } catch (e) { errors.push('jumper: ' + e.message); }
  await settle(win, 900);
  ok('the jumper event list is clean', anyImg().length === 0, anyImg().join(', '));
  ok('...and it did render', /rw-event-name/.test(html(win, 'rwResults') || ''));

  ok('the payload never ran anywhere', !win.__XSS);
  ok('nothing threw while walking them', errors.length === 0, errors.join('\n'));
  stop();
  FIXTURES.teams = keepT; FIXTURES.event = keepE; FIXTURES.awards = keepA;
}

// ── 5. Driven: the round trips actually fell ──
{
  const { win, router, stop } = await boot();
  win.switchTab('tournament');
  await win.loadTournamentTeams(55001, 'Bots @ Bristol', 9001, '66449A', 'RE-V5RC-25-0191');
  await settle(win, 400);

  const count = (from) => router.seen.length - from;
  let at = router.seen.length;
  await win.tournamentGo('teams'); await settle(win, 400);
  const teamsCalls = count(at);
  at = router.seen.length;
  await win.tournamentGo('matches'); await settle(win, 400);
  ok('the matches view needs no request at all — the team view already fetched them',
    count(at) === 0, count(at) + ' calls');
  at = router.seen.length;
  await win.tournamentGo('team'); await settle(win, 400);
  ok('nor does going back to the team view', count(at) === 0, count(at) + ' calls');

  ok('the teams view fetches only the roster and the skills books',
    teamsCalls <= 3, teamsCalls + ' calls');

  // A steady-state live tick is rankings and nothing else.
  await win.tournamentGo('teams'); await settle(win, 400);
  await win.tournamentLiveTick(true); await settle(win, 400);
  at = router.seen.length;
  await win.tournamentLiveTick(true); await settle(win, 400);
  const tick = router.seen.slice(at);
  ok('a live tick refetches rankings', tick.some(c => /rankings/.test(c)));
  ok('...and nothing that cannot have changed', tick.length <= 3,
    tick.map(c => c.replace(/\?.*/, '')).join(' | '));
  stop();
}

console.log(`\nt91: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
