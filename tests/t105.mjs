// t105 — v82: the softer look, and the things asked for "at a tournament".
//
//   · suggestions while typing, from the third digit;
//   · live alliance selection — tap to cross off;
//   · an opponent's last match from the next-match card;
//   · swipe between an event's views; pull to refresh;
//   · a favorite's event saving itself for offline;
//   · rounded corners and fewer outlines, by a scale and not one number.
import fs from 'fs';
import { boot, settle, html, FIXTURES } from './harness.mjs';

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '\n         ' + detail : '')); }
};
const idx = fs.readFileSync('../index.html', 'utf8');
const css = idx.slice(idx.indexOf('<style>'), idx.indexOf('</style>'));
const day = d => { const x = new Date(Date.now() + d * 86400000); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}T08:00:00`; };

console.log('t105 — v82: softer, and at the event');

// ══ 1. Suggestions ═════════════════════════════════════════════════════════
console.log('\n· suggestions while typing');
{
  const { win, router, errors } = await boot();
  ok('two digits suggest nothing', win.vsSuggestStem('66') === null);
  ok('three digits do', win.vsSuggestStem('664') === '664');
  ok('a finished number does not', win.vsSuggestStem('66449A') === null);
  ok('an event name does not', win.vsSuggestStem('Bristol 2026') === null);
  ok('only the entry being typed counts', win.vsSuggestStem('1234X, 66449') === '66449');

  const mark = router.seen.length;
  const got = await win.vsSuggestTeams('66449');
  const asked = router.seen.slice(mark);
  ok('it finds the team', got.length === 1 && got[0].number === '66449A', JSON.stringify(got));
  ok('in ONE request for all 26 letters', asked.filter(p => p.startsWith('/teams?')).length === 1 && (asked.find(p => p.startsWith('/teams?')).match(/number/g) || []).length === 26, asked.join(' | '));
  ok('a stem that is not digits asks for nothing', (await win.vsSuggestTeams("1');x('")).length === 0);

  // A team the device already knows matches on a longer number too.
  win.vsFavSet('66449A', true);
  ok('a favorite matches from three digits', (await win.vsSuggestTeams('664')).some(t => t.number === '66449A'));

  const input = win.document.getElementById('favAddInput');
  input.value = '66449';
  input.dispatchEvent(new win.Event('input', { bubbles: true }));
  await settle(win, 400);
  const host = win.document.getElementById('favAddInputSuggest');
  ok('typing draws a chip under the box', !!host && /sg-chip/.test(host.innerHTML) && /66449A/.test(host.textContent), host && host.innerHTML);
  ok('with the team name, escaped', /Wired Up/.test(host.textContent));
  input.value = '66';
  input.dispatchEvent(new win.Event('input', { bubbles: true }));
  ok('deleting back under three clears them', host.innerHTML === '');

  win.switchTab('scout');
  win.document.getElementById('detailTeamInput').value = '66449';
  win.vsSuggestPick('detailTeamInput', '66449A');
  await settle(win, 200);
  ok('tapping a chip fills the box and runs the search',
    win.document.getElementById('detailTeamInput').value === '66449A' && /Wired Up/.test(html(win, 'detailResults')));
  win.document.getElementById('detailTeamInput').value = '1234X, 66449';
  win.vsSuggestPick('detailTeamInput', '66449A');
  ok('in a list it completes the last entry only', win.document.getElementById('detailTeamInput').value === '1234X, 66449A');
  ok('no errors', errors.length === 0, errors.join('\n'));
  win.close();
}
// A team name is API text.
{
  FIXTURES.teams[0].team_name = '<img src=x onerror=window.__pwn=1>';
  const { win } = await boot();
  const input = win.document.getElementById('favAddInput');
  input.value = '66449';
  input.dispatchEvent(new win.Event('input', { bubbles: true }));
  await settle(win, 400);
  const h = win.document.getElementById('favAddInputSuggest').innerHTML;
  ok('a hostile team name renders as text', !/<img/i.test(h) && /&lt;img/.test(h) && !win.__pwn, h);
  FIXTURES.teams[0].team_name = 'Wired Up';
  win.close();
}

// ══ 2. Live picks, last match, swipe ═══════════════════════════════════════
console.log('\n· at the event');
{
  const store = {};
  FIXTURES.playedThrough = 4;              // quals 1-4 played, 5-6 to come
  const { win, errors } = await boot({ store });
  win.switchTab('tournament');
  await win.loadTournamentTeams(55001, 'Bots @ Bristol Signature Event', 9001, '66449A', 'RE-V5RC-25-0191');
  await settle(win, 200);
  const team = html(win, 'tournamentResults');
  ok('the next-match card offers each opponent\'s last match', /class="md-watch"/.test(team) && /Watch [0-9A-Z]+'s last match/.test(team), team.slice(team.indexOf('md-next'), team.indexOf('md-next') + 400));
  ok('through the Jumper, with stripped arguments', /class="md-watch" onclick="jumpToMatch\('55001', /.test(team));

  await win.tournamentGo('picklist');
  await settle(win, 200);
  let pk = html(win, 'tournamentResults');
  const first = (pk.match(/tTakenToggle\('([0-9A-Z]+)'\)/) || [])[1];
  ok('the partner list has a Taken button per team', !!first && /class="lp-take"/.test(pk));
  ok('and marks the best one still available', /class="lp-row best"/.test(pk) && /Best still available/.test(pk));
  win.tTakenToggle(first);
  await settle(win, 200);
  pk = html(win, 'tournamentResults');
  ok('tapping it stores the team for this event', JSON.parse(store.vex_taken)['55001'].includes(first), store.vex_taken);
  ok('takes it off the list', !new RegExp(`class="lp-take" onclick="tTakenToggle\\('${first}'\\)"`).test(pk));
  ok('and offers an undo', new RegExp(`class="lp-undo" onclick="tTakenToggle\\('${first}'\\)"`).test(pk));
  win.tTakenToggle(first);
  await settle(win, 200);
  ok('undo puts it back', new RegExp(`class="lp-take" onclick="tTakenToggle\\('${first}'\\)"`).test(html(win, 'tournamentResults')));
  win.tTakenToggle(first); win.tTakenReset();
  ok('Clear all empties the event\'s list', !store.vex_taken || !JSON.parse(store.vex_taken)['55001']);
  store.vex_taken = JSON.stringify({ 55001: ["');window.__pwn=1;('", '<b>', '1234X'] });
  ok('a poisoned stored list is narrowed on the way out', win.vsTaken(55001).every(n => /^[A-Z0-9-]+$/.test(n)) && win.vsTaken(55001).includes('1234X'));
  store.vex_taken = '[1,2]';
  ok('storage that is not a map is empty', win.vsTaken(55001).length === 0);

  ok('swipe left from Teams goes to Matches', win.tSwipeTarget('teams', 1) === 'matches');
  ok('swipe right from Teams goes nowhere', win.tSwipeTarget('teams', -1) === null);
  ok('the focused team is the last view', win.tSwipeTarget('picklist', 1) === 'team' && win.tSwipeTarget('team', 1) === null);
  ok('the swipe needs to be mostly sideways', /Math\.abs\(dx\) < 2 \* Math\.abs\(dy\)/.test(idx));
  ok('and does not fire inside something that scrolls sideways', /n\.scrollWidth > n\.clientWidth \+ 4/.test(idx));

  // Pull to refresh asks again, for real.
  await win.tournamentGo('team');
  await settle(win, 200);
  const before = win.document.getElementById('tournamentResults').innerHTML.length;
  const said = await win.vsRefreshCurrent();
  await settle(win, 200);
  ok('refreshing an event page re-renders it', said === 'Updated' && win.document.getElementById('tournamentResults').innerHTML.length === before);
  win.switchTab('info');
  ok('a tab with nothing to refresh says so', (await win.vsRefreshCurrent()) === 'Nothing to refresh here');
  ok('the browser\'s own pull-to-reload is held off on phones', /html, body \{ overscroll-behavior-y: contain; \}/.test(css));
  ok('no errors', errors.length === 0, errors.join('\n'));
  win.close();
  FIXTURES.playedThrough = undefined;
}

// ══ 3. A favorite's event saves itself ═════════════════════════════════════
console.log('\n· automatic offline');
{
  const store = {};
  const { win, router } = await boot({ store });
  const E = (id, a, b) => ({ id, name: 'E' + id, sku: 'RE-V5RC-25-0191', start: day(a), end: day(b) });
  ok('an event running today is wanted', win.vsAutoOfflineWanted(E(55001, 0, 1)));
  ok('one starting in three days is', win.vsAutoOfflineWanted(E(55001, 3, 3)));
  ok('one a month away is not', !win.vsAutoOfflineWanted(E(55001, 30, 30)));
  ok('one that ended last week is not', !win.vsAutoOfflineWanted(E(55001, -7, -7)));

  const mark = router.seen.length;
  ok('it queues', win.vsAutoOffline(E(55001, 0, 1), 9001) === true);
  ok('and not twice', win.vsAutoOffline(E(55001, 0, 1), 9001) === false);
  await settle(win, 500);
  const asked = router.seen.slice(mark);
  ok('it fetched the event for real', asked.some(p => /\/events\/55001\/teams/.test(p)) && asked.some(p => /rankings/.test(p)) && asked.some(p => /\/teams\/9001\/matches/.test(p)), asked.join(' | '));
  const saved = JSON.parse(store.vex_offline_events || '{}')['55001'];
  ok('and recorded the save', !!saved && saved.auto === true && saved.calls > 0, store.vex_offline_events);
  ok('a fresh copy is not saved again', !win.vsAutoOfflineWanted(E(55001, 0, 1)));
  ok('Save-Data is respected', /if \(c && c\.saveData\) return false;/.test(idx));
  ok('there is a cap per visit', /vsAutoOfflineCount >= VS_AUTO_OFFLINE_MAX/.test(idx));
  ok('a save that fetched nothing claims nothing', /if \(got\.calls > 0\) \{/.test(idx));
  win.close();
}

// ══ 4. The softer look ═════════════════════════════════════════════════════
console.log('\n· softer');
const soft = css.slice(css.indexOf('SOFTER (v82)'), css.indexOf('/* Form at this event'));
ok('the radius is a scale of named steps', /--r-sm: 6px; --r-md: 10px; --r-lg: 16px; --r-pill: 999px;/.test(soft));
const used = new Set([...soft.matchAll(/border-radius: (var\(--r-\w+\)|[\d.]+px|50%)/g)].map(m => m[1]));
ok('and more than one step is used', ['var(--r-md)', 'var(--r-lg)', 'var(--r-pill)'].every(v => used.has(v)), [...used].join(' '));
ok('the scanline layer is off everywhere', /body::after \{ display: none; \}/.test(soft));
ok('controls lose their outline', /\.fav-act \{ border-color: transparent; \}/.test(soft));
ok('and get it back for focus', /input:focus, select:focus, \.cs\.open \.cs-bar \{ border-color: var\(--accent-bright\); \}/.test(soft));
ok('no typeface is changed', !/font-family/.test(soft));
ok('the theme control is a round dot', /\.theme-btn \{[^}]*border-radius: 50%/.test(soft));
ok('with no word in it', !/<div class="theme-dot" id="themeDot"><\/div>\s*THEME/.test(idx));
// v83 moved the theme choices to the Settings tab; the dot is gone from the header.
ok('the theme choices are on the Settings tab', /<div class="theme-grid" id="themeDropdown">/.test(idx) && !/class="theme-btn" onclick/.test(idx));
ok('the event links fold behind More on phones', /\.t-nav \.t-nav-link \{ display: none; \}/.test(css) && /\.t-nav\.more-open \.t-nav-link \{ display: flex; \}/.test(css));
ok('More is hidden on a wide screen', /\.t-more-btn \{ display: none; \}/.test(soft));

console.log(`\nt105: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
