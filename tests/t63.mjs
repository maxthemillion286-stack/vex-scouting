// t63 — a day streamed in several parts.
//
// The real failure: six broadcasts covered one event day, the "one video per
// day" model picked the first, the day's first match predated it, the offset
// came out negative, and auto-sync failed silently.
import fs from 'fs';
let pass=0, fail=0;
const ok=(n,c,e)=>{c?(pass++,console.log('  ok   '+n)):(fail++,console.log('  FAIL '+n+(e?'\n         '+e:'')));};
const idx = fs.readFileSync('../index.html','utf8');
const src = idx.match(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/)[1];
const grab = re => src.match(re)[0];

const env = new Function(
  // Shared with rwTryAutoSync, so the segment picker and auto-sync cannot
  // disagree about how early a match may start. Pulled from source rather than
  // restated, so a change to it is exercised here too.
  grab(/const RW_PRESTART_GRACE_SEC = [^;]+;/) + '\n' +
  grab(/function rwDayKey\(ms\)[\s\S]*?\n\}/) + '\n' +
  grab(/function rwPickSegment\(segments, t\)[\s\S]*?\n\}/) + '\n' +
  grab(/function rwCalForMatch\(m, calByDay\)[\s\S]*?\n\}/) + '\n' +
  grab(/function rwOffsetFor\(m, calByDay\)[\s\S]*?\n\}/) + '\n' +
  'return { rwPickSegment, rwCalForMatch, rwOffsetFor, rwDayKey };')();

console.log('t63 — multi-segment days');

// The real broadcast times from the reported event (UTC).
const T = iso => Date.parse(iso);
const segs = [
  { videoId:'jOOpzS2eePk', platform:'youtube', startMs:T('2025-09-13T17:17:14Z'), durationSec:3600 },
  { videoId:'VmTAa3iUiV8', platform:'youtube', startMs:T('2025-09-13T20:31:49Z'), durationSec:3600 },
  { videoId:'HJBPJb0UZ5M', platform:'youtube', startMs:T('2025-09-13T22:07:53Z'), durationSec:1200 },
  { videoId:'4hMUv-wtDNE', platform:'youtube', startMs:T('2025-09-13T22:34:39Z'), durationSec:100 },
  { videoId:'c0NVtyWH39c', platform:'youtube', startMs:T('2025-09-13T22:36:45Z'), durationSec:100 },
  { videoId:'EQjS11H2nAw', platform:'youtube', startMs:T('2025-09-13T22:38:49Z'), durationSec:3600 }
];

ok('a match inside the first segment picks it',
   env.rwPickSegment(segs, T('2025-09-13T17:45:00Z')).videoId === 'jOOpzS2eePk');
ok('a match hours later picks a LATER segment, not the first',
   env.rwPickSegment(segs, T('2025-09-13T20:45:00Z')).videoId === 'VmTAa3iUiV8');
ok('a match in the final segment picks it',
   env.rwPickSegment(segs, T('2025-09-13T23:30:00Z')).videoId === 'EQjS11H2nAw');
ok('a match in a GAP falls back to the segment that had begun',
   env.rwPickSegment(segs, T('2025-09-13T19:30:00Z')).videoId === 'jOOpzS2eePk');
ok('a match well before every segment yields nothing',
   env.rwPickSegment(segs, T('2025-09-13T15:00:00Z')) === null);
ok('a match a few minutes before the first segment still opens it',
   (env.rwPickSegment(segs, T('2025-09-13T17:10:00Z')) || {}).videoId === 'jOOpzS2eePk');
ok('...but half an hour before does not',
   env.rwPickSegment(segs, T('2025-09-13T16:40:00Z')) === null);

// ── the offset, end to end ───────────────────────────────────────────────
const day = env.rwDayKey(T('2025-09-13T20:45:00Z'));
const calAll = { [day]: { videoId:'jOOpzS2eePk', platform:'youtube', day, auto:true, segments:segs,
  anchors:[{matchId:'seg',name:'segment start',matchMs:segs[0].startMs,videoSec:0}] } };

{
  const m = { id: 1, t: T('2025-09-13T20:45:00Z') };
  const cal = env.rwCalForMatch(m, calAll);
  ok('the resolved calibration points at the right video', cal.videoId === 'VmTAa3iUiV8', cal.videoId);
  const off = env.rwOffsetFor(m, calAll);
  // 20:45:00 - 20:31:49 = 13m11s = 791s
  ok('the offset is measured from THAT segment, not the first', off === 791, String(off));
}
{
  // The exact bug: with one video for the whole day this went negative and
  // auto-sync bailed out, leaving the user to press ADD STREAM.
  const m = { id: 2, t: T('2025-09-13T17:20:00Z') };
  const off = env.rwOffsetFor(m, calAll);
  ok('an early match now gets a small positive offset, not a failure',
     off === 166, String(off));
}
{
  const m = { id: 3, t: T('2025-09-13T22:40:00Z') };
  const cal = env.rwCalForMatch(m, calAll);
  ok('a late match opens the last segment', cal.videoId === 'EQjS11H2nAw', cal.videoId);
  ok('with an offset near its start', env.rwOffsetFor(m, calAll) === 71, String(env.rwOffsetFor(m, calAll)));
}
{
  const m = { id: 4, t: T('2025-09-13T15:00:00Z') };
  ok('a match filmed by nobody reports no offset rather than 0:00',
     env.rwOffsetFor(m, calAll) === null, String(env.rwOffsetFor(m, calAll)));
}

// ── a single-video day must behave exactly as before ─────────────────────
{
  const d2 = env.rwDayKey(T('2025-11-24T15:00:00Z'));
  const single = { [d2]: { videoId:'oneVideo123', platform:'youtube', day:d2,
    anchors:[{ matchId:1, name:'Q1', matchMs:T('2025-11-24T15:00:00Z'), videoSec:300 }] } };
  const m = { id:5, t:T('2025-11-24T15:10:00Z') };
  ok('single-video days still use their anchor', env.rwOffsetFor(m, single) === 900,
     String(env.rwOffsetFor(m, single)));
}

// ── the builder and the UI ───────────────────────────────────────────────
ok('segments are built from the found videos', /function rwSegmentsForDay\(pool, day\)/.test(src));
ok('a multi-segment day is written straight to the calibration', /segments: segs,/.test(src));
ok('the UI says how many parts there are', /stream segments/.test(src));
ok('an unfilmed match says so instead of "no stream for this day"',
   /not in the stream/.test(src));

// ── the whole point: matches must become jumpable ────────────────────────
{
  // Every match across the real event day, as the render loop would see them.
  const times = ['17:20','18:05','19:30','20:45','21:10','22:15','22:40','23:30']
    .map(hm => T(`2025-09-13T${hm}:00Z`));
  const jumpable = times.filter(t => env.rwOffsetFor({ id:'x', t }, calAll) !== null);
  ok('every match during the broadcast day is jumpable',
     jumpable.length === times.length, `${jumpable.length}/${times.length}`);
  const vids = new Set(times.map(t => env.rwCalForMatch({ id:'x', t }, calAll).videoId));
  ok('and they are spread across several segments, not all the first',
     vids.size >= 3, [...vids].join(','));
}

console.log(`\nt63: ${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
