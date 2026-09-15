// t87 — the team's own page: how far they got, and the shape of their day.
//
// Asked for from a RobotEvents screenshot: "when I type in 66449a in events and
// click that event it shows me this". That lands on the focused-team view, so
// that is where the three pieces go — a score-by-match chart, the W/L already
// on every row, and a Best result panel.
//
// The chart is hand-rolled SVG: this app is one file, no build step, no CDN.
// Two rules it has to keep, both checked below.
//
//   IDENTITY IS NEVER COLOUR ALONE. There are fifteen user-selectable themes,
//   so nothing may depend on telling two particular hues apart. The opponent's
//   line is dashed as well as muted, and a legend is always present.
//
//   GRIDLINES STAY SOLID. A dashed grid reads as "projection" or "threshold"
//   when it is just a grid; dashing here means "not you" and nothing else.
//
// And one thing only rendering catches: the SVG scales its whole viewBox, so an
// 11-unit label inside a 720-unit box lands at about 5px in a phone-width
// column. Everything in user units grows under 560px to compensate.
import fs from 'fs';
import { boot, settle, html, FIXTURES } from './harness.mjs';
let pass = 0, fail = 0;
const ok = (n, c, e) => { c ? (pass++, console.log('  ok   ' + n)) : (fail++, console.log('  FAIL ' + n + (e ? '\n         ' + e : ''))); };
const idx = fs.readFileSync('../index.html', 'utf8');
const src = idx.match(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/)[1];

console.log('t87 — best result, and score by match');

// ── 1. Best result ──
// md_bestResult is taken off the real page rather than sliced out of the
// source. HANDOFF §7: every extraction in this repo has gone stale the moment
// the function gained a dependency, and this one needs detectRoundFromMatch.
const PAGE = await boot();
const best = PAGE.win.md_bestResult;
const mk = (name, mine, theirs, t) => ({ raw: { name, round: /^Q/i.test(name) ? 2 : 5 }, name,
  played: true, myScore: mine, oppScore: theirs, time: t });

ok('a semifinal loss is reported as Semifinals', (() => {
  const r = best([mk('Qualification 1', 101, 91, 1), mk('R16 #7-1', 143, 5, 2),
                  mk('QF #4-1', 113, 57, 3), mk('SF #2-1', 8, 135, 4)]);
  return r && r.label === 'Semifinals' && r.won === false && r.elim;
})());
ok('winning the final is CHAMPION', (() => {
  const r = best([mk('SF #2-1', 90, 10, 3), mk('Final #1', 120, 80, 4)]);
  return r && r.champion && r.label === 'CHAMPION';
})());
ok('losing the final is Finals, not champion', (() => {
  const r = best([mk('Final #1', 80, 120, 4)]);
  return r && !r.champion && r.label === 'Finals';
})());
ok('a team that never reached eliminations says so', (() => {
  const r = best([mk('Qualification 1', 101, 91, 1), mk('Qualification 2', 99, 90, 2)]);
  return r && r.label === 'QUALIFICATION ONLY' && r.elim === false;
})());
ok('an event with nothing played yet has no best result',
  best([{ raw: { name: 'Qualification 1' }, played: false }]) === null);
ok('the later match of the furthest round is the one reported', (() => {
  const r = best([mk('SF #2-1', 90, 10, 3), mk('SF #2-2', 40, 95, 5)]);
  return r && r.name === 'SF #2-2' && r.won === false;
})());
PAGE.stop();

// ── 2. The chart ──
ok('it needs more than two points to be worth drawing',
  /if \(pts\.length < 3\) return '';/.test(src),
  'a line between two numbers is what the match list already says');
ok('only played matches are plotted', /m\.played &&/.test(src));
ok('the y scale starts at zero and rounds up',
  /Math\.max\(20, Math\.ceil\(top \/ 20\) \* 20\)/.test(src));

// Anti-patterns, checked against the stylesheet.
const css = [...idx.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map(m => m[1]).join('\n');
const rule = sel => (css.match(new RegExp('\\' + sel + '\\s*\\{[^}]*\\}', 'g')) || []).join(' ');
ok('gridlines are solid hairlines, never dashed',
  /\.sc-grid \{[^}]*stroke-width: 1;[^}]*\}/.test(css) && !/\.sc-grid \{[^}]*dasharray/.test(css));
ok('the opponent line is dashed, so identity is not colour alone',
  /line\.sc-opp, path\.sc-opp \{[^}]*stroke-dasharray/.test(css));
ok('a legend is always present — two series', (src.match(/class="sc-key"/g) || []).length === 2);
ok('the legend names the team rather than saying "yours"',
  /\$\{tournamentFocusTeamNumber \|\| 'Their score'\}/.test(src));
ok('marks are thin', /\.sc-line \{[^}]*stroke-width: 2;/.test(css));
ok('overlapping dots get a surface ring, not a border',
  /\.sc-dot \{ stroke: var\(--card\); stroke-width: 2; \}/.test(css));
ok('there is no number printed on every point', !/sc-dotlabel|sc-value/.test(src));
ok('it carries a text alternative', /aria-label="Score by match/.test(src));
ok('the alternative lists the actual scores',
  /\$\{m\.name\} \$\{m\.myScore\} to \$\{m\.oppScore\}/.test(src));

// Hover, per the interaction rule: a line chart ships a crosshair and tooltip.
ok('there is a hit area per match, not per pixel', /class="sc-hit"/.test(src));
ok('the hit area is full height, so it is easy to reach',
  /y="\$\{T\}" width="\$\{w\.toFixed\(1\)\}" height="\$\{ih\}"/.test(src));
ok('a crosshair follows it', /class="sc-cross"/.test(src));
ok('the tooltip says which match and both scores',
  /\$\{m\.name\} · \$\{res\} \$\{m\.myScore\}–\$\{m\.oppScore\}/.test(src));
ok('the handler is delegated, so it survives every re-render',
  /document\.addEventListener\('mousemove', md_chartHover\)/.test(src),
  'including the 30-second live refresh');
ok('the tooltip is clamped inside the plot',
  /Math\.max\(half \+ 2, Math\.min\(box\.width - half - 2, px\)\)/.test(src));

// Label collision — the one thing only rendering catches.
ok('x labels are thinned to at most six', /Math\.ceil\(pts\.length \/ 6\)/.test(src));
ok('the final label never lands on top of the one before it',
  /if \(x\(i\) - lastLabelX < 74\)/.test(src));
ok('long match names are shortened for the axis', /function md_shortMatch\(name\)/.test(src));

// Phone legibility.
const phone = css.slice(css.indexOf('.sc-legend { margin-left: 0; }') - 120,
                        css.indexOf('.sc-tip { font-size: 12px; }') + 40);
ok('labels grow under 560px', /\.sc-ytick, \.sc-xtick \{ font-size: 21px; \}/.test(phone),
  'the viewBox scales, so 11 units becomes about 5px in a phone column');
ok('so do the lines and dots',
  /\.sc-line \{ stroke-width: 4; \}/.test(phone) && /\.sc-dot \{ r: 7;/.test(phone));

// ── 3. The headline strip ──
ok('rank, record and best result sit together at the top',
  /<div class="md-headline">\$\{rankCard\}\$\{recordCard\}\$\{bestCard\}<\/div>/.test(src));
ok('the old rank badge at the bottom is gone',
  !/tournament-rank-badge/.test(src), 'it stated the same number twice');
ok('champion is marked out', /md-stat\$\{bestRes\.champion \? ' is-champion' : ''\}/.test(src));
ok('the projection block only shows while matches remain',
  /if \(quals\.length && remaining\.length\) \{/.test(src),
  'once final it restated the headline number in 28px type underneath it');
ok('favourability survives on its own when the event is over',
  /\} else if \(favorTag\) \{/.test(src));

// ── 4. Driven ──
{
  const { win, errors, stop } = await boot();
  win.switchTab('tournament');
  await win.loadTournamentTeams(55001, 'Maker Faire OC - MS/HS - Day 1', 9001, '66449A', 'RE-V5RC-25-0191');
  await settle(win, 400);
  const h = html(win, 'tournamentResults');

  ok('the headline strip renders', /md-headline/.test(h));
  ok('...with the rank', /Rank<\/div>\s*<div class="md-stat-value">#1/.test(h), h.slice(h.indexOf('md-headline'), h.indexOf('md-headline') + 200));
  ok('...the qualification record', /Qualification record<\/div>\s*<div class="md-stat-value">6–0/.test(h));
  ok('...and how far they got', /Best result<\/div>\s*<div class="md-stat-value">Semifinals/.test(h));
  ok('the run is named', /SF #2-1 · lost/.test(h));

  ok('the chart renders', /class="sc-wrap"/.test(h));
  ok('one dot per played match, per series',
    (h.match(/class="sc-dot sc-myScore"/g) || []).length === 9 &&
    (h.match(/class="sc-dot sc-oppScore"/g) || []).length === 9,
    (h.match(/class="sc-dot sc-myScore"/g) || []).length + ' mine');
  ok('one hit area per match', (h.match(/class="sc-hit"/g) || []).length === 9);
  ok('the axis is labelled without crowding',
    (h.match(/class="sc-xtick"/g) || []).length <= 6 &&
    (h.match(/class="sc-xtick"/g) || []).length >= 4,
    (h.match(/class="sc-xtick"/g) || []).length + ' x labels');
  ok('five gridlines', (h.match(/class="sc-grid"/g) || []).length === 5);
  ok('the record is stated once, not twice',
    (h.match(/6–0/g) || []).length === 1, (h.match(/6–0/g) || []).length + ' times');
  ok('every match still carries its W/L', (h.match(/match-outcome win/g) || []).length === 8);
  ok('and the loss is marked', /match-outcome loss/.test(h));
  ok('nothing threw', errors.length === 0, errors.join('\n'));
  stop();
}

// An event still in progress: no best result yet, and the projection stays.
{
  const keep = FIXTURES.event.start, keepE = FIXTURES.event.end;
  FIXTURES.event.start = new Date(Date.now() + 40 * 86400e3).toISOString();
  FIXTURES.event.end = new Date(Date.now() + 41 * 86400e3).toISOString();
  FIXTURES.unplayed = true;   // a schedule, no scores
  const { win, stop } = await boot();
  win.switchTab('tournament');
  await win.loadTournamentTeams(55001, 'Future Event', 9001, '66449A', 'RE-V5RC-25-0191');
  await settle(win, 400);
  const h = html(win, 'tournamentResults');
  ok('an event with no played matches draws no chart', !/class="sc-wrap"/.test(h));
  ok('...and claims no best result', !/Best result/.test(h));
  stop();
  FIXTURES.event.start = keep; FIXTURES.event.end = keepE; delete FIXTURES.unplayed;
}

console.log(`\nt87: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
