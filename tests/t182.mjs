// t182 — v203 (app 2.61): "who scored?" answered in the app, test matches, sharper marking queue.
import fs from 'fs';
import { boot, settle } from './harness.mjs';
let pass = 0, fail = 0;
const ok = (name, cond, detail) => { if (cond) { pass++; console.log('  ok   ' + name); } else { fail++; console.log('  FAIL ' + name + (detail ? '\n         ' + detail : '')); } };
const src = fs.readFileSync('../src/index.html', 'utf8'), app = fs.readFileSync('../desktop/vex_trainer.py', 'utf8');
console.log('t182 — v203');
{
  const mod = await import('../api/tracker.js');
  const db = new Map(), sets = new Map(), hashes = new Map();
  const realFetch = globalThis.fetch;
  const H = k => { if (!hashes.has(k)) hashes.set(k, new Map()); return hashes.get(k); };
  globalThis.fetch = async (url, opt) => {
    const out = JSON.parse(opt.body).map(c => {
      if (c[0] === 'SET') { db.set(c[1], c[2]); return { result: 'OK' }; }
      if (c[0] === 'GET') return { result: db.get(c[1]) || null };
      if (c[0] === 'SADD') { if (!sets.has(c[1])) sets.set(c[1], new Set()); sets.get(c[1]).add(c[2]); return { result: 1 }; }
      if (c[0] === 'SMEMBERS') return { result: [...(sets.get(c[1]) || [])] };
      if (c[0] === 'HSET') { H(c[1]).set(c[2], c[3]); return { result: 1 }; }
      if (c[0] === 'HDEL') { H(c[1]).delete(c[2]); return { result: 1 }; }
      if (c[0] === 'HMGET') return { result: c.slice(2).map(f => H(c[1]).get(f) || null) };
      if (c[0] === 'HGETALL') return { result: [...H(c[1])].flat() };
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
  const rec = { v: 2, name: 'Q1', round: 2, num: 1, red: ['66449A', '1234X'], blue: ['12345B', '777Z'], rs: 10, bs: 8, vid: 'abcDEF12345', off: 100, rate: 2, w: 640, h: 360, model: 'det1', at: 1, f: [[0, 0], [5, 1, 300, 165, 40, 30, 90, 1, 4660, 22136, 39612, 2]] };
  await call('POST', {}, { passcode: 'correct horse battery', ev: '55001', id: '7', rec });
  H('vt:s:55001').set('7', '{"old":1}'); H('vt:team:66449A').set('55001:7', '{"old":1}');
  let r = await call('POST', {}, { passcode: 'nope', who: { ev: '55001', id: '7', t: 405, x: 300, y: 165 } });
  ok('an answer needs the admin key', r.code === 401 || r.code === 403, String(r.code));
  r = await call('POST', {}, { passcode: 'correct horse battery', who: { ev: '55001', id: '7', t: 405, x: 300, y: 165 } });
  const saved = JSON.parse(db.get('vt:m:55001:7'));
  ok('the answer is kept in the recording', r.code === 200 && JSON.stringify(saved.wq) === '[405,300,165]' && saved.wqt > 0, JSON.stringify(r.body));
  ok('and the match\'s summaries are dropped to be made again', !H('vt:s:55001').has('7') && !H('vt:team:66449A').has('55001:7') && H('vt:redo').has('55001:7'));
  await call('POST', {}, { passcode: 'correct horse battery', who: { ev: '55001', id: '7', t: 405, x: 310, y: 170 } });
  ok('answering the same moment again replaces it', JSON.stringify(JSON.parse(db.get('vt:m:55001:7')).wq) === '[405,310,170]');
  r = await call('GET', { team: '66449A' });
  ok('the team page is told which matches to make again', r.body.redo && r.body.redo['55001:7'] > 0, JSON.stringify(r.body));
  r = await call('POST', {}, { passcode: 'correct horse battery', who: { ev: '55001', id: '9', t: 1, x: 1, y: 1 } });
  ok('an answer for a match that is not there is refused', r.code === 404);
  globalThis.fetch = realFetch;
}
const { win } = await boot();
await settle(win);
const Picked = win.eval('vtPickedAt');
const carried = { 1: [[], []], 2: [[], []], picked: [[44, 1, 1]] };
ok('a person\'s pick is found for a goal going up near then', JSON.stringify(Picked(carried, 47, 1)) === '[44,1,1]' && Picked(carried, 47, 2) === null && Picked(carried, 70, 1) === null);
ok('it beats the nearest robot and the load', /const pk = vtPickedAt\(carried, t, only\);\n\s+if \(pk\) r = robots\[pk\[1\]\]\[pk\[2\]\];/.test(src) && /const r = pk \? robots\[pk\[1\]\]\[pk\[2\]\] : whoWas/.test(src));
ok('the team page drops copies made before an answer', /if \(had && !\(\(had\.wqt \|\| 0\) >= at\)\)/.test(src));
ok('the app: clips, answers, test matches and their check', /def want_check\(t, k, total, sb\):/.test(app) && /def answer_check\(cfg, name, pick\):/.test(app) && /def gold_gate\(name, new_fn, old_fn\):/.test(app) && /openChecks\(\)/.test(app) && /openGold\(\)/.test(app));
ok('a new pin finder and stack reader must not do worse on test matches', (app.match(/gold_gate\('the (new pin finder|stack reader)'/g) || []).length === 2);
ok('the marking queue weighs where the counters disagree', /v \+= 1\.5 \* sum\(abs\(sum\(x\[:3\]\) - sum\(y\[:3\]\)\)/.test(app));
ok('summaries are made again', /const VT_REMAKE = 2(0[3-9]|[1-9]\d)/.test(src));
ok('app 2.61 or later', /VERSION = '2\.(6[1-9]|[7-9]\d)'/.test(app));
ok('release is v203 or later', /const APP_BUILD = 'v(20[3-9]|2[1-9]\d)'/.test(src));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
