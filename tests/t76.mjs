// t76 — VEX TV is BoxCast, and the day assignment is finally legible.
//
// A broadcast object captured off vexworlds.tv settles what the platform is:
//
//   { "id": "efkb0bx8283bgyqvm396",
//     "name": "Qualification Matches (Science)",
//     "starts_at": "2026-04-24T13:15:00Z",
//     "stops_at":  "2026-04-24T20:34:00Z",
//     "description": "V5RC (HS)",
//     "channel_id": "qualification-matches-science-pjiswvniyktygr4misw0",
//     "account_id": "jm81brqcwqhlenmnd1ub",
//     "preview": "https://recordings.boxcast.com/…" }
//
// starts_at is the field that decides everything: the real broadcast start, in
// UTC, which is the role actualStartTime plays for YouTube. stops_at gives a
// duration and `description` carries the grade. So VEX TV CAN sync itself —
// what it still cannot do is embed, because the media is HLS behind CloudFront
// signed URLs issued per viewer.
//
// The second half of this file is about a different failure. Five rounds of
// "day 2 shows day 1" could not be settled from a debug capture, because the
// capture showed what the PROXY returned and nothing about what the client did
// with it — and the bug was client-side every time. vsDayAssignment() puts
// every input to that decision in the report.
import fs from 'fs';
let pass = 0, fail = 0;
const ok = (n, c, e) => { c ? (pass++, console.log('  ok   ' + n)) : (fail++, console.log('  FAIL ' + n + (e ? '\n         ' + e : ''))); };
const px = fs.readFileSync('../api/proxy.js', 'utf8');
const idx = fs.readFileSync('../index.html', 'utf8');
const src = idx.match(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/)[1];
const route = px.slice(px.indexOf("path.startsWith('boxcast:')"), px.indexOf("path.startsWith('siblings:')"));

console.log('t76 — BoxCast broadcasts, and a legible day assignment');

// ── 1. The route exists and is guarded ──
ok('the boxcast route is dispatched', route.length > 400);
ok('the channel id is sanitised', /replace\(\/\[\^\\w-\]\/g, ''\)/.test(route));
ok('an empty channel is refused', /reason: 'bad-channel'/.test(route));
// Two failure paths, and only two: a bad channel id, and nothing found. There
// is no no-key case — BoxCast's list endpoint needs no credential, which is
// also why this route costs no YouTube quota at all.
ok('a bad channel returns an empty array, not a bare error',
  /reason: 'bad-channel', broadcasts: \[\]/.test(route));
ok('finding nothing returns an empty array too',
  /reason: 'no-broadcasts', tried, broadcasts: \[\]/.test(route));
ok('there are no other failure exits to leak through',
  (route.match(/broadcasts: \[\]/g) || []).length === 2,
  'a failure without the array would throw in the client');
ok('no API key is consulted, so this spends no quota',
  !/YOUTUBE_API_KEY/.test(route));

// ── 2. Every candidate URL is recorded, because the query shape is unobserved ──
ok('candidate urls are tried in turn', /for \(const u of \[/.test(route));
ok('each attempt is recorded with its status', /tried\.push\(`\$\{u\.replace\(rest, ''\)\} -> \$\{r\.status\}`\)/.test(route));
ok('a thrown attempt is recorded too', /tried\.push\(`\$\{u\.replace\(rest, ''\)\} -> \$\{String\(e/.test(route));
ok('tried is returned on failure', /reason: 'no-broadcasts', tried/.test(route));
ok('tried is returned on success too', /build: PROXY_BUILD, tried, broadcasts: out/.test(route));
ok('requests are time-limited', /AbortSignal\.timeout\(9000\)/.test(route));

// ── 3. The broadcast is mapped onto the shape the client already consumes ──
ok('starts_at becomes actualStartTime', /actualStartTime: b\.starts_at \|\| null/.test(route),
  'this is what makes VEX TV auto-syncable at all');
ok('starts_at also fills publishedAt, which the day picker reads',
  /publishedAt: b\.starts_at \|\| null/.test(route));
ok('the duration comes from stops_at minus starts_at',
  /Date\.parse\(b\.stops_at\) - Date\.parse\(b\.starts_at\)/.test(route));
ok('the grade veto reads name and description', /gradeOf\(`\$\{b\.name \|\| ''\} \$\{b\.description \|\| ''\}`\)/.test(route));
ok('broadcasts come back oldest first, so day 1 leads',
  /sort\(\(a, b\) => Date\.parse\(a\.actualStartTime \|\| 0\) - Date\.parse\(b\.actualStartTime \|\| 0\)\)/.test(route));
ok('the date window is applied around the event', /36 \* 3600e3/.test(route));
ok('no window given means nothing is discarded', /if \(isNaN\(t\) \|\| isNaN\(sMs\)\) return true;/.test(route));

// Exercise the mapping on the real captured object.
const REAL = {
  id: 'efkb0bx8283bgyqvm396',
  name: 'Qualification Matches (Science)',
  starts_at: '2026-04-24T13:15:00Z',
  stops_at: '2026-04-24T20:34:00Z',
  description: 'V5RC (HS)',
  channel_id: 'qualification-matches-science-pjiswvniyktygr4misw0'
};
const gradeOf = new Function('return ' + px.slice(px.indexOf('function gradeOf'), px.indexOf('function nameTokens')))();
const map = b => ({
  title: [b.name, b.description].filter(Boolean).join(' — '),
  actualStartTime: b.starts_at || null,
  durationSec: (b.starts_at && b.stops_at)
    ? Math.max(0, Math.round((Date.parse(b.stops_at) - Date.parse(b.starts_at)) / 1000)) : null,
  grade: gradeOf(`${b.name || ''} ${b.description || ''}`)
});
const m = map(REAL);
ok('the real broadcast yields a start time', m.actualStartTime === '2026-04-24T13:15:00Z');
ok('its duration is 7h19m', m.durationSec === 26340, String(m.durationSec));
ok('its grade is read as high school from "V5RC (HS)"', m.grade === 'hs', String(m.grade));
ok('the title carries the division', /Qualification Matches \(Science\)/.test(m.title));
ok('a broadcast with no stop time still has a start',
  map({ ...REAL, stops_at: null }).actualStartTime === '2026-04-24T13:15:00Z');
ok('...and reports no duration rather than a wrong one',
  map({ ...REAL, stops_at: null }).durationSec === null);

// ── 4. It is network-only in the service worker ──
const sw = fs.readFileSync('../sw.js', 'utf8');
ok('boxcast bypasses the SW cache', /path=\(\?:[a-z|]*boxcast/.test(sw));

// ── 5. The day assignment is in the debug report ──
ok('the report includes it', /dayAssignment: vsDayAssignment\(\)/.test(src));
const fn = src.slice(src.indexOf('function vsDayAssignment'), src.indexOf('function vsDebugReport'));
ok('it reports the event day list', /eventDays: rwEventDays/.test(fn),
  'if this holds only the team\'s days, the ordinals are wrong — that is the bug');
ok('it reports the team days separately', /teamDays: days/.test(fn));
ok('it reports the start day it fell back to', /eventStartDay: rwEventStartDay/.test(fn));
ok('it lists the pool with titles and labels', /label: typeof rwTitleDayLabel === 'function'/.test(fn));
ok('it shows each pool entry\'s local broadcast day', /startedLocalDay:/.test(fn));
ok('per day it shows the ordinal', /ordinal: rwEventDayOrdinal\(d, i\)/.test(fn));
ok('per day it shows which label was wanted', /wantsDayLabel: rwEventDayOrdinal\(d, i\) \+ 1/.test(fn));
ok('per day it shows the url actually picked', /picked: rwPickStreamForDay\(rwStreamPool, d, rwEventDayOrdinal\(d, i\)\)/.test(fn));
ok('per day it shows any recorded sync failure', /syncFail: rwAutoSyncFail\[d\] \|\| null/.test(fn));
ok('it cannot throw the whole report away', /catch \(e\) \{ return \{ error:/.test(fn));

console.log(`\nt76: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
