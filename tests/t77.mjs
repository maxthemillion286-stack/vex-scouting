// t77 — a stream that starts a few minutes into the first match.
//
// The last step of the Bristol day-2 failure, settled by a ?debug=1 capture at
// v32 that showed the pick was already right:
//
//   { "day": "2026-02-14", "ordinal": 1, "wantsDayLabel": 2,
//     "picked": "…oGL8pNZSdlo",           <- the Day 2 video. Correct.
//     "syncFail": "These matches happened before this stream started" }
//
// Discovery worked, the channel expansion worked, the day assignment worked.
// Auto-sync then refused the day because its FIRST match began slightly before
// the broadcast did — the organiser started recording once play was already
// under way. Every row read "no stream for this day" while the right video sat
// in the box.
//
// §4 has always described the intended behaviour for the multi-segment case:
// "A match up to 15 minutes before the first segment still opens it at 0:00 —
// organisers often start recording a minute into the first match." That grace
// was never applied in rwTryAutoSync, which hard-failed on any negative offset.
// The two now share RW_PRESTART_GRACE_SEC so they cannot disagree again.
//
// Real numbers from the capture:
//   Day 1 video  PGNXu4ksV4k  starts 2026-02-13T21:09:03Z  6501s  (1h48m)
//   Day 2 video  oGL8pNZSdlo  starts 2026-02-14T13:04:23Z 35066s  (9h44m)
import fs from 'fs';
let pass = 0, fail = 0;
const ok = (n, c, e) => { c ? (pass++, console.log('  ok   ' + n)) : (fail++, console.log('  FAIL ' + n + (e ? '\n         ' + e : ''))); };
const idx = fs.readFileSync('../index.html', 'utf8');
const src = idx.match(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/)[1];
const grab = re => (src.match(re) || [''])[0];

console.log('t77 — a stream that starts after the first match has begun');

// ── 1. One constant, shared ──
ok('the grace is defined once', /const RW_PRESTART_GRACE_SEC = 15 \* 60;/.test(src));
ok('the segment picker uses it', /t >= segs\[0\]\.startMs - RW_PRESTART_GRACE_SEC \* 1000/.test(src));
ok('the segment picker no longer carries its own literal',
  !/segs\[0\]\.startMs - 15 \* 60 \* 1000/.test(src), 'two literals is how they drifted apart');
const sync = src.slice(src.indexOf('async function rwTryAutoSync'), src.indexOf('function rewatchCalibrate'));
ok('auto-sync uses the same constant', /secs >= -RW_PRESTART_GRACE_SEC/.test(sync));

// ── 2. The decision, exercised on the real numbers ──
const GRACE = 15 * 60;
const decide = new Function('secs', 'hasInside', `
  const RW_PRESTART_GRACE_SEC = ${GRACE};
  if (secs < 0) {
    if (secs >= -RW_PRESTART_GRACE_SEC) return 'clamp';
    return hasInside ? 'reanchor' : 'refuse';
  }
  return 'ok';`);

const day2Start = Date.parse('2026-02-14T13:04:23Z');
const secsFor = matchIso => Math.round((Date.parse(matchIso) - day2Start) / 1000);

// The first qualification match a few minutes before the broadcast — the case
// that took the whole day down.
ok('a match 4 minutes early is absorbed',
  decide(secsFor('2026-02-14T13:00:00Z'), true) === 'clamp', String(secsFor('2026-02-14T13:00:00Z')));
ok('a match 1 minute early is absorbed', decide(secsFor('2026-02-14T13:03:23Z'), true) === 'clamp');
ok('a match exactly on the start is fine', decide(0, true) === 'ok');
ok('a match 14 minutes early is still absorbed', decide(-14 * 60, true) === 'clamp');
ok('15 minutes exactly is the boundary, and inclusive', decide(-GRACE, true) === 'clamp');

// Beyond the grace: re-anchor rather than refuse, so long as something is inside.
ok('an hour early re-anchors instead of failing', decide(-3600, true) === 'reanchor');
ok('a day-2 match against the day-1 stream still refuses when nothing is inside',
  decide(-3600, false) === 'refuse');

// The genuinely wrong video: day 2's matches against day 1's stream. Day 1 ran
// 21:09:03Z for 1h48m, so a Saturday-morning match is ~16h past its end.
const day1Start = Date.parse('2026-02-13T21:09:03Z');
const wrongVideoSecs = Math.round((Date.parse('2026-02-14T13:04:23Z') - day1Start) / 1000);
ok('day 2 against the day 1 stream is a positive but absurd offset',
  wrongVideoSecs > 0 && wrongVideoSecs > 6501, String(wrongVideoSecs));
const beyond = new Function('secs', 'dur', 'return !!(dur && secs > dur + 3600);');
ok('...and the past-the-end check is what rejects that one',
  beyond(wrongVideoSecs, 6501) === true, 'the two checks cover opposite ends');
ok('the correct pairing is accepted', beyond(secsFor('2026-02-14T15:00:00Z'), 35066) === false);

// ── 3. Re-anchoring keeps the arithmetic honest ──
// The offset is linear, so anchoring on a later match gives the same mapping —
// and the earlier ones then compute negative and say "not in the stream" per
// §4, instead of taking the day down with them.
const off = (matchIso, anchorIso, anchorSec) =>
  Math.round((Date.parse(matchIso) - Date.parse(anchorIso)) / 1000) + anchorSec;
ok('a later match maps the same however we anchored',
  off('2026-02-14T15:00:00Z', '2026-02-14T13:04:23Z', 0) ===
  off('2026-02-14T15:00:00Z', '2026-02-14T14:00:00Z', 3337));
ok('a match before the recording computes negative, as §4 intends',
  off('2026-02-14T12:50:00Z', '2026-02-14T13:04:23Z', 0) < 0);

// ── 4. Failure only when nothing on the day is inside ──
ok('the refusal names the real condition',
  /Every match on this day happened before this stream started/.test(sync));
ok('the old blanket refusal is gone',
  !/return fail\("These matches happened before this stream started/.test(sync),
  'it took whole days down over a few minutes');
ok('re-anchoring searches every division',
  /\(ctx\.allMatches && ctx\.allMatches\.length\) \? ctx\.allMatches : ctx\.matches/.test(sync));
ok('the re-anchored offset is recomputed, not reused',
  /anchor = inStream\[0\];\s*\n\s*secs = Math\.round\(\(anchor\.t - startMs\) \/ 1000\);/.test(sync));

console.log(`\nt77: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
