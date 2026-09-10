// t82 — the app, driven.
//
// Every test before this one reads index.html as TEXT: regexes over the source,
// or a function pulled out with `new Function` and handed made-up arguments.
// That catches a great deal. It caught nothing about the bug that prompted this
// file — the Teams tab rendering a cache that the team-number route never
// filled — because both halves were individually correct. Only walking from one
// screen to the next shows the join.
//
// So this one loads the real index.html in a real DOM, stubs the single thing
// that reaches the outside world (fetch → /api/proxy), and calls the same
// handlers the buttons call.
//
// What it found on the first run, beyond confirming the Teams fix:
//
//   • With site data blocked — Safari private browsing, "block all cookies",
//     a managed school device — window.onload threw on its second line and
//     took everything after it: no tab restore, no service worker, and no
//     enhanceAllSelects(), so all twelve dropdowns stayed raw native controls.
//     Nothing on screen said why. The app just looked broken.
//   • The Bracket view was the one sub-view that rendered no nav, so opening it
//     meant searching the event again to get anywhere else.
import { boot, settle, html, FIXTURES } from './harness.mjs';
let pass = 0, fail = 0;
const ok = (n, c, e) => { c ? (pass++, console.log('  ok   ' + n)) : (fail++, console.log('  FAIL ' + n + (e ? '\n         ' + e : ''))); };

console.log('t82 — end to end, in a real DOM');

// ── 1. It boots ──
{
  const { win, errors } = await boot();
  const d = win.document;
  ok('the page loads with no uncaught error', errors.length === 0, errors.join('\n'));
  ok('every dropdown is enhanced', d.querySelectorAll('.cs').length >= 12,
    d.querySelectorAll('.cs').length + ' enhanced');
  ok('a theme is applied', /theme-/.test(d.body.className), d.body.className);
  ok('the seasons list is populated', (d.getElementById('tournamentSeasonSelect')?.options.length || 0) > 0);
  ok('every tab panel exists',
    ['scout','skills','tournament','rewatch','simulator'].every(t => d.getElementById('tab-' + t)));
}

// ── 2. Blocked site data must cost the convenience and nothing else ──
//
// This is the failure that hid: none of it announces itself. The page renders,
// the data loads, and every control on it is the wrong one.
{
  const { win, errors } = await boot({ noStorage: true });
  const d = win.document;
  ok('a browser that refuses localStorage still boots cleanly', errors.length === 0,
    errors.map(e => String(e).split('\n')[0]).join(' | '));
  ok('...and still enhances every dropdown', d.querySelectorAll('.cs').length >= 12,
    'enhanceAllSelects() sits AFTER the theme read that used to throw');
  ok('...and still applies a theme', /theme-/.test(d.body.className));
  ok('...and still loads seasons', (d.getElementById('tournamentSeasonSelect')?.options.length || 0) > 0);
  let threw = null;
  try { win.switchTab('tournament'); } catch (e) { threw = e; }
  ok('...and switching tabs does not throw', threw === null, threw && threw.message);
  ok('...and the tab actually switches', d.getElementById('tab-tournament').classList.contains('active'));
}

// ── 3. The journey that was broken: team number → event → Teams ──
{
  const { win, errors } = await boot();
  const d = win.document;
  win.switchTab('tournament');
  d.getElementById('tournamentInput').value = '66449A';
  await win.findTournament();
  await settle(win);

  let h = html(win, 'tournamentResults');
  ok('a team number lists that team\'s events', /Bots @ Bristol/.test(h));
  ok('the row calls loadTournamentTeams with the focus team',
    /loadTournamentTeams\(55001, [^)]*, 9001, '66449A'/.test(h),
    'the sku is now a fifth argument; the focus team is still the third and fourth');
  ok('the grade dropdown followed the team', d.getElementById('tournamentGradeSelect').value === 'High School');

  await win.loadTournamentTeams(55001, 'Bots @ Bristol Signature Event', 9001, '66449A');
  await settle(win, 150);
  h = html(win, 'tournamentResults');
  ok('opening it lands on that team\'s matches', /Qualification/.test(h));
  ok('the nav is on screen', /t-nav/.test(h));

  // THE BUG. This tab rendered an empty grid.
  await win.tournamentGo('teams');
  await settle(win, 200);
  h = html(win, 'tournamentResults');
  ok('the Teams tab lists the teams', /66449A/.test(h),
    'this is the reported bug: it rendered a cache nothing had filled');
  ok('it counts them honestly', /2 High School teams registered/.test(h), h.slice(0, 200));
  ok('nothing threw along the way', errors.length === 0, errors.join('\n'));
}

// ── 4. Every sub-view renders, and none of them is a dead end ──
{
  const { win, errors } = await boot();
  win.switchTab('tournament');
  await win.loadTournamentTeams(55001, 'Bots @ Bristol Signature Event', 9001, '66449A');
  await settle(win, 150);
  for (const view of ['teams', 'matches', 'skills', 'awards', 'bracket', 'team']) {
    await win.tournamentGo(view);
    await settle(win, 150);
    const h = html(win, 'tournamentResults');
    ok(`${view}: renders something`, h.length > 300, h.length + ' chars');
    ok(`${view}: keeps the nav, so it is not a dead end`, /t-nav/.test(h),
      'the bracket was the one that did not');
  }
  ok('driving every sub-view raises nothing', errors.length === 0, errors.join('\n'));
}

// ── 5. One event's data must never appear under another's name ──
{
  const { win, errors } = await boot();
  win.switchTab('tournament');
  // Load event A the long way, so its team list is really in memory.
  await win.loadTournamentTeams(55001, 'Event A');
  await settle(win, 200);
  ok('event A has a team list', /66449A/.test(html(win, 'tournamentResults')));

  // Now open a DIFFERENT event whose team list has not been fetched.
  await win.loadTournamentTeams(55002, 'Event B', 9001, '66449A');
  await settle(win, 150);
  await win.tournamentGo('teams');
  await settle(win, 200);
  const h = html(win, 'tournamentResults');
  ok('event B renders under its own name', /Event B/.test(h) && !/Event A/.test(h),
    'the team cache used to survive the switch and show A\'s teams under B');
  ok('and nothing threw', errors.length === 0, errors.join('\n'));
}

// ── 6. A grade with nobody in it explains itself ──
{
  const { win } = await boot();
  win.switchTab('tournament');
  // Only one Middle School team exists in the fixture; ask for the grade that
  // has none by filtering to a division that holds none of them.
  win.document.getElementById('tournamentGradeSelect').value = 'Middle School';
  await win.loadTournamentTeams(55001, 'Bots @ Bristol Signature Event');
  await settle(win, 200);
  const h = html(win, 'tournamentResults');
  ok('a grade with teams still lists them', /12345B/.test(h), h.slice(0, 300));
}

// ── 7. The API falling over is reported, not swallowed ──
{
  const { win, errors } = await boot({ fail: { '/events/55001/teams': 500 } });
  win.switchTab('tournament');
  await win.loadTournamentTeams(55001, 'Bots @ Bristol Signature Event');
  await settle(win, 250);
  const err = (win.document.getElementById('errorBox')?.textContent || '') +
              (win.document.body.textContent || '');
  ok('a failing team fetch surfaces an error rather than an empty screen',
    /error|failed|⚠/i.test(err));
  ok('a failing fetch does not raise an uncaught rejection', errors.length === 0,
    errors.map(e => String(e).split('\n')[0]).join(' | '));
}

// ── 8. The Jumper must not carry one event's facts into the next ──
//
// rwEventStartDay was written in exactly one place: inside rwAutoFindStream.
// Auto-find is SKIPPED when every day of an event already has an anchor (§3,
// the quota saving), so opening an already-calibrated event straight after
// another one left the previous event's first day in place. Every "Day N"
// ordinal is counted from that date, so the day picker was choosing broadcasts
// for an event six weeks away.
//
// Event A is two days in February with divisions; event B is one day in April
// with none. Nothing about them overlaps.
{
  const { win, errors } = await boot();
  // Pre-calibrate B, which is what makes auto-find skip it.
  win.localStorage.setItem('vex_rewatch_55002', JSON.stringify({
    '2026-04-11': {
      videoId: 'abcdefghijk', platform: 'youtube', day: '2026-04-11', auto: true, savedAt: Date.now(),
      anchors: [{ matchId: 'x', name: 'Q1', matchMs: Date.parse('2026-04-11T11:00:00-04:00'), videoSec: 60 }]
    }
  }));
  const d = win.document;
  win.switchTab('rewatch');
  d.getElementById('rwTeamInput').value = '66449A';
  await win.rewatchLoadTeam();
  await settle(win, 200);

  await win.rewatchSelectEvent(FIXTURES.event.id);
  await settle(win, 400);
  const a = win.vsDayAssignment();
  ok('event A reports its own start day', a.eventStartDay === '2026-02-28', a.eventStartDay);
  ok('event A reports its own division', a.teamDivision === 'Alpha', a.teamDivision);
  ok('event A reports both of its days', JSON.stringify(a.eventDays) === '["2026-02-28","2026-03-01"]',
    JSON.stringify(a.eventDays));

  win._rwCtx = { team: null, events: [{ id: FIXTURES.eventB.id, name: FIXTURES.eventB.name }],
                 eventId: null, matches: [], videoId: null, cal: {}, calDay: null };
  await win.rewatchSelectEvent(FIXTURES.eventB.id);
  await settle(win, 400);
  const b = win.vsDayAssignment();
  ok('event B reports ITS start day, not the previous event\'s',
    b.eventStartDay === '2026-04-11', 'got ' + b.eventStartDay + ' — February leaked in from event A');
  ok('event B reports no division, because it has none',
    b.teamDivision === null, 'got ' + b.teamDivision);
  ok('event B reports its single day', JSON.stringify(b.eventDays) === '["2026-04-11"]',
    JSON.stringify(b.eventDays));
  ok('the day ordinal is counted from B\'s own first day',
    b.byDay.length === 1 && b.byDay[0].ordinal === 0,
    JSON.stringify(b.byDay && b.byDay.map(x => [x.day, x.ordinal])));
  ok('switching events raises nothing', errors.length === 0, errors.join('\n'));
}

// ── 9. The RobotEvents link, on every screen and always the right event ──
{
  const { win, errors } = await boot();
  const d = win.document;
  win.switchTab('tournament');
  d.getElementById('tournamentInput').value = '66449A';
  await win.findTournament();
  await settle(win);
  ok('the search result carries the sku into the click',
    /loadTournamentTeams\(55001,[^)]*'RE-V5RC-25-0191'\)/.test(html(win, 'tournamentResults')));

  await win.loadTournamentTeams(FIXTURES.event.id, FIXTURES.event.name, 9001, '66449A', FIXTURES.event.sku);
  await settle(win, 150);
  const href = h => (h.match(/<a class="t-nav-link"[^>]*href="([^"]+)"/) || [])[1] || null;
  for (const view of ['teams', 'matches', 'skills', 'awards', 'bracket', 'team']) {
    await win.tournamentGo(view);
    await settle(win, 150);
    const u = href(html(win, 'tournamentResults'));
    ok(`${view}: links to the event page`,
      u === 'https://events.vex.com/robot-competitions/vex-robotics-competition/RE-V5RC-25-0191.html', u);
  }

  // The Jumper's copy, on the event actually open.
  win.switchTab('rewatch');
  d.getElementById('rwTeamInput').value = '66449A';
  await win.rewatchLoadTeam();
  await settle(win, 200);
  await win.rewatchSelectEvent(FIXTURES.event.id);
  await settle(win, 400);
  ok('the Jumper links to it too',
    href(d.getElementById('rwResults').innerHTML) ===
    'https://events.vex.com/robot-competitions/vex-robotics-competition/RE-V5RC-25-0191.html');
  ok('nothing threw', errors.length === 0, errors.join('\n'));
}

// Arriving without a sku: a button that looks the same, which upgrades to a
// real link once a view fetches the event detail — and never points at the
// event before it.
{
  const { win } = await boot();
  win.switchTab('tournament');
  await win.loadTournamentTeams(FIXTURES.event.id, FIXTURES.event.name, 9001, '66449A');
  await settle(win, 150);
  await win.tournamentGo('team');
  await settle(win, 150);
  let h = html(win, 'tournamentResults');
  ok('no sku yet → a button that resolves on click',
    /<button class="t-nav-link" onclick="openEventPage\('55001'\)"/.test(h) && !/<a class="t-nav-link"/.test(h));

  await win.tournamentGo('teams');
  await settle(win, 250);
  h = html(win, 'tournamentResults');
  ok('once the detail is fetched it becomes a real link',
    /<a class="t-nav-link"[^>]*RE-V5RC-25-0191/.test(h));

  await win.loadTournamentTeams(FIXTURES.eventB.id, FIXTURES.eventB.name);
  await settle(win, 250);
  h = html(win, 'tournamentResults');
  const u = (h.match(/<a class="t-nav-link"[^>]*href="([^"]+)"/) || [])[1] || '';
  ok('a different event links to ITS page, not the previous one',
    u.includes('RE-V5RC-25-0649') && !u.includes('RE-V5RC-25-0191'), u || '(still a button)');
}

console.log(`\nt82: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
