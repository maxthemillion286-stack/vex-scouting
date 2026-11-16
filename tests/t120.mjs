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
  ok('the numbers carry their units', /24 s/.test(rows[0].cells[2].textContent) && /8%/.test(rows[0].cells[3].textContent) && /32%/.test(rows[0].cells[4].textContent) && /3\.6%/.test(rows[0].cells[5].textContent), [...rows[0].cells].map(c => c.textContent).join(' | '));
  ok('a row that is the alliance says so in words, not an asterisk', /alliance/.test(rows[0].cells[1].textContent) && !/\*/.test(host.querySelector('.vt-coach-table').textContent));
  ok('the introduction is one short line', host.querySelector('.rw-hint').textContent.length < 80);
  const why = host.querySelector('details.vs-why');
  ok('what the columns mean is behind an arrow, in plain words', why && !why.open && /What these mean/.test(why.querySelector('summary').textContent) && why.querySelectorAll('p').length === 5);
  ok('the columns have room', /\.vt-coach-table th, \.vt-coach-table td \{ padding: 8px 14px 8px 0;/.test(idx));
  // An event that cannot be looked up still shows.
  win.eval(`vsEventRecord = async () => { throw new Error('offline'); };`);
  await f('vtCoachFill')('66449A');
  ok('an event that cannot be looked up falls back to its number', /Event 65240/.test(doc.getElementById('vtCoach').textContent));
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
