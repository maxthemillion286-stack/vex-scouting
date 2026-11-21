// t157 — v171: "i send all the matches and even after watching them it still
// says for my team its only watched 3 matches even though ive been to 3 events
// with streams". Recordings the app sent had no summary until a website with
// the admin key brought them in; the team page now makes them, and the table
// says how many were tracked against how many its robot was told apart in.
import fs from 'fs';
import { boot, settle } from './harness.mjs';
let pass = 0, fail = 0;
const ok = (name, cond, detail) => { if (cond) { pass++; console.log('  ok   ' + name); } else { fail++; console.log('  FAIL ' + name + (detail ? '\n         ' + detail : '')); } };
const src = fs.readFileSync('../src/index.html', 'utf8');
console.log('t157 — v171');

// ── the server lists every recording of a team, and an event's unsummarised ones
{
  const mod = await import('../api/tracker.js');
  const db = new Map(), sets = new Map(), hashes = new Map();
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opt) => {
    const out = JSON.parse(opt.body).map(c => {
      if (c[0] === 'SET') { db.set(c[1], c[2]); return { result: 'OK' }; }
      if (c[0] === 'GET') return { result: db.get(c[1]) || null };
      if (c[0] === 'SADD') { if (!sets.has(c[1])) sets.set(c[1], new Set()); sets.get(c[1]).add(c[2]); return { result: 1 }; }
      if (c[0] === 'SMEMBERS') return { result: [...(sets.get(c[1]) || [])] };
      if (c[0] === 'HSET') { if (!hashes.has(c[1])) hashes.set(c[1], new Map()); hashes.get(c[1]).set(c[2], c[3]); return { result: 1 }; }
      if (c[0] === 'HDEL') return { result: 0 };
      if (c[0] === 'HKEYS') return { result: [...(hashes.get(c[1]) || new Map()).keys()] };
      if (c[0] === 'HGETALL') return { result: [...(hashes.get(c[1]) || new Map())].flat() };
      return { error: 'unknown ' + c[0] };
    });
    return { ok: true, status: 200, json: async () => out };
  };
  const call = async (method, query, body) => {
    const res = { code: 0, body: null, setHeader() {}, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
    await mod.default({ method, query: query || {}, body }, res);
    return res;
  };
  const E = process.env;
  E.KV_REST_API_URL = 'https://db.example/'; E.KV_REST_API_TOKEN = 'tok'; E.TRACKER_PASSCODE = 'correct horse battery';
  const rec = { v: 2, name: 'Qualification 1', round: 2, num: 1, red: ['66449A', '1234X'], blue: ['12345B', '777Z'], rs: 10, bs: 8, vid: 'abcDEF12345', off: 100, rate: 2, w: 640, h: 360, model: 'det1', at: 1, f: [[0, 0], [5, 1, 300, 165, 40, 30, 90, 1, 4660, 22136, 39612, 2]] };
  let r = await call('POST', {}, { passcode: 'correct horse battery', ev: '55001', id: '7', rec });
  ok('a recording is saved', r.code === 200, JSON.stringify(r.body));
  r = await call('POST', {}, { passcode: 'correct horse battery', ev: '55001', id: '8', rec });
  r = await call('GET', { team: '66449A' });
  ok('the team lists both recordings, though neither has a summary', r.code === 200 && r.body.recs && r.body.recs.sort().join() === '55001:7,55001:8' && Object.keys(r.body.sums).length === 0, JSON.stringify(r.body));
  r = await call('GET', { event: '55001', pending: '1' });
  ok('the event says which recordings have no summary', r.code === 200 && r.body.ids.sort().join() === '7,8', JSON.stringify(r.body));
  hashes.set('vt:s:55001', new Map([['7', '{}']]));
  r = await call('GET', { event: '55001', pending: '1' });
  ok('a summarised one is no longer listed', r.body.ids.join() === '8', JSON.stringify(r.body));
  globalThis.fetch = realFetch;
}

// ── the page makes the missing summaries
ok('the team page makes summaries for its recordings that have none', /async function vtTeamCatchUp\(number, sums\)/.test(src) && /vtTeamRecs\.set\(num, r\.body\.recs/.test(src));
ok('with the admin key, older recordings at its events too, and shares what it made', /\?event=\$\{encodeURIComponent\(ev\)\}&pending=1/.test(src) && /if \(pass\) vtApi\('POST', '', \{ passcode: pass, ev: String\(ev\), id: String\(id\), sum \}\)/.test(src));
ok('the table and the report both catch up and draw again', (src.match(/vtTeamCatchUp\(num, sums\)\.then/g) || []).length >= 3);
ok('the table says tracked against told apart', /its robot told apart in \$\{r\.own\.length\} of \$\{r\.mine\.length\} tracked/.test(src) && /tracked, alliance; its robot told apart in/.test(src));
ok('and counts recordings that could not be used', /could not be used: too few robots were seen/.test(src));

const { win } = await boot();
await settle(win);
// A fake store: two recordings of 66449A with no summary; the page makes them.
const f = n => win.eval(n);
const made = [];
win.vtSummarise = (rec) => ({ ok: 1, sv: f('VT_SUM_V'), red: rec.red, blue: rec.blue, name: rec.name });
win.eval(`vtSummarise = window.vtSummarise; vtApi = async (m, q, b) => {
  if (m === 'POST') { window.__posted = (window.__posted || 0) + 1; return { ok: true, body: {} }; }
  if (q === '?jobs=1') return { ok: true, body: { events: [] } };
  if (/pending=1/.test(q)) return { ok: true, body: { ids: ['9'] } };
  if (/match=/.test(q)) { const id = q.match(/match=(\\d+)/)[1]; return { ok: true, body: { rec: { f: [[0,0]], name: 'Q' + id, red: id === '9' ? ['1X','2Y'] : ['66449A','1X'], blue: ['3Z','4W'] } } }; }
  return { ok: true, body: {} };
}; lsSet(VT_PASS_KEY, 'k');`);
f('vtTeamRecs').set('66449A', ['55001:5', '55001:6']);
const sums = new win.Map([['55001:1', { ok: 1 }]]);
const n = await f('vtTeamCatchUp')('66449A', sums);
ok('it makes the team\'s two and the event\'s other one', n === 3, String(n));
ok('the team\'s count goes from 1 to 3', sums.size === 3 && sums.has('55001:5') && sums.has('55001:6') && !sums.has('55001:9'), [...sums.keys()].join());
ok('and shares all three', win.__posted === 3, String(win.__posted));
ok('it does not do the same ones twice', (await f('vtTeamCatchUp')('66449A', sums)) === 0);
ok('release is v171 or later', /const APP_BUILD = 'v1(7[1-9]|[89]\d)'/.test(src));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
