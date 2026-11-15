// t116 — v109: the desktop app's side of the website.
// Work handed to the app, its recordings brought back in, and a finder it
// trained served to the tracker. The app itself is Python and is checked
// separately (a made-up match video through the whole pipeline, and its
// arithmetic compared with this page's, function by function).
import fs from 'fs';
import { boot, settle } from './harness.mjs';

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '\n         ' + detail : '')); }
};
const idx = fs.readFileSync('../index.html', 'utf8');
const app = fs.readFileSync('../desktop/vex_trainer.py', 'utf8');
const wk = fs.readFileSync('../vendor/vt-worker.js', 'utf8');
console.log('t116 — v109: desktop app');
const mod = await import('../api/tracker.js');

// ── the server ──
const store = {}, sets = {};
const realFetch = globalThis.fetch;
globalThis.fetch = async (u, o) => { const cmds = JSON.parse(o.body); return { ok: true, json: async () => cmds.map(c => {
  if (c[0] === 'SET') { store[c[1]] = c[2]; return { result: 'OK' }; }
  if (c[0] === 'GET') return { result: store[c[1]] ?? null };
  if (c[0] === 'DEL') { delete store[c[1]]; return { result: 1 }; }
  if (c[0] === 'SADD') { (sets[c[1]] = sets[c[1]] || new Set()).add(String(c[2])); return { result: 1 }; }
  if (c[0] === 'SREM') { (sets[c[1]] || new Set()).delete(String(c[2])); return { result: 1 }; }
  if (c[0] === 'SMEMBERS') return { result: [...(sets[c[1]] || [])] };
  return { result: null }; }) }; };
process.env.KV_REST_API_URL = 'https://db.example'; process.env.KV_REST_API_TOKEN = 't'; process.env.TRACKER_PASSCODE = 'correct-horse';
const call = async (method, query, body) => { let code = 0, out = null; const res = { setHeader() {}, status(c) { code = c; return this; }, json(j) { out = j; return this; } }; await mod.default({ method, query, body }, res); return { code, out }; };
const job = { id: '77', name: 'Qualification 5', round: 2, num: 5, vid: 'abcdefghijk', off: 1234, red: ['66449A', '1A'], blue: ['2B', '3C'], rs: 30, bs: 12, t: 1700000000000 };
{
  ok('a job is a match, a video and a second', mod.validJob(job) === null);
  ok('markup in a name is refused', mod.validJob({ ...job, name: '<script>' }) === 'bad name');
  ok('a link where a video id belongs is refused', mod.validJob({ ...job, vid: 'https://x.example/a' }) === 'bad job');
  ok('extra fields are refused', mod.validJob({ ...job, cmd: 'x' }) === 'unknown field');
  ok('without the admin key no work can be given', (await call('POST', {}, { passcode: 'wrong-wrong', jobs: { ev: '900', list: [job] } })).code === 403);
  ok('with it, work is saved', (await call('POST', {}, { passcode: 'correct-horse', jobs: { ev: '900', list: [job] } })).code === 200);
  ok('a bad job in the list refuses the list', (await call('POST', {}, { passcode: 'correct-horse', jobs: { ev: '901', list: [job, { ...job, vid: '!' }] } })).code === 400);
  const evs = await call('GET', { jobs: '1' });
  ok('the app can see which events have work', evs.out.events.join() === '900');
  const list = await call('GET', { jobs: '900' });
  ok('and the matches in one', list.out.list.length === 1 && list.out.list[0].off === 1234 && list.out.list[0].red[0] === '66449A');
  await call('POST', {}, { passcode: 'correct-horse', jobs: { ev: '900', done: true } });
  ok('finished work is cleared', (await call('GET', { jobs: '1' })).out.events.length === 0 && (await call('GET', { jobs: '900' })).out.list.length === 0);
}
{
  const b64 = Buffer.from('x'.repeat(3000)).toString('base64');
  ok('without the admin key no finder can be published', (await call('POST', {}, { passcode: 'wrong-wrong', model: { tag: 'u2611150101', i: 0, n: 1, b64 } })).code === 403);
  ok('nothing is in use until the last part arrives', (await call('POST', {}, { passcode: 'correct-horse', model: { tag: 'u2611150101', i: 0, n: 2, b64 } })).code === 200 && (await call('GET', { model: '1' })).out.model === null);
  await call('POST', {}, { passcode: 'correct-horse', model: { tag: 'u2611150101', i: 1, n: 2, b64, note: 'overall 91.0 vs 88.0 <b>' } });
  const cur = (await call('GET', { model: '1' })).out.model;
  ok('then it is', cur && cur.tag === 'u2611150101' && cur.n === 2 && !/[<>]/.test(cur.note), JSON.stringify(cur));
  ok('its parts can be read back', (await call('GET', { model: 'u2611150101', part: '1' })).out.b64 === b64);
  ok('a part that is not base64 is refused', (await call('POST', {}, { passcode: 'correct-horse', model: { tag: 'u2611150102', i: 0, n: 1, b64: '<script>' } })).code === 400);
  ok('an oversized part is refused', (await call('POST', {}, { passcode: 'correct-horse', model: { tag: 'u2611150102', i: 0, n: 1, b64: 'A'.repeat(950 * 1024) } })).code === 400);
  ok('a tag cannot be a path', (await call('GET', { model: '../x', part: '0' })).code === 400);
  await call('POST', {}, { passcode: 'correct-horse', model: { tag: 'u2611150103', i: 0, n: 1, b64 } });
  ok('a newer finder replaces it and the old parts are let go', (await call('GET', { model: '1' })).out.model.tag === 'u2611150103' && !store['vt:model:u2611150101:0']);
  await call('POST', {}, { passcode: 'correct-horse', model: { clear: true } });
  ok('it can be taken off again', (await call('GET', { model: '1' })).out.model === null);
}
globalThis.fetch = realFetch;

// ── the page ──
const { win } = await boot();
await settle(win);
const f = n => win.eval(n);
{
  const C = f('vtJobClean');
  const j = JSON.parse(JSON.stringify(C({ id: 77, name: 'Qualification 5 <b>', round: 2, num: 5, t: 5, vid: 'abcdefghijk', off: 1234.4, red: ['66449A', '1A'], blue: ['2B', '3C'], rs: 30, bs: 12, extra: 'x' })));
  ok('what the page sends as a job, the server accepts', mod.validJob(j) === null, String(mod.validJob(j)));
  ok('the score travels with it', j.rs === 30 && j.bs === 12 && j.off === 1234);
  // Importing: recordings the app saved come in and are summarised.
  const st = new Map(); win.__st116 = st;
  const pack = f('vtPackFrame'), fr = [];
  for (let i = 0; i < 300; i++) { const t = i * 0.5; fr.push(pack(t, [0, 1, 2, 3].map(r => [100 + r * 120 + 60 * Math.sin(t * 0.7 + r), 100 + 50 * Math.cos(t * 0.5 + r), 50, 50, 0.9, r < 2 ? 1 : 2, null, 0]), 640)); }
  win.__rec116 = { v: 2, name: 'Qualification 5', round: 2, num: 5, red: ['66449A', '1A'], blue: ['2B', '3C'], rs: 30, bs: 12, vid: 'abcdefghijk', off: 1234, rate: 4, w: 640, h: 360, model: 'det1', at: 1, f: fr, tm: [] };
  win.__posts116 = [];
  win.eval(`idbGet = async k => (__st116.has(k) ? JSON.parse(__st116.get(k)) : null); idbSet = async (k, v) => { __st116.set(k, JSON.stringify(v)); };
    lsSet(VT_PASS_KEY, 'correct-horse'); vtLearnMem = {};
    vtApi = async (m, q, body) => {
      if (m === 'POST') { __posts116.push(body); return { ok: true, status: 200, body: { ok: true } }; }
      if (q === '?jobs=1') return { ok: true, body: { events: ['900'] } };
      if (q === '?jobs=900') return { ok: true, body: { list: [{ id: '77' }, { id: '78' }] } };
      if (q === '?event=900') return { ok: true, body: { ids: ['77'] } };
      if (q === '?event=900&match=77') return { ok: true, body: { rec: __rec116 } };
      return { ok: true, body: {} };
    };`);
  const n = await f('vtAppImport')(false);
  ok('a recording the app saved is brought in', n === 1 && st.has('vt:m:900:77'));
  const sums = JSON.parse(st.get(f('VT_SUMS_KEY')) || '{}');
  ok('and summarised like one this device watched', sums['900:77'] && sums['900:77'].ok === 1, JSON.stringify(Object.keys(sums)));
  ok('its summary is saved for everyone', win.__posts116.some(p => p.sum && p.id === '77' && p.passcode === 'correct-horse'));
  ok('work is not cleared while a match is still to come', !win.__posts116.some(p => p.jobs && p.jobs.done));
  win.__posts116.length = 0;
  ok('a second pass brings in nothing new', await f('vtAppImport')(false) === 0 && !win.__posts116.some(p => p.sum));
  win.eval(`lsRemove(VT_PASS_KEY)`);
  ok('without the admin key nothing is imported', await f('vtAppImport')(false) === 0);
  ok('the app row is always there on a computer', /const appRow = `<div class="rw-hint" id="vtAppRow">/.test(idx) && (idx.match(/\$\{appRow\}/g) || []).length === 2);
  ok('only an admin gets the buttons; anyone else is told what is missing', /\$\{vtPass\(\) \? `<div class="rw-playall">/.test(idx) && /save the admin key on this device first/.test(idx));
  ok('sending work needs the key', /if \(!pass\) return say\('Save the admin key in Settings first/.test(idx));
  ok('the quiet import is not run on every redraw', /if \(quiet && Date\.now\(\) - vtImportAt < 60000\) return 0;/.test(idx));
}
// ── the finder the tracker loads ──
{
  ok('the tracker asks for a published finder', /fetch\('\/api\/tracker\?model=1'/.test(wk) && /InferenceSession\.create\(modelSrc,/.test(wk));
  ok('a finder that fails falls back to the built-in one', /catch \(e\) \{ if \(!custom\) throw e; modelSrc = BUILT_IN; custom = ''; await start\(\); \}/.test(wk));
  ok('fetching it never delays the start', /ready for the next start/.test(wk) && /setTimeout\(\(\) => ctl\.abort\(\), 4000\)/.test(wk));
  ok('the service worker keeps the fetched finder across releases', /k !== 'vt-models'/.test(fs.readFileSync('../sw.js', 'utf8')));
}
// ── the app as shipped ──
{
  const bat = fs.readFileSync('../desktop/VEX_Trainer.bat', 'utf8');
  ok('the launcher fetches the program from this site', /vex-scouting-by-max\.vercel\.app\/desktop\/vex_trainer\.py/.test(bat) && /\r\n/.test(bat));
  ok('the app sends the key only to the site\'s own endpoint', (app.match(/passcode/g) || []).length === 1 && /self\.base \+ '\/api\/tracker'/.test(app));
  ok('the app saves recordings in the website\'s format', /'v': 2/.test(app) && /def pack_frame/.test(app) && /'tm': \[\]/.test(app));
  ok('the app never publishes a finder by itself', /Type YES to publish it anyway/.test(app) && /if pick != '1':\s+return/.test(app));
  ok('the review page is only on this computer', /ThreadingHTTPServer\(\('127\.0\.0\.1', port\)/.test(app));
  // v112: Enter saves the admin key, in the app and on the website
  ok('Enter saves the key in the app', /id="keyIn"[^>]*onkeydown="if\(event\.key==='Enter'\)saveKey\(\)"/.test(app));
  ok('the app says what happened to the key, also when nothing answers', /Checking with the website/.test(app) && /did not answer/.test(app) && /Type the admin key first/.test(app));
  ok('Enter saves the key on the website', /id="vtPassInput"[^>]*onkeydown="if\(event\.key==='Enter'\)\{event\.preventDefault\(\);vtPassSave\(\);\}"/.test(idx));
  // v113: the app's speed
  ok('a robot already named is glanced at, not read every look', /if tr\['hits'\] >= 3:\s+return gap >= 3/.test(app));
  ok('a plate that never shows is tried once a second', /if tr\['hits'\] == 0 and tr\['tries'\] >= 12:\s+return gap >= 1/.test(app));
  ok('reading runs on the graphics card when it will take it, else the processor', /for wd in \(160, 320\):/.test(app) && /if self\.reader is None:/.test(app));
  ok('workers share the processor instead of fighting over it', /threads=max\(1, \(os\.cpu_count\(\) or 8\) \/\/ max\(1, int\(cfg\.get\('workers', 4\)\)\)\)/.test(app));
  // v111: the window
  ok('the app opens a window, not a menu', /def serve_ui\(/.test(app) && /if not args:[\s\S]{0,400}return serve_ui\(cfg\)/.test(app));
  ok('three main buttons: Track, Review, Train', (app.match(/<div class="card"><h2>/g) || []).length === 3);
  ok('the window is served to this computer only', /ThreadingHTTPServer\(\('127\.0\.0\.1', p\), H\)/.test(app));
  ok('every request needs the window\'s own token', /secrets\.compare_digest\(given, token\)/.test(app) && /if not self\._allowed\(u\):\s+return self\._send\(403/.test(app));
  ok('a request under another host name is refused', /if host not in \('127\.0\.0\.1', 'localhost'\):\s+return False/.test(app));
  ok('tracking starts with the window once the key is saved', /if cfg\.get\('key'\):\s+job\.start\('track', \['--track'\]\)/.test(app));
  ok('a new finder is published only if it measured better', /if info\['new'\]\[2\] <= info\['old'\]\[2\]:\s+return/.test(app));
  ok('a button can only start one of four known jobs', /return self\._send\(400, \{'error': 'unknown task'\}\)/.test(app));
}
ok('release is v109 or later', /const APP_BUILD = 'v1(09|[1-9]\d)'/.test(idx));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
