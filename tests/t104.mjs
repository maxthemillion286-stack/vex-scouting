// t104 — v81: round trips, the phone layout, favorites, and form at an event.
//
// Four things were asked for at once, and each has a way of quietly going
// back to how it was:
//
//   · a lookup that is cached can be un-cached by one new call site that goes
//     around apiGet, and nothing on screen changes except the wait;
//   · a phone rule lives inside one media query, where a later rule for the
//     same class silently wins;
//   · a favorite is a STORED string that ends up inside inline handlers, which
//     is exactly the shape §"API text is not markup" is about;
//   · a trend is a claim, and §12 says a number has to say what it is a
//     number of.
import fs from 'fs';
import { boot, settle, html, text, FIXTURES } from './harness.mjs';

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '\n         ' + detail : '')); }
};
const idx = fs.readFileSync('../index.html', 'utf8');
const css = idx.slice(idx.indexOf('<style>'), idx.indexOf('</style>'));
const phone = css.slice(css.indexOf('PHONES (v81)'));

console.log('t104 — v81: speed, phones, favorites, form');

// ══ 1. Round trips ═════════════════════════════════════════════════════════
console.log('\n· round trips');
{
  const store = {};
  const { win, router, errors } = await boot({ store });
  const since = n => router.seen.slice(n);

  let mark = router.seen.length;
  await win.gatherTeamData('66449A', 197, 'High School');
  const first = since(mark);
  ok('a first lookup asks for the team once', first.filter(p => p.startsWith('/teams?')).length === 1, first.join(' | '));
  ok('the team\'s events ride with its matches', first.some(p => /^\/teams\/9001\/events/.test(p)));
  ok('so the event records are not asked for a second time', !first.some(p => /^\/events\?id/.test(p)), first.join(' | '));

  mark = router.seen.length;
  await win.gatherTeamData('66449A', 197, 'High School');
  ok('the same lookup again makes no request at all', since(mark).length === 0, since(mark).join(' | '));

  ok('the number → team answer is kept on the device', /"66449A\|1"/.test(store.vex_team_ids || ''), store.vex_team_ids);
  win.apiFreshClear();
  mark = router.seen.length;
  await win.gatherTeamData('66449A', 197, 'High School');
  ok('and survives the in-memory answers being dropped', !since(mark).some(p => p.startsWith('/teams?')), since(mark).join(' | '));
  ok('while the team\'s own data IS refetched then', since(mark).some(p => /^\/teams\/9001\/matches/.test(p)));

  // A caller sorts what it is given. It must not be sorting the cached copy.
  const a = await win.apiGet('/teams/9001/events', { 'season[]': [197] });
  a.length = 0;
  const b = await win.apiGet('/teams/9001/events', { 'season[]': [197] });
  ok('a cached answer is handed out as a copy', b.length === 1);

  // Opening an event from a list that already carried its record.
  win.switchTab('tournament');
  win.document.getElementById('tournamentInput').value = '66449A';
  await win.findTournament();
  await settle(win);
  mark = router.seen.length;
  await win.loadTournamentTeams(55001, 'Bots @ Bristol Signature Event', 9001, '66449A', 'RE-V5RC-25-0191');
  await settle(win);
  const opened = since(mark);
  ok('opening a listed event does not re-ask for its record', !opened.some(p => /^\/events\?id/.test(p)), opened.join(' | '));
  ok('it still loads the matches and the rankings', opened.some(p => /\/matches/.test(p)) && opened.some(p => /\/rankings/.test(p)));
  ok('and the rank is on the page', /Rank/i.test(html(win, 'tournamentResults')) && /#1/.test(html(win, 'tournamentResults')));
  ok('no errors on the way', errors.length === 0, errors.join('\n'));

  // The live half is NOT cached: a refresh has to be able to refetch it.
  const src = idx.slice(idx.indexOf('const API_FRESH_RULES'), idx.indexOf('const API_FRESH_MAX'));
  ok('event matches and rankings are not in the client cache',
    !/divisions/.test(src) && !/events\\\/\\d\+\\\/\((?!teams)/.test(src) && /\^\\\/events\\\/\\d\+\\\/teams\$/.test(src), src);
  ok('a save for offline goes around the cache', /if \(vsOfflineCapture\) return apiGetLive\(endpoint, params\)/.test(idx));
  win.close();
}

// A failed request must not be remembered as an answer.
{
  const { win, router } = await boot({ fail: { '/teams/9001/awards': 404 } });
  let threw = 0;
  try { await win.apiGet('/teams/9001/awards', {}); } catch (e) { threw++; }
  const n = router.seen.filter(p => p.startsWith('/teams/9001/awards')).length;
  try { await win.apiGet('/teams/9001/awards', {}); } catch (e) { threw++; }
  ok('a failure is not cached — the next ask tries again',
    threw === 2 && router.seen.filter(p => p.startsWith('/teams/9001/awards')).length === n + 1);
  win.close();
}

// ══ 2. Form: trend, floor, ceiling ═════════════════════════════════════════
console.log('\n· form at an event');
{
  const { win, errors } = await boot();
  const f = s => win.tFormOf(s);
  ok('a flat line is steady', f([100, 100, 100, 100, 100]).trend === 'steady');
  ok('and a floor pick', f([100, 100, 100, 100, 100]).kind === 'floor');
  ok('a rising line is improving', f([60, 80, 100, 120, 140]).trend === 'improving');
  ok('a falling line is fading', f([140, 120, 100, 80, 60]).trend === 'fading');
  ok('one bad game does not make a team "fading"', f([100, 102, 98, 101, 99, 100, 60]).trend !== 'improving' && f([100, 102, 98, 101, 99, 100, 97]).trend === 'steady');
  ok('a wide swing is a ceiling pick', f([40, 150, 45, 160, 50, 155]).kind === 'ceiling');
  ok('fewer than four matches claims nothing', f([50, 150, 250]).trend === null && f([50, 150, 250]).kind === null);
  ok('but still reports what was played', f([50, 150, 250]).n === 3);
  ok('no scores is not a crash', f([]).n === 0 && f(null).n === 0);
  const q = f([10, 20, 30, 40, 50]);
  ok('the range is the middle half', q.floor === 20 && q.ceil === 40, q.floor + '–' + q.ceil);
  ok('an unplayed 0–0 is not a score of zero',
    /sim_matchPlayed\(redA, blueA, m\)\) continue;/.test(idx.slice(idx.indexOf('function tFormByTeam'), idx.indexOf('const T_FORM_LABEL'))));

  win.switchTab('tournament');
  await win.loadTournamentTeams(55001, 'Bots @ Bristol Signature Event', 9001, '66449A', 'RE-V5RC-25-0191');
  await settle(win);
  await win.tournamentGo('picklist');
  await settle(win, 200);
  const pk = html(win, 'tournamentResults');
  ok('the pick list carries the form table', /Form at this event/.test(pk) && /class="fm-row/.test(pk));
  ok('it says these are ALLIANCE scores', /<strong>alliance<\/strong> score/.test(pk));
  ok('and that partners move them', /partners move every number/.test(pk));
  ok('it can be sorted four ways', ['trend', 'floor', 'ceiling', 'rank'].every(k => pk.includes(`tSetFormSort('${k}')`)));
  win.tSetFormSort('floor');
  await settle(win, 200);
  ok('a sort re-renders and marks itself', /class="pk-size active" onclick="tSetFormSort\('floor'\)"/.test(html(win, 'tournamentResults')));
  ok('no errors', errors.length === 0, errors.join('\n'));
  win.close();
}

// ══ 3. Favorites ═══════════════════════════════════════════════════════════
console.log('\n· favorites');
{
  const store = {};
  const { win, errors } = await boot({ store });
  win.switchTab('favs');
  ok('with none saved it says how to add one', /No favorites yet/.test(html(win, 'favsResults')));
  win.document.getElementById('favAddInput').value = '66449a';
  await win.favAddFromInput();
  await settle(win, 150);
  ok('adding one stores it, upper-cased', store.vex_favs === '["66449A"]', store.vex_favs);
  const card = html(win, 'favsResults');
  ok('its card names the team', /Wired Up/.test(text(win, 'favsResults')));
  ok('and its event', /Bots @ Bristol Signature Event/.test(card));
  ok('and where the event sits in time', /Ended \d+ days ago|Ended yesterday|Running|Starts/.test(card));
  ok('and its rank and record there', /fav-rank/.test(card) && /#1/.test(card), card.slice(0, 600));
  ok('with the four ways in', ['schedule', 'stats', 'watch'].every(k => card.includes(`favGo('66449A', '${k}')`)) && card.includes(`favToggleEvents('66449A')`));

  win.document.getElementById('favAddInput').value = '99999Z';
  await win.favAddFromInput();
  await settle(win, 100);
  ok('a team that does not exist is not saved', store.vex_favs === '["66449A"]', store.vex_favs);

  await win.favToggleEvents('66449A');
  await settle(win, 100);
  ok('EVENTS lists the season', /class="fav-ev"/.test(html(win, 'favsResults')));

  await win.favGo('66449A', 'schedule');
  await settle(win, 200);
  const t = html(win, 'tournamentResults');
  ok('SCHEDULE lands on the team at its event', win.document.getElementById('tab-tournament').classList.contains('active') && /Matches for/.test(t));
  ok('with the rank and the record', /Rank/.test(t) && /Qualification record/.test(t));
  ok('and the matches', /Qualification/.test(t));
  ok('the star there is lit', /class="fav-star on" data-fav="66449A"/.test(t));

  win.vsFavToggle('66449A');
  ok('tapping it removes the favorite', store.vex_favs === '[]');
  ok('and un-lights every star for that team', !win.document.querySelector('.fav-star.on'));

  await win.favGo('66449A', 'stats');
  await settle(win, 200);
  ok('STATS lands on Scout', win.document.getElementById('tab-scout').classList.contains('active') && /Wired Up/.test(html(win, 'detailResults')));
  ok('no errors', errors.length === 0, errors.join('\n'));

  // Which event is "the" event: running beats upcoming beats past.
  const day = d => { const x = new Date(Date.now() + d * 86400000); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}T08:00:00`; };
  const E = (id, a, b) => ({ id, start: day(a), end: day(b) });
  ok('a running event wins', win.favPickEvent([E(1, -30, -30), E(2, 0, 1), E(3, 9, 9)]).id === 2);
  ok('else the NEXT one, not the furthest', win.favPickEvent([E(1, -30, -30), E(3, 40, 40), E(2, 9, 9)]).id === 2);
  ok('else the most recent past one', win.favPickEvent([E(1, -30, -30), E(2, -3, -3)]).id === 2);
  ok('none is none', win.favPickEvent([]) === null);
  win.close();
}

// A favorite is a stored string that reaches inline handlers.
{
  const store = { vex_favs: JSON.stringify(['66449A', '<img src=x onerror=window.__pwn=1>', "');window.__pwn=1;('", 7, null]) };
  const { win, errors } = await boot({ store });
  win.switchTab('favs');
  await settle(win, 150);
  const h = html(win, 'favsResults');
  ok('a poisoned favorites list renders no tag', !/<img/i.test(h));
  ok('and breaks out of no handler', !/onclick="[^"]*'\)[^"]*window/.test(h) && !win.__pwn);
  ok('every stored value is narrowed on the way out', win.vsFavs().every(n => /^[A-Z0-9-]+$/.test(n)), JSON.stringify(win.vsFavs()));
  ok('the real one still shows', /data-favcard="66449A"/.test(h));
  ok('storage that is not a list is an empty list', (() => { store.vex_favs = '{"a":1}'; return win.vsFavs().length === 0; })());
  win.close();
}

// Desktop: the tab is not somewhere a wide screen is ever taken.
ok('favorites is not restored as the opening tab', /\['scout','skills','tournament','rewatch','simulator','info','settings'\]\.includes\(savedTab\)/.test(idx));
ok('it opens first only on a phone that has some', /if \(vsIsPhone\(\) && vsFavList\(\)\.length\) switchTab\('favs'\)/.test(idx));
ok('its button is hidden above phone width', /\.tab-phone-only \{ display: none; \}/.test(css.slice(0, css.indexOf('@media (max-width: 720px) {', css.indexOf('PHONES (v81)')))));
ok('and so is every star', /\.fav-star \{ display: none; \}/.test(css));

// ══ 4. The phone layout ════════════════════════════════════════════════════
console.log('\n· phones');
{
  const { win } = await boot();
  win.switchTab('tournament');
  const sec = win.document.getElementById('tab-tournament');
  ok('every searchable tab gets the fold-away row', ['scout', 'skills', 'tournament', 'rewatch', 'simulator']
    .every(t => win.document.querySelector(`#tab-${t} > .phone-find`)));
  ok('a tab with no results is not folded', !sec.classList.contains('has-results'));
  win.document.getElementById('tournamentInput').value = '66449A';
  await win.findTournament();
  await settle(win, 100);
  ok('results fold the form away', sec.classList.contains('has-results'));
  ok('the row says what was searched', /66449A/.test(sec.querySelector('.phone-find').textContent));
  sec.querySelector('.phone-find').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  ok('a tap brings the form back', sec.classList.contains('show-controls'));
  win.clearTabPanel('tournament');
  await settle(win, 50);
  ok('clearing the results unfolds it', !sec.classList.contains('has-results') && !sec.classList.contains('show-controls'));
  win.close();
}
const btns = [...idx.matchAll(/<button class="tab-btn[^>]*>/g)].map(m => m[0]);
// v83 added Settings: eight buttons, seven of them in the phone bar (Info
// gives its cell to Settings and is one tap from there).
ok('eight tab buttons', btns.length === 8, String(btns.length));
ok('Info steps out of the phone bar', /\.tab-btn\[data-short="INFO"\] \{ display: none; \}/.test(phone));
ok('each with a short label for the bar', btns.every(b => /data-short="[A-Z]+"/.test(b)));
ok('and an icon', (idx.match(/<svg class="tab-ico"/g) || []).length === 8);
ok('the bar is fixed to the bottom', /\.tabs-nav \{\s*position: fixed; left: 0; right: 0; bottom: 0;/.test(phone));
ok('and clears the home indicator', /padding-bottom: env\(safe-area-inset-bottom/.test(phone));
ok('the page leaves room for it', /body \{ padding-bottom: calc\(64px \+ env\(safe-area-inset-bottom/.test(phone));
ok('the event views are a grid, not a strip that runs off the edge', /\.t-nav \{ display: grid; grid-template-columns: repeat\(4, 1fr\); overflow: visible; \}/.test(phone));
ok('the overlay above the content is gone on phones', /body::after \{ display: none; \}/.test(phone));
// Nothing in the phone block sets text under 11px. The one exemption is the
// bar's short label at 10px — the size a tab bar label is on the platform.
const mq = phone.slice(phone.indexOf('@media (max-width: 720px) {'), phone.indexOf('/* The favorites tab itself.'));
const sizes = [...mq.matchAll(/font-size: ([\d.]+)px/g)].map(m => +m[1]);
ok('the phone block sets nothing under 11px', sizes.filter(v => v < 11).join() === '10', sizes.filter(v => v < 11).join());
ok('buttons are a finger tall', /\.btn, \.draft-btn[^{]*\{ min-height: 44px; \}/.test(mq));
// §"Chrome": sizes, spacing and colour are fair game; the typefaces are not.
ok('no typeface is changed for phones', !/font-family/.test(mq.replace(/\.phone-find \{[^}]*\}/, '')));

console.log(`\nt104: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
