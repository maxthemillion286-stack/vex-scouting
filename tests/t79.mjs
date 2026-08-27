// t79 — running out of quota must not read as "nothing matches".
//
// Reported: "states no longer auto find, and neither does most events". States
// worked before. Many events failing at once, having previously worked, is not
// a per-event scoring problem — it is something global, and the only global
// resource here is the YouTube allowance.
//
// ytGet was:
//
//     return r.ok ? await r.json() : null;
//
// So a 403 quotaExceeded came back indistinguishable from a search that
// legitimately matched nothing, and the route went on to report "nothing on
// YouTube matches its name and dates closely enough to trust". That sentence
// describes a judgement about the event. Exhausting the quota is not a
// judgement — nothing was searched. The §11 shape again, and the most
// expensive instance of it, because every event fails at once.
//
// The arithmetic that got us there, all of it self-inflicted:
//
//   name search            101 units
//   channel listing        ~9
//   targeted day searches  up to 202   (v30, two of them)
//   ------------------------------
//   per multi-day event    ~310, against 10,000/day — about 32 events
//
// ...and v27 keyed the cache on PROXY_BUILD, so every one of six releases in
// an afternoon re-billed every event being tested.
import fs from 'fs';
let pass = 0, fail = 0;
const ok = (n, c, e) => { c ? (pass++, console.log('  ok   ' + n)) : (fail++, console.log('  FAIL ' + n + (e ? '\n         ' + e : ''))); };
const px = fs.readFileSync('../api/proxy.js', 'utf8');
const idx = fs.readFileSync('../index.html', 'utf8');
const src = idx.match(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/)[1];

console.log('t79 — quota exhaustion is reported, not disguised');

// ── 1. The failure is captured rather than flattened to null ──
const yt = px.slice(px.indexOf('let ytLastError = null;'), px.indexOf('// Details for up to 50 videos'));
ok('the old flattening return is gone',
  !/return r\.ok \? await r\.json\(\) : null;/.test(px),
  'a 403 and an empty result must not look the same');
ok('a failure records its status', /ytLastError = \{ status: r\.status, reason \}/.test(yt));
ok('the API\'s own reason is preferred', /if \(first && first\.reason\) reason = first\.reason;/.test(yt));
ok('a thrown request is recorded too', /ytLastError = \{ status: 0, reason:/.test(yt));
ok('a body that will not parse does not break the handler', /catch \(e2\) \{\}/.test(yt));

// ── 2. Quota is recognised by name ──
const outOf = new Function('r', "return /quota|dailyLimit|rateLimit|userRateLimit/i.test(r || '');");
ok('quotaExceeded is recognised', outOf('quotaExceeded') === true);
ok('dailyLimitExceeded is recognised', outOf('dailyLimitExceeded') === true);
ok('rateLimitExceeded is recognised', outOf('rateLimitExceeded') === true);
ok('userRateLimitExceeded is recognised', outOf('userRateLimitExceeded') === true);
ok('a genuine key problem is NOT read as quota', outOf('keyInvalid') === false);
ok('a forbidden video is not read as quota', outOf('forbidden') === false);
ok('a plain http failure is not read as quota', outOf('http-500') === false);

// ── 3. It outranks every other explanation ──
ok('the route reports it', /'yt-quota-exhausted'/.test(px));
ok('it is checked before the no-match reasons',
  px.indexOf("ytOutOfQuota() ? 'yt-quota-exhausted'") < px.indexOf("'no-link-and-no-yt-match'"),
  'nothing was searched, so no judgement about the event applies');
ok('the raw error travels with the response', /ytError: ytLastError \|\| undefined/.test(px));

// ── 4. A quota miss is NEVER cached ──
// A miss is cached for a day on the reasoning that a finished event cannot
// gain a stream. That holds for a real miss and is exactly wrong here: the
// event may well have a stream, we just could not look. Caching it would keep
// every event visited while exhausted broken for 24h AFTER the quota resets —
// one bad afternoon becoming a permanent-looking outage.
ok('a quota miss short-circuits before the cache write',
  px.indexOf('if (!found.length && ytOutOfQuota())') < px.indexOf('cache.set(cacheKey'));
ok('and tells the CDN not to keep it', /res\.setHeader\('Cache-Control', 'no-store'\)/.test(px));
ok('a real miss is still cached', /cache\.set\(cacheKey, \{ data: out, status: 200/.test(px));

// ── 5. Deploys stop re-billing every event ──
ok('the cache key uses the lookup version, not the release',
  /const cacheKey = 'streams:' \+ logic \+/.test(px));
ok('the client sends a deliberate lookup version', /const RW_STREAM_LOGIC = 'L\d+';/.test(src));
ok('the release number is no longer the cache key',
  !/&b=\$\{encodeURIComponent\(APP_BUILD\)\}/.test(src));

// ── 6. The biggest optional cost is halved ──
ok('one targeted search, not two', /missing\.slice\(0, 1\)/.test(px));
const cost = (searches) => 101 + 9 + searches * 101;
ok('a multi-day lookup was about 310 units', cost(2) === 312, String(cost(2)));
ok('it is now about 210', cost(1) === 211, String(cost(1)));
ok('that is a third more events per day before exhaustion',
  Math.floor(10000 / cost(1)) - Math.floor(10000 / cost(2)) >= 15,
  `${Math.floor(10000 / cost(2))} -> ${Math.floor(10000 / cost(1))} events`);

// ── 7. The user is told, in both places a reason is shown ──
ok('the day-list status line explains quota', /YouTube's daily search quota is used up/.test(src));
ok('the anchor form explains it too',
  (src.match(/daily search quota is used up/g) || []).length >= 2);
ok('it says the failure is not about the event',
  /this isn't a judgement about the event/.test(src));
ok('it says when it comes back', /resets at midnight Pacific/.test(src));
ok('it offers the thing that still works', /Paste the link by hand below and it still syncs itself/.test(src));

console.log(`\nt79: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
