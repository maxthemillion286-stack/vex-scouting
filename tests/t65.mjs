// t65 — auto-find must report itself, and auto-sync must run per day.
//
// Two silent failures, both of which looked from the outside like "auto-find
// is broken" when auto-find had in fact worked:
//
//   1. The apply/auto-sync block was gated on `anyCal` — the first calibration
//      on ANY day. One published day therefore switched auto-sync off for every
//      other day of the event: auto-find ran, spent its quota, and the result
//      was dropped. ctx.foundStream was never set, so nothing said so.
//   2. The "Found this event's stream automatically" notice rendered ONLY
//      inside the anchor form, which opens on "+ ADD STREAM". A found-but-
//      unsynced day therefore showed nothing at all until that button was
//      pressed, and quiet auto-sync failures discarded their reason entirely.
//
// See HANDOFF.md §11: if something can fail, make it say so.
import fs from 'fs';
let pass = 0, fail = 0;
const ok = (n, c, e) => { c ? (pass++, console.log('  ok   ' + n)) : (fail++, console.log('  FAIL ' + n + (e ? '\n         ' + e : ''))); };
const idx = fs.readFileSync('../index.html', 'utf8');
const src = idx.match(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/)[1];

console.log('t65 — auto-find reports itself, auto-sync runs per day');

// ── 1. The apply block is not gated on a whole-event calibration ──
const applyLine = src.match(/if \(af && af\.url[^)]*\) \{/)[0];
console.log('         ' + applyLine);
ok('the apply block is not gated on anyCal', !/anyCal/.test(applyLine), applyLine);
ok('it still requires auto-find to have returned a url', /af && af\.url/.test(applyLine));

// The per-day skip is what replaces that guard — without it, removing anyCal
// would re-sync days that already have an anchor and clobber published ones.
ok('the per-day loop still skips calibrated days',
  /if \(ctx\.cal && ctx\.cal\[d\]\) continue;/.test(src));

// ── 2. Quiet auto-sync failures record their reason ──
const failFn = src.match(/const fail = \(msg\) => \{[\s\S]*?\};/)[0];
ok('fail() records the reason regardless of quiet',
  /rwAutoSyncFail\[day\] = msg;/.test(failFn), failFn);
ok('the record happens before the quiet check',
  failFn.indexOf('rwAutoSyncFail[day] = msg') < failFn.indexOf('if (!quiet'), failFn);
ok('rwAutoSyncFail is declared', /let rwAutoSyncFail = \{\};/.test(src));
ok('a fresh attempt clears the previous reason',
  /delete rwAutoSyncFail\[day\];/.test(src));
ok('loading an event resets it', /rwAutoSyncFail = \{\};[\s\S]{0,80}vsDebug\.jumper = null;/.test(src));

// ── 3. The "found it" notice renders OUTSIDE the collapsed form ──
const statusBlock = src.slice(
  src.indexOf('const rwUncal ='),
  src.indexOf('if (rwDebugOn())')
);
ok('the status block exists', statusBlock.length > 0 && statusBlock.length < 4000);
ok('it announces a stream that was found automatically',
  /Found this event's stream automatically/.test(statusBlock), 'not in the top-level status block');
ok('it surfaces why auto-sync could not finish',
  /rwSyncWhy/.test(statusBlock));
ok('it still shows the looking-for-stream note',
  /Looking for this event's stream/.test(statusBlock));
ok('it still explains an outright miss',
  /rwStreamReason/.test(statusBlock));

// The notice must not be reachable only from inside `if (formOpen)`.
const formOpenIdx = src.indexOf('if (formOpen) {');
ok('the notice appears before the form block',
  src.indexOf("Found this event's stream automatically") < formOpenIdx,
  'the only copy is inside the form');

// ── 4. Day-awareness: one synced day must not silence the others ──
ok('the status block is driven by uncalibrated days, not a global emptiness test',
  !/!Object\.keys\(calAll\)\.length/.test(statusBlock), statusBlock.slice(0, 200));

const uncalOf = new Function('days', 'calAll',
  "return days.filter(d => d !== 'unknown' && !calAll[d]);");
ok('every day uncalibrated → both listed',
  uncalOf(['2026-03-07', '2026-03-08'], {}).length === 2);
ok('one day synced on a two-day event → the other still reports',
  uncalOf(['2026-03-07', '2026-03-08'], { '2026-03-07': {} }).length === 1);
ok('all days synced → nothing reported',
  uncalOf(['2026-03-07', '2026-03-08'], { '2026-03-07': {}, '2026-03-08': {} }).length === 0);
ok('the unknown-date bucket never asks for a stream',
  uncalOf(['unknown'], {}).length === 0);

console.log(`\nt65: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
