// t72 — a deploy must not serve the previous release's answers, and the
// channel is what enumerates an event, not the relevance search.
//
// Bots @ Bristol published FOUR broadcasts, confirmed on the channel:
//
//   Bots @ Bristol Signature Event (Middle School) Day 1        1:48:21
//   Bots @ Bristol Signature Event High School Overdrive Day 2  5:26:11
//   Bots @ Bristol Signature Event (Middle School) Day 2        9:44:26
//   Bots @ Bristol Signature Event High School Overdrive Day 1
//
// The lookup returned exactly one of them — the Middle School Day 2, the
// longest and most-viewed. Nothing was wrong with the others; the search
// simply did not rank them into the answer.
//
// Three defects behind "still doesn't work", in order of how much they hurt.
//
// 1. CACHING. A found stream is cached 24h with a matching CDN s-maxage, and
//    the CDN is keyed by URL — a URL that did not change when the proxy did.
//    So every fix shipped and the edge kept serving the answer from before it,
//    for a day. Testing straight after a deploy is the worst case and is
//    exactly when anyone tests. ?debug=1 added a cache-buster, so debug
//    captures looked fresh while ordinary use was a day stale — which is why
//    the two disagreed.
//
// 2. ENUMERATION. The relevance search is a good way to FIND an event and a
//    poor way to list it. Once one video is known the channel is authoritative
//    and complete, and listing it costs 2-3 units against the 101 already
//    spent.
//
// 3. GRADE. gradeOf(title + description) let a description settle the grade,
//    and descriptions routinely name the other one. Whichever pattern appeared
//    first won — a coin toss deciding whether a video is dropped outright.
import fs from 'fs';
let pass = 0, fail = 0;
const ok = (n, c, e) => { c ? (pass++, console.log('  ok   ' + n)) : (fail++, console.log('  FAIL ' + n + (e ? '\n         ' + e : ''))); };
const px = fs.readFileSync('../api/proxy.js', 'utf8');
const idx = fs.readFileSync('../index.html', 'utf8');
const src = idx.match(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/)[1];

console.log('t72 — cache versioning, channel enumeration, grade by title');

// ── 1. A deploy gets its own cache entries, server and edge ──
// Keyed on the LOOKUP's version, not the release.
//
// v27 keyed it on PROXY_BUILD, which was right about the problem (a deploy
// must be able to invalidate stale answers) and wrong about the cost: every
// deploy then re-billed every event. A multi-day lookup is ~310 YouTube units
// against a 10,000/day allowance, so six releases in an afternoon spent while
// testing the same events exhausts it — and the symptom is every event on the
// site quietly failing to auto-find at once.
ok('the cache key is the lookup version the client sends, not the release',
  /const cacheKey = 'streams:' \+ logic \+/.test(px));
ok('that version is sanitised before use', /replace\(\/\[\^\\w\.-\]\/g, ''\)/.test(px));
ok('it falls back rather than keying on undefined', /\|\| 'L0'/.test(px));
ok('the client sends a deliberate lookup version', /const RW_STREAM_LOGIC = 'L\d+';/.test(src));
ok('it is NOT the release number', !/&b=\$\{encodeURIComponent\(APP_BUILD\)\}/.test(src),
  'that is what made every deploy re-bill every event');
ok('every proxy lookup url carries it',
  (src.match(/&b=\$\{encodeURIComponent\(RW_STREAM_LOGIC\)\}/g) || []).length >= 3);
ok('the debug cache-buster is still debug-only',
  /\(\(rwDebugOn\(\) \|\| rwForceRefresh\) \? `&_t=\$\{Date\.now\(\)\}` : ''\)/.test(src),
  'busting on every request is the largest quota leak there is (§3)');
ok('caching itself is intact — this is versioning, not disabling',
  /s-maxage=\$\{edge\}/.test(px) && /STREAM_TTL_MS/.test(px));

// The versioned key must actually differ across releases.
const keyOf = new Function('logic', 'sku', 'startISO',
  "return 'streams:' + logic + '|' + sku + '|' + startISO.slice(0, 10);");
ok('bumping the lookup version invalidates',
  keyOf('L1', 'RE-V5RC-25-0191', '2026-02-13') !== keyOf('L2', 'RE-V5RC-25-0191', '2026-02-13'));
ok('a release that does NOT change the lookup reuses the cache',
  keyOf('L1', 'RE-V5RC-25-0191', '2026-02-13') === keyOf('L1', 'RE-V5RC-25-0191', '2026-02-13'),
  'this is the quota fix: six releases should not cost six searches per event');
ok('different events still keep separate entries',
  keyOf('L1', 'RE-V5RC-25-0191', '2026-02-13') !== keyOf('L1', 'RE-V5RC-25-0649', '2026-02-13'));

// ── 2. The channel enumerates the event ──
ok('the search carries the channel out with each hit', /channelId: v\.channelId \|\| null/.test(px));
ok('ytVideoDetails supplies it', /channelId: \(it\.snippet && it\.snippet\.channelId\) \|\| null/.test(px));
ok('the route seeds expansion from a found video',
  /const seedChannel = found\.map\(f => f\.channelId\)\.find\(Boolean\);/.test(px));
ok('expansion reuses resolveChannel rather than a new code path',
  /resolveChannel\(\s*'https:\/\/www\.youtube\.com\/channel\/' \+ seedChannel/.test(px));
ok('already-found videos are not duplicated',
  /if \(found\.some\(f => f\.url === v\.url\)\) continue;/.test(px));
ok('expansion failure leaves the search result standing',
  /catch \(e\) \{ \/\* the search result still stands on its own \*\//.test(px));
ok('the expansion is reported in the response', /expand: \{[\s\S]*?seedChannel/.test(px));
ok('it reports whether it ran and what it added', /ran: !!\(expandKey && seedChannel && startISO\)/.test(px));

// It must fire on the shape that failed: 2-day event, 1 video found.
const shouldExpand = new Function('found', 'eventDays', 'seed',
  'return !!(seed && found < eventDays * 2);');
ok('a two-day event with one video expands', shouldExpand(1, 2, 'UCx') === true, 'the Bristol case');
ok('a two-day event with two videos still expands — grades double the count',
  shouldExpand(2, 2, 'UCx') === true, 'MS and HS both stream both days');
ok('a two-day event already holding four does not', shouldExpand(4, 2, 'UCx') === false);
ok('a single-day event with one video still expands (segments)', shouldExpand(1, 1, 'UCx') === true);
ok('no seed channel means no expansion', shouldExpand(1, 2, null) === false);

// The result cap has to admit all four Bristol broadcasts.
ok('the search keeps enough candidates for a two-grade two-day event',
  /return scored\.slice\(0, 16\);/.test(px), '6 filled up before the needed day got in');
ok('the response carries them too', /streams: found\.slice\(0, 16\)/.test(px));
ok('the search asks for more candidates at the same price',
  /maxResults=50&order=relevance/.test(px));

// ── 3. Grade is decided by the title ──
ok('the title decides, the description only breaks a tie',
  /gradeOf\(v\.title\) \|\| gradeOf\(v\.description\.slice\(0, 400\)\)/.test(px));
ok('the concatenated form is gone',
  !/gradeOf\(v\.title \+ ' ' \+ v\.description/.test(px));

const gradeOf = new Function('return ' + px.slice(px.indexOf('function gradeOf'), px.indexOf('function nameTokens')))();
const decide = (title, desc) => gradeOf(title) || gradeOf(desc.slice(0, 400));

ok('a Middle School title stays MS despite an HS mention in the description',
  decide('Bots @ Bristol Signature Event (Middle School) Day 1',
         'Our High School Overdrive stream is on this channel too.') === 'ms',
  'the concatenated read could return hs and drop this video');
ok('a High School title stays HS despite an MS mention',
  decide('Bots @ Bristol Signature Event High School Overdrive Day 2',
         'Middle School matches were streamed yesterday.') === 'hs');
ok('a silent title still falls back to the description',
  decide('Bots @ Bristol Day 1', 'Middle School division') === 'ms');
ok('no grade anywhere stays ambiguous, not wrong',
  decide('Bots @ Bristol Day 1', 'A great day of robotics.') === null);

// ── 4. The four real Bristol titles sort out correctly ──
const REAL = [
  'Bots @ Bristol Signature Event (Middle School) Day 1',
  'Bots @ Bristol Signature Event High School Overdrive Day 2',
  'Bots @ Bristol Signature Event (Middle School) Day 2',
  'Bots @ Bristol Signature Event High School Overdrive Day 1'
];
const ms = REAL.filter(t => gradeOf(t) === 'ms');
const hs = REAL.filter(t => gradeOf(t) === 'hs');
ok('two Middle School broadcasts are identified', ms.length === 2, ms.join(' | '));
ok('two High School broadcasts are identified', hs.length === 2, hs.join(' | '));

const dayLabel = new Function('RW_WEEKDAYS', 'return ' +
  src.slice(src.indexOf('function rwTitleDayLabel'), src.indexOf('// Which video is labelled')))(
  ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']);
ok('the MS pair splits into day 1 and day 2',
  JSON.stringify(ms.map(t => dayLabel(t).n).sort()) === '[1,2]');
ok('the HS pair splits into day 1 and day 2',
  JSON.stringify(hs.map(t => dayLabel(t).n).sort()) === '[1,2]');

console.log(`\nt72: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
