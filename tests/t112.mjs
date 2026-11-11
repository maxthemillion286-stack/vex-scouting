// t112 — v91: the robot tracker, stage 1.
// The capture itself needs a real browser and a real video; what is tested
// here is everything around it: the finder's arithmetic, what gets queued,
// what is stored, and who may store it.
import fs from 'fs';
import { boot, settle } from './harness.mjs';

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '\n         ' + detail : '')); }
};
const idx = fs.readFileSync('../index.html', 'utf8');
const sw = fs.readFileSync('../sw.js', 'utf8');
console.log('t112 — v91: robot tracker, stage 1');

const { win, errors } = await boot();

console.log('\n· the finder\'s arithmetic');
{
  const lb = win.vtLetterbox(1280, 720);
  ok('a 16:9 frame is letterboxed into the square', lb.nw === 640 && lb.nh === 360 && lb.px === 0 && lb.py === 140 && lb.s === 0.5, JSON.stringify(lb));
  // Two candidates on one robot and one weak one, in the model's (5, N) layout.
  const n = 4, d = new Float32Array(5 * n);
  const put = (i, cx, cy, w, h, s) => { d[i] = cx; d[n + i] = cy; d[2 * n + i] = w; d[3 * n + i] = h; d[4 * n + i] = s; };
  put(0, 320, 320, 40, 30, 0.9); put(1, 322, 321, 40, 30, 0.6); put(2, 100, 200, 20, 20, 0.1); put(3, 500, 400, 30, 30, 0.5);
  const dec = win.vtDecode(d, n, lb, 1280, 720, 0.35);
  ok('weak candidates are dropped', dec.length === 3);
  ok('boxes come back in the source frame\'s pixels', Math.abs(dec[0][0] - 600) < 1e-6 && Math.abs(dec[0][1] - 330) < 1e-6 && dec[0][2] === 80 && dec[0][3] === 60, JSON.stringify(dec[0]));
  const kept = win.vtNMS(dec, 0.5);
  ok('overlapping boxes on one robot become one, the surer one', kept.length === 2 && Math.abs(kept[0][4] - 0.9) < 1e-6);
  ok('a box hanging off the frame is clipped', (() => { const e = new Float32Array(5); e[0] = 5; e[1] = 320; e[2] = 40; e[3] = 40; e[4] = 0.9; const b = win.vtDecode(e, 1, lb, 1280, 720, 0.35)[0]; return b[0] === 0 && b[2] === 50; })());

  const W = 60, H = 40, px = new Uint8ClampedArray(W * H * 4);
  const fill = (x0, x1, r, g, b) => { for (let y = 0; y < H; y++) for (let x = x0; x < x1; x++) { const i = (y * W + x) * 4; px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = 255; } };
  fill(0, 20, 230, 30, 30); fill(20, 40, 30, 50, 230); fill(40, 60, 120, 120, 120);
  ok('a red plate reads as red, a blue one as blue, grey as neither',
    win.vtColorOf(px, W, H, [0, 0, 20, 40]) === 1 && win.vtColorOf(px, W, H, [20, 0, 20, 40]) === 2 && win.vtColorOf(px, W, H, [40, 0, 20, 40]) === 0);
  ok('half red and half blue is not guessed', win.vtColorOf(px, W, H, [10, 0, 20, 40]) === 0);

  const fr = win.vtPackFrame(12.34, [[600, 330, 80, 60, 0.9, 1]], 1280);
  ok('a frame is stored as integers at a 640-wide scale', JSON.stringify(fr) === '[123,1,300,165,40,30,90,1]', JSON.stringify(fr));
  ok('stats count frames that had a robot', (() => { const s = win.vtRecStats({ f: [[0, 0], [1, 2, 1, 1, 1, 1, 90, 1, 2, 2, 2, 2, 80, 2]] }); return s.frames === 2 && s.withRobot === 1 && s.perFrame === 2; })());
  ok('the finder runs in its own worker, one per match watched', /new Worker\('\/vendor\/vt-worker\.js' \+ \(cpu \? '\?cpu' : ''\)\)/.test(idx) && fs.existsSync('../vendor/vt-worker.js') && /numThreads = 1/.test(fs.readFileSync('../vendor/vt-worker.js', 'utf8')));
}

console.log('\n· what gets watched');
{
  ok('jsdom is not a place the tracker runs', win.vtSupported() === false);
  ok('it needs tab capture with a crop', /getDisplayMedia/.test(idx) && /typeof window\.CropTarget !== 'undefined'/.test(idx) && /track\.cropTo\(await window\.CropTarget\.fromElement/.test(idx));
  const t0 = Date.parse('2026-02-28T15:00:00Z');
  const M = (id, round, t, extra) => ({ id, name: (round === 2 ? 'Qualification ' : 'Practice ') + id, round, num: id, t, redNums: ['66449a', '1234X'], blueNums: ['12345B', "77'7Z"], redScore: 10, blueScore: 8, ...extra });
  const day = win.rwDayKey(t0);
  win._rwCtx = { team: null, events: [{ id: 55001, name: 'E' }], eventId: 55001, matches: [M(1, 2, t0), M(2, 2, t0 + 600000), M(3, 1, t0 + 1200000)],
    cal: { [day]: { videoId: 'abcDEF12345', platform: 'youtube', anchorMs: t0, anchorSeconds: 100 } } };
  let q = win.vtQueueFrom(win._rwCtx);
  ok('qualification matches with a video position are queued, in order', q.length === 2 && q[0].id === '1' && q[1].id === '2', JSON.stringify(q.map(m => m.id)));
  ok('at the Jumper\'s own position', q[0].off === 100 && q[1].off === 700);
  ok('practice is not', !q.some(m => m.id === '3'));
  ok('team numbers are narrowed to letters and digits', q[0].red[0] === '66449A' && q[0].blue[1] === '777Z');
  // v93: a posted schedule is not a played match.
  const unplayed = { ...win._rwCtx, matches: [M(7, 2, t0, { redScore: 0, blueScore: 0, exact: false }), M(8, 2, t0, { redScore: null, blueScore: null }), M(9, 2, Date.now() + 86400000)] };
  win._rwCtx = unplayed;
  ok('an unplayed match is never queued, even with a video position', win.vtQueueFrom(unplayed).length === 0);
  ok('played means scored and in the past', win.vtPlayed(M(1, 2, t0)) && !win.vtPlayed(M(1, 2, t0, { redScore: null })) && win.vtPlayed(M(1, 2, t0, { redScore: 0, blueScore: 0, exact: true })));
  win._rwCtx = unplayed; win.vsIsPhone = () => false; win.vtSupported = () => true;
  await win.vtRender(); await settle(win, 100);
  const pnl = win.document.getElementById('vtPanel').innerHTML;
  ok('for an event not yet played, the one button tracks the teams\' earlier matches', /vtStart\('history'\)/.test(pnl) && !/vtStart\('here'\)/.test(pnl) && /class="btn btn-primary" onclick="vtStart\('history'\)"/.test(pnl), pnl.slice(0, 300));
  ok('and says why', /no played matches with video yet/.test(pnl));
  win._rwCtx = { ...unplayed, matches: [M(1, 2, t0), M(2, 2, t0 + 600000), M(3, 1, t0 + 1200000)] };
  win._rwCtx.cal[day].platform = 'vimeo';
  ok('only YouTube can be watched', win.vtQueueFrom(win._rwCtx).length === 0);
  win._rwCtx.cal[day] = { videoId: 'x"><script>', platform: 'youtube', anchorMs: t0, anchorSeconds: 100 };
  ok('a video id that is not one is refused', win.vtQueueFrom(win._rwCtx).length === 0);
  ok('no event, no queue', win.vtQueueFrom(null).length === 0 && win.vtQueueFrom({}).length === 0);
  ok('the panel is outside the Jumper\'s results, which are re-rendered', /<div id="rwResults"><\/div>\s*<div id="vtPanel"><\/div>/.test(idx));
  ok('already-tracked matches are skipped, here or shared', /local\[m\.id\]\.s === 'done'\) \|\| shared\.includes\(m\.id\)\) run\.skipped\+\+/.test(idx));
  ok('a recording with almost no robots is not saved', /if \(st\.withRobot < VT_MIN_FRAMES\)/.test(idx));
  ok('the computer is kept awake', /navigator\.wakeLock\.request\('screen'\)/.test(idx));
  ok('the timer survives a background tab', /new Worker\(URL\.createObjectURL/.test(idx));
  ok('up to four matches at once, never more than half the cores', win.vtParallel() >= 1 && win.vtParallel() <= 4 && /Math\.floor\(cores \/ 2\)/.test(idx));
  ok('each player reads its own share of the one captured picture', /sq\.drawImage\(video, sx, sy, w, h, lb\.px, lb\.py, lb\.nw, lb\.nh\)/.test(idx));
  ok('an unplayed event can be prepared for from its teams\' earlier events', /async function vtHistoryPlan/.test(idx) && /if \(!\(end < Date\.now\(\)\)\) continue;/.test(idx) && /plan\.want\.has\(n\)/.test(idx));
  ok('the feeder does not run far ahead of the players', /run\.queue\.length > 3 \* run\.slots\.length/.test(idx));
  ok('the model and runtime are in the repo', fs.statSync('../models/robot_detector.onnx').size > 5e6 && fs.statSync('../vendor/ort/ort-wasm-simd-threaded.wasm').size > 5e6 && fs.existsSync('../vendor/ort/ort.wasm.min.js') && fs.existsSync('../vendor/ort/ort-wasm-simd-threaded.mjs'));
  ok('and are not copied into the service worker\'s cache', /url\.pathname\.startsWith\('\/vendor\/'\) \|\| url\.pathname\.startsWith\('\/models\/'\)\) return;/.test(sw));
  ok('shared storage is never answered from cache', /startsWith\('\/api\/tracker'\)/.test(sw));
  ok('neither is fetched until Start', !/<script[^>]+vendor\/ort/.test(idx));
}

console.log('\n· event codes that begin VE-');
{
  ok('a VE- code is a code, not a name to search for', win.eval('VS_SKU_RE').test('VE-V5-26-65786') && win.eval('VS_SKU_RE').test('RE-V5RC-25-0191') && !win.eval('VS_SKU_RE').test('Excalibur Robotics'));
  ok('and links to its event page', /VE-V5-26-65786\.html$/.test(win.reEventUrl('ve-v5-26-65786')));
  ok('no check is left that insists on RE-', !/\/\^RE-/.test(idx) && !/\/\^RE-/.test(fs.readFileSync('../api/proxy.js', 'utf8')));
  ok('Track robots goes by the event\'s id, not by searching for its code', /onclick="vtAuto\('\$\{teamAttr\(tournamentEventId\)\}'\)"/.test(idx) && /await rewatchSelectEvent\(Number\(id\)\);/.test(idx));
  // v95: one click, allow the share, and it goes.
  const auto = idx.slice(idx.indexOf('async function vtAuto'), idx.indexOf('async function vtStart'));
  ok('the share is asked for before anything slow', auto.indexOf('const asking = vtAskShare()') > 0 && auto.indexOf('const asking = vtAskShare()') < auto.indexOf('const opening = vtOpenEvent(eventId)'));
  ok('it picks this event\'s matches or the teams\' earlier ones by itself', /let mode = 'history';/.test(auto) && /mode = 'here';/.test(auto) && /await vtStart\(mode, stream\);/.test(auto));
  ok('a share that is not used is let go', /if \(granted\) granted\.getTracks\(\)\.forEach\(t => t\.stop\(\)\)/.test(idx));
  ok('a run has a clear Stop, a progress bar and says it ends by itself', /class="btn btn-primary vt-stop" onclick="vtStop\(\)">Stop tracking</.test(idx) && /id="vtBar"/.test(idx) && /It stops by itself when everything is watched/.test(idx));
  ok('an earlier event with no stream is skipped at once, not waited on', !/i < 90 && !run\.stop/.test(idx) && /run\.phase = 'no stream found, skipped'/.test(idx));
  ok('and the run says which events those were', /run\.noVideoNames\.slice\(0, 4\)/.test(idx));
  ok('an idle player says it is waiting, instead of sitting black', /\.vt-player\.vt-idle::after \{ content: 'Waiting for a match with video'/.test(idx));
  ok('players get the full width and are never under 200px, where YouTube will not play', /\.vt-stage \{ display: grid; grid-template-columns: 1fr;/.test(idx) && /\.vt-player \{ min-width: 200px; min-height: 200px; \}/.test(idx));
  ok('a player that is not playing says why, and is reloaded if pushing does not help', /'ready, not playing'/.test(idx) && /if \(pushes % 3 === 0\) \{ player\.loadVideoById/.test(idx));
  // v98: looks a second.
  const wk = fs.readFileSync('../vendor/vt-worker.js', 'utf8');
  ok('the finder tries the graphics card and proves it on a real run first', /ort\.webgpu\.min\.js', \['webgpu'\]/.test(wk) && /One real run before it is trusted/.test(wk) && /ort\.wasm\.min\.js', \['wasm'\]/.test(wk));
  ok('a graphics card that hangs is given up on, and not tried again', /boot\(false, VT_GPU_WAIT_MS\)/.test(idx) && /catch \(e\) \{ vtGpuBad = true; \}/.test(idx) && /boot\(true, 120000\)/.test(idx));
  ok('the graphics-card runtime is in the repo', fs.existsSync('../vendor/ort/ort.webgpu.min.js') && fs.statSync('../vendor/ort/ort-wasm-simd-threaded.asyncify.wasm').size > 5e6);
  ok('a look is not tied to the player\'s four position reports a second', /const est = apiT \+ Math\.min\(0\.6, \(performance\.now\(\) - apiAt\) \/ 1000 \* VT_RATE\);/.test(idx) && !/t === lastT/.test(idx));
  ok('what is stored stays under the server\'s frame limit', 150 * 6 <= 2000 && /VT_MAX_LOOKS_PER_SEC = 6;/.test(idx));
  ok('the preview is drawn every screen frame, not once per look', /requestAnimationFrame\(paint\)/.test(idx));
  ok('the run reports looks a second and which chip is doing them', /looks a second on the \$\{run\.backend/.test(idx));
  ok('progress shows in the tab title, and so does finishing', /tracking · \$\{VT_TITLE\}/.test(idx) && /'Tracking finished · '/.test(idx));
}

console.log('\n· shared storage and the passcode');
{
  const mod = await import('../api/tracker.js');
  const calls = [];
  const realFetch = globalThis.fetch;
  const db = new Map(), sets = new Map();
  globalThis.fetch = async (url, opt) => {
    calls.push({ url, auth: opt.headers.Authorization });
    const out = JSON.parse(opt.body).map(c => {
      if (c[0] === 'SET') { db.set(c[1], c[2]); return { result: 'OK' }; }
      if (c[0] === 'GET') return { result: db.get(c[1]) || null };
      if (c[0] === 'SADD') { if (!sets.has(c[1])) sets.set(c[1], new Set()); sets.get(c[1]).add(c[2]); return { result: 1 }; }
      if (c[0] === 'SMEMBERS') return { result: [...(sets.get(c[1]) || [])] };
      return { error: 'unknown' };
    });
    return { ok: true, status: 200, json: async () => out };
  };
  const call = async (method, query, body) => {
    const res = { code: 0, body: null, setHeader() {}, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
    await mod.default({ method, query: query || {}, body }, res);
    return res;
  };
  const rec = { v: 1, name: 'Qualification 1', round: 2, num: 1, red: ['66449A', '1234X'], blue: ['12345B', '777Z'], rs: 10, bs: 8, vid: 'abcDEF12345', off: 100, rate: 2, w: 640, h: 360, model: 'det1', at: 1, f: [[0, 0], [5, 1, 300, 165, 40, 30, 90, 1]] };
  const E = process.env;
  delete E.KV_REST_API_URL; delete E.KV_REST_API_TOKEN; delete E.UPSTASH_REDIS_REST_URL; delete E.UPSTASH_REDIS_REST_TOKEN; delete E.TRACKER_PASSCODE;
  let r = await call('GET', { status: '1' });
  ok('with nothing set up it says so', r.code === 200 && r.body.db === false && r.body.passcode === false);
  r = await call('GET', { event: '55001' });
  ok('and reading answers empty, not an error', r.code === 200 && r.body.ids.length === 0 && calls.length === 0);
  r = await call('POST', {}, { passcode: 'anything-at-all', ev: '55001', id: '1', rec });
  ok('nothing can be saved with no passcode on the server', r.code === 403);

  E.KV_REST_API_URL = 'https://db.example/'; E.KV_REST_API_TOKEN = 'tok'; E.TRACKER_PASSCODE = 'correct horse battery';
  r = await call('GET', { status: '1' });
  ok('set up, it says so', r.body.db === true && r.body.passcode === true);
  ok('the status never includes the passcode or token', !/correct|tok/.test(JSON.stringify(r.body)));
  r = await call('POST', {}, { passcode: 'wrong', ev: '55001', id: '1', rec });
  ok('a wrong passcode is refused', r.code === 403 && calls.length === 0);
  r = await call('POST', {}, { ev: '55001', id: '1', rec });
  ok('and so is none', r.code === 403);
  r = await call('POST', {}, { passcode: 'correct horse battery', check: true });
  ok('the right one checks out', r.code === 200 && r.body.ok === true);
  r = await call('POST', {}, { passcode: 'correct horse battery', ev: '55001', id: '1', rec });
  ok('and saves', r.code === 200 && db.has('vt:m:55001:1') && sets.get('vt:ev:55001').has('1'));
  ok('through the database\'s REST pipeline, with its token', calls[0].url === 'https://db.example/pipeline' && calls[0].auth === 'Bearer tok');
  r = await call('GET', { event: '55001' });
  ok('anyone can list what is tracked', r.code === 200 && r.body.ids.join() === '1');
  r = await call('GET', { event: '55001', match: '1' });
  ok('and read a match', r.code === 200 && r.body.rec.f.length === 2);
  r = await call('GET', { event: '55001', match: '2' });
  ok('an untracked match is a 404', r.code === 404);
  r = await call('GET', { event: "1;DROP" });
  ok('an event id that is not a number is refused', r.code === 400);
  const bad = async over => (await call('POST', {}, { passcode: 'correct horse battery', ev: '55001', id: '9', rec: { ...rec, ...over } })).code;
  ok('markup in a record is refused', await bad({ red: ['<script>'] }) === 400 && await bad({ vid: 'a b' }) === 400);
  ok('unknown fields are refused', await bad({ html: '<b>' }) === 400);
  ok('frames that are not integers are refused', await bad({ f: [[0, 1, 'x', 1, 1, 1, 1, 1]] }) === 400 && await bad({ f: [[0, 2, 1, 1, 1, 1, 1, 1]] }) === 400);
  ok('a different version is refused', await bad({ v: 2 }) === 400);
  ok('nothing bad was stored', !db.has('vt:m:55001:9'));
  E.TRACKER_PASSCODE = 'short';
  r = await call('POST', {}, { passcode: 'short', check: true });
  ok('a passcode under eight characters does not count as one', r.code === 403);
  const src = fs.readFileSync('../api/tracker.js', 'utf8');
  ok('passcodes are compared in constant time', /crypto\.timingSafeEqual/.test(src));
  ok('a wrong guess costs time', /setTimeout\(r, 400\)/.test(src));
  ok('the other spelling of the database variables works', /UPSTASH_REDIS_REST_URL/.test(src) && /UPSTASH_REDIS_REST_TOKEN/.test(src));
  globalThis.fetch = realFetch;
  delete E.KV_REST_API_URL; delete E.KV_REST_API_TOKEN; delete E.TRACKER_PASSCODE;
}

console.log('\n· settings, and the top tabs');
{
  ok('Settings has a passcode box', !!win.document.getElementById('vtPassInput') && win.document.getElementById('vtPassInput').type === 'password');
  win.switchTab('settings');
  await settle(win, 200);
  ok('and says where things stand', /shared storage|passcode/i.test(win.document.getElementById('vtSetState').textContent), win.document.getElementById('vtSetState').textContent);
  ok('the passcode is listed on the privacy page', /robot tracker's passcode/.test(fs.readFileSync('../privacy.html', 'utf8')) && /The robot tracker<\/h2>/.test(fs.readFileSync('../privacy.html', 'utf8')));
  ok('the passcode is only ever sent to this site\'s own endpoint', (idx.match(/vtPass\(\)/g) || []).length <= 4 && /fetch\('\/api\/tracker'/.test(idx));
  ok('no errors', errors.length === 0, errors.join('\n'));
}
win.close();
console.log(`\nt112: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
