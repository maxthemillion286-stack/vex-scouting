// t73 — "most day 2 events still show day 1".
//
// Two defects, both of which point the same way: one day earlier than reality.
//
// 1. TIMEZONE. rwDayKey builds a day key from the LOCAL date
//    (getFullYear/getMonth/getDate), but the date match sliced the first ten
//    characters off the ISO string — the UTC date — and compared the two. They
//    disagree whenever a broadcast's UTC date differs from its local one, and a
//    late-afternoon start in any US timezone is already tomorrow in UTC. The
//    day that owned a video failed to claim it and the day before kept it.
//
// 2. NO EVENT DAY LIST. The ordinal came from the event's start date, and fell
//    back to the day's index within THIS TEAM's days when the API had no usable
//    start. A team playing only Saturday has Saturday at index 0, which asks
//    for the video titled "Day 1". Systematic, which matches "most".
//
// ctx.allMatches already holds every division's matches, so the event's real
// day list was available the whole time — and it comes through rwDayKey, so it
// cannot disagree with the day keys it is compared against.
//
// Also adds a tier that needs neither titles nor timezones: when the broadcasts
// line up one per event day, the k-th chronologically IS day k.
import fs from 'fs';
let pass = 0, fail = 0;
const ok = (n, c, e) => { c ? (pass++, console.log('  ok   ' + n)) : (fail++, console.log('  FAIL ' + n + (e ? '\n         ' + e : ''))); };
const idx = fs.readFileSync('../index.html', 'utf8');
const src = idx.match(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/)[1];
const grab = re => (src.match(re) || [''])[0];

console.log('t73 — day 2 must not resolve to day 1');

const pick = days => new Function('days',
  'let rwEventStartDay = null;\nlet rwEventDays = days || [];\n' +
  grab(/function rwDayKey\(ms\)[\s\S]*?\n\}/) + '\n' +
  grab(/function rwEventDayOrdinal\(dayKey, fallbackIndex\)[\s\S]*?\n\}/) + '\n' +
  grab(/const RW_WEEKDAYS = \[[^\]]*\];/) + '\n' +
  grab(/function rwTitleDayLabel\(title\)[\s\S]*?\n\}/) + '\n' +
  grab(/function rwPickByDayLabel\(pool, dayKey, dayIndex\)[\s\S]*?\n\}/) + '\n' +
  grab(/function rwPickStreamForDay\(pool, dayKey, dayIndex\)[\s\S]*?\n\}/) +
  '\nreturn rwPickStreamForDay;')(days);

// ── 1. The date match runs both sides through rwDayKey ──
const picker = grab(/function rwPickStreamForDay\(pool, dayKey, dayIndex\)[\s\S]*?\n\}/);
ok('the UTC string slice is gone',
  !/String\(s\.publishedAt\)\.slice\(0, 10\) === dayKey/.test(picker),
  'comparing a UTC date to a local day key is off by one for evening starts');
ok('both sides go through rwDayKey', /rwDayKey\(t\) === dayKey/.test(picker));
ok('an unparseable timestamp is skipped, not matched', /!isNaN\(t\) && rwDayKey/.test(picker));

// ── 2. The event's own day list drives the ordinal ──
ok('the day list is consulted first',
  /const i = rwEventDays\.indexOf\(dayKey\);[\s\S]{0,60}if \(i >= 0\) return i;/.test(src));
ok('it is built from every division where available',
  /ctx\.allMatches && ctx\.allMatches\.length \? ctx\.allMatches : matches/.test(src));
ok('it is built with rwDayKey, so it cannot disagree about timezones',
  /rwEventDays = \[\.\.\.new Set\([\s\S]{0,240}rwDayKey\(m\.t\)/.test(src));
ok('undated matches are excluded', /\.filter\(d => d !== 'unknown'\)\.sort\(\)/.test(src));

// ── 3. The reported failure, end to end ──
const twoDay = ['2026-02-13', '2026-02-14'];
const p = pick(twoDay);

const labelled = [
  { url: 'D1', title: 'Bots @ Bristol Signature Event (Middle School) Day 1' },
  { url: 'D2', title: 'Bots @ Bristol Signature Event (Middle School) Day 2' }
];
ok('day 2 gets Day 2 with no start date and a team-index of 0',
  p(labelled, '2026-02-14', 0) === 'D2', 'the reported failure');
ok('day 1 still gets Day 1', p(labelled, '2026-02-13', 0) === 'D1');

// ── 4. Chronological tier: no titles, no timezones ──
const untitled = [
  { url: 'FIRST', publishedAt: '2026-02-13T14:00:00Z' },
  { url: 'SECOND', publishedAt: '2026-02-14T14:00:00Z' }
];
ok('the picker takes broadcasts in order when counts line up',
  /dated\.length === rwEventDays\.length/.test(picker));
ok('day 1 gets the first broadcast', p(untitled, '2026-02-13', 0) === 'FIRST');
ok('day 2 gets the second broadcast even at team-index 0',
  p(untitled, '2026-02-14', 0) === 'SECOND', 'needs neither a title convention nor a timezone');

// A stray extra video must not shift everything by one.
const withStray = [
  { url: 'FIRST', publishedAt: '2026-02-13T14:00:00Z' },
  { url: 'SECOND', publishedAt: '2026-02-14T14:00:00Z' },
  { url: 'STRAY', publishedAt: '2026-02-14T20:00:00Z' }
];
ok('an uneven count does not use the chronological tier',
  p(withStray, '2026-02-13', 0) === 'FIRST', 'falls to the date match, which is right here');

// ── 5. The ranking order is intact ──
ok('an exact date still wins first',
  picker.indexOf('rwDayKey(t) === dayKey') < picker.indexOf('rwPickByDayLabel'));
ok('a label still beats chronological order',
  picker.indexOf('rwPickByDayLabel') < picker.indexOf('dated.length === rwEventDays.length'));
ok('chronological order still beats proximity',
  picker.indexOf('dated.length === rwEventDays.length') < picker.indexOf('gap'));
ok('index order remains the last resort',
  picker.lastIndexOf('pool[dayIndex]') > picker.indexOf('gap'));
ok('a labelled pool that skips this day still refuses',
  p([{ url: 'D1', title: 'Bristol Day 1' }], '2026-02-14', 0) === null);

console.log(`\nt73: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
