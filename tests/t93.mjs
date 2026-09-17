// t93 — the look applied everywhere, and the button that looked like a no-op.
//
// v60 quietened the Tournament tab. v62 carries the same rules through Scout,
// Skills, the Jumper and the Simulator, because half an app in one style is
// worse than either style applied consistently.
//
// The rules, so a later change can be checked against them:
//   · a list that draws hairlines between its rows does not also frame the set
//   · a panel keeps its surface and loses its outline
//   · a row in a list is a row, not a box
//   · a sub-navigation is an underline strip, never a tray of filled buttons
//   · a notice is a rule down its left edge, not a box with a tint
import fs from 'fs';
import { boot, settle, html } from './harness.mjs';
let pass = 0, fail = 0;
const ok = (n, c, e) => { c ? (pass++, console.log('  ok   ' + n)) : (fail++, console.log('  FAIL ' + n + (e ? '\n         ' + e : ''))); };
const idx = fs.readFileSync('../index.html', 'utf8');
const src = idx.match(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/)[1];
const css = idx.slice(0, idx.indexOf('</style>'));

console.log('t93 — one look everywhere, and MULTI SCOUT');

// ══ 1. No set is both hairlined and framed ══════════════════════════════════
console.log('\n· frames around lists');
// The `gap: 1px; background: var(--border)` idiom IS the row separator. A
// border on the same rule draws the outline twice.
{
  const doubled = [];
  for (const m of css.matchAll(/^\s*(\.[a-zA-Z0-9_-]+)\s*\{([^}]*)\}/gm)) {
    const [, cls, body] = m;
    if (/gap: 1px/.test(body) && /background: var\(--border\)/.test(body)
        && /border: 1px solid/.test(body)) doubled.push(cls);
  }
  ok('no list frames its own hairlines', doubled.length === 0, doubled.join(', '));
}
for (const cls of ['.detail-overview', '.rw-list', '.rw-events', '.skill-table',
                   '.pick-list', '.ev-attend-list', '.sim-rating-table',
                   '.bracket-odds', '.ladder-grid', '.t-skills', '.t-awards',
                   '.tournament-list']) {
  ok(`${cls} is a list, not a framed list`,
    new RegExp('\\' + cls + ' \\{[^}]*\\}').test(css) &&
    !new RegExp('\\' + cls + ' \\{[^}]*border: 1px solid').test(css));
}

// ══ 2. Panels keep the surface, lose the outline ════════════════════════════
console.log('\n· panels');
for (const cls of ['.detail-block', '.detail-radar', '.rw-block', '.sim-block',
                   '.sched-summary', '.md-headline', '.team-card', '.sim-alliance',
                   '.sim-ov-team', '.md-expand', '.es-sig-panel']) {
  const rule = new RegExp('\\' + cls + ' \\{[^}]*\\}').exec(css);
  if (!rule) continue;
  ok(`${cls} has no outline`, !/border: 1px solid/.test(rule[0]), rule[0].slice(0, 110));
}

// ══ 3. Rows are rows ═══════════════════════════════════════════════════════
console.log('\n· rows');
for (const cls of ['.match-row', '.t-match-row', '.sched-row', '.sim-event-item']) {
  const rule = new RegExp('\\' + cls + ' \\{[^}]*\\}').exec(css);
  ok(`${cls} separates with a hairline`,
    !!rule && /border-bottom: 1px solid/.test(rule[0]) && !/border: 1px solid/.test(rule[0]),
    rule ? rule[0].slice(0, 120) : 'rule not found');
}
ok('the win/loss stripe survives — that one is information',
  /\.match-row\.win \{ border-left: 4px solid/.test(css) &&
  /\.rw-row\.win \{ box-shadow: inset 3px 0 0/.test(css));

// ══ 4. Both sub-navigations are the same strip ══════════════════════════════
console.log('\n· sub-navigation');
for (const nav of ['.t-nav', '.sim-subnav']) {
  const rule = new RegExp('\\' + nav + ' \\{[^}]*\\}').exec(css);
  ok(`${nav} is an underline strip`,
    !!rule && /border-bottom: 1px solid var\(--border\)/.test(rule[0]) && !/border: 1px solid/.test(rule[0]),
    rule ? rule[0].slice(0, 130) : 'not found');
  ok(`${nav} scrolls rather than wrapping`, !!rule && /overflow-x: auto/.test(rule[0]));
}
ok('neither marks the active view with a filled block',
  !/\.t-nav-btn\.active \{[^}]*background: var\(--accent\)/.test(css) &&
  !/\.sub-btn\.active \{[^}]*background: var\(--accent\)/.test(css));
ok('both mark it with a bottom rule instead',
  /\.t-nav-btn\.active \{[^}]*border-bottom-color: var\(--accent-bright\)/.test(css) &&
  /\.sub-btn\.active \{[^}]*border-bottom-color: var\(--accent-bright\)/.test(css));

// ══ 5. Notices are a rule, not a box ═══════════════════════════════════════
console.log('\n· notices');
for (const cls of ['.error-box', '.rolldown', '.t-hidden-note', '.md-next']) {
  const rule = new RegExp('\\' + cls + ' \\{[^}]*\\}').exec(css);
  ok(`${cls} is a left rule`, !!rule && /border-left: 2px solid/.test(rule[0]) && !/border: 1px solid/.test(rule[0]),
    rule ? rule[0].slice(0, 120) : 'not found');
}

// ══ 6. A label does not trail a rule off its end ═══════════════════════════
ok('no label draws a gradient rule after itself',
  !/::after \{ content: ''; flex: 1; height: 1px; background: linear-gradient/.test(css),
  '.section-label lost this in v60; the block labels kept it until v62');

// ══ 7. Typefaces are still the ones from before the redesign ═══════════════
console.log('\n· typefaces');
ok('the event sub-nav links match the views beside them',
  /\.t-nav-link \{[^}]*font-family: var\(--display\)/.test(css) &&
  /\.t-nav-link \{[^}]*text-transform: uppercase/.test(css),
  'v60 put these in the mono face and v61 put them back — do not do it again');
ok('the simulator sub-nav uses the display face too',
  /\.sim-subnav \.sub-btn \{[^}]*font-family: var\(--display\)/.test(css));

// ══ 7b. Two faces, two jobs ════════════════════════════════════════════════
//
// mono is for numbers, ids, clocks and short labels; body is for sentences.
// The Jumper already worked this way — .rw-hint and .sim-caveat were on the
// body face — and v63 finished it across the other tabs.
console.log('\n· prose vs numbers');
{
  const face = (cls) => {
    const r = new RegExp('^[^\n{]*\\.' + cls + '\\s*\\{[^}]*\\}', 'm').exec(css);
    if (!r) return null;
    const f = /font-family: var\(--(\w+)\)/.exec(r[0]);
    return f ? f[1] : 'inherited';
  };
  for (const cls of ['hint', 't-empty', 'no-awards', 'md-drift', 'rw-fallback',
                     'rw-resume-text', 'rw-check', 't-hidden-note', 'info-bar',
                     'page-info', 'error-box', 'team-location', 'detail-robot']) {
    ok(`.${cls} is prose, so it is on the body face`, face(cls) === 'body', '-> ' + face(cls));
  }
  for (const cls of ['md-stat-label', 'match-num', 'match-time', 'rw-step-at', 'ov-label']) {
    ok(`.${cls} is a label or a clock, so it stays mono`, face(cls) === 'mono', '-> ' + face(cls));
  }
  ok('prose carries leading, because Rajdhani sits smaller than the mono face',
    /\.hint \{[^}]*line-height: 1\.5/.test(css));
}

// ══ 7c. Digits that get compared are tabular ═══════════════════════════════
//
// Only matters in a proportional face — monospace digits already align. The
// trap: a naive `.foo {` regex also matches `.foo.state .foo {`, so the
// declaration lands on a colour override and never reaches the base rule.
console.log('\n· tabular figures');
{
  const bad = [];
  for (const cls of ['match-score', 'md-winpct', 't-sk-total', 'pick-win', 'rd-score',
                     'skill-rank', 'rd-pos', 'ladder-cell-pos', 'ss-record',
                     'md-stat-value', 'tt-num', 'skill-num', 'sim-ov-num', 'md-opp-num',
                     't-sk-team', 'sr-team', 'pick-team', 'team-number', 'detail-number',
                     'md-next-name', 'ov-big', 't-match-score', 'rw-score']) {
    // the rule that actually sets the type for this class, not a state override
    const r = new RegExp('^[^\n{]*\\.' + cls + '\\s*\\{[^}]*(?:font-family|font-size)[^}]*\\}', 'm').exec(css);
    if (!r || !/tabular-nums/.test(r[0])) bad.push(cls);
  }
  ok('every compared number column is tabular', bad.length === 0, bad.map(c => '.' + c).join(', '));
  ok('...and it is on the base rule, not a state override',
    !/\.match-row\.upcoming \.match-score \{[^}]*tabular/.test(css) &&
    !/\.skill-row\.selected \.skill-rank \{[^}]*tabular/.test(css),
    'a colour override is not where type belongs');
}

// ══ 8. MULTI SCOUT ═════════════════════════════════════════════════════════
//
// The Scout tab renders comparison cards for two or more numbers and the full
// single profile for one. The schedule view handed it ONE number, so it
// produced exactly what the SCOUT button beside it produced — pressing it
// looked like pressing nothing.
console.log('\n· MULTI SCOUT on a schedule');
ok('it refuses to be a second SCOUT button',
  /if \(list\.size < 2\) \{[\s\S]{0,300}return;/.test(src),
  'one number is the single-team profile, which is the other button');
ok('...and says what it needs instead of failing silently',
  /Multi Scout compares two or more teams/.test(src));
ok('a schedule can name the teams worth comparing',
  /function tScheduleTeamNumbers\(myMatches, selfNumber\)/.test(src));
ok('...from both sides of every match',
  /\[\.\.\.\(m\.myNums \|\| \[\]\), \.\.\.\(m\.oppNums \|\| \[\]\)\]/.test(src));
ok('...and never lists the team itself twice',
  /if \(u && u !== self\) out\.add\(u\);/.test(src));

{
  const { win, errors, stop } = await boot();
  win.switchTab('tournament');
  await win.loadTournamentTeams(55001, 'Bots @ Bristol', 9001, '66449A', 'RE-V5RC-25-0191');
  await settle(win, 700);
  const h = html(win, 'tournamentResults');
  const btn = [...win.document.querySelectorAll('#tournamentResults button')]
    .find(b => /MULTI SCOUT/.test(b.textContent));
  ok('the button says how many it will compare', !!btn && /MULTI SCOUT \d+/.test(btn.textContent),
    btn ? btn.textContent.trim() : 'no button');
  ok('...and that is more than one', !!btn && Number(btn.textContent.match(/(\d+)/)[1]) > 1,
    btn ? btn.textContent.trim() : '');

  btn.click();
  await settle(win, 2200);
  ok('pressing it lands on the Scout tab',
    win.document.getElementById('tab-scout').classList.contains('active'));
  const val = win.document.getElementById('detailTeamInput').value;
  ok('the focused team is in the list', /66449A/.test(val), val);
  ok('so are the teams it plays', val.split(/,\s*/).length > 1, val);
  const d = html(win, 'detailResults');
  ok('and it draws a card per team, not one profile',
    (d.match(/class="team-card/g) || []).length > 1,
    (d.match(/class="team-card/g) || []).length + ' cards');

  // The guard, driven.
  win.switchTab('tournament'); await settle(win, 250);
  win.multiScoutFromTournament('66449A');
  await settle(win, 350);
  ok('a lone team does not silently re-run the single profile',
    win.document.getElementById('tab-tournament').classList.contains('active'),
    'it should stay put and explain');
  ok('nothing threw', errors.length === 0, errors.join('\n'));
  stop();
}

console.log(`\nt93: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
