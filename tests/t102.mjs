// t102 — an event's dates are dates, not moments.
//
// Reported as "some of the dates on events are not perfectly accurate", and
// "some" was the whole clue. RobotEvents hands an event's start and end over
// as ISO 8601 carrying the VENUE's offset:
//
//     "2026-10-11T00:00:00-04:00"   →  the 11th of October, in New York
//
// The app passed that whole string to `new Date()` and formatted it with
// toLocaleDateString(), which re-projects the instant into the READER's
// timezone. Midnight on the 11th in New York is 9pm on the 10th in
// California, so an away event advertised the day before it ran — while every
// local event looked right, because for those the two zones agree.
//
// Measured in node before the fix, across five zones:
//
//   America/Los_Angeles   every midnight-start event east of the Rockies, and
//                         every event the API records in plain UTC, a day early
//   Pacific/Honolulu      the above, plus midnight-start CALIFORNIA events
//   Asia/Tokyo            every US event a day late
//   America/New_York      only the plain-UTC ones
//   Europe/London         none — which is why this was easy to miss
//
// This file runs in Pacific/Honolulu, ten hours west of the fixture's venue,
// so every assertion below would have failed before the fix. TZ is set before
// the harness is imported because jsdom takes the host process's zone.
process.env.TZ = 'Pacific/Honolulu';

import fs from 'fs';
const { boot, settle, FIXTURES } = await import('./harness.mjs');
let pass = 0, fail = 0;
const ok = (n, c, e) => { c ? (pass++, console.log('  ok   ' + n)) : (fail++, console.log('  FAIL ' + n + (e ? '\n         ' + e : ''))); };

const idx = fs.readFileSync('../index.html', 'utf8');
const src = idx.match(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/)[1];
const proxy = fs.readFileSync('../api/proxy.js', 'utf8');
// Whole-line comments removed, so the prose explaining the bug is not mistaken
// for the bug.
const code = src.replace(/^[ \t]*\/\/.*$/gm, '');

console.log('t102 — event dates, in the venue\'s calendar');

// ══ 1. The day a string names ══════════════════════════════════════════════
// The date component of an ISO 8601 string is already relative to the offset
// that follows it, so the first ten characters ARE the day — whatever the
// offset, and whether there is one at all.
console.log('\n· the day the string names');
{
  const { win, stop } = await boot();
  await settle(win, 300);
  const ev = (expr) => win.eval(expr);

  const table = [
    // iso                            day           reader sees today  why
    ['2026-10-11T00:00:00-04:00', '2026-10-11', '10/10/2026', 'New York, midnight'],
    ['2026-10-11T00:00:00-05:00', '2026-10-11', '10/10/2026', 'Texas, midnight'],
    ['2026-10-11T08:00:00-05:00', '2026-10-11', '10/11/2026', 'Texas, 8am'],
    ['2026-10-11T00:00:00-07:00', '2026-10-11', '10/10/2026', 'California, midnight'],
    ['2026-10-11T00:00:00Z',      '2026-10-11', '10/10/2026', 'recorded in UTC'],
    ['2026-10-11',                '2026-10-11', '10/10/2026', 'a bare date'],
    ['2026-02-28T09:00:00-05:00', '2026-02-28', '2/28/2026',  'the fixture\'s start'],
  ];
  for (const [iso, day, , why] of table) {
    ok(`${iso} is ${day} (${why})`,
      ev(`evDayKey(${JSON.stringify(iso)})`) === day,
      String(ev(`evDayKey(${JSON.stringify(iso)})`)));
    // And what gets rendered carries that day, not the reader's projection of
    // the instant. Compared on the day NUMBER so the assertion does not depend
    // on the host's locale.
    const shown = String(ev(`evDate(${JSON.stringify(iso)})`));
    ok(`...and renders with ${Number(day.slice(8))} in it`,
      new RegExp('\\b' + Number(day.slice(8)) + '\\b').test(shown), shown);
  }
  // Four of the seven rows above are rows this fix actually moved. If the old
  // and new renderings ever agree on all of them, the test has stopped testing.
  const moved = table.filter(([iso]) => {
    const t = Date.parse(iso);
    return !isNaN(t) && win.eval(`evDate(${JSON.stringify(iso)})`) !==
      new Date(t).toLocaleDateString();
  });
  ok('this zone still disagrees with the old rendering on several of them',
    moved.length >= 4, `${moved.length} of ${table.length}`);

  // Garbage in, nothing out — never "NaN" or "Invalid Date" on screen.
  for (const bad of [null, undefined, '', 'nope', 'soon', '20261011', {}, 0]) {
    const k = ev(`evDayKey(${JSON.stringify(bad === undefined ? null : bad)})`);
    ok(`evDayKey(${JSON.stringify(bad)}) is null`, k === null, String(k));
    const d = String(ev(`evDate(${JSON.stringify(bad === undefined ? null : bad)})`));
    ok(`evDate(${JSON.stringify(bad)}) is empty`, d === '', d);
  }

  // The venue's offset, which is what everything else keys off.
  for (const [iso, want] of [['2026-10-11T00:00:00-04:00', -240],
                             ['2026-10-11T09:00:00+09:30', 570],
                             ['2026-10-11T00:00:00Z', 0],
                             ['2026-10-11', null],
                             ['', null]]) {
    const got = ev(`evTzOffMin(${JSON.stringify(iso)})`);
    ok(`evTzOffMin(${JSON.stringify(iso)}) === ${want}`, got === want, String(got));
  }
  stop();
}

// ══ 2. How many days ═══════════════════════════════════════════════════════
// Counted as calendar days, both ends. Elapsed milliseconds cannot answer it,
// and the way it got this wrong cost YouTube quota: a single-day event read as
// two sent the Jumper looking for a Day 2 video that does not exist, and the
// proxy's targeted search is 100 units a go against 10,000 a day.
console.log('\n· how many days the event covers');
{
  const { win, stop } = await boot();
  await settle(win, 300);
  const cases = [
    ['2026-10-11T08:00:00-05:00', '2026-10-11T21:00:00-05:00', 1, '13 hours on ONE day — the case that read as 2'],
    ['2026-10-11T08:00:00-05:00', '2026-10-11T20:00:00-05:00', 1, 'exactly 12 hours, which rounded up'],
    ['2026-10-11T09:00:00-04:00', '2026-10-11T18:00:00-04:00', 1, 'an ordinary single day'],
    ['2026-02-28T09:00:00-05:00', '2026-03-01T18:00:00-05:00', 2, 'a weekend, across a month boundary'],
    ['2026-02-28T18:00:00-05:00', '2026-03-01T09:00:00-05:00', 2, 'a weekend, late then early'],
    ['2026-04-23T08:00:00-04:00', '2026-04-27T20:00:00-04:00', 5, 'Worlds'],
    ['2026-10-11T08:00:00-05:00', null, 1, 'no end recorded'],
    ['2026-10-11T08:00:00-05:00', '2026-10-09T08:00:00-05:00', 1, 'an end before the start'],
    [null, null, 1, 'nothing at all'],
  ];
  for (const [s, e, want, why] of cases) {
    const got = win.eval(`evDayCount(${JSON.stringify(s)}, ${JSON.stringify(e)})`);
    ok(`${want} day${want === 1 ? '' : 's'}: ${why}`, got === want, String(got));
  }

  // The proxy answers the same question for the same reason, in its own file.
  // Both must agree, or the client fetches a pool the proxy did not build.
  const pEvDayCount = new Function(
    (proxy.match(/function evDayKey\(iso\) \{[\s\S]*?\n\}/) || [''])[0] + '\n' +
    (proxy.match(/function evDayCount\(startISO, endISO\) \{[\s\S]*?\n\}/) || [''])[0] + '\n' +
    'return evDayCount;')();
  for (const [s, e, want, why] of cases) {
    ok(`the proxy also says ${want} for: ${why}`, pEvDayCount(s, e) === want, String(pEvDayCount(s, e)));
  }
  // Dividing an elapsed interval by a DAY is the bug. Dividing one by 1000 for
  // a duration in seconds is not, and an earlier draft of this flagged it.
  const byDay = /\(\s*Date\.parse\([^;]{0,120}?\)\s*-\s*Date\.parse\([^;]{0,120}?\)\s*\)\s*\/\s*864000?00?e?3?/;
  ok('the client no longer divides elapsed milliseconds to count days',
    !byDay.test(code), (code.match(byDay) || [''])[0]);
  ok('nor does the proxy', !byDay.test(proxy.replace(/^[ \t]*\/\/.*$/gm, '')),
    (proxy.match(byDay) || [''])[0]);
  stop();
}

// ══ 3. Nothing renders an event date through the instant any more ══════════
// The guard, not the individual fixes: every date formatter in the page has to
// live in one of four places. A new `new Date(ev.start).toLocaleDateString()`
// anywhere else is the bug coming back.
console.log('\n· no formatter left outside the four that are allowed');
{
  const ALLOWED = new Set([
    'evDate',        // the one event-date formatter
    'rwDayLabel',    // a YYYY-MM-DD day heading, already a calendar date
    'md_time',       // a MATCH's time, which really is a moment on your clock
    'vsDateReport'   // reproduces the old rendering on purpose, for the diagnostic
  ]);
  const fnAt = i => {
    const m = [...code.slice(0, i).matchAll(/^function (\w+)/gm)].pop();
    return m ? m[1] : '(top level)';
  };
  const holders = [...code.matchAll(/\.toLocaleDateString\(/g)].map(m => fnAt(m.index));
  const stray = holders.filter(h => !ALLOWED.has(h));
  ok('every .toLocaleDateString sits in an approved function', stray.length === 0,
    [...new Set(stray)].join(', '));
  ok('and all four are still there', [...ALLOWED].every(a => holders.includes(a)),
    holders.join(', '));

  // The six call sites that were wrong, named, so a revert is loud.
  ok('the Jumper\'s event list formats the day', /evDate\(e\.start\)/.test(code));
  ok('the Tournament event list formats the day',
    (code.match(/\$\{evDate\(ev\.start\)\}/g) || []).length === 2,
    (code.match(/\$\{evDate\(ev\.start\)\}/g) || []).length + ' of 2');
  ok('the saved-for-offline list formats the day',
    /\[ev\.sku \|\| '', evDate\(ev\.start\), ev\.location\?\.region \|\| ''\]/.test(code));
  ok('the Event Scout row formats the day',
    /start: evDate\(p\.ev\.start, \{ month: 'short', day: 'numeric' \}\)/.test(code));
  ok('the three local fmtDate shims are gone', !/const fmtDate = s =>/.test(code),
    'one helper does that job now');
}

// ══ 4. Driven: an away event, read from ten hours away ═════════════════════
// The proof. A midnight-start Connecticut event, rendered in Honolulu. Before
// the fix every one of these read 2/27.
console.log('\n· driven, from Pacific/Honolulu');
{
  const keepStart = FIXTURES.event.start, keepEnd = FIXTURES.event.end;
  FIXTURES.event.start = '2026-02-28T00:00:00-05:00';
  FIXTURES.event.end = '2026-03-01T00:00:00-05:00';
  // What the old code put on screen, computed rather than asserted, so this
  // says WHY the test has teeth rather than hard-coding a number.
  const wasShowing = new Date(Date.parse(FIXTURES.event.start)).toLocaleDateString();
  const dayNow = '28';
  ok('the reader\'s zone really does disagree with the venue\'s',
    /\b27\b/.test(wasShowing), wasShowing);

  const { win, errors, stop } = await boot();
  await settle(win, 400);
  const doc = win.document;

  // The Tournament tab's event list.
  win.switchTab('tournament');
  doc.getElementById('tournamentInput').value = '66449A';
  await win.findTournament();
  await settle(win, 1400);
  const tMeta = [...doc.querySelectorAll('#tab-tournament .tournament-meta')]
    .map(e => e.textContent).join(' | ');
  ok('the Tournament event list shows the venue\'s day', /\b2\/28\/2026\b/.test(tMeta), tMeta.slice(0, 200));
  ok('...and not the reader\'s projection of it', !/\b2\/27\/2026\b/.test(tMeta), tMeta.slice(0, 200));

  // The Scout tab's Events Attended list and its filter rows.
  win.switchTab('scout');
  doc.getElementById('detailTeamInput').value = '66449A';
  await win.runDetailedScout();
  await settle(win, 2000);
  const sMeta = [...doc.querySelectorAll('#tab-scout .ev-attend-meta, #tab-scout .ev-row-meta')]
    .map(e => e.textContent).join(' | ');
  ok('Events Attended shows the venue\'s day', /\b2\/28\/2026\b/.test(sMeta), sMeta.slice(0, 300));
  ok('...and not the reader\'s', !/\b2\/27\/2026\b/.test(sMeta), sMeta.slice(0, 300));

  // The diagnostic, which is the thing that makes the next date report
  // answerable from one capture instead of several rounds.
  const rep = win.vsDebugReport();
  ok('the debug report carries a dates section', !!rep.dates);
  ok('it names the reader\'s zone', rep.dates.readerZone === 'Pacific/Honolulu', String(rep.dates.readerZone));
  ok('it reports the reader\'s offset', rep.dates.readerOffsetMin === -600, String(rep.dates.readerOffsetMin));
  const row = (rep.dates.events || []).find(e => e.raw === FIXTURES.event.start);
  ok('it recorded the event, raw', !!row, JSON.stringify(rep.dates.events).slice(0, 300));
  if (row) {
    ok('with the day sliced out of the string', row.day === '2026-02-28', String(row.day));
    ok('with the venue\'s offset', row.venueOffsetMin === -300, String(row.venueOffsetMin));
    ok('with the day count', row.days === 2, String(row.days));
    ok('with what is on screen now', /\b28\b/.test(String(row.shows)), String(row.shows));
    ok('and with what used to be, so the two can be told apart',
      /\b27\b/.test(String(row.wasShowing)), String(row.wasShowing));
  }
  ok('nothing threw', errors.length === 0, errors.join('\n'));
  stop();
  FIXTURES.event.start = keepStart; FIXTURES.event.end = keepEnd;
  void dayNow;
}

// ══ 5. The Jumper's day keys are the venue's days ══════════════════════════
// rwDayKey reduces two different things to a calendar day — a match's
// scheduled time, which carries the venue's offset, and a broadcast's
// actualStartTime, which YouTube reports in UTC. Reducing both to the READER's
// day kept them agreeing with each other, so nothing looked wrong, but it
// disagreed with rwEventStartDay, which is sliced straight out of the API
// string and is therefore the venue's day. rwEventDayOrdinal compares those
// two, so a mismatch asks for the wrong "Day N" video — §3's worst outcome:
// every match time wrong with nothing on screen saying so.
console.log('\n· the Jumper buckets matches by the venue\'s day');
{
  const { win, stop } = await boot();
  await settle(win, 300);
  // 1am Sunday in Connecticut is 8pm Saturday in Honolulu.
  const t = Date.parse('2026-03-01T01:00:00-05:00');

  win.eval('rwEventTzOffMin = null');
  ok('with no event loaded it is the reader\'s day — exactly as before',
    win.eval(`rwDayKey(${t})`) === '2026-02-28', String(win.eval(`rwDayKey(${t})`)));

  win.eval('rwEventTzOffMin = -300');
  ok('with the event loaded it is the venue\'s day',
    win.eval(`rwDayKey(${t})`) === '2026-03-01', String(win.eval(`rwDayKey(${t})`)));
  ok('and a daytime match is unaffected either way',
    win.eval(`rwDayKey(${Date.parse('2026-02-28T11:00:00-05:00')})`) === '2026-02-28');

  ok('a timestamp that is not one says so', win.eval('rwDayKey(NaN)') === 'unknown');
  ok('and so does nothing at all', win.eval('rwDayKey(null)') === 'unknown');

  // The suffix that hands a day back to the proxy as the venue's day.
  win.eval('rwEventTzOffMin = null');
  ok('with no event the suffix is Z', win.eval('rwTzSuffix()') === 'Z');
  win.eval('rwEventTzOffMin = -300');
  ok('a western venue signs its offset', win.eval('rwTzSuffix()') === '-05:00', win.eval('rwTzSuffix()'));
  win.eval('rwEventTzOffMin = 570');
  ok('and so does a half-hour one', win.eval('rwTzSuffix()') === '+09:30', win.eval('rwTzSuffix()'));
  stop();
}
// The offset has to be known BEFORE the first day key is computed, or one
// event ends up holding both kinds of key — worse than the old behaviour,
// which was at least consistently one or the other.
console.log('\n· and it knows the offset before it needs it');
{
  const flow = code.slice(code.indexOf('const metaLoaded = rwRecordEventMeta(eventId);'));
  const awaited = flow.indexOf('await metaLoaded;');
  const firstKey = flow.indexOf('rwDayKey(');
  ok('the event record is awaited before the first rwDayKey call',
    awaited > -1 && firstKey > -1 && awaited < firstKey,
    `await at ${awaited}, first key at ${firstKey}`);
  ok('it is awaited exactly once', (flow.match(/await metaLoaded;/g) || []).length === 1);
  ok('rwRecordEventMeta sets the offset beside the start day',
    /rwEventStartDay = evDayKey\(e0\.start\);[\s\S]{0,400}?rwEventTzOffMin = evTzOffMin\(e0\.start\);/.test(code));
  ok('and rwResetEventState clears it with the rest',
    /rwEventStartDay = null;\s*\n\s*rwEventTzOffMin = null;/.test(code));
  ok('the day a broadcast aired is sent to the proxy with the venue\'s offset, encoded whole',
    /encodeURIComponent\(rwEventDays\[0\] \+ 'T00:00:00' \+ rwTzSuffix\(\)\)/.test(code),
    'a "+09:00" appended raw arrives as a space');
  ok('the lookup version moved, so yesterday\'s cached day assignment is not reused',
    /const RW_STREAM_LOGIC = 'L5';/.test(code));
}

// ══ 6. "Upcoming" is a question about YOUR calendar ════════════════════════
console.log('\n· still ahead of you');
{
  const { win, stop } = await boot();
  await settle(win, 300);
  const today = String(win.eval('evTodayKey()'));
  ok('today is a day key', /^\d{4}-\d{2}-\d{2}$/.test(today), today);
  const now = new Date();
  ok('and it is actually today, in the reader\'s zone',
    today === `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`,
    today);
  ok('the Event Scout compares calendar days, not a 24-hour fudge',
    /const k = evDayKey\(e\.end \|\| e\.start\); return !!k && k >= todayKey;/.test(code));
  ok('...and the fudge is gone', !/t >= Date\.now\(\) - 86400000/.test(code),
    'that kept yesterday\'s events on a list of events you can still register for');
  stop();
}

// ══ 7. The fallback date, when the /events lookup fails ════════════════════
// The Scout tab seeds each event's date from a match's own time until the
// /events lookup fills in the real one. That seed has to be the EARLIEST
// match: on a two-day event it was whichever one the loop reached first, so a
// failed lookup dated the event to day 2 about half the time.
console.log('\n· the fallback date is the first day, not a coin toss');
{
  ok('the seed keeps the earliest match time',
    /} else if \(seed && \(!cur\.start \|\| seed < cur\.start\)\) \{\s*\n\s*cur\.start = seed;/.test(code));

  const { win, stop } = await boot({ fail: { '/events?': 500 } });
  await settle(win, 300);
  const doc = win.document;
  win.switchTab('scout');
  doc.getElementById('detailTeamInput').value = '66449A';
  await win.runDetailedScout();
  await settle(win, 2000);
  const meta = [...doc.querySelectorAll('#tab-scout .ev-attend-meta')]
    .map(e => e.textContent).join(' | ');
  // The fixture's matches run 11:00–13:00 on the 28th and the 1st. With the
  // lookup refused, the earliest of those is the date — the 28th, never the 1st.
  // Asserted on a NON-EMPTY list, or the check passes by rendering nothing —
  // which is exactly how the Skills tab hid six XSS holes until t100.
  ok('the list still rendered with the lookup refused', !!meta, JSON.stringify(meta));
  ok('with the lookup refused it still shows day one',
    /\b2\/28\/2026\b/.test(meta) && !/\b3\/1\/2026\b/.test(meta), meta.slice(0, 200));
  stop();
}

// ══ 8. The release markers ═════════════════════════════════════════════════
console.log('\n· release');
{
  const app = (idx.match(/const APP_BUILD = '([^']+)'/) || [])[1];
  const sw = fs.readFileSync('../sw.js', 'utf8');
  const cache = (sw.match(/const CACHE_NAME = 'vex-scout-([^']+)'/) || [])[1];
  const pb = (proxy.match(/const PROXY_BUILD = '([^']+)'/) || [])[1];
  ok('all three markers agree', app === pb && pb === cache, `${app} / ${pb} / ${cache}`);
}

console.log(`\nt102: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
