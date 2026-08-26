// t47 — client-side per-day stream selection (rwPickStreamForDay).
import fs from 'fs';
let pass=0, fail=0;
const ok=(n,c,e)=>{c?(pass++,console.log('  ok   '+n)):(fail++,console.log('  FAIL '+n+(e?'\n         '+e:'')));};
const html = fs.readFileSync(process.argv[2]||'../index.html','utf8');
const src = html.match(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/)[1];
// rwPickStreamForDay now delegates to the day-label reader, so both helpers
// have to come across with it or the extraction throws on an undefined name.
// Pulled from source rather than restated here, so this exercises the real
// ranking instead of a copy that can drift from it.
const grab = re => (src.match(re) || [''])[0];
const fn = [
  // rwEventStartDay is set from the API at runtime; null here means the
  // ordinal falls back to the passed index, which is what these cases assume.
  'let rwEventStartDay = null;',
  // Empty here, so the ordinal falls through to the passed index — which is
  // what these positional cases assume. t69 exercises it populated.
  'let rwEventDays = [];',
  grab(/function rwDayKey\(ms\)[\s\S]*?\n\}/),
  grab(/function rwEventDayOrdinal\(dayKey, fallbackIndex\)[\s\S]*?\n\}/),
  grab(/const RW_WEEKDAYS = \[[^\]]*\];/),
  grab(/function rwTitleDayLabel\(title\)[\s\S]*?\n\}/),
  grab(/function rwPickByDayLabel\(pool, dayKey, dayIndex\)[\s\S]*?\n\}/),
  grab(/function rwPickStreamForDay\(pool, dayKey, dayIndex\)[\s\S]*?\n\}/)
].join('\n');
const rwPickStreamForDay = new Function(fn + '; return rwPickStreamForDay;')();

console.log('t47 — per-day stream selection');

ok('an empty pool yields nothing', rwPickStreamForDay([], '2026-03-07', 0) === null);
ok('a null pool yields nothing', rwPickStreamForDay(null, '2026-03-07', 0) === null);

const dated = [
  { url:'A', publishedAt:'2026-03-07T14:00:00Z' },
  { url:'B', publishedAt:'2026-03-08T14:00:00Z' }
];
ok('day 1 gets the day 1 video', rwPickStreamForDay(dated,'2026-03-07',0) === 'A');
ok('day 2 gets the day 2 video', rwPickStreamForDay(dated,'2026-03-08',1) === 'B');

// A broadcast that begins the evening before still covers the next morning
const evening = [{ url:'X', publishedAt:'2026-03-06T23:30:00Z' }];
ok('an evening-before broadcast still matches the next day',
   rwPickStreamForDay(evening,'2026-03-07',0) === 'X');

// Far-off videos must not be dragged in
const stale = [{ url:'OLD', publishedAt:'2026-01-01T12:00:00Z' }];
ok('a video months away is not matched by date, only by position',
   rwPickStreamForDay(stale,'2026-03-07',0) === 'OLD');

// Undated pool (scraped links, no channel search) falls back to order
const undated = [{ url:'P' }, { url:'Q' }, { url:'R' }];
ok('undated pool: day index picks positionally', rwPickStreamForDay(undated,'2026-03-08',1) === 'Q');
ok('undated pool: overflow falls back to the first',
   rwPickStreamForDay(undated,'2026-03-20',9) === 'P');

// Single video, multi-day event — every day reuses it rather than getting null
const one = [{ url:'ONLY', publishedAt:'2026-03-07T14:00:00Z' }];
ok('one video covers day 1', rwPickStreamForDay(one,'2026-03-07',0) === 'ONLY');
ok('one video is still returned for day 2 (auto-sync rejects a bad pair)',
   rwPickStreamForDay(one,'2026-03-08',1) === 'ONLY');

console.log(`\nt47: ${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
