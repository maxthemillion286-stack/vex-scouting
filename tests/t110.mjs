// t110 — v87: comparing teams, and every match of a team's in the Jumper.
import fs from 'fs';
import { boot, settle, html, FIXTURES } from './harness.mjs';

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '\n         ' + detail : '')); }
};
const idx = fs.readFileSync('../index.html', 'utf8');
console.log('t110 — v87');

console.log('\n· compare teams');
{
  FIXTURES.wideRoster = 12; FIXTURES.playedThrough = 4;
  const { win, errors } = await boot();
  win.switchTab('tournament');
  await win.loadTournamentTeams(55001, 'Bots @ Bristol Signature Event', 9001, '66449A', 'RE-V5RC-25-0191');
  await settle(win, 300);
  await win.tournamentGo('picklist');
  await settle(win, 300);
  const pk = () => html(win, 'tournamentResults');
  ok('the pick list has a compare box', /Compare teams/.test(pk()) && !!win.document.getElementById('tCompareInput'));
  ok('with the roster offered as you type', (pk().match(/<option value="/g) || []).length >= 3);
  ok('alone, it says what to do', /Add a team to see it next to 66449A/.test(pk()));

  win.document.getElementById('tCompareInput').value = '1234x, 12345B';
  win.tCompareAddFromInput();
  await settle(win, 300);
  const t = win.document.querySelector('.cmp');
  ok('two added teams make a table', !!t);
  const heads = [...t.querySelectorAll('thead th')].map(h => h.textContent.replace(/\s+/g, ''));
  ok('your team leads it, then the ones you added', heads[1].startsWith('66449A') && heads[2].startsWith('1234X') && heads[3].startsWith('12345B'), heads.join('|'));
  const labels = [...t.querySelectorAll('tbody th')].map(h => h.textContent);
  ok('one metric per row', ['Seed', 'Record', 'Rating', 'AP a match', 'Usual low score', 'Usual high score', 'Trend', 'World skills rank'].every(l => labels.includes(l)), labels.join('|'));
  ok('and the win chance of pairing with you', labels.some(l => /Win chance with 66449A/.test(l)));
  const winRow = [...t.querySelectorAll('tbody tr')].find(r => /Win chance/.test(r.textContent));
  ok('which is blank for your own column, not "no data"', winRow.children[1].textContent === '' && /%/.test(winRow.children[2].textContent));
  ok('the best in a row is marked with a symbol, not colour alone', /class="cmp-dot" aria-label="best of these">●/.test(pk()));
  ok('the caveat says these are alliance numbers', /come from <strong>alliance<\/strong> scores/.test(pk()));

  win.tCompareAdd('99999Z');
  ok('a team not at the event is refused', win.tCompareList().join() === '1234X,12345B');
  win.tCompareAdd('1234X');
  ok('a team is not added twice', win.tCompareList().length === 2);
  win.tCompareSet(['1234X', '12345B', '777Z', '100A', '101B', '102C']);
  await settle(win, 200);
  ok('four at most', win.tCompareList().length === 4, win.tCompareList().join());
  win.tCompareRemove('1234X');
  await settle(win, 200);
  ok('✕ removes one', !win.tCompareList().includes('1234X'));
  win.tCompareClear();
  await settle(win, 200);
  ok('Clear empties it', win.tCompareList().length === 0 && !win.document.querySelector('.cmp'));
  win.tCompareAdd("');window.__pwn=1;('");
  ok('a hostile number goes nowhere', win.tCompareList().length === 0 && !win.__pwn);
  ok('no errors', errors.length === 0, errors.join('\n'));
  win.close();
  FIXTURES.wideRoster = undefined; FIXTURES.playedThrough = undefined;
}

console.log('\n· every match, in the Jumper');
{
  FIXTURES.playedThrough = 4;
  const { win, errors } = await boot();
  win.switchTab('rewatch');
  win.document.getElementById('rwTeamInput').value = '66449A';
  await win.rewatchLoadTeam();
  await settle(win, 200);
  await win.rewatchSelectEvent(55001);
  await settle(win, 400);
  const d = win.document;
  const block = d.querySelector('.rw-all');
  ok('picking the event shows one list of all the matches', !!block && /All 6 matches for 66449A/.test(block.textContent), block && block.textContent.slice(0, 80));
  const rows = [...block.querySelectorAll('.rw-row')];
  ok('one row per match, in the order played', rows.length === 6 && /Qualification 1/.test(rows[0].textContent) && /Qualification 6/.test(rows[5].textContent));
  ok('with partner and opponents', /66449A\s*1234X/.test(rows[0].textContent) && /12345B\s*777Z/.test(rows[0].textContent));
  ok('and the score, this team first', /101–91/.test(rows[0].textContent));
  ok('a 0–0 with no start is "not played", not a tie', /not played/.test(rows[5].textContent) && rows[5].classList.contains('pending') && !/0–0/.test(rows[5].textContent));
  ok('the record counts only what was played', /4–0/.test(block.querySelector('.rw-all-rec').textContent));
  ok('it is the first block of matches on the page', d.getElementById('rwResults').innerHTML.indexOf('rw-all') < d.getElementById('rwResults').innerHTML.indexOf('rw-day-head', d.getElementById('rwResults').innerHTML.indexOf('rw-all') + 400));
  ok('it says how many have video', /No video is linked yet|have video|Every match has video/.test(block.textContent));
  // With a position for the day, every played match gets a Watch button.
  const ctx = win._rwCtx;
  const day = win.rwDayKey(ctx.matches[0].t);
  ctx.cal[day] = { videoId: 'abcdefghijk', anchors: [{ matchId: ctx.matches[0].id, matchMs: ctx.matches[0].t, videoSec: 600 }] };
  win.rewatchRender();
  const watch = [...d.querySelectorAll('.rw-all .rw-watch')];
  ok('matches on a day with a stream get ▶ Watch', watch.length >= 3 && /rewatchJump\('\d+'\)/.test(watch[0].getAttribute('onclick')), String(watch.length));
  watch[0].dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await settle(win, 150);
  ok('and it opens the match', !!win._rwCtx.playing && !!d.querySelector('.rw-all .rw-row.playing'));
  ok('the day lists under it are still there', d.querySelectorAll('.rw-block').length >= 2);
  ok('no errors', errors.length === 0, errors.join('\n'));
  win.close();
  FIXTURES.playedThrough = undefined;
}
ok('on a phone the list keeps the teams and the score', /\.rw-all \.rw-teams \{ display: block;/.test(idx) && /\.rw-all \.rw-score \{ display: block;/.test(idx));

console.log(`\nt110: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
