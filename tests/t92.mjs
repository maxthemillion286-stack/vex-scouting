// t92 — events kept for offline, and moving between matches.
//
// Two features from IDEAS.md (5 and 11). Both are about the app remembering
// something across a boundary it used to forget at: a dead network, and
// closing the tab.
//
// A third, addresses in the location bar, was built here in v59 and removed
// again in v60 — see IDEAS.md § 3 for what it did and why it went.
import fs from 'fs';
import { boot, settle, html, newIdb } from './harness.mjs';
let pass = 0, fail = 0;
const ok = (n, c, e) => { c ? (pass++, console.log('  ok   ' + n)) : (fail++, console.log('  FAIL ' + n + (e ? '\n         ' + e : ''))); };
const idx = fs.readFileSync('../index.html', 'utf8');
const src = idx.match(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/)[1];

console.log('t92 — offline, and stepping through matches');

// ══ 1. Saved for offline ══════════════════════════════════════════════════
console.log('\n· an event kept on the device');

ok('the save reuses the app\'s own calls',
  /async function vsOfflineSave\(eventId\)[\s\S]{0,900}apiGet\(`\/events\/\$\{id\}\/teams`\)/.test(src),
  'a separate list of endpoints would drift out of step with the views');
ok('and bypasses the memo, because a memo hit is not a request',
  /The memo is deliberately bypassed/.test(src));
ok('a page is stored under the exact path that produced it',
  /if \(vsOfflineCapture\) \{ vsOfflineCapture\.n\+\+; idbSet\(VS_OFF_PREFIX \+ path, body\); \}/.test(src));
ok('a device that has saved nothing pays nothing',
  /if \(vsOfflineAny\(\)\) \{/.test(src));
ok('...and that flag does not re-read localStorage per request',
  /let vsOfflineAnyAt = null;/.test(src) && /vsOfflineAnyAt = null;/.test(src));
ok('holding a saved copy skips the backoff',
  /return await fetchPageLive\(page, saved \? 1 : 5\);/.test(src),
  'five attempts is thirty-one seconds to reach an answer already in hand');
ok('the retry count is actually wired to it',
  /for \(let attempt = 0; attempt < maxAttempts; attempt\+\+\)/.test(src));
ok('the index entry waits for the writes',
  /await new Promise\(r => setTimeout\(r, 60\)\);[\s\S]{0,80}vsOfflineNote\(id, \{/.test(src));
ok('the debug panel reports what came from a saved copy',
  /offlineHits: vsDebug\.offlineHits/.test(src) && /offlineEvents:/.test(src));

{
  const store = newIdb(), ls = {};
  // Thursday, at home, on wifi.
  {
    const { win, errors, stop } = await boot({ idb: store, store: ls });
    win.switchTab('tournament');
    await win.loadTournamentTeams(55001, 'Bots @ Bristol', null, '', 'RE-V5RC-25-0191');
    await settle(win, 400);
    ok('the button is offered on every event view', /id="tOfflineBtn"/.test(html(win, 'tournamentResults')));
    await win.vsOfflineSave(55001); await settle(win, 900);
    const entry = JSON.parse(ls['vex_offline_events'] || '{}')['55001'];
    ok('the save records what it kept', !!entry && entry.calls > 0, JSON.stringify(entry));
    ok('it stores the real name and SKU, not the id',
      !!entry && entry.sku === 'RE-V5RC-25-0191' && /Bristol/.test(entry.name), JSON.stringify(entry));
    ok('the button becomes the badge', /✓ SAVED/.test(html(win, 'tournamentResults')));
    ok('forgetting it is a button, not a right-click',
      /t-offline-x/.test(html(win, 'tournamentResults')) && !/oncontextmenu/.test(src),
      'this app is used on a phone; a context menu is not thumb-reachable');
    win.vsOfflineForget(55001); await settle(win, 300);
    ok('...and forgetting works', !/✓ SAVED/.test(html(win, 'tournamentResults')));
    await win.vsOfflineSave(55001); await settle(win, 900);   // put it back for the next block
    ok('re-saving restores the badge', /✓ SAVED/.test(html(win, 'tournamentResults')));
    ok('nothing threw', errors.length === 0, errors.join('\n'));
    stop();
  }
  // Saturday, in the gym, nothing works.
  {
    const { win, errors, stop } = await boot({ idb: store, store: ls, fail: { '/': 503 } });
    win.switchTab('tournament');
    await win.loadTournamentTeams(55001, 'Bots @ Bristol', null, '', 'RE-V5RC-25-0191');
    await settle(win, 2500);
    const h = html(win, 'tournamentResults');
    ok('the roster still opens with every request failing',
      ['66449A', '1234X', '12345B'].every(n => h.includes(n)),
      h.length + ' chars rendered');
    ok('and it came from the saved copy, not a lucky request',
      win.eval('vsDebug.offlineHits') > 0, 'offlineHits = ' + win.eval('vsDebug.offlineHits'));
    await win.tournamentGo('matches'); await settle(win, 1500);
    ok('the schedule opens too', /Qualification/.test(html(win, 'tournamentResults')));
    stop();
  }
  // A device that never saved anything gets no false promises.
  {
    const { win, stop } = await boot({ fail: { '/': 503 } });
    ok('an unsaved event does not claim to be saved', !win.vsOfflineHas || !win.eval('vsOfflineHas(55001)'));
    stop();
  }
}

// ══ 2. Stepping through matches ═══════════════════════════════════════════
console.log('\n· the Jumper, match to match');

ok('the order is the screen\'s order',
  /The order here is deliberately the SCREEN's order/.test(src),
  'any other sequence means "next" points somewhere the page never showed');
ok('only matches that can actually be opened are in it',
  /if \(rwOffsetFor\(m, cal\) !== null\) out\.push\(m\);/.test(src));
ok('the marks are keyed per event',
  /function rwSeenFor\(eventId\)/.test(src));
ok('the stored list is bounded',
  /ids\.slice\(-400\)/.test(src) && /if \(keys\.length > 40\)/.test(src));
ok('coming back offers a button, not an autoplay',
  /Deliberately a button rather than an autoplay/.test(src));
ok('the resume row checks the match is still playable',
  /rwOffsetFor\(x, calAll\) !== null/.test(src),
  'an event whose calibration was cleared would offer a dead link');

{
  const ls = {};
  const open = async (store) => {
    const { win, errors, stop } = await boot({ store });
    win.switchTab('rewatch');
    const t = win.document.getElementById('rwTeamInput'); if (t) t.value = '66449A';
    await win.rewatchLoadTeam(); await settle(win, 700);
    await win.rewatchSelectEvent(55001); await settle(win, 900);
    return { win, errors, stop };
  };
  const { win, errors, stop } = await open(ls);
  const ctx = win._rwCtx;
  const anchor = ctx.matches.find(m => m.t !== null);
  const day = win.rwDayKey(anchor.t);
  win.rewatchCalibrateDay(day); await settle(win, 200);
  win.document.getElementById('rwVideoInput').value = 'https://www.youtube.com/watch?v=abcdefghijk';
  win.document.getElementById('rwAnchorTime').value = '10:00';
  const sel = win.document.getElementById('rwAnchorMatch');
  sel.innerHTML = `<option value="${anchor.id}">x</option>`;
  sel.value = String(anchor.id);
  win.rewatchCalibrate(day); await settle(win, 300);

  const order = win.rwPlayOrder();
  ok('a calibrated day produces a playable order', order.length >= 3, order.length + ' playable');
  ok('...in the order the page lists them',
    order.map(m => m.name).join(',') === order.map(m => m.name).sort().join(','),
    order.map(m => m.name).join(', '));

  win.rewatchJump(order[0].id); await settle(win, 250);
  let h = html(win, 'rwResults');
  ok('the player says where you are', /rw-step-at">\s*1 \/ /.test(h),
    (h.match(/rw-step-at">([^<]*)</) || [])[1]);
  ok('back is dead at the first one', /rwStep\(-1\)"\s*disabled/.test(h.replace(/\s+/g, ' ')));
  ok('forward is alive', !/rwStep\(1\)"\s*disabled/.test(h.replace(/\s+/g, ' ')));

  win.rwStep(1); await settle(win, 250);
  h = html(win, 'rwResults');
  ok('next moves one row', /rw-step-at">\s*2 \/ /.test(h), (h.match(/rw-step-at">([^<]*)</) || [])[1]);
  ok('the row on screen is marked', /rw-row [^"]*playing/.test(h));
  ok('the one you left carries a tick', (h.match(/rw-seen/g) || []).length >= 1);

  win.rwStep(1); await settle(win, 250);
  h = html(win, 'rwResults');
  ok('and stops at the end', /rwStep\(1\)"\s*disabled/.test(h.replace(/\s+/g, ' ')) || order.length > 3);
  ok('the last one is written down', /"last":\{"id":/.test(ls['vex_rw_seen'] || ''), ls['vex_rw_seen']);
  ok('nothing threw', errors.length === 0, errors.join('\n'));
  stop();

  // Come back to the same device.
  const two = await open(ls);
  const h2 = html(two.win, 'rwResults');
  ok('it offers to pick up where you stopped', /rw-resume/.test(h2));
  ok('...and names the match', /You were last watching <strong>Qualification/.test(h2),
    (h2.match(/You were last watching <strong>([^<]*)</) || [])[1]);
  ok('the rows you opened stay ticked', (h2.match(/rw-seen/g) || []).length >= 3,
    (h2.match(/rw-seen/g) || []).length + ' ticks');
  two.win.rwForget(55001); await settle(two.win, 200);
  ok('and CLEAR forgets them', !/rw-resume/.test(html(two.win, 'rwResults')));
  ok('nothing threw on the way back', two.errors.length === 0, two.errors.join('\n'));
  two.stop();
}

console.log(`\nt92: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
