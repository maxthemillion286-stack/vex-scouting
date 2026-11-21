// t168 — v182 (app 2.50): "whenever someone on the website uses the jumper and
// watches a match it automatically trains in the background".
import fs from 'fs';
let pass = 0, fail = 0;
const ok = (name, cond, detail) => { if (cond) { pass++; console.log('  ok   ' + name); } else { fail++; console.log('  FAIL ' + name + (detail ? '\n         ' + detail : '')); } };
const src = fs.readFileSync('../src/index.html', 'utf8'), app = fs.readFileSync('../desktop/vex_trainer.py', 'utf8');
console.log('t168 — v182');
const mod = await import('../api/tracker.js');
const sets = new Map(), hashes = new Map(), kv = new Map();
globalThis.fetch = async (url, opt) => {
  const out = JSON.parse(opt.body).map(c => {
    const h = k => { if (!hashes.has(k)) hashes.set(k, new Map()); return hashes.get(k); };
    switch (c[0]) {
      case 'SET': kv.set(c[1], c[2]); return { result: 'OK' };
      case 'GET': return { result: kv.get(c[1]) || null };
      case 'SADD': if (!sets.has(c[1])) sets.set(c[1], new Set()); sets.get(c[1]).add(c[2]); return { result: 1 };
      case 'SISMEMBER': return { result: sets.has(c[1]) && sets.get(c[1]).has(c[2]) ? 1 : 0 };
      case 'SMEMBERS': return { result: [...(sets.get(c[1]) || [])] };
      case 'HSET': h(c[1]).set(c[2], c[3]); return { result: 1 };
      case 'HEXISTS': return { result: h(c[1]).has(c[2]) ? 1 : 0 };
      case 'HLEN': return { result: h(c[1]).size };
      case 'HDEL': h(c[1]).delete(c[2]); return { result: 1 };
      case 'HGETALL': return { result: [...h(c[1])].flat() };
      default: return { result: null };
    }
  });
  return { ok: true, status: 200, json: async () => out };
};
const call = async (method, query, body) => {
  const res = { code: 0, body: null, setHeader() {}, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
  await mod.default({ method, query: query || {}, body }, res);
  return res;
};
process.env.KV_REST_API_URL = 'https://db.example/'; process.env.KV_REST_API_TOKEN = 'tok'; process.env.TRACKER_PASSCODE = 'correct horse battery';
const job = { id: '91', name: 'Qualification 12', round: 2, num: 12, vid: 'abcDEF12345', off: 812, red: ['66449A', '1234X'], blue: ['5B', '7C'] };
let r = await call('POST', {}, { want: { ev: '55001', job } });
ok('anyone watching offers the match, no admin key', r.code === 200 && r.body.ok, JSON.stringify(r.body));
r = await call('POST', {}, { want: { ev: '55001', job: { ...job, vid: 'bad vid!' } } });
ok('checked like any job', r.code === 400);
r = await call('POST', {}, { want: { ev: '55001', job: { ...job, extra: 1 } } });
ok('nothing else can ride along', r.code === 400);
r = await call('GET', { wants: '1' });
ok('the app can list them', r.body.wants.length === 1 && r.body.wants[0].ev === '55001' && r.body.wants[0].job.id === '91', JSON.stringify(r.body));
const rec = { v: 2, name: 'Qualification 12', round: 2, num: 12, red: job.red, blue: job.blue, vid: job.vid, off: 812, rate: 2, w: 640, h: 360, model: 'det1', at: 1, f: [[0, 0], [5, 1, 300, 165, 40, 30, 90, 1, 4660, 22136, 39612, 2]] };
r = await call('POST', {}, { passcode: 'correct horse battery', ev: '55001', id: '91', rec });
r = await call('GET', { wants: '1' });
ok('once the app has tracked it, it is no longer asked for', r.body.wants.length === 0, JSON.stringify(r.body));
r = await call('POST', {}, { want: { ev: '55001', job } });
ok('a match already tracked is not asked for again', r.body.tracked === true);
ok('the Jumper offers each match opened', /vtWatchWant\(ctx, m\);/.test(src) && /vtApi\('POST', '', \{ want: \{ ev: String\(ctx\.eventId\), job: vtJobClean\(j\) \} \}\)/.test(src));
ok('the app tracks them with the website\'s work, and on its own', /wants = wants_open\(site\)/.test(app) && /if not events and wants_open\(site\):/.test(app));
ok('a match that cannot be tracked is tried twice at most', /WANTS_TRIES = 2/.test(app));
ok('app 2.50 or later', /VERSION = '2\.(5\d|[6-9]\d)'/.test(app));
ok('release is v182 or later', /const APP_BUILD = 'v1(8[2-9]|9\d)'/.test(src));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
