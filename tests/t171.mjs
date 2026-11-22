// t171 — v188 (app 2.53): Ask goes through the website: the question waits
// there, the owner's app takes it and answers.
import fs from 'fs';
import { boot, settle } from './harness.mjs';
let pass = 0, fail = 0;
const ok = (name, cond, detail) => { if (cond) { pass++; console.log('  ok   ' + name); } else { fail++; console.log('  FAIL ' + name + (detail ? '\n         ' + detail : '')); } };
const src = fs.readFileSync('../src/index.html', 'utf8'), app = fs.readFileSync('../desktop/vex_trainer.py', 'utf8');
console.log('t171 — v188');
const mod = await import('../api/tracker.js');
const kv = new Map(), lists = new Map();
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opt) => {
  const out = JSON.parse(opt.body).map(c => {
    const L = k => { if (!lists.has(k)) lists.set(k, []); return lists.get(k); };
    switch (c[0]) {
      case 'SET': kv.set(c[1], c[2]); return { result: 'OK' };
      case 'GET': return { result: kv.has(c[1]) ? kv.get(c[1]) : null };
      case 'DEL': kv.delete(c[1]); return { result: 1 };
      case 'LPUSH': L(c[1]).unshift(c[2]); return { result: L(c[1]).length };
      case 'LLEN': return { result: L(c[1]).length };
      case 'RPOP': return { result: L(c[1]).length ? L(c[1]).pop() : null };
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
let r = await call('POST', {}, { ask: { question: 'Who has the best auto?', table: 'team | auto\n66449A | 4', where: 'Excalibur', history: [] } });
ok('anyone can ask: the question waits on the website', r.code === 200 && /^[0-9a-f]{16}$/.test(r.body.id), JSON.stringify(r.body));
const id = r.body.id;
r = await call('GET', { ask: id });
ok('until the app answers, it is waiting (and no app has looked yet)', r.body.waiting === true && r.body.app === false, JSON.stringify(r.body));
r = await call('POST', {}, { asksTake: 1 });
ok('only the app (with the key) can take questions', r.code === 403);
r = await call('POST', {}, { passcode: 'correct horse battery', asksTake: 1 });
ok('the app takes it, with the table', r.body.asks.length === 1 && r.body.asks[0].question === 'Who has the best auto?' && r.body.asks[0].table.includes('66449A'), JSON.stringify(r.body));
r = await call('GET', { ask: id });
ok('now the website knows the app is open', r.body.waiting && r.body.app === true);
r = await call('POST', {}, { passcode: 'correct horse battery', askAnswer: { id, answer: '66449A: usually 4 pins.' } });
r = await call('GET', { ask: id });
ok('the answer comes back', r.body.answer === '66449A: usually 4 pins.', JSON.stringify(r.body));
r = await call('POST', {}, { ask: { question: 'x'.repeat(700), table: '' } });
ok('a question too long is refused', r.code === 400);
r = await call('POST', {}, { ask: { question: 'q', table: 'x'.repeat(200000) } });
ok('so is a table too big', r.code === 400);
globalThis.fetch = realFetch;
// The page: asks, waits, shows the answer.
const { win } = await boot();
await settle(win);
win.eval(`vtTeamSumsMany = async () => new Map(); window.__n = 0;
vtApi = async (m, q, b) => { if (m === 'POST') return { ok: true, body: { ok: true, id: 'abcdef0123456789' } };
  window.__n++; return { ok: true, body: window.__n < 2 ? { waiting: true, app: true } : { answer: '471A, usually 6 pins.' } }; };`);
win.document.body.insertAdjacentHTML('beforeend', win.eval('tAskBlock')({}));
win.eval(`window._tAskCtx = { R: { ratings: new Map(), event: { name: 'X' } }, seeds: [{ id: 1, number: '1A', eventRank: 1 }] }`);
win.document.getElementById('tAskInput').value = 'best auto?';
await win.eval('tAsk()');
const log = win.document.getElementById('tAskLog').textContent;
ok('the page shows the question and the answer', log.includes('best auto?') && log.includes('471A, usually 6 pins.'), log);
ok('the app takes questions every few seconds while its window is open', /def ask_relay\(cfg_get, stop\):/.test(app) && /target=ask_relay/.test(app) && /'asksTake': 1/.test(app));
ok('v189: the answer is asked for as JSON it must fill, thinking off, asked again with more room if empty', /'format': schema/.test(app) && /text, thought = once\(3000\)/.test(app));
ok('app 2.53 or later', /VERSION = '2\.(5[3-9]|[6-9]\d)'/.test(app));
ok('release is v188 or later', /const APP_BUILD = 'v1(8[8-9]|9\d)'/.test(src));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
