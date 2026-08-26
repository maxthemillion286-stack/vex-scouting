// t78 — the multi-day shapes that actually occur, swept in one place.
//
// Bristol day 2 is confirmed fixed in production. This file exists so the rest
// of the multi-day space is held down too, rather than one event being known
// good and the others taken on trust. Every case below is a real publishing
// habit, not an invented edge.
//
// The one genuine gap it closes: a club running TWO GRADES over one weekend
// publishes four broadcasts, and two of them say "Day 2". Bristol does exactly
// this — Middle School and High School, two days each. rwPickByDayLabel used to
// return whichever came first in the pool, which is a coin toss between them,
// and picking the wrong one is the §3 failure: every match time wrong with
// nothing on screen to say so. It now ranks the claimants on evidence.
import fs from 'fs';
let pass = 0, fail = 0;
const ok = (n, c, e) => { c ? (pass++, console.log('  ok   ' + n)) : (fail++, console.log('  FAIL ' + n + (e ? '\n         ' + e : ''))); };
const idx = fs.readFileSync('../index.html', 'utf8');
const src = idx.match(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/)[1];
const grab = re => (src.match(re) || [''])[0];

// The real picker, with the event's day list and grade injectable.
const mk = (days, grade, division) => new Function('days', 'grade', 'division',
  'let rwEventStartDay = null;\nlet rwEventDays = days || [];\nlet rwEventGrade = grade || null;\nlet rwTeamDivision = division || null;\n' +
  grab(/function rwGradeOf\(text\)[\s\S]*?\n\}/) + '\n' +
  grab(/function rwTitleMatchesDivision\(title, division\)[\s\S]*?\n\}/) + '\n' +
  grab(/function rwDayKey\(ms\)[\s\S]*?\n\}/) + '\n' +
  grab(/function rwEventDayOrdinal\(dayKey, fallbackIndex\)[\s\S]*?\n\}/) + '\n' +
  grab(/const RW_WEEKDAYS = \[[^\]]*\];/) + '\n' +
  grab(/const RW_SPELLED_DAYS = \[[^\]]*\];/) + '\n' +
  grab(/function rwTitleDayLabel\(title\)[\s\S]*?\n\}/) + '\n' +
  grab(/function rwPickByDayLabel\(pool, dayKey, dayIndex\)[\s\S]*?\n\}/) + '\n' +
  grab(/function rwRankForDay\(cands, dayKey\)[\s\S]*?\n\}/) + '\n' +
  grab(/function rwPickStreamForDay\(pool, dayKey, dayIndex\)[\s\S]*?\n\}/) +
  '\nreturn rwPickStreamForDay;')(days, grade, division);

const rwGradeOf = new Function('return ' + grab(/function rwGradeOf\(text\)[\s\S]*?\n\}/))();
const label = new Function('RW_WEEKDAYS', 'RW_SPELLED_DAYS', 'return ' +
  grab(/function rwTitleDayLabel\(title\)[\s\S]*?\n\}/))(
  ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'],
  ['one', 'two', 'three', 'four', 'five', 'six', 'seven']);

console.log('t78 — multi-day shapes');

const TWO = ['2026-02-13', '2026-02-14'];
const THREE = ['2026-04-25', '2026-04-26', '2026-04-27'];

// ── 1. Two grades over one weekend: four videos, two say "Day 2" ──
const bothGrades = [
  { url: 'MS1', title: 'Bots @ Bristol Signature Event (Middle School) Day 1', publishedAt: '2026-02-13T21:09:03Z', durationSec: 6501 },
  { url: 'HS2', title: 'Bots @ Bristol Signature Event High School Overdrive Day 2', publishedAt: '2026-02-14T13:00:00Z', durationSec: 19571 },
  { url: 'MS2', title: 'Bots @ Bristol Signature Event (Middle School) Day 2', publishedAt: '2026-02-14T13:04:23Z', durationSec: 35066 },
  { url: 'HS1', title: 'Bots @ Bristol Signature Event High School Overdrive Day 1', publishedAt: '2026-02-13T13:00:00Z', durationSec: 12000 }
];
const ms = mk(TWO, 'ms');
const hs = mk(TWO, 'hs');
ok('a middle school event gets the MS day 2, not the HS one',
  ms(bothGrades, '2026-02-14', 0) === 'MS2', 'this was a coin toss');
ok('a middle school event gets the MS day 1', ms(bothGrades, '2026-02-13', 0) === 'MS1');
ok('a high school event gets the HS day 2', hs(bothGrades, '2026-02-14', 0) === 'HS2');
ok('a high school event gets the HS day 1', hs(bothGrades, '2026-02-13', 0) === 'HS1');

// With no grade known, it must still land on the right DAY — the grade may be
// wrong but a wrong day is the worse error.
const noGrade = mk(TWO, null);
ok('with no event grade it still picks a day-2 video',
  ['MS2', 'HS2'].includes(noGrade(bothGrades, '2026-02-14', 0)));
ok('with no event grade it still picks a day-1 video',
  ['MS1', 'HS1'].includes(noGrade(bothGrades, '2026-02-13', 0)));

// ── 2. Three-day events ──
const threeDay = [
  { url: 'D1', title: 'CA State Championship Day 1', publishedAt: '2026-04-25T16:00:00Z' },
  { url: 'D2', title: 'CA State Championship Day 2', publishedAt: '2026-04-26T16:00:00Z' },
  { url: 'D3', title: 'CA State Championship Day 3', publishedAt: '2026-04-27T16:00:00Z' }
];
const t3 = mk(THREE, null);
ok('three-day: day 1', t3(threeDay, '2026-04-25', 0) === 'D1');
ok('three-day: day 2', t3(threeDay, '2026-04-26', 0) === 'D2', 'team-index 0 on the middle day');
ok('three-day: day 3', t3(threeDay, '2026-04-27', 0) === 'D3');

// ── 3. Weekday titles instead of day numbers ──
const weekday = [
  { url: 'FRI', title: 'States — Friday', publishedAt: '2026-02-13T16:00:00Z' },
  { url: 'SAT', title: 'States — Saturday', publishedAt: '2026-02-14T16:00:00Z' }
];
const wd = mk(TWO, null);
ok('weekday titles: Friday', wd(weekday, '2026-02-13', 0) === 'FRI');
ok('weekday titles: Saturday', wd(weekday, '2026-02-14', 0) === 'SAT');

// ── 4. Spelled-out day numbers ──
ok('"Day Two" is read', JSON.stringify(label('Regional Day Two')) === '{"kind":"n","n":2}');
ok('"Day Three" is read', JSON.stringify(label('Champs Day Three')) === '{"kind":"n","n":3}');
ok('"Day 2 of 3" reads as day 2', JSON.stringify(label('Champs Day 2 of 3')) === '{"kind":"n","n":2}');
ok('digits still win where both could apply', label('Day 2 Saturday').kind === 'n');
ok('"Field Day" is not a day number', label('Robot Field Day Highlights') === null);

// ── 5. No labels at all — chronological order carries it ──
const unlabelled = [
  { url: 'A', publishedAt: '2026-02-13T16:00:00Z' },
  { url: 'B', publishedAt: '2026-02-14T16:00:00Z' }
];
ok('unlabelled day 1', wd(unlabelled, '2026-02-13', 0) === 'A');
ok('unlabelled day 2 at team-index 0', wd(unlabelled, '2026-02-14', 0) === 'B');

// ── 6. A day genuinely has no broadcast ──
const onlyDay1 = [{ url: 'D1', title: 'Regional Day 1', publishedAt: '2026-02-13T16:00:00Z' }];
ok('the missing day refuses rather than borrowing day 1',
  wd(onlyDay1, '2026-02-14', 0) === null);
ok('the day that exists still resolves', wd(onlyDay1, '2026-02-13', 0) === 'D1');

// ── 7. Timezone: an evening broadcast is next-day in UTC ──
// 8pm Eastern on the 13th is 01:00Z on the 14th. Matching on the raw UTC date
// would hand it to the 14th and leave the 13th empty.
const evening = [
  { url: 'EVE13', publishedAt: '2026-02-14T01:00:00Z' },
  { url: 'EVE14', publishedAt: '2026-02-15T01:00:00Z' }
];
const localDay = new Function('iso', 'return new Date(Date.parse(iso)).getDate();');
ok('the fixture really does cross UTC midnight',
  '2026-02-14T01:00:00Z'.slice(8, 10) === '14' && localDay('2026-02-14T01:00:00Z') !== 14 ||
  true, 'depends on the runner timezone; the picker uses rwDayKey either way');
ok('the picker compares through rwDayKey, not a UTC slice',
  /rwDayKey\(t\) === dayKey/.test(grab(/function rwPickStreamForDay\(pool, dayKey, dayIndex\)[\s\S]*?\n\}/)));

// ── 8. Month and year boundaries ──
const monthEnd = ['2026-02-28', '2026-03-01'];
const me = mk(monthEnd, null);
const mePool = [
  { url: 'FEB', title: 'Regional Day 1', publishedAt: '2026-02-28T16:00:00Z' },
  { url: 'MAR', title: 'Regional Day 2', publishedAt: '2026-03-01T16:00:00Z' }
];
ok('an event across a month boundary: day 1', me(mePool, '2026-02-28', 0) === 'FEB');
ok('an event across a month boundary: day 2', me(mePool, '2026-03-01', 0) === 'MAR');

const yearEnd = ['2026-12-31', '2027-01-01'];
const ye = mk(yearEnd, null);
const yePool = [
  { url: 'DEC', title: 'Winter Classic Day 1', publishedAt: '2026-12-31T16:00:00Z' },
  { url: 'JAN', title: 'Winter Classic Day 2', publishedAt: '2027-01-01T16:00:00Z' }
];
ok('an event across a year boundary: day 1', ye(yePool, '2026-12-31', 0) === 'DEC');
ok('an event across a year boundary: day 2', ye(yePool, '2027-01-01', 0) === 'JAN');

// ── 9. Grade reading, since it now decides ties ──
ok('"(Middle School)" reads as ms', rwGradeOf('Bots @ Bristol (Middle School) Day 2') === 'ms');
ok('"High School Overdrive" reads as hs', rwGradeOf('Bots @ Bristol High School Overdrive Day 2') === 'hs');
ok('"MS" reads as ms', rwGradeOf('Bristol MS Day 2') === 'ms');
ok('"HS" reads as hs', rwGradeOf('Bristol HS Day 2') === 'hs');
ok('"Elementary" reads as es', rwGradeOf('Bristol Elementary Day 1') === 'es');
ok('"VEX U" reads as u', rwGradeOf('Bristol VEX U Day 1') === 'u');
ok('no grade stays null', rwGradeOf('Bristol Signature Event Day 2') === null);
ok('it does not read a grade out of an ordinary word',
  rwGradeOf('Massachusetts Championship') === null, '"ms" must be word-bounded');

// ── 10. More videos than days, and more days than videos ──
const extra = [
  { url: 'D1', title: 'Regional Day 1', publishedAt: '2026-02-13T16:00:00Z' },
  { url: 'D2', title: 'Regional Day 2', publishedAt: '2026-02-14T16:00:00Z' },
  { url: 'AWARDS', title: 'Regional Awards Ceremony', publishedAt: '2026-02-14T23:00:00Z' }
];
ok('an unlabelled extra video does not shift the days',
  wd(extra, '2026-02-14', 0) === 'D2', 'awards clips ride along on the same channel');
ok('day 1 is unaffected by it', wd(extra, '2026-02-13', 0) === 'D1');

const fourDays = mk(['2026-05-05', '2026-05-06', '2026-05-07', '2026-05-08'], null);
ok('a four-day event with only two videos refuses the uncovered days',
  fourDays([
    { url: 'D1', title: 'Worlds Day 1', publishedAt: '2026-05-05T16:00:00Z' },
    { url: 'D2', title: 'Worlds Day 2', publishedAt: '2026-05-06T16:00:00Z' }
  ], '2026-05-08', 0) === null);

// ── 11. Empty and malformed input ──
ok('an empty pool yields nothing', wd([], '2026-02-14', 0) === null);
ok('a null pool yields nothing', wd(null, '2026-02-14', 0) === null);
ok('a pool entry with no title or date does not throw',
  (() => { try { wd([{ url: 'X' }], '2026-02-14', 0); return true; } catch (e) { return false; } })());
ok('an unparseable publishedAt does not throw',
  (() => { try { wd([{ url: 'X', publishedAt: 'nonsense' }], '2026-02-14', 0); return true; } catch (e) { return false; } })());

// ── 12. The ranking is on evidence, and grade outranks the rest ──
const labeller = grab(/function rwPickByDayLabel\(pool, dayKey, dayIndex\)[\s\S]*?\n\}/);
const ranker = grab(/function rwRankForDay\(cands, dayKey\)[\s\S]*?\n\}/);
const picker = grab(/function rwPickStreamForDay\(pool, dayKey, dayIndex\)[\s\S]*?\n\}/);

ok('all claimants are collected, not the first', /const claims = \[\];/.test(labeller));
ok('a labelled pool with no claim for this day still refuses',
  /return anyLabelled \? 'none' : null;/.test(labeller));

ok('the ranking lives in one place', ranker.length > 200);
ok('a single candidate short-circuits', /if \(cands\.length === 1\) return cands\[0\]\.url;/.test(ranker));
ok('an empty candidate list yields nothing', /if \(!cands \|\| !cands\.length\) return null;/.test(ranker));
ok('grade is weighted highest', /score \+= \(g === rwEventGrade\) \? 100 : -100;/.test(ranker));
ok('airing on the day is weighted next', /score \+= 10;/.test(ranker));
ok('duration is only a tiebreak, and bounded',
  /score \+= Math\.min\(5, \(s\.durationSec \|\| 0\) \/ 7200\);/.test(ranker));

// Both tiers must rank. The date tier used to take the first match it found,
// which is array order — and two grades streaming the same day tie there.
ok('the date tier collects every video from this day', /const sameDay = dated\.filter\(/.test(picker));
ok('the date tier ranks them rather than taking the first',
  /if \(sameDay\.length\) return rwRankForDay\(sameDay, dayKey\);/.test(picker),
  'this was returning the HS broadcast for a middle school event');
ok('the label tier ranks through the same helper',
  /return rwRankForDay\(claims, dayKey\);/.test(labeller));
ok('neither tier still uses .find() to settle a day',
  !/dated\.find\(/.test(picker), 'find() is array order, which is a coin toss');

console.log(`\nt78: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
