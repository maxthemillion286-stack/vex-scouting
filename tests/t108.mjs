// t108 — v85: what you need to move up, the season line, the My team page,
// and playing matches back to back.
import fs from 'fs';
import { boot, settle, html, FIXTURES } from './harness.mjs';

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '\n         ' + detail : '')); }
};
const idx = fs.readFileSync('../index.html', 'utf8');
console.log('t108 — v85');

console.log('\n· what you need to move up');
{
  const { win } = await boot();
  const row = (id, name, rank, wp, ap, sp) => ({ team: { id, name }, rank, wp, ap, sp });
  const rows = [row(1, 'A', 1, 12, 20, 100), row(2, 'B', 2, 10, 30, 90), row(3, 'C', 3, 10, 10, 80), row(4, 'ME', 4, 8, 40, 70), row(5, 'E', 5, 6, 50, 60), row(6, 'F', 6, 2, 0, 50)];
  const c = win.tClimb(rows, 4);
  ok('it knows where you are', c.now === 4 && c.total === 6);
  ok('a win is two WP, and ties break on AP', c.after === 2 && c.passed.map(r => r.team.name).join() === 'B,C', `${c.after} ${c.passed.map(r => r.team.name)}`);
  ok('it names who is one win behind', c.chasing.map(r => r.team.name).join() === 'E');
  const note = win.tClimbNote(rows, 4, 2);
  ok('the sentence says the place and who is passed', /you would be <strong>2nd<\/strong>, passing <strong>B<\/strong>, <strong>C<\/strong>/.test(note), note);
  ok('and what the number is based on', /standings as they are right now/.test(note) && /autonomous win point is not counted/.test(note));
  ok('nothing is said once qualification is over', win.tClimbNote(rows, 4, 0) === '');
  ok('first place is told it stays', /You are 1st/.test(win.tClimbNote(rows, 1, 1)));
  ok('a gap of more than a win says so', /would not move you up yet/.test(win.tClimbNote(rows, 6, 1)));
  ok('a team not in the table gets nothing', win.tClimb(rows, 99) === null && win.tClimbNote(rows, 99, 1) === '');
  ok('rankings with no WP column get nothing', win.tClimb([{ team: { id: 1 } }, { team: { id: 2 } }], 1) === null);
  ok('a team name is escaped', !/<img/.test(win.tClimbNote([row(1, '<img src=x>', 1, 10, 0, 0), row(2, 'ME', 2, 9, 0, 0)], 2, 1)));
  ok('ordinals read right', /<strong>1st<\/strong>/.test(win.tClimbNote([row(1, 'A', 1, 10, 0, 0), row(2, 'ME', 2, 9, 0, 0)], 2, 1)));
  win.close();
}

console.log('\n· the season line');
{
  const { win } = await boot();
  const d = {
    eventsList: [{ id: 1, name: 'First', start: '2025-10-04T08:00:00' }, { id: 2, name: 'Second <b>', start: '2025-12-06T08:00:00' }, { id: 3, name: 'Third', start: '2026-02-07T08:00:00' }, { id: 4, name: 'Unplayed', start: '2026-03-07T08:00:00' }],
    rankings: [{ event: { id: 3 }, wins: 6, losses: 0, ties: 0, rank: 1 }, { event: { id: 1 }, wins: 1, losses: 4, ties: 1, rank: 20 }, { event: { id: 2 }, wins: 3, losses: 3, ties: 0, rank: 9 }, { event: { id: 2 }, wins: 1, losses: 0, ties: 0, rank: 2 }, { event: { id: 4 }, wins: 0, losses: 0, ties: 0 }]
  };
  const pts = win.seasonPoints(d);
  ok('events are in the order they were played', pts.map(p => p.name).join() === 'First,Second <b>,Third');
  ok('a tie counts as half a win', pts[0].rate === 25, String(pts[0].rate));
  ok('a second table for one event keeps the fuller one', pts[1].played === 6 && pts[1].rate === 50);
  ok('an event with no matches is not a point', pts.length === 3);
  const svg = win.seasonChart(d);
  ok('it draws one line with a dot per event', (svg.match(/class="ssn-dot"/g) || []).length === 3 && (svg.match(/<polyline/g) || []).length === 1);
  ok('it says the direction in words', /Up 75 points since the first event/.test(svg));
  ok('each dot carries its event, record and rank', /<title>First \([^)]+\): won 25% of qualification matches, 1–4–1, ranked 20<\/title>/.test(svg), svg.match(/<title>[^<]*/)[0]);
  ok('an event name is escaped', /Second &lt;b&gt;/.test(svg) && !/Second <b>/.test(svg));
  ok('only the ends are labelled, not every point', (svg.match(/class="ssn-val"/g) || []).length === 2);
  ok('one event is not a trend, so no chart', win.seasonChart({ eventsList: d.eventsList.slice(0, 1), rankings: d.rankings.slice(1, 2) }) === '');
  ok('it has a text description for a screen reader', /role="img" aria-label="Qualification win rate at each of 3 events/.test(svg));
  ok('the Scout card shows it above the events', idx.indexOf('html += seasonChart(d);') < idx.indexOf('html += renderEventsAttended(d);'));
  win.close();
}

console.log('\n· my team, on a computer');
{
  const store = { vex_my_team: '66449A' };
  const { win, errors } = await boot({ store });
  ok('there is a My team tab, for computers only', !!win.document.querySelector('.tab-btn.tab-desk-only[data-tab="home"]'));
  win.switchTab('home');
  await settle(win, 500);
  const h = html(win, 'homeResults');
  ok('it names the team', /class="home-num">66449A</.test(h) && /Wired Up/.test(h));
  ok('its event, with when', /Bots @ Bristol Signature Event/.test(h) && /Latest event|Playing now|Next event/.test(h));
  ok('rank and record there', /class="home-big">#1</.test(h), h.slice(0, 900));
  ok('the season record', /class="home-k">Season</.test(h) && /% won|no matches yet/.test(h));
  ok('and the ways in', /favOpenEvent\('66449A', 55001\)/.test(h) && /favGo\('66449A', 'watch'\)/.test(h) && /favGo\('66449A', 'stats'\)/.test(h));
  ok('the rail link opens it', (() => { win.switchTab('scout'); win.myTeamOpen(); return win.document.getElementById('tab-home').classList.contains('active'); })());
  win.myTeamClear();
  await settle(win, 100);
  ok('with no team it points at Settings', /Set your team/.test(html(win, 'homeResults')) && /switchTab\('settings'\)/.test(html(win, 'homeResults')));
  ok('a computer with a team set opens on it', /else if \(!vsIsPhone\(\) && vsMyTeam\(\)\) switchTab\('home'\);/.test(idx));
  ok('no errors', errors.length === 0, errors.join('\n'));
  win.close();
}

console.log('\n· play all my matches');
{
  ok('the window is longer than a match', /const RW_PLAYALL_SEC = 180;/.test(idx));
  ok('a jump re-arms the clock', /rewatchRender\(\);\n  rwPlayAllArm\(\);/.test(idx));
  ok('the timer checks nothing changed underneath it', /String\(c\.eventId\) !== forEvent \|\| String\(c\.playing\.matchId\) !== forMatch\) return;/.test(idx));
  ok('the countdown does not re-render the player', /The countdown changes its own text only/.test(idx));
  ok('the last match stops instead of looping', /if \(!info \|\| !info\.next\) \{ ctx\.playAll = false; return; \}/.test(idx));
  const { win } = await boot();
  const t0 = Date.parse('2026-02-28T15:00:00Z'), day = win.rwDayKey(t0);
  const ms = [1, 2, 3].map(i => ({ id: i, name: 'Q' + i, round: 2, num: i, t: t0 + i * 600000, redNums: [], blueNums: [] }));
  win._rwCtx = { eventId: 55001, events: [], days: [day], matches: ms, shift: {}, cal: { [day]: { videoId: 'abc', anchors: [{ matchId: 1, matchMs: t0, videoSec: 0 }] } } };
  ok('three matches with positions are playable', win.rwPlayOrder().length === 3);
  ok('the button offers all of them', /Play all 3 matches in order/.test(win.rwPlayAllButton()));
  win.rwPlayAllStart();
  ok('starting opens the first and turns it on', win._rwCtx.playAll === true && String(win._rwCtx.playing.matchId) === '1');
  ok('the button becomes Stop', /rwPlayAllStop\(\)/.test(win.rwPlayAllButton()));
  win.rwStep(1);
  ok('stepping by hand keeps it going', win._rwCtx.playAll === true && String(win._rwCtx.playing.matchId) === '2');
  win.rwPlayAllStop();
  ok('Stop turns it off', win._rwCtx.playAll === false);
  win._rwCtx.matches = ms.slice(0, 1);
  ok('one match needs no play-all', win.rwPlayAllButton() === '');
  win.rwPlayAllClear();
  win.close();
}

console.log(`\nt108: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
