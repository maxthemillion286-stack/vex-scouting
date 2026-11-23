// t114 — v106: the stream's clock, and live tracking.
// The clock is read off the stream's overlay; here the readings are made up,
// to check that the periods follow them and that waiting clocks are ignored.
import fs from 'fs';
import { boot, settle } from './harness.mjs';

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '\n         ' + detail : '')); }
};
const idx = fs.readFileSync('../src/index.html', 'utf8');
console.log('t114 — v106: clock and live');

const { win } = await boot();
await settle(win);
const f = n => win.eval(n);

// ── reading the clock ──
{
  const T = f('vtTimerText');
  ok('1:45 is 105 seconds', T('1:45') === 105);
  ok('0:07 is 7 seconds', T('0:07') === 7);
  ok('spaces around it are fine', T(' 0:15 ') === 15);
  ok('a score is not a clock', T('87') === null && T('15') === null);
  ok('a time of day is not a match clock', T('10:45') === null && T('3:15') === null);
  ok('a match name is not a clock', T('Qualification 12') === null);
  ok('nothing is nothing', T('') === null && T(null) === null);
}
{
  const L = f('vtLabelOf');
  const got = L([{ text: '66449A' }, { text: 'Qualification 14' }, { text: '1:02' }]);
  ok('the match name is picked out of everything read', got && got.round === 2 && got.num === 14, JSON.stringify(got));
  ok('no match name, no label', L([{ text: '1:02' }, { text: '54' }]) === null);
}

// ── periods from the clock ──
{
  const P = f('vtPhases');
  // Still robots: movement alone finds nothing useful.
  const still = Array.from({ length: 200 }, (_, k) => ({ t: k, s: { 1: [null, null], 2: [null, null] } }));
  const base = P(still, true, null);
  ok('with no clock it says so', base.clock === false);
  // Autonomous began at 40 s, driver at 62 s. Read every 5 s.
  const tm = [];
  for (let t = 42; t < 55; t += 5) tm.push(t * 10, 15 - (t - 40));
  for (let t = 57; t < 62; t += 5) tm.push(t * 10, 0);                 // sitting at 0:00 between periods
  tm.push(600, 105);                                                    // sitting at 1:45 before driver
  for (let t = 65; t < 165; t += 5) tm.push(t * 10, 105 - (t - 62));
  const ph = P(still, true, tm);
  ok('driver control starts where the clock says', ph.driver === 62, JSON.stringify(ph));
  ok('autonomous starts where the clock says', ph.start === 40, JSON.stringify(ph));
  ok('it is marked as read from the clock', ph.clock === true);
  ok('the match ends 1:45 after driver began', ph.end === 167);
  // One misread digit does not move it.
  const bad = tm.slice(); bad[bad.length - 9] = 14 + 16;               // wrong reading mid-driver
  ok('one misread does not move the start', P(still, true, bad).driver === 62);
  // Two readings are not enough to trust.
  ok('too few readings are not trusted', P(still, true, [650, 102, 700, 97]).clock === false);
  // A clock stuck at 1:45 for a long time says nothing.
  const stuck = []; for (let t = 0; t < 60; t += 5) stuck.push(t * 10, 105);
  ok('a waiting clock is ignored', P(still, true, stuck).clock === false);
  // Driver clock only: autonomous is placed just before it.
  const drvOnly = []; for (let t = 65; t < 165; t += 5) drvOnly.push(t * 10, 105 - (t - 62));
  const d = P(still, true, drvOnly);
  ok('with only the driver clock, autonomous is put before it', d.driver === 62 && d.start < 62 && d.start >= 62 - 80, JSON.stringify(d));
}

// ── the summary carries it ──
{
  const S = f('vtSummarise'), pack = f('vtPackFrame');
  const mk = tm => {
    const fr = [];
    for (let i = 0; i < 400; i++) {
      const t = i * 0.5, m = t - 30;
      const rx = m < 0 ? 100 : m < 15 ? 100 + m * 10 : 250 + 40 * Math.sin(t), bx = m < 20 ? 540 : 400 + 40 * Math.cos(t);
      fr.push(pack(t, [[rx, 100, 50, 50, 0.9, 1, null, 0], [rx, 220, 50, 50, 0.9, 1, null, 0], [bx, 100, 50, 50, 0.9, 2, null, 0], [bx, 220, 50, 50, 0.9, 2, null, 0]], 640));
    }
    return { v: 2, name: 'Qualification 3', round: 2, num: 3, red: ['66449A', '1A'], blue: ['2B', '3C'], rs: 20, bs: 10, vid: 'abcdefghijk', off: 0, rate: 2, w: 640, h: 360, model: 'x', at: 1, f: fr, tm };
  };
  const tm = []; for (let t = 55; t < 150; t += 5) tm.push(t * 10, 105 - (t - 52));
  const a = S(mk(tm), null), b = S(mk([]), null), c = S(mk(undefined), null);
  ok('a summary made with the clock is marked', a.ok === 1 && a.ck === 1 && a.dr === 52, JSON.stringify({ ok: a.ok, ck: a.ck, dr: a.dr }));
  ok('one made without is marked too', b.ok === 1 && b.ck === 0);
  ok('a recording from before clocks still summarises', c.ok === 1 && c.ck === 0);
}

// ── the server takes it ──
{
  const mod = await import('../api/tracker.js');
  const rec = { v: 2, name: 'Q1', vid: 'abcdefghijk', off: 0, rate: 1, w: 640, h: 360, red: ['66449A'], blue: ['1A'], f: [[0, 0]], tm: [100, 105, 150, 100], rs: null, bs: null, wide: 1 };
  ok('a recording with clock readings is accepted', mod.validRec(rec) === null, String(mod.validRec(rec)));
  ok('a live recording has no score yet and is accepted', mod.validRec({ ...rec, tm: [] }) === null);
  ok('clock readings must be whole numbers', mod.validRec({ ...rec, tm: [1.5, 2] }) === 'bad clock');
  ok('clock readings must come in pairs', mod.validRec({ ...rec, tm: [1, 2, 3] }) === 'bad clock');
  ok('clock readings cannot be text', mod.validRec({ ...rec, tm: ['<b>', 2] }) === 'bad clock');
  ok('a flood of clock readings is refused', mod.validRec({ ...rec, tm: new Array(402).fill(1) }) === 'bad clock');
  ok('a summary marked as clock-read is accepted', mod.validSum({ sv: 3, ck: 1, red: ['66449A'], blue: ['1A'] }) === null);
}

// ── live ──
{
  ok('there is a live loop', /async function vtLiveLoop\(run, slot, ctx, ev\)/.test(idx));
  ok('live watches one stream at normal speed', /mode === 'live' \? 1 : vtParallel\(\)/.test(idx) && /setPlaybackRate\(1\)/.test(idx));
  ok('a new match name ends the last recording and starts the next', /await finish\(\); cur = begin\(label, now\);/.test(idx));
  ok('a recording is closed after five and a half minutes at most', /now - cur\.t0 > VT_WINDOW_WIDE\) await finish\(\)/.test(idx));
  ok('live and watching save through the same step', (idx.match(/await vtKeep\(run, /g) || []).length === 2);
  ok('the tracker box offers Track live', /onclick="vtStart\('live'\)">Track live</.test(idx));
  ok('a team view does not offer live', /\$\{ctx\.team \? '' : `<button class="btn btn-secondary" onclick="vtStart\('history'\)">Track these teams' earlier matches<\/button> <button class="btn btn-secondary" onclick="vtStart\('live'\)">/.test(idx));
  ok('a match saved without a score is remembered as such', /idx\[id\]\.ns = 1/.test(idx));
  ok('scores are filled in before summaries are refreshed', /vtScoreFill\(ev, ctx\)\.catch\(\(\) => \{\}\)\.then\(\(\) => vtBackfill\(ev\)\)/.test(idx));
  ok('plates are read live as well', (idx.match(/await vtPlates\(run, slot, video, sx, sy, boxes/g) || []).length === 2);
  ok('with no stream known, live says what to do', /No stream is known for this event yet/.test(idx));
}

// ── a late score is filled in ──
{
  const store = new Map();
  win.eval(`idbGet = async k => (window.__st.has(k) ? JSON.parse(window.__st.get(k)) : null); idbSet = async (k, v) => { window.__st.set(k, JSON.stringify(v)); };`.replace(/window\.__st/g, '__st114'));
  win.__st114 = store;
  const S = f('vtLocalSave'), F = f('vtScoreFill'), I = f('vtLocalIndex');
  const rec = { v: 2, name: 'Qualification 7', round: 2, num: 7, red: ['66449A', '1A'], blue: ['2B', '3C'], rs: null, bs: null, vid: 'abcdefghijk', off: 0, rate: 1, w: 640, h: 360, f: [], tm: [], wide: 1 };
  await S('900', '77', rec, 'done');
  ok('saved without a score, flagged', (await I('900'))['77'].ns === 1);
  ok('nothing changes while the score is not posted', await F('900', { matches: [{ id: 77, redScore: null, blueScore: null }] }) === 0);
  const n = await F('900', { matches: [{ id: 77, redScore: 31, blueScore: 12, t: 1 }] });
  const after = JSON.parse(store.get('vt:m:900:77'));
  ok('once posted, the score is added', n === 1 && after.rs === 31 && after.bs === 12, JSON.stringify([n, after.rs, after.bs]));
  ok('and it is no longer waiting', !(await I('900'))['77'].ns);
  ok('a second pass does nothing', await F('900', { matches: [{ id: 77, redScore: 31, blueScore: 12, t: 1 }] }) === 0);
}

// ── the Jumper remembers the team ──
{
  const src = idx.slice(idx.indexOf('async function jumpToMatch('), idx.indexOf('async function rewatchLoadEvent('));
  ok('a ▶ from a team page resolves that team', /team = await sim_resolveTeamCached\(String\(teamNumber\)\)/.test(src));
  ok('the Jumper is opened on that team, not the whole event', /window\._rwCtx = \{\s*team, events:/.test(src) && !/team: null/.test(src));
  ok('the same event for a different team is loaded again', /!sameTeam/.test(src));
}

// ── stream links for everyone ──
{
  const C = f('rwCalForShare');
  const cal = {
    '2026-11-14': { videoId: 'abcdefghijk', platform: 'youtube', day: '2026-11-14', auto: true, savedAt: 5, durationSec: 20000,
      anchors: [{ matchId: 123, name: 'Qualifier #1 <b>', matchMs: 1000, videoSec: 60 }] },
    '2026-11-15': { videoId: 'zzzzzzzzzzz', platform: 'youtube', day: '2026-11-15', published: true, anchors: [{ matchId: 1, name: 'Q1', matchMs: 1, videoSec: 1 }] },
    '2026-11-16': { videoId: 'vextv', platform: 'vexworldstv', day: '2026-11-16', anchors: [{ matchId: 1, name: 'Q1', matchMs: 1, videoSec: 1 }] },
    'unknown': { videoId: 'abcdefghijk', platform: 'youtube', anchors: [{ matchId: 1, name: 'Q1', matchMs: 1, videoSec: 1 }] }
  };
  const days = JSON.parse(JSON.stringify(C(cal)));
  ok('only this device\'s own YouTube or Vimeo days are shared', Object.keys(days).join() === '2026-11-14', Object.keys(days).join());
  ok('names are stripped to plain text', days['2026-11-14'].anchors[0].name === 'Qualifier #1 b' && days['2026-11-14'].anchors[0].matchId === '123');
  const mod = await import('../api/tracker.js');
  ok('what the page sends, the server accepts', mod.validCalDay('2026-11-14', days['2026-11-14']) === null, String(mod.validCalDay('2026-11-14', days['2026-11-14'])));
  const good = days['2026-11-14'];
  ok('markup in a name is refused', mod.validCalDay('2026-11-14', { ...good, anchors: [{ ...good.anchors[0], name: '<script>' }] }) === 'bad anchor');
  ok('a video id must look like one', mod.validCalDay('2026-11-14', { ...good, videoId: 'https://evil.example/x' }) === 'bad video');
  ok('an unknown platform is refused', mod.validCalDay('2026-11-14', { ...good, platform: 'other' }) === 'bad video');
  ok('extra fields are refused', mod.validCalDay('2026-11-14', { ...good, html: 'x' }) === 'unknown field');
  ok('the day must match its key', mod.validCalDay('2026-11-13', good) === 'bad video');
  ok('segments are accepted', mod.validCalDay('2026-11-14', { ...good, segments: [{ videoId: 'abcdefghijk', platform: 'youtube', startMs: 1 }, { videoId: 'abcdefghijl', platform: 'youtube', startMs: 2 }] }) === null);
  // The handler: nothing saved without the key; saved and read back with it.
  const calls = [];
  const store = {};
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, o) => {
    const cmds = JSON.parse(o.body); calls.push(cmds);
    return { ok: true, json: async () => cmds.map(c => {
      if (c[0] === 'HSET') { (store[c[1]] = store[c[1]] || {})[c[2]] = c[3]; return { result: 1 }; }
      if (c[0] === 'HGETALL') return { result: Object.entries(store[c[1]] || {}).flat() };
      return { result: null };
    }) };
  };
  process.env.KV_REST_API_URL = 'https://db.example'; process.env.KV_REST_API_TOKEN = 't'; process.env.TRACKER_PASSCODE = 'correct-horse';
  const call = async (method, query, body) => { let code = 0, out = null; const res = { setHeader() {}, status(c) { code = c; return this; }, json(j) { out = j; return this; } }; await mod.default({ method, query, body }, res); return { code, out }; };
  const no = await call('POST', {}, { passcode: 'wrong-wrong', cal: { ev: '900', days } });
  ok('without the admin key nothing is saved', no.code === 403 && !calls.length);
  const yes = await call('POST', {}, { passcode: 'correct-horse', cal: { ev: '900', days } });
  ok('with it, the link is saved', yes.code === 200 && !!store['vt:cal:900'], JSON.stringify(yes));
  const bad = await call('POST', {}, { passcode: 'correct-horse', cal: { ev: '900', days: { '2026-11-14': { ...good, videoId: '<x>' } } } });
  ok('a bad link is refused even with the key', bad.code === 400);
  const got = await call('GET', { cal: '900' });
  ok('anyone can read it back', got.code === 200 && got.out.cal['2026-11-14'].videoId === 'abcdefghijk', JSON.stringify(got.out));
  ok('an event with none answers empty', (await call('GET', { cal: '901' })).out.cal && Object.keys((await call('GET', { cal: '901' })).out.cal).length === 0);
  globalThis.fetch = realFetch;
  ok('saving a link shares it', /lsSet\(rwCalKey\(eid\), JSON\.stringify\(calByDay\)\);\n  rwShareCal\(eid, calByDay\);/.test(idx));
  ok('nothing is sent without the key', /if \(typeof vtPass !== 'function' \|\| !vtPass\(\)/.test(idx));
  ok('shared links are read before the event\'s own are merged', /await rwLoadPublished\(\);\n    await rwSharedCal\(eventId\);/.test(idx));
  ok('a slow answer cannot hold the Jumper up', /setTimeout\(\(\) => res\(null\), 2500\)/.test(idx));
}

// ── admin key ──
{
  ok('Settings calls it the admin key', /<h3 class="set-h">Admin key<\/h3>/.test(idx) && /placeholder="Admin key"/.test(idx));
  ok('no on-screen text says passcode any more', !/['"`>][^'"`<\n]*\b[Pp]asscode (is|was|accepted|removed|first)/.test(idx) && !/Tracker passcode/.test(idx));
  ok('a key already saved still works', /VT_PASS_KEY = 'vex_tracker_pass'/.test(idx));
}

ok('release is v106 or later', /const APP_BUILD = 'v1(0[6-9]|[1-9]\d)'/.test(idx));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
