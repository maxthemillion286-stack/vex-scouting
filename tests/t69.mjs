// t69 — day ordinals come from the EVENT, and a wrong video is refused.
//
// Reported from production at v23. The siblings lookup worked — the panel said
// "from the event's YouTube channel" — but Saturday, the event's day 2, was
// handed the video titled "Day 1", and every match row read "no stream for
// this day" while the form showed a stream.
//
// Cause: the day list the Jumper renders is built from THIS TEAM's matches,
// not the event's days. A team that only plays Saturday produces a list of one
// day at index 0, and index 0 asks for "Day 1" — which is Friday's broadcast.
// The index of a day in a filtered list is not its ordinal in the event.
//
// Three defences, because getting this wrong is worse than finding nothing
// (HANDOFF §3): every match time is then wrong with nothing saying so.
//   1. The ordinal is measured from the event's own start date.
//   2. A labelled pool that has no label for this day says so, instead of
//      falling through to a proximity guess.
//   3. Auto-sync refuses an offset that lands past the end of the recording —
//      what a day-2 match anchored to the day-1 stream looks like.
import fs from 'fs';
let pass = 0, fail = 0;
const ok = (n, c, e) => { c ? (pass++, console.log('  ok   ' + n)) : (fail++, console.log('  FAIL ' + n + (e ? '\n         ' + e : ''))); };
const idx = fs.readFileSync('../index.html', 'utf8');
const src = idx.match(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/)[1];
const grab = re => (src.match(re) || [''])[0];

console.log('t69 — event-relative day ordinals and wrong-video refusal');

// ── 1. The ordinal is measured from the event's start, not the array index ──
const mk = (startDay, days) => new Function('startDay', 'days',
  'let rwEventStartDay = startDay;\nlet rwEventDays = days || [];\nlet rwEventGrade = null;\nlet rwTeamDivision = null;\n' +
  grab(/function rwGradeOf\(text\)[\s\S]*?\n\}/) + '\n' +
  grab(/function rwTitleMatchesDivision\(title, division\)[\s\S]*?\n\}/) + '\n' +
  grab(/function rwEventDayOrdinal\(dayKey, fallbackIndex\)[\s\S]*?\n\}/) +
  '\nreturn rwEventDayOrdinal;')(startDay, days);

const ordFri = mk('2026-02-13');
ok('the event\'s first day is ordinal 0', ordFri('2026-02-13', 0) === 0);
ok('the event\'s second day is ordinal 1 even when it is the team\'s first',
  ordFri('2026-02-14', 0) === 1, 'this is the reported bug');
ok('a four-day event counts through', ordFri('2026-02-16', 0) === 3);
ok('without an event start it falls back to the given index',
  mk(null)('2026-02-14', 0) === 0);

// The event's own day list outranks the start date, and works without one.
// This is what most day-2 columns were missing: with no start date the
// ordinal fell back to the day's index within THIS TEAM's days, and a team
// playing only Saturday has Saturday at index 0 — which asks for "Day 1".
const twoDay = ['2026-02-13', '2026-02-14'];
ok('the day list gives Saturday ordinal 1 with no start date at all',
  mk(null, twoDay)('2026-02-14', 0) === 1, 'the reported "most day 2 events show day 1"');
ok('the day list gives Friday ordinal 0', mk(null, twoDay)('2026-02-13', 0) === 0);
ok('a four-day event indexes through the list',
  mk(null, ['2026-05-05', '2026-05-06', '2026-05-07', '2026-05-08'])('2026-05-08', 0) === 3);
ok('the day list wins over a disagreeing start date',
  mk('2026-02-14', twoDay)('2026-02-14', 0) === 1);
ok('a day outside the list still falls back to the start date',
  mk('2026-02-13', twoDay)('2026-02-15', 0) === 2);
ok('a date before the event start falls back rather than going negative',
  ordFri('2026-02-12', 7) === 7);
ok('an unparseable day falls back', ordFri('not-a-date', 4) === 4);

// ── 2. A labelled pool that does not cover this day says so ──
const pick = (startDay, days) => new Function('startDay', 'days',
  'let rwEventStartDay = startDay;\nlet rwEventDays = days || [];\nlet rwEventGrade = null;\nlet rwTeamDivision = null;\n' +
  grab(/function rwGradeOf\(text\)[\s\S]*?\n\}/) + '\n' +
  grab(/function rwTitleMatchesDivision\(title, division\)[\s\S]*?\n\}/) + '\n' +
  grab(/function rwDayKey\(ms\)[\s\S]*?\n\}/) + '\n' +
  grab(/function rwEventDayOrdinal\(dayKey, fallbackIndex\)[\s\S]*?\n\}/) + '\n' +
  grab(/const RW_WEEKDAYS = \[[^\]]*\];/) + '\n' +
  grab(/function rwTitleDayLabel\(title\)[\s\S]*?\n\}/) + '\n' +
  grab(/function rwPickByDayLabel\(pool, dayKey, dayIndex\)[\s\S]*?\n\}/) + '\n' +
  grab(/function rwRankForDay\(cands, dayKey\)[\s\S]*?\n\}/) + '\n' +
  grab(/function rwPickStreamForDay\(pool, dayKey, dayIndex\)[\s\S]*?\n\}/) +
  '\nreturn rwPickStreamForDay;')(startDay, days);

const bristol = [
  { url: 'D1', title: 'Bots @ Bristol Signature Event (Middle School) Day 1' },
  { url: 'D2', title: 'Bots @ Bristol Signature Event (Middle School) Day 2' }
];
const p = pick('2026-02-13');
ok('Friday gets Day 1', p(bristol, '2026-02-13', 0) === 'D1');
ok('Saturday gets Day 2 even at team-index 0',
  p(bristol, '2026-02-14', 0) === 'D2', 'the exact production failure');

// Only day 1 was published — day 2 must NOT be handed it
const onlyD1 = [{ url: 'D1', title: 'Bots @ Bristol (Middle School) Day 1' }];
ok('a day with no matching label gets nothing, not the wrong video',
  p(onlyD1, '2026-02-14', 0) === null, 'silently wrong times is the worse failure');
ok('...but the day it IS labelled for still resolves',
  p(onlyD1, '2026-02-13', 0) === 'D1');

// An unlabelled pool keeps the old proximity/index behaviour
const unlabelled = [{ url: 'A', publishedAt: '2026-02-13T18:00:00Z' },
                    { url: 'B', publishedAt: '2026-02-14T18:00:00Z' }];
ok('an unlabelled pool still resolves by date', p(unlabelled, '2026-02-14', 1) === 'B');
ok('an unlabelled undated pool still falls back to position',
  p([{ url: 'X' }, { url: 'Y' }], '2026-02-14', 1) === 'Y');

// Weekday labels
const weekend = [{ url: 'SAT', title: 'CA States — Saturday' }, { url: 'SUN', title: 'CA States — Sunday' }];
ok('Saturday resolves by weekday name', p(weekend, '2026-02-14', 0) === 'SAT');
ok('Sunday resolves by weekday name', p(weekend, '2026-02-15', 1) === 'SUN');

// ── 3. Auto-sync refuses an offset past the end of the recording ──
const sync = src.slice(src.indexOf('async function rwTryAutoSync'), src.indexOf('function rewatchCalibrate'));
ok('auto-sync accepts the video length', /knownDuration = null/.test(sync));
ok('an offset past the end is refused', /secs > knownDuration \+ 3600/.test(sync));
ok('the refusal explains itself in hours', /h into a video only/.test(sync));
// The hard refusal on ANY negative offset is deliberately gone. It was
// throwing away whole days over the few minutes organisers take to start
// recording — the Bristol day-2 failure. What replaced it still refuses a
// genuinely wrong video, but only once no match on the day is inside it.
ok('a small negative offset is absorbed, not refused',
  /if \(secs >= -RW_PRESTART_GRACE_SEC\) \{\s*secs = 0;/.test(sync),
  'a stream that started a minute into the first match is normal (§4)');
ok('it gathers the matches that ARE inside the stream',
  /\.filter\(m => m\.t !== null && rwDayKey\(m\.t\) === day && m\.t >= startMs\)/.test(sync));
ok('and re-anchors on the earliest of them',
  /anchor = inStream\[0\];[\s\S]{0,80}secs = Math\.round\(\(anchor\.t - startMs\) \/ 1000\);/.test(sync));
ok('it looks across every division, not just this team',
  /\(ctx\.allMatches && ctx\.allMatches\.length\) \? ctx\.allMatches : ctx\.matches\)\s*\n?\s*\.filter\(m => m\.t !== null && rwDayKey/.test(sync));
ok('it still refuses when NO match on the day is inside the recording',
  /Every match on this day happened before this stream started/.test(sync));
ok('the grace is the shared constant, not a second literal',
  /RW_PRESTART_GRACE_SEC/.test(sync) && !/secs >= -900/.test(sync));

const beyond = new Function('secs', 'knownDuration',
  'return !!(knownDuration && secs > knownDuration + 3600);');
ok('a day-2 match against a day-1 stream is refused (24h into 7h)',
  beyond(24 * 3600, 7 * 3600) === true);
ok('a genuine late match in a long stream is kept (6h into 7h)',
  beyond(6 * 3600, 7 * 3600) === false);
ok('an hour of slack for a stream that ran long',
  beyond(7.5 * 3600, 7 * 3600) === false);
ok('no duration known → no opinion', beyond(24 * 3600, null) === false);

// ── 4. The caller must not substitute the headline link over a refusal ──
const loop = src.slice(src.indexOf('const picked = rwPickStreamForDay'), src.indexOf('// Re-render either way'));
ok('a refused day is skipped, not back-filled',
  /if \(!picked && rwStreamPool\.length\) \{[\s\S]*?continue;/.test(loop), loop.slice(0, 400));
ok('the reason is recorded for the status line', /rwAutoSyncFail\[d\] =/.test(loop));
ok('the video length is passed through to auto-sync', /knownDuration:/.test(loop));
ok('an empty pool still falls back to the headline link', /picked \|\| webcastRaw/.test(loop));

console.log(`\nt69: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
