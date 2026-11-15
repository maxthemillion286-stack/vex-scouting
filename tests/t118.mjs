// t118 — v114: briefing, clips, review anywhere, organiser channels, and the
// tracker in the win chances.
import fs from 'fs';
import { boot, settle } from './harness.mjs';
let pass = 0, fail = 0;
const ok = (name, cond, detail) => { if (cond) { pass++; console.log('  ok   ' + name); } else { fail++; console.log('  FAIL ' + name + (detail ? '\n         ' + detail : '')); } };
const idx = fs.readFileSync('../index.html', 'utf8'), app = fs.readFileSync('../desktop/vex_trainer.py', 'utf8'), px = fs.readFileSync('../api/proxy.js', 'utf8');
console.log('t118 — v114');
const mod = await import('../api/tracker.js');

// ── the server ──
const store = {}, sets = {}, hashes = {};
const realFetch = globalThis.fetch;
globalThis.fetch = async (u, o) => { const cmds = JSON.parse(o.body); return { ok: true, json: async () => cmds.map(c => {
  const [op, k, a, b] = c;
  if (op === 'SET') { store[k] = a; return { result: 'OK' }; }
  if (op === 'GET') return { result: store[k] ?? null };
  if (op === 'DEL') { delete store[k]; return { result: 1 }; }
  if (op === 'SADD') { (sets[k] = sets[k] || new Set()).add(String(a)); return { result: 1 }; }
  if (op === 'SREM') { (sets[k] || new Set()).delete(String(a)); return { result: 1 }; }
  if (op === 'SCARD') return { result: (sets[k] || new Set()).size };
  if (op === 'SMEMBERS') return { result: [...(sets[k] || [])] };
  if (op === 'HSET') { (hashes[k] = hashes[k] || {})[a] = b; return { result: 1 }; }
  if (op === 'HGET') return { result: (hashes[k] || {})[a] ?? null };
  if (op === 'HDEL') { for (const f of c.slice(2)) delete (hashes[k] || {})[f]; return { result: 1 }; }
  if (op === 'HGETALL') return { result: Object.entries(hashes[k] || {}).flat() };
  return { result: null }; }) }; };
process.env.KV_REST_API_URL = 'https://db.example'; process.env.KV_REST_API_TOKEN = 't'; process.env.TRACKER_PASSCODE = 'correct-horse';
const call = async (method, query, body) => { let code = 0, out = null; const res = { setHeader() {}, status(c) { code = c; return this; }, json(j) { out = j; return this; } }; await mod.default({ method, query, body }, res); return { code, out }; };
const K = 'correct-horse';
{
  const jpg = '/9j/' + 'A'.repeat(400);
  const frame = { id: 'abcdefghijk_0123456789', w: 1280, h: 720, boxes: [[10, 20, 90, 90, 0.4]], b64: jpg };
  ok('a frame is a picture and boxes', mod.validFrame(frame) === null);
  ok('something that is not a JPEG is refused', mod.validFrame({ ...frame, b64: 'PHNjcmlwdD4' + 'A'.repeat(200) }) === 'not a jpeg');
  ok('markup where a picture belongs is refused', mod.validFrame({ ...frame, b64: '<svg onload=x>' + 'A'.repeat(200) }) === 'bad picture');
  ok('an oversized picture is refused', mod.validFrame({ ...frame, b64: '/9j/' + 'A'.repeat(600 * 1024) }) === 'bad picture');
  ok('boxes must be numbers', mod.validFrame({ ...frame, boxes: [['<b>', 1, 2, 3, 4]] }) === 'bad boxes');
  ok('without the admin key no frame can be sent', (await call('POST', {}, { passcode: 'nope-nope', frame })).code === 403);
  ok('with it, it waits for review', (await call('POST', {}, { passcode: K, frame })).code === 200 && (await call('GET', { frames: '1' })).out.ids.join() === frame.id);
  const got = await call('GET', { frame: frame.id });
  ok('a device fetches the frame to review', got.code === 200 && got.out.frame.w === 1280 && got.out.frame.b64 === jpg);
  ok('a correction needs the key', (await call('POST', {}, { passcode: 'nope-nope', label: { id: frame.id, skip: false, boxes: [[1, 2, 3, 4]] } })).code === 403);
  ok('a correction is saved', (await call('POST', {}, { passcode: K, label: { id: frame.id, skip: false, boxes: [[1, 2, 3, 4], [5, 6, 70, 80]] } })).code === 200);
  ok('the reviewed frame leaves the queue and its picture is let go', (await call('GET', { frames: '1' })).out.ids.length === 0 && (await call('GET', { frame: frame.id })).code === 404);
  const labs = (await call('GET', { labels: '1' })).out.labels;
  ok('the app can read the corrections', labs[frame.id] && labs[frame.id].boxes.length === 2 && labs[frame.id].skip === false);
  await call('POST', {}, { passcode: K, labelsdone: [frame.id] });
  ok('and clear them once it has them', Object.keys((await call('GET', { labels: '1' })).out.labels).length === 0);
  for (let i = 0; i < 300; i++) (sets['vt:frames'] = sets['vt:frames'] || new Set()).add('fill' + String(i).padStart(4, '0'));
  ok('the queue has a ceiling', (await call('POST', {}, { passcode: K, frame })).code === 409);
  sets['vt:frames'].clear();
}
{
  ok('a venue\'s channel is saved with the key', (await call('POST', {}, { passcode: K, chan: { key: 'cypressranchhigh|cypress', id: 'UC' + 'a'.repeat(22) } })).code === 200);
  ok('and without it is not', (await call('POST', {}, { passcode: 'nope-nope', chan: { key: 'x1y2|z', id: 'UC' + 'b'.repeat(22) } })).code === 403);
  ok('anyone can ask for it', (await call('GET', { chan: 'cypressranchhigh|cypress' })).out.id === 'UC' + 'a'.repeat(22));
  ok('an unknown venue has none', (await call('GET', { chan: 'nowhere|none' })).out.id === null);
  ok('a channel id must look like one', (await call('POST', {}, { passcode: K, chan: { key: 'abcd|e', id: 'https://evil.example' } })).code === 400);
  hashes['vt:team:66449A'] = { '900:1': JSON.stringify({ sv: 3, ok: 1, red: ['66449A'], blue: ['1A'] }) };
  const many = await call('GET', { teams: '66449A,1a,<x>' });
  ok('several teams are answered in one go', many.code === 200 && many.out.teams['66449A']['900:1'].ok === 1 && many.out.teams['1A'] && Object.keys(many.out.teams).length === 2, JSON.stringify(Object.keys(many.out.teams)));
  ok('a summary may carry its video', mod.validSum({ sv: 3, ok: 1, vid: 'abcdefghijk', of: 1234, red: ['66449A'], blue: ['1A'] }) === null && mod.validSum({ sv: 3, vid: 'https://x', red: [], blue: [] }) === 'bad video');
}
globalThis.fetch = realFetch;

// ── the page ──
const { win } = await boot();
await settle(win);
const f = n => win.eval(n);
// A team's matches, as summaries. `field` adds what a marked field gives.
const robot = (o = {}) => ({ sec: 100, am: 1, ap: 0.2, ar: 0.6, act: 0.02, opp: 0.3, prs: 0.05, prd: 0.05, stp: 3, es: 0.2, ea: 0.3, apt: 0.3, vis: 0.9, wa: 3, wb: 0, ...o });
const fieldBits = { th: 0.45, ts: 0.02, to: 0.01, qh: 0.1, qs: 0.05, qo: 0.02, qm: 0.1, tv: 3, td: 1, ca: 1, cw: 1, da: 1, dw: 1, gd: 20, gt: 40, rl: 1, rn: 1, eg: 1, art: 162 };
const mkSums = (num, n, field, extra = {}) => { const m = new Map(); for (let i = 0; i < n; i++) m.set('900:' + (i + 1), { sv: f('VT_SUM_V'), ok: 1, fq: field ? 1 : 0, name: 'Qualification ' + (i + 1), round: 2, num: i + 1, red: [num, '1A'], blue: ['2B', '3C'], rs: 40 + i, bs: 30, vid: 'abcdefghijk', of: 1000 * (i + 1), st: 12, dr: 30, ck: i % 2,
  R: { ...robot(), sw: 2, wk: 60 }, B: { ...robot(), sw: 0, wk: 40 }, Ra: robot(field ? { ...fieldBits, ...extra } : extra), Rb: robot({ wa: 0, wb: 3, ...(field ? { ...fieldBits, th: 0.02, qh: 0.6 } : {}) }), Ba: robot({ wa: 3 }), Bb: robot({ wa: 0, wb: 3 }) }); return m; };
{
  const B = f('vtBrief');
  const a = B('66449A', mkSums('66449A', 5, true));
  ok('with the field marked: the autonomous route is named', /→/.test(a.auto) && /5 of 5/.test(a.auto), a.auto);
  ok('a robot that sits on a toggle is called a toggle defender', /^Toggle defender: holds its own toggle/.test(a.strat), a.strat);
  ok('scoring speed is points per ten seconds of stacking', /points per 10 s of stacking/.test(a.speed), a.speed);
  const st = B('66449A', mkSums('66449A', 5, true, { th: 0.02, qh: 0.6 }));
  ok('one that works a quadrant is called a stacker', /^Stacker: works the pins in its own quadrant/.test(st.strat), st.strat);
  const pr = B('66449A', mkSums('66449A', 5, true, { th: 0.1, to: 0.2, qo: 0.25, qh: 0.1 }));
  ok('playing on the other side is said as pressure', /opponents' side to slow their scoring/.test(pr.strat), pr.strat);
  const b = B('66449A', mkSums('66449A', 4, false));
  ok('without the field marked it still says something true', /moved in 4 of 4/.test(b.auto) && /hal(f|ves)/.test(b.strat) && /\d+ a match/.test(b.speed), JSON.stringify(b));
  ok('and claims no role', !/Toggle|Stacker/.test(b.strat) && b.field === 0);
  ok('one match is not enough to brief on', B('66449A', mkSums('66449A', 1, true)).auto === '');
  ok('a team it never saw has nothing', B('9999Z', mkSums('66449A', 5, true)).n === 0);
}
{
  const C = f('vtClips'), clips = C('66449A', mkSums('66449A', 3, false));
  ok('each tracked match gives a clip', clips.length === 3 && clips[0].vid === 'abcdefghijk');
  ok('a clip starts three seconds before autonomous', clips[0].t === 1000 + 12 - 3, String(clips[0].t));
  ok('and says which alliance the team is on', clips[0].side === 'red');
  const old = mkSums('66449A', 2, false); for (const s of old.values()) delete s.vid;
  ok('a summary from before clips gives none, and is made again', C('66449A', old).length === 0 && /have\.vid !== undefined\) continue;/.test(idx));
  ok('a new summary records its video and where the match is', /vid: \/\^\[A-Za-z0-9_-\]\{6,20\}\$\/\.test\(String\(rec\.vid \|\| ''\)\) \? String\(rec\.vid\) : '', of: Math\.round\(rec\.off \|\| 0\)/.test(idx));
  ok('clips are offered on the team report and in the briefing', /Watch its autonomous runs \(\$\{clips\.length\}\)/.test(idx) && /▶ autonomous runs \(\$\{b\.clips\}\)/.test(idx));
}
{
  // The briefing, rendered.
  win.eval(`apiGet = async p => /\\/teams$/.test(p) ? [{ number: '66449A' }, { number: '1A' }, { number: '77Z' }] : [];
    window.__many118 = null; vtTeamSumsMany = async () => window.__many118; window._rwCtx = { eventId: 900, events: [{ id: 900, name: 'Test <b>Event</b>' }], matches: [] };`);
  win.__many118 = new Map([['66449A', mkSums('66449A', 5, true)], ['1A', mkSums('66449A', 5, true)], ['77Z', new Map()]]);
  await f('vtBriefingOpen')();
  const body = win.document.querySelector('#vtBriefOver .vt-over-body');
  ok('the briefing lists the teams it has watched', body && body.querySelectorAll('.vt-brief').length === 2, body && body.innerHTML.slice(0, 200));
  ok('with autonomous, strategy and scoring for each', /Autonomous/.test(body.textContent) && /Strategy/.test(body.textContent) && /Scoring/.test(body.textContent));
  ok('teams it has not watched are named, not hidden', /Not watched yet \(1\):<\/strong> 77Z/.test(body.innerHTML));
  ok('an event name cannot inject markup', !/<b>Event<\/b>/.test(body.innerHTML));
  f('vtOverlayClose')('vtBriefOver');
  ok('closing it clears it', win.document.getElementById('vtBriefOver').innerHTML === '');
  ok('a phone gets the briefing button too', /if \(vsIsPhone\(\)\) \{ panel\.innerHTML = `<div class="rw-block vt-block"><div class="detail-block-label">Scouting from video<\/div>\$\{briefRow\}<\/div>`; return; \}/.test(idx));
}
{
  // Review: the gestures.
  win.eval(`vtRev = { boxes: [[100, 100, 80, 80], [110, 110, 20, 20]], hist: [], drag: null, img: null }; vtRevDraw = () => {};`);
  const E = f('vtRevEdit');
  E({ x0: 115, y0: 115, x: 115, y: 115, w: 0, h: 0 }, 1280);
  ok('a tap removes the smallest box under it', JSON.stringify(win.eval('vtRev.boxes')) === '[[100,100,80,80]]');
  E({ x0: 400, y0: 300, x: 400, y: 300, w: 120, h: 90 }, 1280);
  ok('a drag draws a box', win.eval('vtRev.boxes.length') === 2 && win.eval('vtRev.boxes[1][2]') === 120);
  E({ x0: 900, y0: 600, x: 900, y: 600, w: 3, h: 2 }, 1280);
  ok('a tap on nothing changes nothing', win.eval('vtRev.boxes.length') === 2 && win.eval('vtRev.hist.length') === 2);
  f('vtRevUndo')(); f('vtRevUndo')();
  ok('undo steps back', win.eval('vtRev.boxes.length') === 2 && win.eval('vtRev.boxes[1][2]') === 20);
  ok('Settings offers the review', /onclick="vtReviewOpen\(\)">Review frames<\/button>/.test(idx));
  ok('reviewing needs the admin key', /if \(!vtPass\(\)\) \{ vtSettingsRefresh\('Save the admin key first/.test(idx));
  ok('the canvas takes touch as well as a mouse', /addEventListener\('pointerdown'/.test(idx) && /touch-action: none/.test(idx));
}
{
  // Organiser channels.
  const key = f('rwVenueKey');
  ok('a venue is keyed by its name and city', key({ location: { venue: 'Cypress Ranch High School', city: 'Cypress' } }) === 'cypressranchhighschool|cypress');
  ok('no venue, no key', key({ location: { city: 'Cypress' } }) === '' && key({}) === '');
  win.__posts118 = [];
  win.eval(`vtApi = async (m, q, b) => { if (m === 'POST') { __posts118.push(b); return { ok: true, body: {} }; } return { ok: true, body: { id: q.includes('shared') ? 'UC' + 's'.repeat(22) : null } }; }; lsRemove(RW_CHAN_KEY); lsSet(VT_PASS_KEY, 'correct-horse');`);
  const e0 = { location: { venue: 'Cypress Ranch High School', city: 'Cypress' } };
  ok('an unknown venue has no channel', await f('rwKnownChannel')(e0) === null);
  f('rwRememberChannel')(e0, 'UC' + 'a'.repeat(22));
  ok('a found stream\'s channel is remembered', await f('rwKnownChannel')(e0) === 'UC' + 'a'.repeat(22));
  ok('and shared, with the admin key', win.__posts118.length === 1 && win.__posts118[0].chan.key === 'cypressranchhighschool|cypress');
  f('rwRememberChannel')(e0, 'not-a-channel');
  ok('something that is not a channel id is not remembered', await f('rwKnownChannel')(e0) === 'UC' + 'a'.repeat(22));
  ok('another device learns it from the shared copy', await f('rwKnownChannel')({ location: { venue: 'Shared Hall', city: 'x' } }) === 'UC' + 's'.repeat(22));
  ok('the known channel is asked before any search', idx.indexOf("encodeURIComponent('channel:' + ch)") < idx.indexOf("encodeURIComponent('streams:' + e0.sku)") && /if \(e0\.sku && needPool && !viaChannel\)/.test(idx));
  ok('the proxy lists a channel inside the event\'s dates', /path\.startsWith\('channel:'\)/.test(px) && /source: 'yt-channel'/.test(px));
}
{
  // Tracking in the win chances.
  const A = f('sim_applyTracking'), S = f('sim_trackScore');
  const ratings = new Map(), count = new Map(), index = new Map();
  for (let i = 0; i < 10; i++) { ratings.set('t' + i, 20 + i * 2); count.set('t' + i, 6); index.set('t' + i, (i - 4.5) / 3); }
  ratings.set('new', 10); count.set('new', 1); index.set('new', 1.5);         // one match here, but the tracker rates it highly
  const before = ratings.get('new'), mid = ratings.get('t5');
  const res = A(ratings, count, index);
  ok('where video predicts ratings, it is used', res.used === 11 && res.fitOn === 10 && res.slope > 0, JSON.stringify(res));
  ok('a team with one match here moves toward what was seen of it', ratings.get('new') > before + 5, before + ' → ' + ratings.get('new'));
  ok('a team with many matches barely moves', Math.abs(ratings.get('t5') - mid) < 0.5);
  const r2 = new Map(), i2 = new Map();
  for (let i = 0; i < 10; i++) { r2.set('t' + i, 40 - i * 2); i2.set('t' + i, (i - 4.5) / 3); }
  const snap = JSON.stringify([...r2]);
  ok('where video does not predict this event, nothing changes', A(r2, count, i2).used === 0 && JSON.stringify([...r2]) === snap);
  ok('too few tracked teams, nothing changes', A(new Map(ratings), count, new Map([...index].slice(0, 5))).used === 0);
  const rows = new Map();
  for (let i = 0; i < 6; i++) rows.set('T' + i, [0, 1, 2].map(() => ({ act: 0.01 + i * 0.004, ap: 0.1 + i * 0.03, stp: 12 - i * 2 })));
  const sc = S(rows);
  ok('faster, further in autonomous and fewer stops scores higher', sc.get('T5') > sc.get('T3') && sc.get('T3') > sc.get('T0') && sc.get('T5') <= 2, JSON.stringify([...sc]));
  ok('a team with two tracked matches is not scored', !S(new Map([...rows, ['X', [{ act: 1, ap: 1, stp: 0 }, { act: 1, ap: 1, stp: 0 }]]])).has('X'));
  ok('the page says when video is in the chances', /<strong>Video included:<\/strong>/.test(idx));
  ok('it is applied after the season, with a time limit', /sim_applyTracking\(ratings, matchCount, await sim_trackIndex\(numById, 1500\)\)/.test(idx));
}
// ── the app ──
{
  ok('the app uses what the processor can carry', /cfg\['workers'\] = max\(2, min\(8, \(os\.cpu_count\(\) or 8\) \/\/ 2\)\)/.test(app) && /workers_chosen/.test(app));
  ok('video is decoded on the graphics card only after it proves itself', /CAP_PROP_HW_ACCELERATION, cv2\.VIDEO_ACCELERATION_ANY/.test(app) && /3000 <= at <= 9000/.test(app) && /if self\.cap is None:\s+self\.cap = cv2\.VideoCapture\(path\)/.test(app));
  ok('the app sends frames for review and brings corrections back', /def push_review/.test(app) && /def pull_labels/.test(app) && /sync_review\(cfg\)\s+# corrections made on a phone count too/.test(app));
  ok('pictures are shrunk before they are sent', /min\(1\.0, 960 \/ w\)/.test(app) && /IMWRITE_JPEG_QUALITY, 72/.test(app));
}
ok('release is v114 or later', /const APP_BUILD = 'v1(1[4-9]|[2-9]\d)'/.test(idx));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
