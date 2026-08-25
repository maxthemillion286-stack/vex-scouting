// t70 — the channel listing must reach back to the event, and the lookup that
// does it must be visible in the debug report.
//
// From a production capture of Bots @ Bristol (RE-V5RC-25-0191), a two-day
// event in February read in August:
//
//   "streams": [ { "title": "...Day 2", "source": "yt-search" } ]
//   "channels": []
//   (no siblings block at all)
//
// Two separate defects behind that.
//
// 1. resolveChannel read ONE page of 50 uploads and stopped. The uploads
//    playlist is newest-first, so a club posting a couple of videos a week has
//    pushed a February event off that page long before August. The broadcast
//    existed and the channel was right; the lookup still came back empty, and
//    it read as "no stream published". This breaks every PAST event on an
//    active channel, which is the general case — not one bad event.
//
// 2. vsDebugReport() whitelists the keys it renders, so vsDebug.siblings was
//    never shown. The one capture that would have said whether the channel
//    lookup ran could not say it. A diagnostic nobody can read is not a
//    diagnostic (HANDOFF §9).
import fs from 'fs';
let pass = 0, fail = 0;
const ok = (n, c, e) => { c ? (pass++, console.log('  ok   ' + n)) : (fail++, console.log('  FAIL ' + n + (e ? '\n         ' + e : ''))); };
const px = fs.readFileSync('../api/proxy.js', 'utf8');
const idx = fs.readFileSync('../index.html', 'utf8');
const src = idx.match(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/)[1];
const rc = px.slice(px.indexOf('async function resolveChannel'), px.indexOf('// Grade level is NOT a scoring word'));

console.log('t70 — channel listing reaches back, and says so');

// ── 1. Pagination ──
ok('resolveChannel was found', rc.length > 400);
ok('the uploads playlist is paged, not read once', /pageToken/.test(rc), 'still a single page');
ok('the page token is carried into the next request',
  /pageToken \? '&pageToken=' \+ encodeURIComponent\(pageToken\)/.test(rc));
ok('the next token is read from the response', /j && j\.nextPageToken/.test(rc));
ok('paging is bounded', /page < 6/.test(rc), 'an unbounded walk on a daily uploader is a quota hole');
ok('it stops once a page predates the window', /Math\.min\(\.\.\.times\) < windowLo/.test(rc));
ok('it stops when the playlist runs out', /if \(!pageToken\) break;/.test(rc));
ok('an empty page ends the walk', /if \(!batch\.length\) break;/.test(rc));
ok('the window floor is computed once and reused',
  /const windowLo = startMs - 60 \* 86400e3;/.test(rc) && (rc.match(/windowLo/g) || []).length >= 3);
ok('the details call is still batched to one unit', /ytVideoDetails\(ids, ytKey\)/.test(rc));
ok('candidates are still capped before the details call', /\.slice\(0, 50\)/.test(rc));

// The stop condition, exercised rather than only read.
const stop = new Function('oldestOnPage', 'windowLo', 'return oldestOnPage < windowLo;');
const feb = Date.parse('2026-02-13T05:00:00Z');
const windowLo = feb - 60 * 86400e3;   // mid-December 2025
ok('a page of August uploads does not stop the walk',
  stop(Date.parse('2026-08-01T00:00:00Z'), windowLo) === false, 'would abandon the search too early');
ok('a page reaching March keeps going',
  stop(Date.parse('2026-03-01T00:00:00Z'), windowLo) === false);
ok('a page reaching November 2025 stops it',
  stop(Date.parse('2025-11-01T00:00:00Z'), windowLo) === true);

// Six pages must actually be enough to cross a busy channel's six months.
const perWeek = 3, weeks = 26;
ok('six pages span a channel posting three a week for six months',
  6 * 50 > perWeek * weeks, `${6 * 50} slots vs ${perWeek * weeks} uploads`);

// ── 2. The lookup is visible in the report ──
const report = src.slice(src.indexOf('function vsDebugReport'), src.indexOf('const rwDebugOn ='));
ok('the report renders the siblings lookup', /siblings: vsDebug\.siblings/.test(report),
  'without this a multi-day failure cannot be diagnosed from a capture');
ok('the jumper block is still rendered', /jumper: vsDebug\.jumper/.test(report));
ok('recent errors are still rendered', /recentErrors: vsDebug\.errors/.test(report));
ok('the client still records the siblings response', /vsDebug\.siblings = \{/.test(src));
ok('it records the http status and body', /http: sr\.status, body: sj/.test(src));

console.log(`\nt70: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
