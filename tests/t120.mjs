// t120 — v120: short first, more on request; the My team table by name.
//
// Reported with a screenshot of the My team table ("Event 65240", columns run
// together) and: "most descriptions on the website … are wayy too long, they
// should be simple and get the point across although if you click an
// expanding arrow it can explain furthermore".
import fs from 'fs';
import { boot, settle } from './harness.mjs';
let pass = 0, fail = 0;
const ok = (name, cond, detail) => { if (cond) { pass++; console.log('  ok   ' + name); } else { fail++; console.log('  FAIL ' + name + (detail ? '\n         ' + detail : '')); } };
const idx = fs.readFileSync('../index.html', 'utf8'), app = fs.readFileSync('../desktop/vex_trainer.py', 'utf8');
console.log('t120 — v120');
const { win } = await boot();
await settle(win);
const doc = win.document, f = n => win.eval(n);
const long = 'This sentence is the point. ' + 'And this is the further explanation that goes on for a good while. '.repeat(4);

// ── long text folds ──
{
  doc.body.insertAdjacentHTML('beforeend', `<div id="t120">
    <div class="rw-hint a">${long}</div>
    <div class="rw-hint b">Short and fine.</div>
    <div class="sim-caveat c">${long}<button>Do it</button></div>
    <div class="vt-note d" id="liveStatus">${long}</div>
    <div class="set-p e">${long}<a href="#x">a link</a></div>
    <p class="plain f">${long}</p>
    <div class="sim-caveat g"><strong>Bold start.</strong> ${long}</div></div>`);
  const S = f('vsShorten'), host = doc.getElementById('t120');
  S(host);
  const a = host.querySelector('.a'), more = a.nextElementSibling;
  ok('a long explanation is folded to its start', a.classList.contains('vs-short') && !a.classList.contains('vs-open'));
  ok('with an arrow under it', more && more.classList.contains('vs-more') && /▸ more/.test(more.textContent) && more.getAttribute('aria-expanded') === 'false');
  ok('none of its words are removed', a.textContent === long);
  more.click();
  ok('the arrow shows the rest', a.classList.contains('vs-open') && /▾ less/.test(more.textContent) && more.getAttribute('aria-expanded') === 'true');
  more.click();
  ok('and folds it again', !a.classList.contains('vs-open') && /▸ more/.test(more.textContent));
  ok('a short line is left alone', !host.querySelector('.b').classList.contains('vs-short'));
  ok('text with a button in it is never folded', !host.querySelector('.c').classList.contains('vs-short'));
  ok('nor text with a link', !host.querySelector('.e').classList.contains('vs-short'));
  ok('nor a status line that updates (it has an id)', !host.querySelector('.d').classList.contains('vs-short'));
  ok('ordinary paragraphs are not touched', !host.querySelector('.f').classList.contains('vs-short'));
  ok('formatting inside a folded text survives', host.querySelector('.g').classList.contains('vs-short') && !!host.querySelector('.g strong'));
  const before = host.querySelectorAll('.vs-more').length;
  S(host); S(host);
  ok('doing it again adds no second arrow', host.querySelectorAll('.vs-more').length === before && before === 2);
  // Re-rendered text gets its own arrow, and an orphaned one is not doubled.
  a.outerHTML = `<div class="rw-hint a2">${long}</div>`;
  S(host);
  ok('text drawn again is folded again, with one arrow', host.querySelector('.a2').classList.contains('vs-short') && host.querySelectorAll('.vs-more').length === 2);
  ok('new text is folded by itself as the page draws it', /new MutationObserver\(ask\)\.observe\(document\.body, \{ childList: true, subtree: true \}\)/.test(idx));
  ok('folding is two lines, in CSS, so it suits any width', /\.vs-short:not\(\.vs-open\) \{ display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2;/.test(idx));
  host.remove();
}
// ── the My team table ──
{
  const robot = (o = {}) => ({ sec: 100, am: 1, ap: 0.32, ar: 0.6, act: 0.036, opp: 0.3, prs: 0.05, prd: 0.08, stp: 24, es: 0.2, ea: 0.3, apt: 0.3, vis: 0.9, wa: 0, wb: 0, ...o });
  const sums = new Map();
  for (const [ev, n] of [['65240', 4], ['64982', 3]]) for (let i = 0; i < n; i++) sums.set(ev + ':' + (i + 1), { sv: f('VT_SUM_V'), ok: 1, name: 'Qualification ' + (i + 1), red: ['66449A', '1A'], blue: ['2B', '3C'], rs: 40, bs: 30, vid: 'abcdefghijk', of: 100, st: 5, dr: 20,
    R: { ...robot(), sw: 0, wk: 0 }, B: { ...robot(), sw: 0, wk: 0 }, Ra: robot(), Rb: robot(), Ba: robot(), Bb: robot() });
  win.__sums120 = sums;
  doc.body.insertAdjacentHTML('beforeend', '<div id="vtCoach"></div>');
  win.eval(`vtTeamSums = async () => __sums120; vsMyTeam = () => '66449A';
    vsEventRecord = async id => String(id) === '65240' ? [{ id: 65240, name: 'Cypress <b>Showdown</b>', start: '2026-11-07T08:00:00-06:00' }] : [{ id: 64982, name: 'Bay Area Fall Classic', start: '2026-10-10T08:00:00-07:00' }];`);
  await f('vtCoachFill')('66449A');
  const host = doc.getElementById('vtCoach'), rows = [...host.querySelectorAll('.vt-coach-table tbody tr')];
  ok('each event is a row', rows.length === 2);
  ok('named, not numbered', /Cypress/.test(rows[0].cells[0].textContent) && /Bay Area Fall Classic/.test(rows[1].cells[0].textContent) && !/Event 6/.test(host.textContent), rows.map(r => r.cells[0].textContent).join(' | '));
  ok('newest first, with its date', /Nov/.test(rows[0].cells[0].textContent) && /Oct/.test(rows[1].cells[0].textContent));
  ok('an event name cannot inject markup', !host.querySelector('.vt-coach-table b'));
  ok('the columns are the ones asked for', [...host.querySelectorAll('.vt-coach-table th')].map(h => h.textContent).join('|') === 'Event|Matches|Autonomous|Goes for|Pins a match|Points from pins|5 pins stacked in');
  ok('autonomous is said in words', /moved in \d of \d/.test(rows[0].cells[2].textContent), rows[0].cells[2].textContent);
  ok('with no pins counted, it says so rather than showing a zero', /not counted yet/.test(rows[0].cells[4].textContent) && /not counted yet/.test(rows[0].cells[6].textContent));
  ok('and says what is needed for them', /Mark the field/.test(host.querySelector('#vtCoachWhy').textContent));
  ok('a row that is the alliance says so in words, not an asterisk', /alliance/.test(rows[0].cells[1].textContent) && !/\*/.test(host.querySelector('.vt-coach-table').textContent));
  ok('the introduction is one short line', host.querySelector('.rw-hint').textContent.length < 80);
  const why = host.querySelector('details.vs-why');
  ok('what the columns mean is behind an arrow, in plain words', why && !why.open && /What these mean/.test(why.querySelector('summary').textContent) && why.querySelectorAll('p').length === 7 && /10 for each yellow half and 5 for each half of your own colour/.test(why.textContent));
  ok('on a phone each event is a card, so nothing scrolls sideways', /@media \(max-width: 600px\) \{\s+\.vt-coach-table, \.vt-coach-table tbody, \.vt-coach-table tr \{ display: block; width: 100%; \}/.test(idx) && /\.vt-coach-table thead \{ display: none; \}/.test(idx));
  ok('and every number carries its own label there', [...rows[0].cells].slice(1).map(c => c.getAttribute('data-label')).join('|') === 'Matches|Autonomous|Goes for|Pins a match|Points from pins|5 pins stacked in' && /td\[data-label\]::before \{ content: attr\(data-label\);/.test(idx));
  ok('the columns have room', /\.vt-coach-table th, \.vt-coach-table td \{ padding: 8px 14px 8px 0;/.test(idx));
  // An event that cannot be looked up still shows.
  win.eval(`vsEventRecord = async () => { throw new Error('offline'); };`);
  await f('vtCoachFill')('66449A');
  ok('an event that cannot be looked up falls back to its number', /Event 65240/.test(doc.getElementById('vtCoach').textContent));
}
// ── the table with pins counted ──
{
  const C = f('vtCoachPins');
  const own = [{ ys: 12, as: 2, ya: 2, t5: 50 }, { ys: 8, as: 0, ya: 0 }, { ys: 10, as: 4, ya: 4, t5: 70 }];
  const P = C(own, 1);
  ok('pins a match: halves over two, averaged', Math.abs(P.pins - (12 + 2 + 8 + 10 + 4) / 2 / 3) < 1e-9, String(P.pins));
  ok('points: 10 a yellow half, 5 an alliance half', Math.abs(P.points - ((30 * 10 + 6 * 5) / 3)) < 1e-9, String(P.points));
  ok('pins set down in autonomous', Math.abs(P.auto - 1) < 1e-9);
  ok('time to five pins is averaged over the matches that got there', P.t5 === 60);
  ok('and a general pace comes with it', Math.round(P.perPin) === Math.round(105 / P.pins));
  const pair = C([{ ys: 6, as: 0, ya: 0 }, { ys: 4, as: 2, ya: 2 }, { ys: 2, as: 0, ya: 0 }, { ys: 0, as: 0, ya: 0 }], 2);
  ok('when the row is the alliance, both robots make one match', pair.pins === 3.5, String(pair.pins));
  ok('no pins counted: nothing claimed', C([{ act: 1 }, { act: 2 }], 1) === null);
  // From the app's recording: when, not only how many.
  const fx = JSON.parse(fs.readFileSync('./fixtures/pins_rec.json', 'utf8'));
  win.__rec120 = fx.rec; win.__quad120 = { q: fx.quad, by: 'click' };
  const sum = win.eval('vtSummarise(__rec120, __quad120, null)');
  const top = [sum.Ra, sum.Rb].sort((a, b) => b.ys - a.ys)[0], low = [sum.Ra, sum.Rb].sort((a, b) => b.ys - a.ys)[1];
  ok('the robot that stacked six pins has a time to its fifth', top.t5 >= 30 && top.t5 <= 80, String(top.t5));
  ok('the one that stacked two never reached five', low.t5 === undefined);
  ok('nothing was set down in autonomous in that match', top.ya === 0 && low.ya === 0, JSON.stringify([top.ya, low.ya]));
  const mod = await import('../api/tracker.js');
  ok('the server accepts the timed summary', mod.validSum(JSON.parse(JSON.stringify(sum))) === null);
  ok('summaries with pins counted but not timed are made again', /!\(have\.pk && have\.Ra && have\.Ra\.ya === undefined\)/.test(idx));
  // The table, with pins.
  const robot = (o = {}) => ({ sec: 100, am: 1, ap: 0.32, ar: 0.6, act: 0.036, opp: 0.3, prs: 0.05, prd: 0.08, stp: 24, es: 0.2, ea: 0.3, apt: 0.3, vis: 0.9, wa: 3, wb: 0, ...o });
  const sums = new Map();
  for (let i = 0; i < 4; i++) sums.set('65240:' + (i + 1), { sv: f('VT_SUM_V'), ok: 1, name: 'Q' + i, red: ['66449A', '1A'], blue: ['2B', '3C'], rs: 40, bs: 30, vid: 'abcdefghijk', of: 100, st: 5, dr: 20, pk: 70,
    R: { ...robot(), sw: 0, wk: 0 }, B: { ...robot(), sw: 0, wk: 0 }, Ra: robot({ ys: 12, as: 2, ya: 2, t5: 48 }), Rb: robot({ wa: 0, wb: 3, ys: 2, as: 0, ya: 0 }), Ba: robot({ ys: 0, as: 0, ya: 0 }), Bb: robot({ wa: 0, wb: 3, ys: 0, as: 0, ya: 0 }) });
  win.__sums120b = sums;
  win.eval(`vtTeamSums = async () => __sums120b; vsEventRecord = async () => [{ name: 'Cypress Showdown', start: '2026-11-07T08:00:00-06:00' }];`);
  await f('vtCoachFill')('66449A');
  const cells = [...doc.querySelectorAll('#vtCoach .vt-coach-table tbody tr')][0].cells;
  ok('pins a match are shown', cells[4].textContent === '7.0', cells[4].textContent);
  ok('points from pins are shown', cells[5].textContent === '130', cells[5].textContent);
  ok('time to five pins is shown', cells[6].textContent === '48 s', cells[6].textContent);
  ok('which pins it goes for is shown', /^Mostly yellow pins \(86% of what it scores\)$/.test(cells[3].textContent), cells[3].textContent);
  const St = f('vtPinStyle');
  ok('mostly its own colour is said too', St(2, 10).kind === 'own' && /Mostly its own colour's pins \(83%/.test(St(2, 10).text));
  ok('an even split is called both', St(6, 5).kind === 'both' && /55% yellow, 45% its own colour/.test(St(6, 5).text));
  ok('a couple of pins is too few to call a habit', St(2, 1) === null && St(0, 0) === null);
  const Bf = f('vtBrief')('66449A', sums);
  ok('the briefing\'s strategy line leads with it', /^Mostly yellow pins/.test(Bf.strat) && Bf.style === 'yellow', Bf.strat);
  ok('autonomous says what it set down', /Sets down about 1\.0 pins in it/.test(cells[2].textContent), cells[2].textContent);
  ok('the note about missing pins is gone', !doc.getElementById('vtCoachWhy'));
}
// ── the app: a ceiling on download speed ──
{
  ok('downloads can be held to a speed', /max_mbps=0\):/.test(app) && /def pace\(nbytes\):/.test(app) && /opts\['ratelimit'\] = int\(limit \* 1e6\)/.test(app));
  ok('Settings offers it in plain words', /Gentle, fine for gaming \(15 MB\/s\)/.test(app) && /if body\.get\('speed'\) in \(0, 5, 15, 40\):/.test(app));
  ok('fewer connections are opened when it is held', /conns = max\(2, min\(conns, int\(max_mbps \/\/ 3\) or 2\)\)/.test(app));
}
ok('release is v120 or later', /const APP_BUILD = 'v1[2-9]\d'/.test(idx));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
