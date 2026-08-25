// t67 — the `siblings:` route: the other days of a multi-day event.
//
// Organisers stream one broadcast PER DAY but publish only one of them in the
// event description — in practice the last. Everything upstream of this route
// then had exactly one video for an event that needed several, so day 1 was
// anchored against day 2's recording: negative offset, auto-sync refuses, no
// match jumpable. Observed as "Day 2 for both days" on a two-day signature.
//
// The fix uses the cheapest lead available: the known video's channel. The
// snippet that names it rides along on a details call we already pay for, and
// resolveChannel() then lists the channel's broadcasts inside the event's date
// window with the §3 grade veto applied. 2-3 units against the 101 a name
// search costs, and more trustworthy — the channel is confirmed, not inferred
// from a title.
import fs from 'fs';
let pass = 0, fail = 0;
const ok = (n, c, e) => { c ? (pass++, console.log('  ok   ' + n)) : (fail++, console.log('  FAIL ' + n + (e ? '\n         ' + e : ''))); };
const px = fs.readFileSync('../api/proxy.js', 'utf8');
const idx = fs.readFileSync('../index.html', 'utf8');
const src = idx.match(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/)[1];

console.log('t67 — siblings: the other days of a multi-day event');

// ── 1. The channel id is captured, not re-fetched ──
ok('ytVideoDetails keeps channelId from the snippet it already pays for',
  /channelId: \(it\.snippet && it\.snippet\.channelId\) \|\| null/.test(px));
ok('it still requests the snippet part',
  /videos\?part=snippet,liveStreamingDetails,contentDetails/.test(px));

// ── 2. The route exists and validates its input ──
const route = px.slice(px.indexOf("} else if (path.startsWith('siblings:')) {"),
                       px.indexOf('// Main authenticated v2 API'));
ok('the route is dispatched', route.length > 200);
ok('it refuses without a key', /reason: 'no-key'/.test(route));
ok('it validates the video id', /\^\[A-Za-z0-9_-\]\{11\}\$/.test(route));
ok('it refuses without dates — the window is what separates the days',
  /reason: 'no-dates'/.test(route));
ok('an unresolvable channel is reported, not guessed at',
  /reason: 'no-channel'/.test(route));
ok('every failure path still returns a streams array',
  (route.match(/streams: \[\]/g) || []).length >= 4, 'a bare failure would throw in the client');

// ── 3. It reuses resolveChannel rather than a second code path ──
ok('it resolves via the existing channel path',
  /resolveChannel\(\s*'https:\/\/www\.youtube\.com\/channel\/' \+ channelId/.test(route));
ok('resolveChannel still parses a /channel/UC… url',
  /\\\/channel\\\/\(UC\[\\w-\]\+\)/.test(px));
ok('results are tagged so the client can label them',
  /source: 'yt-siblings'/.test(route));

// ── 4. Caching, per §3 — quota is the whole reason this route exists ──
ok('a finished event is cached hard', /eventOver \? NEG_TTL_PAST_MS : NEG_TTL_MS/.test(route));
ok('a hit uses the full stream TTL', /out\.ok \? STREAM_TTL_MS/.test(route));
ok('the CDN is told too', /s-maxage=\$\{edge\}/.test(route));
ok('the cache-buster stays behind debug', !/&_t=\$\{Date\.now\(\)\}(?!.*rwDebugOn)/.test(route));

// ── 5. The client only asks when it actually needs to ──
const call = src.slice(src.indexOf('// Still short of one video per day?'),
                       src.indexOf('return webcastRaw ?'));
ok('the client calls the route', /siblings:' \+ ytId/.test(call));
ok('only for multi-day events', /dayCount > 1/.test(call));
ok('only when the pool cannot already cover every day',
  /rwStreamPool\.length < dayCount/.test(call));
ok('only with a real YouTube id', /\^\[A-Za-z0-9_-\]\{11\}\$/.test(call));
ok('the cache-buster is debug-only here too',
  /rwDebugOn\(\) \? `&_t=\$\{Date\.now\(\)\}` : ''/.test(call));

const needSibs = new Function('dayCount', 'poolLen', 'ytId',
  "return !!(dayCount > 1 && poolLen < dayCount && ytId);");
ok('two days, one video → asks', needSibs(2, 1, 'oGL8pNZ5dlo') === true);
ok('two days, both videos already → does not ask', needSibs(2, 2, 'oGL8pNZ5dlo') === false);
ok('single day → never asks', needSibs(1, 0, 'oGL8pNZ5dlo') === false);
ok('no video to go on → cannot ask', needSibs(2, 0, '') === false);
ok('a four-day Worlds with two videos → asks', needSibs(4, 2, 'oGL8pNZ5dlo') === true);

// ── 6. A better pool replaces the one that could not cover the event ──
ok('the channel listing supersedes a short pool',
  /if \(sibs\.length > rwStreamPool\.length\)/.test(call));
ok('the miss reason is cleared once days are found',
  /rwStreamReason = null;/.test(call));
ok('the known video is preferred as the headline when present',
  /sibs\.find\(x => x\.url === webcastRaw\) \|\| sibs\[0\]/.test(call));

// ── 7. Labels must name the real source ──
// 'yt-search' used to fall through to "(from the event description)", which
// actively misdirects anyone reading the panel to debug a miss.
ok('a name-search hit says so', /'yt-search': ' \(found on YouTube by event name\)'/.test(src));
ok('a channel sibling says so', /'yt-siblings': " \(from the event's YouTube channel\)"/.test(src));

console.log(`\nt67: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
