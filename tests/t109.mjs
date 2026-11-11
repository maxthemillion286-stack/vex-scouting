// t109 — v86: last time's answer painted at once, and asking ahead of the tap.
import fs from 'fs';
import { boot, settle, html } from './harness.mjs';

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '\n         ' + detail : '')); }
};
const idx = fs.readFileSync('../index.html', 'utf8');
console.log('t109 — v86: instant and ahead');

console.log('\n· what you saw last time');
{
  const store = {};
  const { win } = await boot({ store });
  win.vsFavSet('66449A', true);
  win.switchTab('favs');
  await settle(win, 300);
  const snap = JSON.parse(store.vex_snap || '{}')['66449A'];
  ok('a loaded card is remembered', !!snap && snap.name === 'Wired Up' && snap.ev && snap.ev.id === 55001, store.vex_snap);
  ok('with its rank, tied to that event', snap.rank && snap.rank.rank === 1 && snap.rankEv === 55001);
  win.close();

  // Next visit, with the network refusing everything: the card still has it.
  const { win: w2 } = await boot({ store, fail: { '/teams': 500, '/events': 500 } });
  store.vex_team_ids = '{}';
  w2.apiFreshClear();
  w2.switchTab('favs');
  const h0 = html(w2, 'favsResults');
  ok('it is on the card before any request answers', /Wired Up/.test(h0) && /Bots @ Bristol Signature Event/.test(h0) && /#1/.test(h0), h0.slice(0, 500));
  ok('and says how old it is', /class="fav-asof">as of /.test(h0));
  await settle(w2, 300);
  const h1 = html(w2, 'favsResults');
  ok('a failed refresh leaves it there', /Bots @ Bristol Signature Event/.test(h1) && /#1/.test(h1) && !/Could not load/.test(h1), h1.slice(0, 400));
  w2.close();
}
{
  // A rank remembered for a DIFFERENT event than the one now showing is not shown.
  const { win } = await boot();
  ok('a rank from another event is not painted', win.vsSnapRankHtml({ at: 1, ev: { id: 2, start: '2026-01-01T08:00:00' }, rankEv: 1, rank: { rank: 3, total: 9 } }) === '');
  ok('no snapshot, nothing painted', win.favPaintSnap('NOPE1A') === false);
  const store2 = { vex_snap: JSON.stringify({ '66449A': { at: Date.now(), name: '<img src=x onerror=window.__pwn=1>', ev: { id: 55001, name: '<b>x</b>', start: '2026-02-28T08:00:00', end: '2026-02-28T17:00:00' }, rankEv: 55001, rank: { rank: '<i>1', total: 3 } } }) };
  win.close();
  const { win: w3 } = await boot({ store: store2 });
  w3.vsFavSet('66449A', true);
  w3.switchTab('favs');
  const h = html(w3, 'favsResults');
  ok('a poisoned snapshot is drawn as text', !/<img|<b>x|<i>1/.test(h) && !w3.__pwn, h.slice(0, 400));
  ok('storage that is not a map is empty', (() => { store2.vex_snap = '[1]'; return w3.vsSnapGet('66449A') === null; })());
  w3.close();
}

console.log('\n· asking ahead of the tap');
{
  const { win, router } = await boot();
  const day = d => { const x = new Date(Date.now() + d * 86400000); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}T08:00:00`; };
  const ev = { id: 55001, start: day(-1), end: day(0), divisions: [{ id: 1 }, { id: 2 }] };
  ok('an event that has not started is not fetched', win.vsWarmEvent({ id: 9, start: day(5), end: day(5) }, 9001) === false);
  let mark = router.seen.length;
  ok('a started one is', win.vsWarmEvent(ev, 9001) === true);
  ok('once, not on every render', win.vsWarmEvent(ev, 9001) === false);
  await settle(win, 500);
  const warmed = router.seen.slice(mark);
  ok('it asks for the matches and rankings of each division', ['divisions/1/matches', 'divisions/2/matches', 'divisions/1/rankings', 'divisions/2/rankings'].every(k => warmed.some(p => p.includes(k))), warmed.join(' | '));
  mark = router.seen.length;
  const a = await win.apiGet('/events/55001/divisions/1/matches');
  ok('the tap is answered from it, with no new request', router.seen.length === mark && Array.isArray(a) && a.length > 0);
  await win.apiGet('/events/55001/divisions/1/matches');
  ok('and only once: the next ask is a real request', router.seen.length === mark + 1);
  ok('it expires after a minute', /const API_WARM_MS = 60000;/.test(idx) && /if \(Date\.now\(\) - warm\.at < API_WARM_MS\)/.test(idx));
  ok('the live half is still not in the lasting cache', !/divisions/.test(idx.slice(idx.indexOf('const API_FRESH_RULES'), idx.indexOf('const API_FRESH_MAX'))));
  ok('Save-Data and offline skip it', /if \(!ev \|\| ev\.id == null \|\| !vsAutoOfflineAllowed\(\)\) return false;/.test(idx));
  ok('a save for offline is never answered from it', idx.indexOf('if (vsOfflineCapture) return apiGetLive(endpoint, params);') < idx.indexOf('const warm = apiWarmStore.get(warmKey);'));
  win.switchTab('rewatch');
  ok('opening the Jumper opens the connection to the video host', !!win.document.querySelector('link[rel="preconnect"][href="https://www.youtube.com"]'));
  win.switchTab('scout'); win.switchTab('rewatch');
  ok('once', win.document.querySelectorAll('link[rel="preconnect"][href="https://www.youtube.com"]').length === 1);
  win.close();
}

console.log(`\nt109: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
