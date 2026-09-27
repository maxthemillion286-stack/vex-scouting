// t98 — the Event Scout's region scope, and being able to see why.
//
// Reported: "for the optimal event it does not look for events strictly in my
// region even though i set it to my region."
//
// The region is an INVISIBLE INPUT. It is derived from the team number's
// RobotEvents registration, it is never shown, and every event that reaches
// the rendered list has already passed the filter — so from the list alone
// there is no way to tell whether the filter ran, what it filtered to, or what
// it threw away. That is the actual defect this file guards against, whatever
// the underlying cause turns out to be:
//
//   · the heading says which region it searched
//   · a note says where that region came from, and what RobotEvents means by
//     the word (a whole state or province, not a VEX competition region)
//   · vsDebug.escout counts the funnel: what came back, what was dropped and
//     why, and which regions the API actually sent
//   · vsDebug.truncated records any query answered in part, which is how you
//     tell a filter the API honoured from one it ignored
//
// The fixture deliberately IGNORES the region parameter and answers a
// season-wide query with a spread of regions. That is the case worth pinning:
// if RobotEvents ever stops honouring `region`, the client-side filter is the
// only thing keeping another state's events off the list.
import fs from 'fs';
import { boot, settle, FIXTURES } from './harness.mjs';
let pass = 0, fail = 0;
const ok = (n, c, e) => { c ? (pass++, console.log('  ok   ' + n)) : (fail++, console.log('  FAIL ' + n + (e ? '\n         ' + e : ''))); };

const idx = fs.readFileSync('../index.html', 'utf8');
const src = idx.match(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/)[1];

console.log('t98 — Event Scout: which region, and how to see it');

const SPREAD = [
  { name: 'Bristol Blitz',       region: 'Connecticut', city: 'Bristol' },
  { name: 'Hartford Havoc',      region: 'Connecticut', city: 'Hartford' },
  { name: 'New Haven Nationals', region: 'Connecticut', city: 'New Haven' },
  { name: 'Dallas Dustup',       region: 'Texas',       city: 'Dallas' },
  { name: 'Austin Assault',      region: 'Texas',       city: 'Austin' },
  { name: 'Fresno Fracas',       region: 'California',  city: 'Fresno' },
  { name: 'Last Year Leftover',  region: 'Connecticut', city: 'Danbury', inDays: -30 }
];

async function scout(scope, you = '66449A') {
  const { win, errors, stop } = await boot();
  win.switchTab('simulator');
  win.document.getElementById('simEscoutYou').value = you;
  win.document.getElementById('simEscoutScope').value = scope;
  await win.runEventScout();
  await settle(win, 1200);
  const doc = win.document;
  return {
    win, errors, stop,
    report: win.vsDebugReport ? win.vsDebugReport() : null,
    heading: (doc.querySelector('#escoutResults .sim-block-label') || {}).textContent || '',
    notes: [...doc.querySelectorAll('#escoutResults .sim-caveat')].map(e => e.textContent),
    names: [...doc.querySelectorAll('#escoutResults .pick-team')].map(e => e.textContent.trim()),
    locs: [...doc.querySelectorAll('#escoutResults .pick-name')].map(e => e.textContent.trim())
  };
}

// ══ 1. Scope "my region" keeps only that region ═════════════════════════════
console.log('\n· my region');
{
  const keepR = FIXTURES.teamRegion, keepS = FIXTURES.eventSpread;
  FIXTURES.teamRegion = 'Connecticut';
  FIXTURES.eventSpread = SPREAD;
  const r = await scout('region');

  ok('only the team\'s own region is listed',
    r.locs.length > 0 && r.locs.every(l => /Connecticut/.test(l)), r.locs.join(' | '));
  ok('the other states did not get through',
    !r.names.some(n => /Dallas|Austin|Fresno/.test(n)), r.names.join(', '));
  ok('and a finished event did not either',
    !r.names.some(n => /Leftover/.test(n)), r.names.join(', '));

  // The funnel is the point of the change: the list can only ever show what
  // survived, so the counts of what did not have to live somewhere.
  const f = r.report && r.report.escout;
  ok('the funnel is recorded', !!f);
  ok('it names the region it resolved, and where from',
    f && f.team.region === 'Connecticut' && f.team.number === '66449A',
    f && JSON.stringify(f.team));
  ok('it counts what the API returned', f && f.returned.region === SPREAD.length,
    f && JSON.stringify(f.returned));
  ok('it counts what was dropped for being elsewhere', f && f.dropped.otherRegion === 3,
    f && JSON.stringify(f.dropped));
  ok('and what was dropped for being over', f && f.dropped.past === 1,
    f && JSON.stringify(f.dropped));
  ok('it records which regions actually came back — the evidence that the API '
    + 'ignored the filter',
    f && f.regionsReturned.Texas === 2 && f.regionsReturned.California === 1,
    f && JSON.stringify(f.regionsReturned));
  ok('the kept count matches the rendered rows', f && f.kept === r.locs.length,
    f && `${f.kept} vs ${r.locs.length}`);

  // Visible, not just in the debug panel.
  ok('the heading says which region it searched', /Connecticut/.test(r.heading), r.heading);
  ok('the heading still says what it is sorting by', /easiest field first/.test(r.heading), r.heading);
  const note = r.notes.join(' ');
  ok('a note says where the region came from', /registered for 66449A/.test(note), note);
  ok('...and warns that RobotEvents means a whole state',
    /whole state or province/.test(note), note);
  ok('...and says how many were dropped', /3 of them outside Connecticut/.test(note), note);
  ok('nothing threw', r.errors.length === 0, r.errors.join('\n'));
  r.stop();
  FIXTURES.teamRegion = keepR; FIXTURES.eventSpread = keepS;
}

// ══ 2. Signature scope does not apply it ════════════════════════════════════
console.log('\n· the other two scopes');
{
  const keepR = FIXTURES.teamRegion, keepS = FIXTURES.eventSpread;
  FIXTURES.teamRegion = 'Connecticut';
  FIXTURES.eventSpread = SPREAD;
  const r = await scout('signature');
  const f = r.report && r.report.escout;
  ok('signature scope asks for no region events', f && f.returned.region === 0,
    f && JSON.stringify(f.returned));
  ok('so the heading does not claim a region', !/Connecticut/.test(r.heading), r.heading);
  ok('and the region note is not shown',
    !r.notes.some(n => /registered for/.test(n)), r.notes.join(' | '));
  r.stop();

  const b = await scout('both');
  const fb = b.report && b.report.escout;
  ok('both scopes fetch both lists', fb && fb.returned.region === SPREAD.length,
    fb && JSON.stringify(fb.returned));
  ok('and the heading says so', /Connecticut \+ signature/.test(b.heading), b.heading);
  // Same event from both queries must not appear twice.
  ok('nothing is listed twice', new Set(b.names).size === b.names.length, b.names.join(', '));
  b.stop();
  FIXTURES.teamRegion = keepR; FIXTURES.eventSpread = keepS;
}

// ══ 3. A query answered in part says so ═════════════════════════════════════
// apiGet stops at ten pages. Past that, rows are dropped in silence — and on
// /events that silence is the difference between "my region has 12 events" and
// "the API ignored the filter and we saw 4% of the season".
console.log('\n· partial answers');
ok('apiGet still caps its page fetch', /const last = Math\.min\(data\.meta\.last_page, 10\);/.test(src));
ok('and now records when the cap bites',
  /if \(data\.meta\.last_page > last\) \{/.test(src) && /vsDebug\.truncated\.push\(/.test(src));
ok('with the query that was cut short', /path: endpoint \+ '\?' \+ qs\.toString\(\)/.test(src));
ok('the list is bounded', /if \(vsDebug\.truncated\.length > 8\) vsDebug\.truncated\.shift\(\);/.test(src));
// The report whitelists its keys, so a block that is not named there is
// invisible — which is exactly how a previous diagnostic went missing.
ok('the debug report names the funnel', /escout: vsDebug\.escout,/.test(src));
ok('the debug report names the truncations', /truncated: vsDebug\.truncated,/.test(src));

// ══ 4. The typed team number is escaped ═════════════════════════════════════
// It is self-inflicted rather than stored, but it is still user input going
// into innerHTML, and the sweep in t91 should have caught it.
console.log('\n· the typed number');
ok('the heading escapes it', /Optimal events for \$\{esc\(you\)\}/.test(src));
ok('the region note escapes it', /registered for \$\{esc\(you\)\}/.test(src));
ok('the no-data caveat escapes it', /No season data found for \$\{esc\(you\)\} yet/.test(src));
{
  const keepR = FIXTURES.teamRegion, keepS = FIXTURES.eventSpread, keepT = FIXTURES.teams;
  FIXTURES.teamRegion = 'Connecticut';
  FIXTURES.eventSpread = SPREAD;
  FIXTURES.teams = [...FIXTURES.teams,
    { id: 9099, number: '<IMG SRC=X ONERROR=ALERT(1)>', team_name: 'Poison', grade: 'High School' }];
  const r = await scout('region', '<img src=x onerror=alert(1)>');
  const h = r.win.document.getElementById('escoutResults').innerHTML;
  ok('a payload in the box does not become a tag', !/<img/i.test(h),
    h.slice(0, 200));
  ok('it comes back as text', /&lt;img/i.test(h) || !/alert\(1\)/.test(h));
  r.stop();
  FIXTURES.teamRegion = keepR; FIXTURES.eventSpread = keepS; FIXTURES.teams = keepT;
}

console.log(`\nt98: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
