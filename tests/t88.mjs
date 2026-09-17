// t88 — back and forward through where you have been.
//
// "have a forward and back arrow (left and right) that let me navigate to the
// place i came from and go back to where i came from, if im already as far back
// or forward as possible make the arrow greyed out like i cant click backwards
// if im already as far back as possible"
//
// The app is one page with no URLs, so the browser's own Back button either
// leaves the site or does nothing. Getting from a team's matches back to the
// list you picked them from meant retyping the search.
//
// Each entry carries a CLOSURE that puts the app back, rather than a
// description of a state some future render would have to learn to rebuild.
// Replaying re-enters the same functions a click does, so `busy` is what stops
// a replay recording itself as a new place — without it, going back would push
// the place you went back to and the stack would never shrink.
import fs from 'fs';
import { boot, settle, html } from './harness.mjs';
let pass = 0, fail = 0;
const ok = (n, c, e) => { c ? (pass++, console.log('  ok   ' + n)) : (fail++, console.log('  FAIL ' + n + (e ? '\n         ' + e : ''))); };
const idx = fs.readFileSync('../index.html', 'utf8');
const src = idx.match(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/)[1];

console.log('t88 — back / forward');

// ── 1. Shape ──
ok('both arrows exist', /id="navBack"/.test(idx) && /id="navFwd"/.test(idx));
ok('they start disabled, before any navigation has happened',
  /id="navBack"[^>]*disabled/.test(idx) && /id="navFwd"[^>]*disabled/.test(idx));
ok('they are labelled for a screen reader',
  /aria-label="Back"/.test(idx) && /aria-label="Forward"/.test(idx));
ok('they sit outside .tabs-nav',
  idx.indexOf('nav-history') < idx.indexOf('<div class="tabs-nav">'),
  'the sliding tab indicator is positioned from that row\'s children');
ok('the stack is capped', /const VS_NAV_MAX = 50;/.test(src));

// Going back to a tab you found empty leaves it empty. Otherwise
// Tournament → search → back lands on the tab with the results still on
// screen, and the only sign anything happened is the arrow greying out.
ok('a tab entry remembers whether its panel was empty',
  /const wasEmpty = tabPanelEmpty\(tabName\);/.test(src));
ok('...and clears it on the way back', /if \(wasEmpty\) clearTabPanel\(tabName\);/.test(src));
ok('...but only what was already empty when you arrived',
  /Only ever clears what was already empty/.test(src),
  'it can never throw away something you navigated to');
ok('the tab you land on at boot counts as empty',
  /\{ switchTab\(tab\); clearTabPanel\(tab\); \}/.test(src));

// Greying out is `disabled`, not a class — so it cannot look dead and still work.
ok('the disabled state is the real one, not a class',
  /back\.disabled = !canBack;/.test(src) && /fwd\.disabled = !canFwd;/.test(src));
ok('and it is visibly faded', (() => {
  const m = idx.match(/\.nav-arrow:disabled \{[^}]*opacity: ([\d.]+)/);
  return m && parseFloat(m[1]) <= 0.4;
})(), 'the exact value is a taste call; being clearly dimmer is not');
ok('the live arrow is brighter than the dead one',
  /\.nav-arrow:not\(:disabled\) \{ color: var\(--text-dim\); \}/.test(idx) &&
  /\.nav-arrow \{[^}]*color: var\(--text-muted\)/.test(idx));

// Glyphs rather than buttons: a bordered box either side of the label read as
// two more controls competing with the tabs directly underneath.
ok('the arrows carry no box of their own',
  /\.nav-arrow \{[^}]*background: none; border: 0;/.test(idx),
  'they are chrome for getting back to something, not a primary control');
ok('...but the touch target survives the slimming',
  /\.nav-arrow \{[^}]*padding: 6px 7px;/.test(idx),
  'about 28px tall with a 14px glyph — thumbable without looking heavy');
ok('the hover state is behind a real pointer',
  /@media \(hover: hover\) \{ \.nav-arrow:not\(:disabled\):hover/.test(idx),
  'a touch device latches hover onto the last thing tapped');
ok('each arrow says where it goes', /back\.title = canBack \? 'Back to '/.test(src));
ok('nothing is printed beside them — the page says where you are',
  !/navWhere|nav-where/.test(idx),
  'the arrows only need to say where they LEAD, which the tooltips do');
ok('Alt+arrow works too, the same chord a browser uses',
  /if \(e\.key === 'ArrowLeft'\) \{ e\.preventDefault\(\); vsNavGo\(-1\); \}/.test(src));

// ── 2. The rules, in isolation ──
const push = new Function(`
  const VS_NAV_MAX = 50;
  const vsNav = { stack: [], i: -1, busy: false };
  function vsNavRender() {}
  ${src.slice(src.indexOf('function vsNavPush'), src.indexOf('async function vsNavGo'))}
  return { vsNav, vsNavPush };`)();
const { vsNav, vsNavPush } = push;
const at = () => (vsNav.stack[vsNav.i] || {}).key;
const canBack = () => vsNav.i > 0;
const canFwd = () => vsNav.i < vsNav.stack.length - 1;

vsNavPush('a', 'A', () => {});
ok('the first place cannot be gone back from', canBack() === false);
ok('...nor forward from', canFwd() === false);
vsNavPush('b', 'B', () => {});
ok('a second place makes back available', canBack() === true && at() === 'b');
vsNav.i = 0;
ok('being at the start means forward is available', canFwd() === true);
vsNavPush('c', 'C', () => {});
ok('going somewhere new from halfway back drops what was ahead',
  vsNav.stack.length === 2 && at() === 'c' && canFwd() === false,
  vsNav.stack.map(e => e.key).join(','));
vsNavPush('c', 'C again', () => {});
ok('landing where you already are is not a new place',
  vsNav.stack.length === 2 && at() === 'c', vsNav.stack.map(e => e.key).join(','));
vsNavPush('c', 'C again', () => {});
ok('landing where you already are is not a move',
  vsNav.stack.length === 2 && vsNav.i === 1);
ok('...but the newer closure is kept', vsNav.stack[1].label === 'C again',
  'an event opened without a SKU and then with one');
vsNav.busy = true;
vsNavPush('d', 'D', () => {});
ok('a replay does not record itself as a new place', vsNav.stack.length === 2,
  'otherwise going back pushes what you went back to and the stack never shrinks');
vsNav.busy = false;
for (let i = 0; i < 60; i++) vsNavPush('k' + i, 'K' + i, () => {});
ok('the stack stops growing', vsNav.stack.length === 50, vsNav.stack.length + ' entries');
ok('...by dropping the oldest', vsNav.stack[0].key !== 'c');

// ── 3. Driven through the real app ──
{
  const { win, errors, stop } = await boot();
  const d = win.document;
  const back = () => d.getElementById('navBack');
  const fwd = () => d.getElementById('navFwd');
  // Where you are is read off the PAGE, not off a label. That is the honest
  // question anyway: did the app actually go back, or did a caption change?
  const tabOpen = () => ['scout', 'skills', 'tournament', 'rewatch', 'simulator']
    .find(t => d.getElementById('tab-' + t).classList.contains('active'));
  const results = () => html(win, 'tournamentResults');
  const onSearchList = () => /CLICK TO VIEW MATCHES/.test(results());
  const onTeamView = () => /Matches for/.test(results()) && /66449A/.test(results());
  const onTeamList = () => /teams registered/.test(results());
  // The tooltip names the destination, which is the only text the arrows carry.
  const backTo = () => back().title;
  const fwdTo = () => fwd().title;

  ok('a fresh load starts on the Scout tab', tabOpen() === 'scout', tabOpen());
  ok('...and both arrows are dead there',
    back().disabled === true && fwd().disabled === true,
    'nothing came before it and nothing after');

  win.switchTab('tournament');
  ok('switching tabs is a move', tabOpen() === 'tournament');
  ok('...so back comes alive', back().disabled === false);
  ok('...and it names where it leads', backTo() === 'Back to Scout', backTo());
  ok('...and forward stays dead', fwd().disabled === true);
  ok('...saying so', fwdTo() === 'Nothing to go forward to', fwdTo());

  d.getElementById('tournamentInput').value = '66449A';
  await win.findTournament();
  await settle(win);
  ok('a list of search results is somewhere you came from', onSearchList());
  ok('...and back leads to the tab', backTo() === 'Back to Tournament', backTo());

  await win.loadTournamentTeams(55001, 'Bots @ Bristol', 9001, '66449A', 'RE-V5RC-25-0191');
  await settle(win, 350);
  ok('opening an event is a move', onTeamView() && !onSearchList());
  ok('...and back leads to the results', backTo() === "Back to 66449A's events", backTo());

  await win.tournamentGo('teams');
  await settle(win, 350);
  ok('so is changing sub-view', onTeamList());

  // Back, all the way — checking the PAGE each time.
  await win.vsNavGo(-1); await settle(win, 350);
  ok('back returns to the team view', onTeamView() && !onTeamList());
  ok('...and forward is now available', fwd().disabled === false);
  ok('...naming where it goes', /^Forward to Teams/.test(fwdTo()), fwdTo());
  await win.vsNavGo(-1); await settle(win, 350);
  ok('back again really re-runs the search', onSearchList(),
    'the entry replays it, it does not just relabel anything');
  await win.vsNavGo(-1); await settle(win, 350);
  ok('back again reaches the Tournament tab as it was found — empty',
    tabOpen() === 'tournament' && !onSearchList(),
    'a back press that leaves the results up looks like it did nothing');
  await win.vsNavGo(-1); await settle(win, 350);
  ok('back again reaches where the session started', tabOpen() === 'scout');
  ok('...and back is dead at the start', back().disabled === true);
  ok('...saying so', backTo() === 'Nothing to go back to', backTo());
  await win.vsNavGo(-1); await settle(win, 200);
  ok('pressing it again does nothing', tabOpen() === 'scout');

  // Forward, all the way.
  for (let i = 0; i < 4; i++) { await win.vsNavGo(1); await settle(win, 350); }
  ok('forward walks back up to the last place', onTeamList(), results().slice(0, 120));
  ok('...and is dead at the end', fwd().disabled === true);
  await win.vsNavGo(1); await settle(win, 200);
  ok('pressing it again does nothing', onTeamList());
  ok('the tab really did follow along', tabOpen() === 'tournament');
  ok('nothing threw anywhere in that', errors.length === 0, errors.join('\n'));
  stop();
}

// A move to somewhere new after going back must drop the forward history.
{
  const { win, stop } = await boot();
  const d = win.document;
  win.switchTab('tournament');
  win.switchTab('skills');
  await win.vsNavGo(-1); await settle(win, 200);
  ok('forward is available after going back', d.getElementById('navFwd').disabled === false);
  win.switchTab('simulator');
  ok('going somewhere new drops it', d.getElementById('navFwd').disabled === true);
  await win.vsNavGo(-1); await settle(win, 200);
  ok('and back now leads where you actually were',
    d.getElementById('tab-tournament').classList.contains('active'),
    'Skills was dropped when Simulator was opened from halfway back');
  stop();
}

// ── 4. The chart is gone ──
ok('no score chart is rendered any more', !/md_scoreChart|sc-wrap|sc-plot/.test(src));
ok('its styles went with it', !/\.sc-grid|\.sc-dot|\.sc-xtick/.test(idx));
ok('its hover listeners went too', !/md_chartHover/.test(src));
ok('the best-result panel stayed', /function md_bestResult/.test(src));

console.log(`\nt88: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
