// t89 — the calibration controls have to move the picture.
//
// "when i press -30 it doesnt show me where -30 brings me in the preview"
//
// −30s changed the day's anchors and re-rendered, and the match list's times
// all updated — but ctx.playing.off was still whatever it had been when ▶ was
// pressed. So the embed kept its old ?start=, the clock above it kept the old
// value, and the button appeared to do nothing.
//
// That is the whole point of nudging. You press it while watching, to see the
// match come into frame; adjusting a number you cannot see the effect of is
// guesswork, and it is why "it's off by a bit" took so long to correct.
//
// Anything that re-times a day does it: the ±30s nudges, the minute shift in
// either direction, adding an anchor, removing one.
import fs from 'fs';
import { boot, settle } from './harness.mjs';
let pass = 0, fail = 0;
const ok = (n, c, e) => { c ? (pass++, console.log('  ok   ' + n)) : (fail++, console.log('  FAIL ' + n + (e ? '\n         ' + e : ''))); };
const idx = fs.readFileSync('../index.html', 'utf8');
const src = idx.match(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/)[1];

console.log('t89 — nudging moves the preview');

// ── 1. Every re-timing path refreshes the preview ──
ok('there is one place that does it', /function rwRefreshPlaying\(ctx, day\)/.test(src));
for (const [fn, where] of [
  ['rewatchNudge', 'the ±30s buttons'],
  ['rewatchShiftBy', 'the minute shift'],
  ['rewatchRemoveAnchor', 'removing an anchor']
]) {
  const body = src.slice(src.indexOf('function ' + fn), src.indexOf('\n}', src.indexOf('function ' + fn)));
  ok(`${where} refreshes it`, /rwRefreshPlaying\(ctx,/.test(body), body.slice(0, 200));
}
ok('so does setting an anchor by hand',
  /\/\/ A new anchor re-times every match on the day[\s\S]{0,120}rwRefreshPlaying\(ctx, day\);/.test(src));
ok('the offset is recomputed, never patched by the same delta',
  /const off = rwOffsetFor\(m, ctx\.cal\);/.test(src.slice(src.indexOf('function rwRefreshPlaying'))),
  'interpolation between two anchors does not move by a flat amount');

// ── 2. What it picks ──
ok('a nudge on a different day than the preview follows the nudge',
  /if \(m && day && rwDayKey\(m\.t\) !== day\) m = null;/.test(src));
ok('with nothing playing it starts on the match the day is anchored to',
  /const anchored = cal && \(cal\.anchors \|\| \[\]\)\[0\];/.test(src),
  'that is the one you are lining up');
ok('...falling back to the day\'s first match', /\.sort\(\(a, b\) => a\.t - b\.t\)\[0\] \|\| null;/.test(src));
ok('a match with no computable offset clears the preview rather than lying',
  /if \(off === null\) \{ ctx\.playing = null; return; \}/.test(src));

// ── 3. Driven ──
const CAL = () => JSON.stringify({ '2026-02-28': {
  videoId: 'abcdefghijk', platform: 'youtube', day: '2026-02-28', auto: true, savedAt: Date.now(),
  anchors: [{ matchId: 1001 + 55001, name: 'Qualification 1',
              matchMs: Date.parse('2026-02-28T11:00:00-05:00'), videoSec: 600 }]
}});
const openJumper = async () => {
  const b = await boot();
  b.win.localStorage.setItem('vex_rewatch_55001', CAL());
  b.win.switchTab('rewatch');
  b.win.document.getElementById('rwTeamInput').value = '66449A';
  await b.win.rewatchLoadTeam();
  await settle(b.win, 200);
  await b.win.rewatchSelectEvent(55001);
  await settle(b.win, 400);
  return b;
};
const srcOf = (d) => { const f = d.querySelector('#rwPlayer iframe'); return f ? f.getAttribute('src') : null; };
const clockOf = (d) => { const h = d.querySelector('#rwPlayer .detail-block-label'); return h ? h.textContent.trim() : null; };

{
  const { win, document: _, errors, stop } = await openJumper();
  const d = win.document;
  const ctx = () => win._rwCtx;

  win.rewatchJump(String(ctx().matches[0].id));
  await settle(win, 200);
  const off0 = ctx().playing.off, src0 = srcOf(d), clock0 = clockOf(d);
  ok('a match plays at its computed offset', off0 === 600, String(off0));
  ok('...and the embed starts there', /start=600/.test(src0 || ''), src0);
  ok('...and the clock above it says so', /10:00/.test(clock0 || ''), clock0);

  win.rewatchNudge('2026-02-28', -30);
  await settle(win, 200);
  ok('−30s moves the offset back thirty seconds', ctx().playing.off === off0 - 30,
    `${off0} → ${ctx().playing.off}`);
  ok('...the embed re-seeks', srcOf(d) !== src0 && /start=570/.test(srcOf(d) || ''), srcOf(d));
  ok('...and the clock follows', /9:30/.test(clockOf(d) || ''), clockOf(d));

  win.rewatchNudge('2026-02-28', 30);
  await settle(win, 200);
  ok('+30s puts it back exactly', ctx().playing.off === off0 && /start=600/.test(srcOf(d) || ''));

  // The minute box, in both directions.
  d.getElementById('rwShiftBack_2026-02-28').value = '2';
  win.rewatchShiftBy('2026-02-28', -1);
  await settle(win, 200);
  ok('two minutes earlier moves it two minutes', ctx().playing.off === off0 - 120,
    String(ctx().playing.off));
  ok('...and the embed with it', /start=480/.test(srcOf(d) || ''), srcOf(d));
  d.getElementById('rwShiftFwd_2026-02-28').value = '2';
  win.rewatchShiftBy('2026-02-28', 1);
  await settle(win, 200);
  ok('two minutes later puts it back', ctx().playing.off === off0);

  ok('nothing threw', errors.length === 0, errors.join('\n'));
  stop();
}

// Pressing a nudge with nothing playing must still show you something —
// otherwise the controls are invisible until you happen to press play first.
{
  const { win, stop } = await openJumper();
  const d = win.document;
  const ctx = () => win._rwCtx;
  ctx().playing = null;
  win.rewatchRender();
  await settle(win, 150);
  ok('no preview to begin with', srcOf(d) === null);

  win.rewatchNudge('2026-02-28', -30);
  await settle(win, 200);
  ok('a nudge opens one', !!ctx().playing && srcOf(d) !== null);
  ok('...on the anchored match', ctx().playing.matchId === 1001 + 55001,
    String(ctx().playing.matchId));
  ok('...already showing the nudged position', /start=570/.test(srcOf(d) || ''), srcOf(d));
  stop();
}

// Removing the only anchor leaves nothing to compute against; the preview must
// go rather than sit there at a position that no longer means anything.
{
  const { win, stop } = await openJumper();
  const d = win.document;
  const ctx = () => win._rwCtx;
  win.rewatchJump(String(ctx().matches[0].id));
  await settle(win, 200);
  ok('playing before the anchor goes', !!ctx().playing);
  win.rewatchRemoveAnchor('2026-02-28', String(1001 + 55001));
  await settle(win, 200);
  ok('removing the last anchor clears the preview', ctx().playing === null);
  ok('...and takes the embed off screen', srcOf(d) === null);
  stop();
}

console.log(`\nt89: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
