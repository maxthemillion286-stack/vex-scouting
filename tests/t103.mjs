// t103 — the week before an event.
//
// Reported as: "when the event date nears and i check it just says no matches
// played and i can't see any tournament info."
//
// That is the worst possible moment for this tab to be empty. The match
// schedule is set by the organiser and usually does not appear until the day
// before or the morning of, so for the whole week you are actually deciding
// things — who to scout, what you are walking into — every view was a dead
// end. Measured against a realistic pre-event fixture before the fix:
//
//   the view you land on   209 chars  "No matches found for 66449A at this event."
//   ▸ matches              203 chars  "No match schedule posted for this event yet."
//   ▸ skills               204 chars  "No skills runs recorded at this event yet."
//   ▸ awards               172 chars  "No awards recorded for this event yet."
//   ▸ bracket              246 chars  "Eliminations have not started…"
//   ▸ picklist             215 chars  "Not enough ranked teams…"
//   ▸ teams                481 chars  a list with every column a dash
//
// Six of seven views, one grey line each. Yet RobotEvents has plenty to say
// before an event: who registered, where they stand on the world skills board,
// and how they have played at their OTHER events this season. That last one is
// the same model the Event Scout ranks twenty fields with, pointed at one.
//
// The fixture state is FIXTURES.scheduleUnposted — every per-event endpoint
// answers empty while the roster and the season board stay full.
import fs from 'fs';
import { boot, settle, FIXTURES } from './harness.mjs';
let pass = 0, fail = 0;
const ok = (n, c, e) => { c ? (pass++, console.log('  ok   ' + n)) : (fail++, console.log('  FAIL ' + n + (e ? '\n         ' + e : ''))); };

const idx = fs.readFileSync('../index.html', 'utf8');
const src = idx.match(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/)[1];
const code = src.replace(/^[ \t]*\/\/.*$/gm, '');

console.log('t103 — before the event');

const EV = FIXTURES.event.id;
const keep = { start: FIXTURES.event.start, end: FIXTURES.event.end, loc: FIXTURES.event.location };
const inDays = n => {
  const d = new Date(Date.now() + n * 86400000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}T09:00:00-05:00`;
};
const preEvent = () => {
  FIXTURES.scheduleUnposted = EV;
  FIXTURES.wideRoster = 24;
  FIXTURES.event.start = inDays(6);
  FIXTURES.event.end = inDays(7);
  FIXTURES.event.location = { city: 'Bristol', region: 'Connecticut', venue: 'Bristol Eastern High School' };
};
const restore = () => {
  FIXTURES.scheduleUnposted = null;
  FIXTURES.wideRoster = null;
  FIXTURES.event.start = keep.start;
  FIXTURES.event.end = keep.end;
  FIXTURES.event.location = keep.loc;
};
const land = async (win, focusNum, focusId) => {
  win.switchTab('tournament');
  await win.loadTournamentTeams(EV, FIXTURES.event.name, focusId ?? 9001, focusNum ?? '66449A', FIXTURES.event.sku);
  await settle(win, 5000);
};
const txt = doc => (doc.getElementById('tournamentResults').textContent || '').replace(/\s+/g, ' ').trim();

// ══ 1. Where the event sits relative to today ══════════════════════════════
// In the venue's calendar (§18), both ends counted, and it has to read
// correctly on every one of the five days that matter.
console.log('\n· when it runs');
{
  const { win, stop } = await boot();
  await settle(win, 300);
  const today = String(win.eval('evTodayKey()'));
  ok('today is a day key', /^\d{4}-\d{2}-\d{2}$/.test(today), today);
  const day = n => new Date(Date.parse(today + 'T12:00:00Z') + n * 86400000).toISOString().slice(0, 10);
  const when = (s, e) => JSON.parse(win.eval(
    `JSON.stringify(tWhen({ start: ${JSON.stringify(day(s) + 'T09:00:00-04:00')}, end: ${JSON.stringify(day(e) + 'T18:00:00-04:00')} }))`));

  const cases = [
    [0, 0, 'now', 'Running today', 1],
    [0, 1, 'now', 'Running now — day 1 of 2', 2],
    [-1, 0, 'now', 'Running now — day 2 of 2', 2],
    [-2, 0, 'now', 'Running now — day 3 of 3', 3],
    [1, 1, 'ahead', 'Starts tomorrow', 1],
    [6, 7, 'ahead', 'Starts in 6 days', 2],
    [-1, -1, 'past', 'Ended yesterday', 1],
    [-4, -3, 'past', 'Ended 3 days ago', 2],
  ];
  for (const [s, e, state, label, span] of cases) {
    const w = when(s, e);
    ok(`${label} (${state})`, w.state === state && w.label === label && w.span === span,
      `${w.state} / ${w.label} / span ${w.span}`);
  }
  ok('a one-day event names the day in full', /^[A-Z][a-z]+day, /.test(when(1, 1).dates), when(1, 1).dates);
  ok('a multi-day event names both ends', when(6, 7).dates.includes('–'), when(6, 7).dates);
  ok('an event with no start at all is simply unknown',
    win.eval('tWhen({})') === null && win.eval("tWhen({ start: 'soon' })") === null);
  stop();
}

// ══ 2. The view you land on is no longer a dead end ════════════════════════
// This is the report. Searching your own team and clicking the event is THE
// path, and it was 209 characters of nothing.
console.log('\n· the view you land on');
{
  preEvent();
  const { win, errors, router, stop } = await boot();
  const doc = win.document;
  await settle(win, 400);
  await land(win);
  const body = txt(doc);

  ok('it is not one grey line any more', body.length > 700, `${body.length} chars`);
  ok('it still says there are no matches, somewhere',
    /schedule is set by the event organiser/i.test(body), body.slice(0, 200));
  ok('and says when the schedule turns up', /day before or the morning of/i.test(body));
  ok('it is labelled for what it is',
    (doc.querySelector('.t-pre-label') || {}).textContent === 'Before the event',
    (doc.querySelector('.t-pre-label') || {}).textContent);

  // The four things you want to know a week out.
  const cards = [...doc.querySelectorAll('.md-stat')].map(e => e.textContent.replace(/\s+/g, ' ').trim());
  ok('it says when it starts', cards.some(c => /Starts in 6 days/.test(c)), cards.join(' | '));
  ok('...with the dates', cards.some(c => /–/.test(c) && /\b(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\b/.test(c)), cards.join(' | '));
  ok('it says where', cards.some(c => /Bristol, Connecticut/.test(c)), cards.join(' | '));
  ok('...down to the venue', cards.some(c => /Bristol Eastern High School/.test(c)), cards.join(' | '));
  ok('it says how many registered', cards.some(c => /27 teams/.test(c)), cards.join(' | '));
  ok('...and the grade split', cards.some(c => /21 HS · 6 MS/.test(c)), cards.join(' | '));
  ok('it says where you land', cards.some(c => /66449A LANDS|66449A lands/i.test(c) && /~#\d+/.test(c)),
    cards.join(' | '));

  // The field itself.
  const rows = [...doc.querySelectorAll('.pick-row')];
  ok('the registered field is listed', rows.length > 0, `${rows.length} rows`);
  ok('every row names a team', rows.every(r => /\S/.test(r.querySelector('.pick-team').textContent)));
  ok('every row carries a rating or an honest dash',
    rows.every(r => /^\s*(\d+|—)\s*$/.test(r.querySelector('.pick-win').textContent)),
    rows.map(r => r.querySelector('.pick-win').textContent.trim()).join(','));
  ok('the list is strongest first', (() => {
    const v = rows.map(r => r.querySelector('.pick-win').textContent.trim())
      .filter(t => /^\d+$/.test(t)).map(Number);
    return v.every((n, i) => i === 0 || v[i - 1] >= n);
  })(), rows.map(r => r.querySelector('.pick-win').textContent.trim()).join(','));
  ok('the last column is the grade, not the same word sixteen times',
    new Set(rows.map(r => r.querySelector('.pick-opr').textContent.trim())).size > 1,
    [...new Set(rows.map(r => r.querySelector('.pick-opr').textContent.trim()))].join(','));
  ok('a row can be clicked through to Scout',
    rows.every(r => /scoutTeam\(/.test(r.getAttribute('onclick') || '')));
  ok('and it says so', /Click a team to scout it/.test(body));
  ok('your own row is the marked one',
    (doc.querySelector('.pick-row.first') || {}).textContent?.includes('66449A'),
    (doc.querySelector('.pick-row.first') || {}).textContent);

  // Where the numbers come from, stated — a rating built from somewhere else
  // is worth having only if the page says it is from somewhere else.
  ok('it says the rating is season form, not this event',
    /matches at their other events this season/i.test(body), body.slice(-400));
  ok('the strength line is an average, said as one',
    /The strongest \d+ average \d+ True Skill/.test(body),
    'printed beside your own rating, "top-field TS" reads like a ceiling you are over');

  ok('nothing threw', errors.length === 0, errors.join('\n'));

  // ── Where it got the numbers ──
  const asked = router.seen;
  ok('it read the registered roster', asked.some(p => p === `/events/${EV}/teams?per_page=250&page=1`),
    asked.filter(p => /teams/.test(p)).join(' | '));
  ok('it read the season skills board', asked.some(p => /legacy:.*\/skills/.test(p)));
  ok('and it read those teams\' matches at OTHER events',
    asked.some(p => /^\/teams\/\d+\/matches/.test(p) && !p.includes(`event[]=${EV}`)),
    asked.filter(p => /\/matches/.test(p)).slice(0, 4).join(' | '));
  stop();
  restore();
}

// ══ 3. The other way in ════════════════════════════════════════════════════
console.log('\n· the all-matches view, same dead end');
{
  preEvent();
  const { win, errors, stop } = await boot();
  const doc = win.document;
  await settle(win, 400);
  await land(win);
  await win.tournamentGo('matches');
  await settle(win, 5000);
  const body = txt(doc);
  ok('it shows the same panel', !!doc.querySelector('.t-pre-label') && doc.querySelectorAll('.pick-row').length > 0,
    body.slice(0, 200));
  ok('and still says the schedule is the organiser\'s to post',
    /day before or the morning of/.test(body));
  ok('nothing threw', errors.length === 0, errors.join('\n'));
  stop();
  restore();
}

// ══ 4. The scan is capped, and says so ═════════════════════════════════════
// A field's character is set by its top end. Rating all 800 teams at Worlds
// would be a season of matches each; rating the top of the board is one call
// per team and answers the question.
console.log('\n· capped, and honest about it');
{
  preEvent();
  const { win, stop } = await boot();
  const doc = win.document;
  await settle(win, 400);
  await land(win);
  const cap = Number(win.eval('T_PREVIEW_SCAN'));
  ok('there is a stated cap', Number.isFinite(cap) && cap > 0, String(cap));
  const rows = doc.querySelectorAll('.pick-row').length;
  ok('with 27 registered it rates the cap, not all of them', rows === cap, `${rows} rows, cap ${cap}`);
  ok('and the page says which it scanned and out of how many',
    new RegExp(`The ${cap} scanned are the top of the world skills board out of 27 registered`).test(txt(doc)),
    txt(doc).slice(-300));
  stop();
  restore();
}

// ══ 5. Your own team, even from the bottom of the field ════════════════════
// "Where do I land" is the question. A team outside the scanned top has to be
// added anyway, or the one row you came for is the one row missing.
console.log('\n· you are always in the list');
{
  preEvent();
  const { win, stop } = await boot();
  const doc = win.document;
  await settle(win, 400);
  // 123H is wideRoster index 23 — last on the board, well outside the top 16.
  await land(win, '123H', 9123);
  const rows = [...doc.querySelectorAll('.pick-row')];
  const mine = rows.find(r => r.querySelector('.pick-team').textContent.trim() === '123H');
  ok('a team outside the scanned top is still rated', !!mine,
    rows.map(r => r.querySelector('.pick-team').textContent.trim()).join(','));
  ok('and marked', !!mine && mine.classList.contains('first'));
  ok('the headline counts it in', /123H/.test(txt(doc)), txt(doc).slice(0, 300));
  ok('it is the WEAKEST, which is the honest answer',
    !!mine && rows.indexOf(mine) === rows.length - 1,
    `row ${rows.indexOf(mine) + 1} of ${rows.length}`);
  stop();
  restore();
}

// ══ 6. It does NOT run when there are matches ══════════════════════════════
// The preview pulls a season of matches per scanned team. Doing that for an
// event that has already been played would be a pile of requests for a panel
// nobody sees.
console.log('\n· it stays out of the way once the schedule is up');
{
  const { win, router, stop } = await boot();
  const doc = win.document;
  await settle(win, 400);
  await land(win);
  ok('a played event shows matches, not the preview',
    !doc.querySelector('.t-pre-label'), txt(doc).slice(0, 160));
  const seasonPulls = router.seen.filter(p => /^\/teams\/\d+\/matches/.test(p) && !/event\[\]=/.test(p));
  ok('and buys no season match data for the field', seasonPulls.length === 0,
    seasonPulls.join(' | '));
  stop();
}

// ══ 7. The live refresh no longer swaps the view out from under you ════════
// renderEventTeamMatchesView never set tournamentView, so arriving through
// your own team — the common path — left the global on 'teams' while the match
// view was on screen. The live tick dispatches on that global, so every 30
// seconds at a running event it rebuilt the whole TEAM LIST over the top.
console.log('\n· the view says which view it is');
{
  const { win, stop } = await boot();
  await settle(win, 400);
  await land(win);
  ok('landing on a team\'s matches sets the view to team',
    win.eval('tournamentView') === 'team', String(win.eval('tournamentView')));
  ok('the live tick can therefore re-render it',
    win.eval("RW_LIVE_VIEWS.includes('team')"));
  ok('the render declares it, like its siblings do',
    /async function renderEventTeamMatchesView\(\) \{\s*\n\s*tournamentView = 'team';/.test(code));
  // And clicking a team number in the match list goes through the same door.
  ok('tournamentFocusOn reaches it through that same function',
    /tournamentFocusOn[\s\S]{0,700}?renderEventTeamMatchesView\(\);/.test(code));
  stop();
}

// ══ 8. The rating engine was split, not copied ═════════════════════════════
// Resolving a team number costs a request each. A caller holding ids already —
// an event's roster — has no business buying them back.
console.log('\n· one rating engine, two doors');
{
  ok('there is a by-ids builder', /async function sim_buildRatingsFromIds\(ids, seasonId, setStatus\)/.test(code));
  ok('the by-numbers builder delegates to it rather than repeating it',
    /const out = await sim_buildRatingsFromIds\(uniqueIds, seasonId, setStatus\);/.test(code));
  ok('...and the match-walking loop exists exactly once',
    (code.match(/const matches = await sim_teamMatchesCached\(tid, seasonId\);/g) || []).length === 1);
  ok('the preview uses the by-ids door', /sim_buildRatingsFromIds\(picked\.map\(r => r\.t\.id\)/.test(code));

  // Both still answer.
  const { win, stop } = await boot();
  await settle(win, 400);
  const got = await win.eval("sim_buildRatingsFromIds(['9001','9002'], '197')");
  ok('the by-ids builder returns a ratings map', got && typeof got.ratings?.get === 'function',
    JSON.stringify(Object.keys(got || {})));
  const got2 = await win.eval("sim_buildRatingsFromTeams(['66449A','1234X'], '197')");
  ok('the by-numbers builder still resolves numbers to ids',
    got2 && got2.byNumber && !!got2.byNumber['66449A'], JSON.stringify(Object.keys(got2?.byNumber || {})));
  ok('...and still hands back the id→number map it always did',
    got2 && got2.idToNum && Object.keys(got2.idToNum).length > 0);
  stop();
}

// ══ 9. A string from the API is not markup ═════════════════════════════════
// The preview renders team numbers, team names, a city and a venue — four more
// values a team or an organiser types in. t100 found six holes of exactly this
// shape; a new view is a new chance at a seventh.
console.log('\n· poisoned strings do not become tags');
{
  const P = '<img src=x onerror="window.__XSS=1">';
  preEvent();
  const keepTeams = FIXTURES.teams;
  FIXTURES.event.location = { city: P, region: P, venue: P };
  FIXTURES.teams = FIXTURES.teams.map((t, i) =>
    i === 1 ? { ...t, number: P, team_name: P } : t);

  const { win, errors, stop } = await boot();
  const doc = win.document;
  await settle(win, 400);
  await land(win);
  const nodes = [...doc.querySelectorAll('body *')].filter(e => e.getAttribute && e.getAttribute('onerror'));
  ok('the preview renders the payload as text, not markup', nodes.length === 0,
    nodes.map(n => (n.parentElement || n).outerHTML.slice(0, 140)).join(' | '));
  ok('and the panel still rendered', !!doc.querySelector('.t-pre-label'));
  ok('nothing threw', errors.length === 0, errors.join('\n'));
  stop();

  FIXTURES.teams = keepTeams;
  restore();
  // Named, so a revert is loud.
  ok('the venue and city go through esc', /\$\{esc\(loc \|\| venue\)\}/.test(code));
  ok('the team number in the handler is stripped, not escaped',
    /onclick="scoutTeam\('\$\{teamAttr\(r\.number\)\}'\)"/.test(code));
  ok('and its text is escaped', /<div class="pick-team">\$\{esc\(r\.number\)\}<\/div>/.test(code));
  ok('the name and skills line is escaped', /\$\{esc\(sub\) \|\| '&nbsp;'\}/.test(code));
}

// ══ 10. It survives the parts that can fail ════════════════════════════════
console.log('\n· when the data is not there');
{
  // No roster at all — registration has not opened.
  preEvent();
  FIXTURES.wideRoster = null;
  const keepTeams = FIXTURES.teams;
  FIXTURES.teams = [];
  const a = await boot();
  await settle(a.win, 400);
  await land(a.win);
  ok('an event with nobody registered says so, and does not throw',
    /No teams have registered/.test(txt(a.win.document)), txt(a.win.document).slice(0, 220));
  ok('...quietly', a.errors.length === 0, a.errors.join('\n'));
  a.stop();
  FIXTURES.teams = keepTeams;
  restore();

  // The roster call itself refused.
  preEvent();
  const b = await boot({ fail: { [`/events/${EV}/teams`]: 500 } });
  await settle(b.win, 400);
  await land(b.win);
  const body = txt(b.win.document);
  ok('a refused roster leaves a readable page, not a blank one', body.length > 150, body.slice(0, 200));
  ok('...that still says when the event is', /Starts in \d+ days/.test(body), body.slice(0, 200));
  ok('...and does not throw', b.errors.length === 0, b.errors.join('\n'));
  b.stop();
  restore();
}

// ══ 10b. Registered, but not on the schedule ══════════════════════════════
// The other nothing. When the event HAS matches and this team is in none of
// them — withdrawn, a late scratch, a division not yet published — telling
// that person "the organiser has not posted the schedule yet" is a plain lie.
console.log('\n· on the roster, not on the schedule');
{
  const { win, errors, stop } = await boot();
  await settle(win, 400);
  // 555A plays only in division 2 of the default fixture, so searching for it
  // through division 1's roster finds a team with a schedule; 9999Z is on no
  // match at all.
  win.switchTab('tournament');
  await win.loadTournamentTeams(EV, FIXTURES.event.name, 9999, '9999Z', FIXTURES.event.sku);
  await settle(win, 3000);
  const body = txt(win.document);
  ok('it says the team is not on the schedule', /does not appear in this event's schedule/.test(body),
    body.slice(0, 260));
  ok('...and says how many matches the event does have', /\d+ matches are posted/.test(body),
    body.slice(0, 260));
  ok('it does NOT claim the schedule is unposted', !/day before or the morning of/.test(body),
    body.slice(0, 300));
  ok('and it offers the match list instead', /SEE EVERY MATCH AT THIS EVENT/.test(body));
  ok('nothing threw', errors.length === 0, errors.join('\n'));
  stop();
}

// ══ 11. An event that ran and never posted anything ════════════════════════
// The same empty shape, reached from the other side of the date. Telling
// someone to "check back" for an event that finished last week is wrong.
console.log('\n· an event that already ran');
{
  preEvent();
  FIXTURES.event.start = inDays(-5);
  FIXTURES.event.end = inDays(-4);
  const { win, errors, stop } = await boot();
  await settle(win, 400);
  await land(win);
  const body = txt(win.document);
  ok('it says the event has been and gone', /Ended \d+ days ago|Ended yesterday/.test(body), body.slice(0, 200));
  ok('it does not tell you to check back', !/check back/.test(body), body.slice(0, 300));
  ok('it says who would have had to upload the results',
    /organiser did not upload results/.test(body), body.slice(0, 400));
  // "Before the event" over a heading that reads "Ended 4 days ago" is the
  // panel contradicting itself.
  ok('and the panel is named for where the event actually is',
    (win.document.querySelector('.t-pre-label') || {}).textContent === 'After the event',
    (win.document.querySelector('.t-pre-label') || {}).textContent);
  ok('nothing threw', errors.length === 0, errors.join('\n'));
  stop();
  restore();
}

// ══ 11b. Running right now, nothing uploaded yet ══════════════════════════
// Telling someone standing at the venue to "check back — it usually appears
// the day before" is advice about a day that has already passed.
console.log('\n· the event is on and nothing is posted');
{
  preEvent();
  FIXTURES.event.start = inDays(0);
  FIXTURES.event.end = inDays(1);
  const { win, errors, stop } = await boot();
  await settle(win, 400);
  await land(win);
  const body = txt(win.document);
  ok('the panel knows the event is on',
    (win.document.querySelector('.t-pre-label') || {}).textContent === 'The event is on',
    (win.document.querySelector('.t-pre-label') || {}).textContent);
  ok('and says which day of it', /Running now — day 1 of 2/.test(body), body.slice(0, 220));
  ok('it does not give advice about yesterday', !/day before or the morning of/.test(body),
    body.slice(0, 400));
  ok('it says matches land as they are uploaded',
    /as the organiser uploads them/.test(body), body.slice(0, 400));
  ok('and that the page refreshes itself', /refreshes itself while the event is live/.test(body));
  ok('nothing threw', errors.length === 0, errors.join('\n'));
  stop();
  restore();
}

// ══ 12. Release ════════════════════════════════════════════════════════════
console.log('\n· release');
{
  const app = (idx.match(/const APP_BUILD = '([^']+)'/) || [])[1];
  const sw = fs.readFileSync('../sw.js', 'utf8');
  const cache = (sw.match(/const CACHE_NAME = 'vex-scout-([^']+)'/) || [])[1];
  const proxy = (fs.readFileSync('../api/proxy.js', 'utf8').match(/const PROXY_BUILD = '([^']+)'/) || [])[1];
  ok('all three markers agree', app === proxy && proxy === cache, `${app} / ${proxy} / ${cache}`);
}

restore();
console.log(`\nt103: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
