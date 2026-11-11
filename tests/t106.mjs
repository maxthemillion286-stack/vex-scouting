// t106 — v83: Settings, your own team, the version badge, season-wide
// suggestions, and the computer layout.
import fs from 'fs';
import { boot, settle, html, FIXTURES } from './harness.mjs';
const window_ctx = (win, ctx) => { win._rwCtx = ctx; };

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '\n         ' + detail : '')); }
};
const idx = fs.readFileSync('../index.html', 'utf8');
const css = idx.slice(idx.indexOf('<style>'), idx.indexOf('</style>'));
const BUILD = (idx.match(/const APP_BUILD = '(v\d+)'/) || [])[1];

console.log('t106 — v83: settings, my team, the computer');

console.log('\n· settings and my team');
{
  const store = {};
  const { win, errors } = await boot({ store });
  ok('there is a Settings tab and panel', !!win.document.querySelector('.tab-btn[data-tab="settings"]') && !!win.document.getElementById('tab-settings'));
  win.switchTab('settings');
  ok('it opens', win.document.getElementById('tab-settings').classList.contains('active'));
  ok('with no team it says so', /No team set yet/.test(html(win, 'myTeamState')));
  ok('and the rail link is hidden', win.document.getElementById('myTeamLink').hidden === true);

  win.document.getElementById('myTeamInput').value = '99999Z';
  await win.myTeamSaveFromInput();
  ok('a team that does not exist is not saved', !store.vex_my_team);

  win.document.getElementById('myTeamInput').value = '66449a';
  await win.myTeamSaveFromInput();
  await settle(win, 100);
  ok('a real one is, upper-cased', store.vex_my_team === '66449A', store.vex_my_team);
  ok('the page says which', /Your team is <strong>66449A<\/strong>/.test(html(win, 'myTeamState')));
  ok('the rail link shows it', win.document.getElementById('myTeamLink').hidden === false && /66449A/.test(win.document.getElementById('myTeamLink').textContent));
  ok('empty team boxes are filled in', ['detailTeamInput', 'tournamentInput', 'rwTeamInput'].every(id => win.document.getElementById(id).value === '66449A'));
  win.document.getElementById('detailTeamInput').value = '1234X';
  win.myTeamPrefill();
  ok('a box with something in it is left alone', win.document.getElementById('detailTeamInput').value === '1234X');

  win.vsFavSet('1234X', true);
  ok('it comes first on Favorites, starred or not', win.vsFavList().join() === '66449A,1234X');
  win.switchTab('favs');
  await settle(win, 150);
  const favs = html(win, 'favsResults');
  ok('its card is marked, with no remove button', /data-favcard="66449A"[\s\S]*?My team/.test(favs) && !/vsFavSet\('66449A', false\)/.test(favs));
  ok('the other card keeps its remove button', /vsFavSet\('1234X', false\)/.test(favs));

  win.myTeamClear();
  ok('Remove clears it', !store.vex_my_team && win.vsMyTeam() === '' && win.vsFavList().join() === '1234X');

  store.vex_my_team = "');window.__pwn=1;('<b>";
  win.myTeamApply();
  ok('a poisoned stored team is narrowed before it is drawn', !/[<>'"();=]/.test(win.vsMyTeam()) && !/window\.__pwn|\('|=1/.test(win.document.getElementById('myTeamLink').innerHTML) && !win.__pwn);

  // The theme choices moved here and still work.
  store.vex_my_team = '';
  ok('sixteen themes on the Settings tab', win.document.querySelectorAll('#tab-settings .theme-option').length === 16);
  ok('none left in the header', !win.document.querySelector('header .theme-option, header .theme-btn'));
  win.applyTheme('dark-blue');
  ok('picking one applies and stores it', win.document.body.classList.contains('theme-dark-blue') && store.vex_theme === 'dark-blue');
  ok('and marks it', win.document.getElementById('opt-dark-blue').classList.contains('active'));

  // The badge: a version and whether the data is live.
  win.setBadge(true);
  const b = win.document.getElementById('statusBadge');
  ok('the badge shows the version', b.textContent.replace(/\s+/g, '') === BUILD + 'Live', b.textContent);
  ok('and never the word CONNECTED', !/CONNECTED/i.test(b.textContent));
  win.setBadge(false);
  ok('offline says Offline', /Offline/.test(b.textContent) && !b.classList.contains('connected'));
  ok('About carries the version too', new RegExp('VEX Scout ' + BUILD).test(win.document.getElementById('setAbout').textContent));
  ok('Info is one tap from Settings', /onclick="switchTab\('info'\)">What VEX Scout does</.test(idx));
  ok('no errors', errors.length === 0, errors.join('\n'));
  win.close();
}

console.log('\n· suggestions for any team this season');
{
  const { win } = await boot();
  // Stand in for the season boards: two teams nobody has looked up.
  win.getFullSeasonSkills = async () => ({ byId: { 1: { number: '3050X', globalRank: 9 }, 2: { number: '3050W', globalRank: 2 }, 3: { number: '9999A', globalRank: 1 } } });
  const got = (await win.vsSuggestSeasonTeams('305')).map(t => t.number);
  ok('a three-digit stem finds a four-digit team', got.includes('3050X') && got.includes('3050W') && !got.includes('9999A'), got.join());
  ok('best skills rank first', got[0] === '3050W');
  const all = (await win.vsSuggestTeams('3050')).map(t => t.number);
  ok('and they reach the suggestions', all.includes('3050X') && all.includes('3050W'), all.join());
  win.getFullSeasonSkills = () => new Promise(() => {});
  const t0 = Date.now();
  await win.vsSuggestSeasonTeams('305');
  ok('a board that never answers does not hang the box', Date.now() - t0 < 4000);
  ok('the Settings team box suggests too', /myTeamInput: \(\) => myTeamSaveFromInput\(\)/.test(idx));
  win.close();
}


console.log('\n· the Jumper: shift and late-running matches');
{
  const { win } = await boot();
  const D = '2026-02-28T15:00:00Z';
  const t0 = Date.parse(D);
  const day = win.rwDayKey(t0);
  // A day streamed in two parts: the case the old shift could not move.
  const cal = { [day]: { videoId: 'aaa', segments: [{ videoId: 'aaa', startMs: t0 - 600000 }, { videoId: 'bbb', startMs: t0 + 3600000 }] } };
  const m = { id: 1, t: t0 };
  window_ctx(win, { eventId: 55001, cal, shift: {}, matches: [m] });
  const base = win.rwOffsetFor(m, cal);
  ok('a match in a multi-part day has a position', base === 600, String(base));
  win._rwCtx.shift[day] = 90;
  ok('a shift moves it, segments or not', win.rwOffsetFor(m, cal) === 690);
  win._rwCtx.shift[day] = -9999;
  ok('and never below the start of the video', win.rwOffsetFor(m, cal) === 0);
  win._rwCtx.shift = {};
  ok('no shift, no change', win.rwOffsetFor(m, cal) === base);
  win.rwSaveShift(55001, { [day]: 70 });
  ok('a shift is kept per event', win.rwLoadShift(55001)[day] === 70 && Object.keys(win.rwLoadShift(999)).length === 0);
  ok('the bar offers minutes and seconds both ways', ['-300', '-60', '-10', '10', '60', '300'].every(v => idx.includes(`[${v}, '`)));
  ok('and says how far a day has moved', win.rwShiftLabel(70) === '1:10 later' && win.rwShiftLabel(-125) === '2:05 earlier');
  ok('RESET clears the shift with the stream', /if \(ctx\.shift\) \{ if \(day\) delete ctx\.shift\[day\];/.test(idx));

  // Late-running: a match with only a scheduled time borrows its neighbours' slip.
  const iso = ms => new Date(ms).toISOString();
  const all = [
    { scheduled: iso(t0), started: iso(t0 + 12 * 60000) },
    { scheduled: iso(t0 + 20 * 60000), started: iso(t0 + 38 * 60000) },
    { scheduled: iso(t0 + 86400000), started: iso(t0 + 86400000 + 60 * 60000) }   // another day
  ];
  const mine = [{ exact: false, sched: t0 + 18 * 60000, t: t0 + 18 * 60000 }, { exact: true, sched: t0, t: t0 + 5 }, { exact: false, sched: t0 + 6 * 3600000, t: t0 + 6 * 3600000 }];
  const moved = win.rwApplySlip(mine, all);
  ok('it takes the slip of the nearest scheduled neighbour', mine[0].t === t0 + 18 * 60000 + 18 * 60000 && mine[0].est === true, String((mine[0].t - t0) / 60000));
  ok('a match with a real start is left alone', mine[1].t === t0 + 5 && !mine[1].est);
  ok('nothing within reach, nothing guessed', mine[2].t === t0 + 6 * 3600000 && !mine[2].est && moved === 1);
  ok('it stays marked as an estimate', mine[0].exact === false);
  win.close();
}

console.log('\n· active and inactive teams');
{
  const { win } = await boot();
  const keep = FIXTURES.teams;
  FIXTURES.teams = [{ ...keep[0], number: '3050A', registered: false, team_name: 'Old Bots' }, { ...keep[0], id: 9777, number: '3050X', registered: true, team_name: 'New Bots' }];
  const got = await win.vsSuggestTeams('3050');
  ok('active teams come first', got[0].number === '3050X' && got[0].active === true, JSON.stringify(got));
  ok('a letter that no longer competes is last and flagged', got[got.length - 1].number === '3050A' && got[got.length - 1].active === false);
  const input = win.document.getElementById('favAddInput');
  input.value = '3050';
  input.dispatchEvent(new win.Event('input', { bubbles: true }));
  await settle(win, 400);
  const h = win.document.getElementById('favAddInputSuggest').innerHTML;
  ok('the chip says Inactive', /class="sg-chip inactive"[^>]*><b>3050A<\/b>[\s\S]*?<i>Inactive<\/i>/.test(h), h);
  ok('and Active on the other', /<b>3050X<\/b>[\s\S]*?<i>Active<\/i>/.test(h));
  FIXTURES.teams = keep;
  win.close();
}

console.log('\n· rows line up');
ok('every control in a row is one height', /\.controls-row input\[type="text"\][^{]*\{ height: 46px;/.test(css) && /\.controls-row > \.btn[^{]*\{ height: 46px;/.test(css));
ok('and sits on the row\'s bottom edge', /\.controls-row \{ align-items: flex-end; \}/.test(css));

console.log('\n· the computer');
const desk = css.slice(css.indexOf('THE COMPUTER (v83)'));
const mq = desk.slice(desk.indexOf('@media (min-width: 900px) {'));
ok('the redesign is inside one wide-screen query', mq.length > 500);
ok('the tabs are a rail down the left', /\.tabs-nav \{ position: fixed; left: 12px;/.test(mq) && /body \{ padding-left: 248px;/.test(mq));
ok('the page is left-aligned, not centred', /\.container \{ max-width: 1180px; margin: 0;/.test(mq));
ok('the tagline under the logo is gone', /\.logo-sub \{ display: none; \}/.test(mq));
ok('the gradient wash is gone', /body::before \{ display: none; \}/.test(mq));
ok('the page name is a heading, in sentence case', /\.section-label \{[^}]*font-size: 30px;[^}]*text-transform: lowercase;/.test(mq) && /\.section-label::first-letter \{ text-transform: uppercase; \}/.test(mq));
ok('field labels use the reading face, not the mono one', /\.input-label \{[^}]*font-family: var\(--body\);/.test(mq));
ok('a team number in the event views is not lowercased', /\.t-nav-btn\[onclick\*="'team'"\] \{ text-transform: none; \}/.test(mq));
ok('SKU keeps its capitals', /\.input-label\.keep-case \{ text-transform: none; \}/.test(mq));
const sizes = [...mq.matchAll(/font-size: ([\d.]+)px/g)].map(m => +m[1]);
ok('nothing in it is under 12px', sizes.every(v => v >= 12), sizes.filter(v => v < 12).join());
ok('the three typefaces are still the only three', [...new Set([...css.matchAll(/font-family: ([^;]+);/g)].map(m => m[1].trim()))]
  .every(f => /var\(--(mono|display|body)\)|inherit|'Share Tech Mono'|'Oswald'|'Rajdhani'|monospace|sans-serif/.test(f)));

console.log(`\nt106: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
