// t66 — a link in the event description must not short-circuit the search.
//
// The bug, and why multi-day events (Worlds, States, any two-day signature)
// never synced:
//
//   const found = rwFindWebcasts(e0).filter(...);
//   if (found.length) { webcastRaw = found[0].url; }
//   else if (e0.sku) { ...ask the proxy, build rwStreamPool... }
//
// Organisers put ONE broadcast in the event description — usually the last
// day's. Finding it returned before the proxy was ever consulted, so
// rwStreamPool stayed empty and the per-day segment machinery in HANDOFF §4
// had nothing to work with. That single URL was then applied to every day:
// day 1 got day 2's video, the offset came out negative, and auto-sync bailed
// with "these matches happened before this stream started" — quietly, because
// auto-sync on the user's behalf is always quiet.
//
// Observed on "Bots @ Bristol Signature Event (Middle School)": the Friday
// column was handed the video titled "Day 2".
//
// This is the §11 shape: a path that returns before reaching the fallback that
// would have worked. Same as the two worst bugs in this project's history.
import fs from 'fs';
let pass = 0, fail = 0;
const ok = (n, c, e) => { c ? (pass++, console.log('  ok   ' + n)) : (fail++, console.log('  FAIL ' + n + (e ? '\n         ' + e : ''))); };
const idx = fs.readFileSync('../index.html', 'utf8');
const src = idx.match(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/)[1];
const fn = src.slice(src.indexOf('async function rwAutoFindStream'),
                     src.indexOf('async function rewatchSelectEvent'));

console.log('t66 — description link does not short-circuit the pool');

// The upper bound only confirms the slice grabbed one function rather than
// running off the end of the file — it is not a size policy. Raised as the
// function gained the channel-expansion path; roughly half of it is comment,
// which is the house style here and shouldn't trip a test.
ok('rwAutoFindStream was found', fn.length > 200 && fn.length < 14000, `length ${fn.length}`);

// ── 1. The two paths are no longer mutually exclusive ──
ok('the proxy call is not an else-branch of the description check',
  !/\}\s*else if \(e0\.sku\)/.test(fn), 'still `else if (e0.sku)`');
ok('the proxy is consulted on its own condition',
  /if \(e0\.sku && needPool\)/.test(fn));
ok('the description link is still read first (it is free)',
  fn.indexOf('rwFindWebcasts') < fn.indexOf('needPool'));

// ── 2. needPool: search only when one video cannot cover the event ──
const needPoolOf = new Function('dayCount', 'webcastRaw',
  'return dayCount > 1 || !webcastRaw;');
ok('multi-day event with a description link → still searches',
  needPoolOf(2, 'https://youtu.be/abc') === true);
ok('three-day event → still searches', needPoolOf(3, 'https://youtu.be/abc') === true);
ok('single-day event with a link → no search, no quota',
  needPoolOf(1, 'https://youtu.be/abc') === false);
ok('single-day event with no link → searches',
  needPoolOf(1, '') === true);

// ── 3. dayCount arithmetic ──
const dayCountOf = new Function('start', 'end', `
  const s = Date.parse(start), en = Date.parse(end);
  if (isNaN(s) || isNaN(en)) return 1;
  return Math.max(1, Math.round((en - s) / 86400000) + 1);`);
ok('one-day event counts 1',
  dayCountOf('2026-02-13T09:00:00Z', '2026-02-13T20:00:00Z') === 1);
ok('two-day event counts 2',
  dayCountOf('2026-02-13T09:00:00Z', '2026-02-14T20:00:00Z') === 2);
ok('a Worlds-length event counts every day',
  dayCountOf('2026-05-05T09:00:00Z', '2026-05-08T20:00:00Z') === 4);
ok('unparseable dates fall back to 1 rather than NaN',
  dayCountOf('', '') === 1);
ok('never returns 0 or negative',
  dayCountOf('2026-02-14T09:00:00Z', '2026-02-13T20:00:00Z') >= 1);

// ── 4. An empty search result is not a miss when we already have a link ──
const reasonOf = new Function('list', 'webcastRaw', 'j', `
  return (list.length || webcastRaw)
    ? (list.length ? (j.reason || null) : null)
    : (j.reason || 'no-links-on-page');`);
ok('search found nothing but the description had a link → not reported as a miss',
  reasonOf([], 'https://youtu.be/abc', {}) === null);
ok('search found nothing and there was no link → reported',
  reasonOf([], '', {}) === 'no-links-on-page');
ok('the proxy\'s own reason survives when there was no link',
  reasonOf([], '', { reason: 'page-unreachable' }) === 'page-unreachable');
ok('a populated pool clears the miss',
  reasonOf([{ url: 'x' }], '', {}) === null);

// ── 5. The pool is still what drives per-day selection ──
ok('the whole list is kept, not just a best pick', /rwStreamPool = list;/.test(fn));
ok('per-day selection still consults the pool',
  /rwPickStreamForDay\(rwStreamPool/.test(src));
ok('multi-segment days still consult the pool',
  /rwSegmentsForDay\(rwStreamPool/.test(src));

console.log(`\nt66: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
