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
ok('the current place is named', /id="navWhere"/.test(idx));
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
  const where = () => d.getElementById('navWhere').textContent;

  ok('a fresh load records the tab you landed on', where() === 'Scout', where());
  ok('...and both arrows are dead there',
    back().disabled === true && fwd().disabled === true,
    'nothing came before it and nothing after');

  win.switchTab('tournament');
  ok('switching tabs is a move', where() === 'Tournament');
  ok('...so back comes alive', back().disabled === false);
  ok('...and forward stays dead', fwd().disabled === true);

  d.getElementById('tournamentInput').value = '66449A';
  await win.findTournament();
  await settle(win);
  ok('a list of search results is somewhere you came from', where() === "66449A's events");

  await win.loadTournamentTeams(55001, 'Bots @ Bristol', 9001, '66449A', 'RE-V5RC-25-0191');
  await settle(win, 350);
  ok('opening an event is a move', where() === '66449A at Bots @ Bristol', where());

  await win.tournamentGo('teams');
  await settle(win, 350);
  ok('so is changing sub-view', where() === 'Teams — Bots @ Bristol', where());

  // Back, all the way.
  await win.vsNavGo(-1); await settle(win, 350);
  ok('back returns to the event', where() === '66449A at Bots @ Bristol', where());
  ok('...and forward is now available', fwd().disabled === false);
  await win.vsNavGo(-1); await settle(win, 350);
  ok('back again returns to the search results', where() === "66449A's events", where());
  ok('...and the results are really on screen again',
    /CLICK TO VIEW MATCHES/.test(html(win, 'tournamentResults')),
    'the entry replays the search, it does not just relabel the bar');
  await win.vsNavGo(-1); await settle(win, 350);
  ok('back again reaches the Tournament tab', where() === 'Tournament', where());
  await win.vsNavGo(-1); await settle(win, 350);
  ok('back again reaches where the session started', where() === 'Scout', where());
  ok('...and back is dead at the start', back().disabled === true);
  await win.vsNavGo(-1); await settle(win, 200);
  ok('pressing it again does nothing', where() === 'Scout', where());

  // Forward, all the way.
  for (let i = 0; i < 4; i++) { await win.vsNavGo(1); await settle(win, 350); }
  ok('forward walks back up to the last place', where() === 'Teams — Bots @ Bristol', where());
  ok('...and is dead at the end', fwd().disabled === true);
  await win.vsNavGo(1); await settle(win, 200);
  ok('pressing it again does nothing', where() === 'Teams — Bots @ Bristol');
  ok('the tab really did follow along',
    d.getElementById('tab-tournament').classList.contains('active'));
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
    d.getElementById('navWhere').textContent === 'Tournament',
    d.getElementById('navWhere').textContent);
  stop();
}

// ── 4. The chart is gone ──
ok('no score chart is rendered any more', !/md_scoreChart|sc-wrap|sc-plot/.test(src));
ok('its styles went with it', !/\.sc-grid|\.sc-dot|\.sc-xtick/.test(idx));
ok('its hover listeners went too', !/md_chartHover/.test(src));
ok('the best-result panel stayed', /function md_bestResult/.test(src));

console.log(`\nt88: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
