// t98 — the Event Scout's region scope, and being able to see why.
//
// v78: "my region" now means the VEX COMPETITION region — California - Region 4
// — not the state. RobotEvents records a sub-region on a TEAM (eventRegion, on
// the legacy skills endpoint) and on no event at all, so each in-state event is
// placed by the sub-region most of its registered teams belong to.
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
  // Retargeted in v78: `region` split into the STATE the API can filter on and
  // the VEX sub-region it cannot. Same concerns, renamed fields.
  ok('it names the state it resolved, and where from',
    f && f.team.state === 'Connecticut' && f.team.number === '66449A',
    f && JSON.stringify(f.team));
  ok('it counts what the API returned', f && f.returned.state === SPREAD.length,
    f && JSON.stringify(f.returned));
  ok('it counts what was dropped for being in another state',
    f && f.dropped.otherState === 3, f && JSON.stringify(f.dropped));
  ok('and what was dropped for being over', f && f.dropped.past === 1,
    f && JSON.stringify(f.dropped));
  ok('it records which states actually came back — the evidence that the API '
    + 'ignored the filter',
    f && f.statesReturned.Texas === 2 && f.statesReturned.California === 1,
    f && JSON.stringify(f.statesReturned));
  ok('the kept count matches the rendered rows', f && f.kept === r.locs.length,
    f && `${f.kept} vs ${r.locs.length}`);

  // Visible, not just in the debug panel.
  ok('the heading says which region it searched', /Connecticut/.test(r.heading), r.heading);
  ok('the heading still says what it is sorting by', /easiest field first/.test(r.heading), r.heading);
  const note = r.notes.join(' ');
  // This fixture records every team's eventRegion as the STATE, which is one of
  // the shapes RobotEvents really uses — so this run exercises the fallback,
  // and §1b below exercises a real sub-region.
  // `notes` is textContent, so the <strong> around the name is already gone.
  ok('a note says the whole state was searched',
    /Searching Connecticut, the whole state/.test(note), note.slice(0, 200));
  ok('...and names the reason it could not narrow',
    /with no region number, so there is no sub-region to narrow to/.test(note), note);
  ok('nothing threw', r.errors.length === 0, r.errors.join('\n'));
  r.stop();
  FIXTURES.teamRegion = keepR; FIXTURES.eventSpread = keepS;
}

// ══ 1b. The whole point: Region 4, not California ═══════════════════════════
//
// Reported: "the 'my region' option should only include events in MY region,
// for example if i was from california region 4 i would only get results for
// california region 4."
//
// RobotEvents records a VEX sub-region on a TEAM (eventRegion, legacy skills)
// and on NO event. So an event is placed by the sub-region most of its
// registered teams belong to — the rosters are fetched for the strength model
// anyway, so placing the events we were going to analyse costs nothing extra.
console.log('\n· the VEX competition region, not the state');
{
  const keep = { t: FIXTURES.teams, r: FIXTURES.teamRegion, s: FIXTURES.eventSpread,
                 v: FIXTURES.vexRegionOf, ro: FIXTURES.rosterOf };
  const R4 = [{ id: 7001, number: '3050W' }, { id: 7002, number: '1658S' }, { id: 7003, number: '2496W' }];
  const R2 = [{ id: 7101, number: '90696C' }, { id: 7102, number: '95071V' }, { id: 7103, number: '4253B' }];
  const R1 = [{ id: 7201, number: '315P' }, { id: 7202, number: '1138X' }];
  const REGION = {};
  for (const t of R4) REGION[t.id] = 'California - Region 4';
  for (const t of R2) REGION[t.id] = 'California - Region 2';
  for (const t of R1) REGION[t.id] = 'California - Region 1';
  FIXTURES.teams = [...R4, ...R2, ...R1].map(t => ({ ...t, team_name: 'T' + t.id, grade: 'High School' }));
  FIXTURES.teamRegion = 'California';
  FIXTURES.vexRegionOf = t => REGION[t.id] || 'California - Region 4';
  FIXTURES.eventSpread = [
    { name: 'Fresno Fracas',       region: 'California', city: 'Fresno' },
    { name: 'Clovis Clash',        region: 'California', city: 'Clovis' },
    { name: 'San Diego Showdown',  region: 'California', city: 'San Diego' },
    { name: 'Irvine Invitational', region: 'California', city: 'Irvine' },
    { name: 'Sacramento Scrap',    region: 'California', city: 'Sacramento' },
    { name: 'Dallas Dustup',       region: 'Texas',      city: 'Dallas' }
  ];
  FIXTURES.rosterOf = { 57000: R4, 57001: R4, 57002: R2, 57003: R2, 57004: R1, 57005: R2 };

  const r = await scout('region', '3050W');
  const f = r.report && r.report.escout;

  ok('my VEX region is read from the skills standings, not the address',
    f && f.team.vexRegion === 'California - Region 4', f && JSON.stringify(f.team));
  ok('only Region 4 events are listed',
    r.names.length === 2 && r.names.every(n => /Fresno|Clovis/.test(n)), r.names.join(', '));
  ok('the other California sub-regions are gone',
    !r.names.some(n => /San Diego|Irvine|Sacramento/.test(n)), r.names.join(', '));
  ok('and the out-of-state one never got near the placing step',
    f && f.dropped.otherState === 1, f && JSON.stringify(f.dropped));
  ok('three in-state events were dropped as another sub-region',
    f && f.dropped.otherVexRegion === 3, f && JSON.stringify(f.dropped));

  // The placement tally is the evidence. Without it, "why is that event gone"
  // is unanswerable — the same reason the funnel exists at all.
  ok('each in-state event is recorded against the sub-region it was placed in',
    f && f.placed['California - Region 4'] === 2
      && f.placed['California - Region 2'] === 2
      && f.placed['California - Region 1'] === 1,
    f && JSON.stringify(f.placed));
  ok('every in-state event was scanned, not just the analysed ones',
    f && f.scanned === 5, f && String(f.scanned));

  ok('the heading names the sub-region, not the state',
    /California - Region 4/.test(r.heading) && !/· California ·/.test(r.heading), r.heading);
  const note = r.notes.join(' ');
  ok('the note says it is the competition region, not the state',
    /the VEX competition region 3050W competes in, not just the state/.test(note), note);
  ok('...and shows the split it found',
    /2 in California - Region 4/.test(note) && /3 elsewhere in California/.test(note), note);
  ok('nothing threw', r.errors.length === 0, r.errors.join('\n'));
  r.stop();

  // ── Two ways to have no sub-region, both ending at the state ──
  // Falling back is right; doing it silently is not.
  //
  // (a) no skills run yet, so nothing recorded at all.
  FIXTURES.vexRegionOf = () => '';
  const b = await scout('region', '3050W');
  const bf = b.report && b.report.escout;
  ok('with no sub-region on record it falls back to the state',
    bf && bf.team.vexRegion === null && b.names.length === 5, b.names.join(', '));
  ok('...and says so rather than pretending it narrowed',
    /is not on this season's skills board yet/.test(b.notes.join(' ')), b.notes.join(' ').slice(0, 200));
  ok('nothing threw on the fallback', b.errors.length === 0, b.errors.join('\n'));
  b.stop();

  // (b) RobotEvents records the eventRegion as just the STATE, with no number.
  // That is not a sub-region, and saying it narrowed to one would be a lie.
  FIXTURES.vexRegionOf = () => 'California';
  const c = await scout('region', '3050W');
  const cf = c.report && c.report.escout;
  ok('a state-shaped eventRegion is not treated as a sub-region',
    cf && cf.team.vexRegion === null, cf && JSON.stringify(cf.team));
  ok('...but what was on record is still reported',
    cf && cf.team.eventRegionRaw === 'California', cf && JSON.stringify(cf.team));
  ok('...and the note does not claim to have searched one',
    !/the VEX competition region 3050W competes in/.test(c.notes.join(' '))
    && /no region number/.test(c.notes.join(' ')), c.notes.join(' ').slice(0, 200));
  ok('...and every in-state event is still offered', c.names.length === 5, c.names.join(', '));
  c.stop();

  FIXTURES.teams = keep.t; FIXTURES.teamRegion = keep.r; FIXTURES.eventSpread = keep.s;
  FIXTURES.vexRegionOf = keep.v; FIXTURES.rosterOf = keep.ro;
}

// ══ 2. Signature scope does not apply it ════════════════════════════════════
console.log('\n· the other two scopes');
{
  const keepR = FIXTURES.teamRegion, keepS = FIXTURES.eventSpread;
  FIXTURES.teamRegion = 'Connecticut';
  FIXTURES.eventSpread = SPREAD;
  const r = await scout('signature');
  const f = r.report && r.report.escout;
  ok('signature scope asks for no in-state events', f && f.returned.state === 0,
    f && JSON.stringify(f.returned));
  ok('so the heading does not claim a region', !/Connecticut/.test(r.heading), r.heading);
  ok('and the region note is not shown',
    !r.notes.some(n => /registered for/.test(n)), r.notes.join(' | '));
  r.stop();

  const b = await scout('both');
  const fb = b.report && b.report.escout;
  ok('both scopes fetch both lists', fb && fb.returned.state === SPREAD.length,
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
// Retargeted in v78 with the note's wording. The concern is unchanged: the
// typed number reaches innerHTML in BOTH branches of the note, so both must
// escape it — the one that names a sub-region, and the fallback that does not.
ok('the region note escapes it, in both branches',
  /\$\{esc\(you\)\} competes in/.test(src)
  && /\$\{esc\(you\)\} is not on this season's skills board/.test(src));
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
