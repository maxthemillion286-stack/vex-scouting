// t75 — the anchor form must not offer another day's recording, and a missing
// day gets searched for by name.
//
// Reported: "basically every signature I click into, the 2nd day has no stream,
// and when I click add stream it automatically sets it to the stream link from
// day 1."
//
// The second half of that is a bug on its own, and it was in the form:
//
//     value="${(cal && cal.videoId) || (ctx.foundStream && ctx.foundStream.url)
//             || ctx.videoId || ''}"
//
// ctx.foundStream.url is ONE url for the whole event — the headline link, which
// is day 1's. So opening "+ ADD STREAM" on day 2 pre-filled day 1's broadcast,
// and RETRY SYNC or the paste handler then anchored day 2 against it. The form
// was inviting the exact wrong answer, and the banner above it announced a find
// this day had never been given.
//
// An empty box is the correct answer when a day has no video: it says there is
// nothing for this day, which is true. Offering another day's recording is the
// §3 failure — silently wrong times with nothing on screen to say so.
//
// The first half is discovery, and takes the suggestion made repeatedly: name
// the day in the query. Relevance ranking is mostly views, so on an event whose
// days are published under near-identical titles the popular day wins and the
// other never surfaces. "…Day 2" puts it first.
import fs from 'fs';
let pass = 0, fail = 0;
const ok = (n, c, e) => { c ? (pass++, console.log('  ok   ' + n)) : (fail++, console.log('  FAIL ' + n + (e ? '\n         ' + e : ''))); };
const idx = fs.readFileSync('../index.html', 'utf8');
const src = idx.match(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/)[1];
const px = fs.readFileSync('../api/proxy.js', 'utf8');

console.log('t75 — per-day pre-fill, and a targeted search for a missing day');

// ── 1. The form is filled from THIS day ──
ok('a per-day link is computed', /const dayLink = \(cal && cal\.videoId\)/.test(src));
ok('it comes from the day picker, not the headline link',
  /rwPickStreamForDay\(rwStreamPool, day, rwEventDayOrdinal\(day, days\.indexOf\(day\)\)\)/.test(src));
ok('it falls back to empty, never to another day',
  /rwEventDayOrdinal\(day, days\.indexOf\(day\)\)\)\s*\|\|\s*'';/.test(src));
ok('the input is filled from it', /id="rwVideoInput" value="\$\{dayLink\}"/.test(src));
ok('the headline link is gone from the input',
  !/id="rwVideoInput" value="[^"]*ctx\.foundStream/.test(src),
  'this is what put day 1 in day 2\'s box');
ok('the player only mounts when this day has a link',
  /id="rwCalPlayerWrap" style="display:\$\{dayLink \? '' : 'none'\}/.test(src));
ok('the global videoId no longer decides the player',
  !/rwCalPlayerWrap[^>]*ctx\.videoId/.test(src));

// ── 2. The banner tells the truth per day ──
ok('"found it, filled in below" requires a link for this day',
  /\$\{dayLink && ctx\.foundStream \?/.test(src),
  'it used to announce a find day 2 had not been given');
ok('a day with no video says so instead',
  /!dayLink && rwStreamPool\.length \?/.test(src));
ok('it prefers the recorded reason when there is one',
  /rwAutoSyncFail\[day\] \|\| "No broadcast was found for this day/.test(src));
ok('it explains that other days do have one',
  /The other days of this event have one/.test(src));

// The pre-fill decision, exercised.
const prefill = new Function('cal', 'picked',
  "return (cal && cal.videoId) || picked || '';");
ok('a calibrated day shows its own video', prefill({ videoId: 'CAL' }, 'PICK') === 'CAL');
ok('an uncalibrated day shows the video picked for it', prefill(null, 'PICK') === 'PICK');
ok('a day with nothing shows an empty box', prefill(null, null) === '');
ok('a day with nothing does NOT show the headline link',
  prefill(null, null) !== 'https://youtube.com/watch?v=DAY1LINK00');

// ── 3. A missing day is searched for by name ──
ok('the targeted search exists', /Day \$\{miss\.n\}/.test(px));
ok('it only runs for days with no broadcast',
  /const missing = eventDayKeys\.map\(\(k, i\) => \(\{ k, n: i \+ 1 \}\)\)\.filter\(d => !have\.has\(d\.k\)\)/.test(px));
// Cut from two to one. Each is another 100 units, and two of them made a
// multi-day lookup ~310 — the biggest line item, spent on the days the free
// channel listing had already failed to cover.
ok('it is capped at one extra search', /missing\.slice\(0, 1\)/.test(px));
ok('it never runs when the page gave links for free',
  /if \(searched && expandKey && evName && eventDayKeys\.length > 1\)/.test(px),
  '§3: a link on the page must cost zero YouTube quota — t60 counts this');
ok('it runs after the free channel listing, not before',
  px.indexOf('Expand to the whole channel') < px.indexOf('One targeted search per day still missing'));
ok('results are tagged so their origin is visible', /add\(v\.url, 'yt-day-search'\)/.test(px));
ok('duplicates are not added', /if \(found\.some\(f => f\.url === v\.url\)\) continue;[\s\S]{0,80}yt-day-search/.test(px));
ok('a failed targeted search leaves the found days standing',
  /catch \(e\) \{ \/\* the days already found still stand \*\//.test(px));

// ── 4. Day coverage is judged in the EVENT's timezone ──
ok('the offset is read off the start date', /\(\[\+-\]\)\(\\d\{2\}\):\(\\d\{2\}\)\$/.test(px));
ok('day keys are shifted by it', /new Date\(ms \+ tzOffMin \* 60000\)/.test(px));

const tzOf = new Function('startISO', `
  const m = /([+-])(\\d{2}):(\\d{2})$/.exec(startISO || '');
  if (m) return (m[1] === '-' ? -1 : 1) * (+m[2] * 60 + +m[3]);
  return 0;`);
ok('a US Eastern event reads as -300', tzOf('2026-02-13T00:00:00-05:00') === -300);
ok('a US Pacific event reads as -480', tzOf('2026-02-13T00:00:00-08:00') === -480);
ok('a UTC event reads as 0', tzOf('2026-02-13T00:00:00Z') === 0);
ok('a positive offset is handled', tzOf('2026-02-13T00:00:00+02:00') === 120);

const keyIn = new Function('ms', 'tzOffMin',
  "return new Date(ms + tzOffMin * 60000).toISOString().slice(0, 10);");
// 8pm Eastern on the 14th is 01:00Z on the 15th — reading it in UTC moves the
// broadcast to the next day, which makes a covered day look missing and buys a
// targeted search for nothing.
const eightPmEastern = Date.parse('2026-02-15T01:00:00Z');
ok('an evening Eastern broadcast counts as its own local day',
  keyIn(eightPmEastern, -300) === '2026-02-14', keyIn(eightPmEastern, -300));
ok('...where reading it in UTC would have moved it to the next day',
  keyIn(eightPmEastern, 0) === '2026-02-15');
const nineAmPacific = Date.parse('2026-02-14T17:00:00Z');
ok('a morning Pacific broadcast stays on its own day',
  keyIn(nineAmPacific, -480) === '2026-02-14');

// ── 5. The response says which days ended up covered ──
ok('the expand block lists the event days', /eventDayKeys,/.test(px));
ok('and which of them have a broadcast', /coveredDays: \[\.\.\.coveredDays\(\)\]/.test(px));
ok('and how many targeted searches were bought', /targetedSearches: targeted/.test(px));

console.log(`\nt75: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
