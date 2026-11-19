// Vercel Serverless Function — shared storage for the robot tracker (v91).
//
// What the tracker learns by watching a match is saved here so that it is
// watched ONCE: any device can read it, and only a device that knows the
// passcode can write it.
//
// Storage is Upstash Redis over its REST API (added to the project from
// Vercel ▸ Storage). Nothing here is needed for the rest of the site: with no
// database configured every request answers plainly and the tracker keeps its
// results on the device instead.
//
//   GET  ?status=1               → { db, passcode }   what is configured
//   GET  ?event=ID               → { ids: [...] }     matches already tracked
//   GET  ?event=ID&match=MID     → { rec }            one match's tracks
//   GET  ?team=66449A            → { sums }           every tracked match of a team, summarised
//   POST { passcode, check }     → { ok }             is this passcode right
//   POST { passcode, ev, id, rec } → { ok }           save one match
//   GET  ?jobs=1 | ?jobs=EV      → { events } | { list }   work for the desktop app
//   POST { passcode, jobs: { ev, list } | { ev, done } }
//   GET  ?model=1 | ?model=TAG&part=i → { model } | { b64 }   a finder trained in the app
//   POST { passcode, model: { tag, i, n, b64 } | { clear } }
//   GET  ?teams=A,B,C            → { teams }          several teams' summaries (≤12)
//   GET  ?chan=KEY               → { id }             the channel that broadcasts from a venue
//   GET  ?frames=1 | ?frame=ID | ?labels=1             frames waiting for review, one frame, finished labels
//   POST { passcode, chan | frame | label | labelsdone }
//   GET  ?learn=VID              → { learn }          what was learned about a stream
//   POST { passcode, learn }     → { ok }             save it
//   GET  ?cal=EV                 → { cal }            the event's stream links, by day
//   POST { passcode, cal: { ev, days } } → { ok }     save stream links
//
// Environment:
//   KV_REST_API_URL / KV_REST_API_TOKEN            (set by the Upstash integration)
//   UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN   (its other spelling)
//   TRACKER_PASSCODE                               (made up by the site owner)

import crypto from 'crypto';

export const config = { maxDuration: 15 };

const MAX_REC_BYTES = 600 * 1024;      // one match is ~50 KB; this is a ceiling, not a target
const MAX_FRAMES = 2000;
const MIN_PASSCODE = 8;

function env() {
  const e = process.env;
  return {
    url: String(e.KV_REST_API_URL || e.UPSTASH_REDIS_REST_URL || '').replace(/\/+$/, ''),
    token: String(e.KV_REST_API_TOKEN || e.UPSTASH_REDIS_REST_TOKEN || ''),
    // Trimmed: a key pasted into Vercel with a space or a line break after it
    // could otherwise never be matched by typing it.
    passcode: String(e.TRACKER_PASSCODE || '').trim()
  };
}

// Compared as digests, in constant time: the length of the real passcode and
// how much of a guess was right must not show in how long the answer takes.
function passcodeOk(given, real) {
  if (!real || real.length < MIN_PASSCODE || typeof given !== 'string' || !given.trim()) return false;
  const a = crypto.createHash('sha256').update(given.trim()).digest();
  const b = crypto.createHash('sha256').update(real).digest();
  return crypto.timingSafeEqual(a, b);
}

const digits = v => /^\d{1,12}$/.test(String(v == null ? '' : v)) ? String(v) : null;

async function redis(E, commands) {
  const r = await fetch(E.url + '/pipeline', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + E.token, 'Content-Type': 'application/json' },
    body: JSON.stringify(commands)
  });
  if (!r.ok) throw new Error('storage answered ' + r.status);
  const out = await r.json();
  if (!Array.isArray(out)) throw new Error('storage answered something unexpected');
  for (const o of out) if (o && o.error) throw new Error('storage: ' + String(o.error).slice(0, 120));
  return out.map(o => o && o.result);
}

// A record is numbers and short strings in a known shape. Anything else is
// refused: what is stored here is served to every visitor.
export function validRec(rec) {
  if (!rec || typeof rec !== 'object' || Array.isArray(rec)) return 'not a record';
  if (rec.v !== 1 && rec.v !== 2) return 'unknown version';
  const per = rec.v === 2 ? 10 : 6;        // v2 boxes carry a look (3 numbers) and a plate read
  const str = (v, n) => typeof v === 'string' && v.length <= n;
  const num = v => typeof v === 'number' && Number.isFinite(v);
  if (!str(rec.name || '', 60) || !str(rec.vid || '', 20) || !/^[A-Za-z0-9_-]*$/.test(rec.vid || '')) return 'bad text';
  for (const k of ['off', 'rate', 'w', 'h']) if (!num(rec[k])) return 'bad ' + k;
  for (const side of ['red', 'blue']) {
    if (!Array.isArray(rec[side]) || rec[side].length > 4 || !rec[side].every(t => str(t, 10) && /^[A-Z0-9]*$/.test(t))) return 'bad teams';
  }
  if (!Array.isArray(rec.f) || rec.f.length > MAX_FRAMES) return 'bad frames';
  for (const fr of rec.f) {
    if (!Array.isArray(fr) || fr.length > 2 + per * 40 || !fr.every(v => Number.isInteger(v) && v > -100000 && v < 100000)) return 'bad frame';
    if (fr.length < 2 || fr.length !== 2 + per * fr[1]) return 'bad frame length';
  }
  const allowed = ['v', 'name', 'round', 'num', 'red', 'blue', 'rs', 'bs', 'vid', 'off', 'rate', 'w', 'h', 'model', 'at', 'f', 'wide', 'tm', 'pn', 'pw', 'ph', 'tg', 'vo', 'cu', 'pf', 'gs', 'cf'];
  // The finder's threshold when it was recorded (v150): boxes below it are unsure ones.
  if (rec.cf != null && !(Number.isInteger(rec.cf) && rec.cf >= 1 && rec.cf <= 100)) return 'bad threshold';
  // Pins and cups on each goal and loader: [tenths, then 13 spots × (red, blue, yellow halves, cups)].
  if (rec.gs != null && !(Array.isArray(rec.gs) && rec.gs.length <= 24000 && rec.gs.length % 53 === 0 && rec.gs.every(v => Number.isInteger(v) && v >= -1 && v < 100000))) return 'bad goal counts';
  // Cups the trained finder saw: [tenths, how many, then x, bottom y, w, h each]; pf = 1 when pins came from it.
  if (rec.cu != null && !(Array.isArray(rec.cu) && rec.cu.length <= 24000 && rec.cu.every(v => Number.isInteger(v) && v > -100000 && v < 100000))) return 'bad cups';
  if (rec.pf != null && rec.pf !== 0 && rec.pf !== 1) return 'bad pin finder';
  // What a vision model said: [tenths, box x, box y, what it is doing 0-8, plate 0-4], five whole numbers a robot a look.
  if (rec.vo != null && !(Array.isArray(rec.vo) && rec.vo.length <= 600 && rec.vo.length % 5 === 0 && rec.vo.every(v => Number.isInteger(v) && v > -100000 && v < 100000))) return 'bad vision notes';
  // Toggle readings: [tenths, then red% and blue% for each of four walls], nine whole numbers a look.
  if (rec.tg != null && !(Array.isArray(rec.tg) && rec.tg.length <= 2000 && rec.tg.length % 9 === 0 && rec.tg.every(v => Number.isInteger(v) && v > -100000 && v < 100000))) return 'bad toggles';
  // Pin sightings: [tenths, how many, then six whole numbers each: x, y, w, h, area, colour].
  if (rec.pn != null && !(Array.isArray(rec.pn) && rec.pn.length <= 40000 && rec.pn.every(v => Number.isInteger(v) && v > -100000 && v < 10000000))) return 'bad pins';
  for (const k of ['pw', 'ph']) if (rec[k] != null && !(Number.isInteger(rec[k]) && rec[k] > 0 && rec[k] < 10000)) return 'bad ' + k;
  // The stream's clock as it was read: [tenths of a second, seconds on the clock, …].
  if (rec.tm != null && !(Array.isArray(rec.tm) && rec.tm.length <= 400 && rec.tm.length % 2 === 0 && rec.tm.every(v => Number.isInteger(v) && v > -100000 && v < 100000))) return 'bad clock';
  for (const k of Object.keys(rec)) if (!allowed.includes(k)) return 'unknown field ' + k.slice(0, 20);
  for (const k of ['round', 'num', 'rs', 'bs', 'at', 'wide']) if (rec[k] != null && !num(rec[k])) return 'bad ' + k;
  if (rec.model != null && !str(rec.model, 20)) return 'bad model';
  return null;
}

// A match's summary: a dozen numbers per alliance, worked out on the device
// from the boxes. Stored once per event and once under each team in it, so a
// team's whole season is one read.
export function validSum(s) {
  if (!s || typeof s !== 'object' || Array.isArray(s)) return 'not a summary';
  if (!Number.isInteger(s.sv) || s.sv < 1 || s.sv > 99) return 'unknown version';
  if (JSON.stringify(s).length > 12000) return 'summary too large';
  const num = v => v === null || (typeof v === 'number' && Number.isFinite(v));
  if (s.name != null && !(typeof s.name === 'string' && s.name.length <= 60 && /^[A-Za-z0-9 #.,()\/-]*$/.test(s.name))) return 'bad name';
  for (const side of ['red', 'blue']) {
    if (!Array.isArray(s[side]) || s[side].length > 4 || !s[side].every(t => typeof t === 'string' && /^[A-Z0-9]{1,10}$/.test(t))) return 'bad teams';
  }
  for (const k of Object.keys(s)) {
    if (['name', 'red', 'blue'].includes(k)) continue;
    if (k === 'vid') { if (typeof s.vid !== 'string' || !/^[A-Za-z0-9_-]{0,20}$/.test(s.vid)) return 'bad video'; continue; }
    if (['R', 'B', 'Ra', 'Rb', 'Ba', 'Bb'].includes(k)) {
      const o = s[k];
      if (!o || typeof o !== 'object' || Array.isArray(o) || Object.keys(o).length > 200) return 'bad side';
      for (const f of Object.keys(o)) if (!/^[a-z][a-z0-9]{1,3}$/.test(f) || !num(o[f])) return 'bad measure';
      continue;
    }
    if (!/^[a-z]{2,6}$/.test(k) || !num(s[k])) return 'bad field';
  }
  return null;
}
// One event's stream links, a day at a time: which video, and where one match
// is in it. Text is limited to what a video id or a match name can contain.
export function validCalDay(day, c) {
  if (!/^[0-9-]{8,10}$/.test(String(day)) || !c || typeof c !== 'object' || Array.isArray(c)) return 'bad day';
  const num = v => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) < 1e14;
  const id = v => typeof v === 'string' && /^[A-Za-z0-9_-]{4,20}$/.test(v);
  const allowed = ['videoId', 'platform', 'day', 'anchors', 'durationSec', 'hash', 'segments'];
  for (const k of Object.keys(c)) if (!allowed.includes(k)) return 'unknown field';
  if (!id(c.videoId) || !['youtube', 'vimeo'].includes(c.platform) || c.day !== day) return 'bad video';
  if (c.durationSec != null && !num(c.durationSec)) return 'bad length';
  if (c.hash != null && !(typeof c.hash === 'string' && /^[A-Za-z0-9]{1,20}$/.test(c.hash))) return 'bad hash';
  if (!Array.isArray(c.anchors) || !c.anchors.length || c.anchors.length > 8) return 'bad anchors';
  for (const a of c.anchors) {
    if (!a || typeof a !== 'object' || Object.keys(a).length !== 4) return 'bad anchor';
    if (typeof a.matchId !== 'string' || !/^[A-Za-z0-9_-]{1,20}$/.test(a.matchId)) return 'bad anchor';
    if (typeof a.name !== 'string' || a.name.length > 60 || !/^[A-Za-z0-9 #.,()\/_-]*$/.test(a.name)) return 'bad anchor';
    if (!num(a.matchMs) || !num(a.videoSec)) return 'bad anchor';
  }
  if (c.segments != null) {
    if (!Array.isArray(c.segments) || c.segments.length > 12) return 'bad segments';
    for (const g of c.segments) {
      if (!g || typeof g !== 'object') return 'bad segment';
      for (const k of Object.keys(g)) if (!['videoId', 'platform', 'startMs', 'endMs', 'durationSec'].includes(k)) return 'bad segment';
      if (!id(g.videoId) || !['youtube', 'vimeo'].includes(g.platform) || !num(g.startMs)) return 'bad segment';
      if ((g.endMs != null && !num(g.endMs)) || (g.durationSec != null && !num(g.durationSec))) return 'bad segment';
    }
  }
  return null;
}
// What has been learned about one stream video: numbers only.
export function validLearn(L) {
  if (!L || typeof L !== 'object' || Array.isArray(L)) return 'bad learn';
  const num = v => typeof v === 'number' && Number.isFinite(v);
  for (const k of Object.keys(L)) if (!['vid', 'n', 'conf', 'clock', 'still'].includes(k)) return 'unknown field';
  if (typeof L.vid !== 'string' || !/^[A-Za-z0-9_-]{6,20}$/.test(L.vid)) return 'bad video';
  if (!Number.isInteger(L.n) || L.n < 0 || L.n > 100000 || !num(L.conf) || L.conf < 0.3 || L.conf > 0.6) return 'bad numbers';
  if (L.clock !== null && !(Array.isArray(L.clock) && L.clock.length === 4 && L.clock.every(v => num(v) && v >= -0.1 && v <= 1.1))) return 'bad clock';
  if (!Array.isArray(L.still) || L.still.length > 12) return 'bad still';
  for (const s of L.still) {
    if (!s || typeof s !== 'object' || Object.keys(s).length !== 4) return 'bad still';
    if (![s.x, s.y].every(v => num(v) && v >= -0.1 && v <= 1.1) || ![s.m, s.a].every(v => Number.isInteger(v) && v >= 0 && v <= 100000)) return 'bad still';
  }
  return null;
}
// Work for the desktop app: which matches to watch, and where each is in its
// video. Written by the website (it knows the schedule and the stream), read
// by the app. Team numbers, match names, video ids and numbers only.
export function validJob(j) {
  if (!j || typeof j !== 'object' || Array.isArray(j)) return 'bad job';
  const num = v => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) < 1e14;
  for (const k of Object.keys(j)) if (!['id', 'name', 'round', 'num', 'vid', 'off', 'red', 'blue', 'rs', 'bs', 't'].includes(k)) return 'unknown field';
  if (!digits(j.id) || typeof j.vid !== 'string' || !/^[A-Za-z0-9_-]{6,20}$/.test(j.vid) || !num(j.off) || j.off < 0) return 'bad job';
  if (typeof j.name !== 'string' || j.name.length > 60 || !/^[A-Za-z0-9 #.,()\/-]*$/.test(j.name)) return 'bad name';
  for (const k of ['round', 'num', 'rs', 'bs', 't']) if (j[k] != null && !num(j[k])) return 'bad ' + k;
  for (const side of ['red', 'blue']) if (!Array.isArray(j[side]) || j[side].length > 4 || !j[side].every(x => typeof x === 'string' && /^[A-Z0-9]{1,10}$/.test(x))) return 'bad teams';
  return null;
}
const MODEL_PART_B64 = 900 * 1024, MODEL_MAX_PARTS = 80;
const modelTag = v => typeof v === 'string' && /^[a-z0-9]{4,16}$/.test(v) ? v : null;
// A frame for review: a picture, where the finder thinks the robots are.
const FRAME_ID = /^[A-Za-z0-9_-]{4,60}$/, MAX_FRAMES_WAITING = 300, MAX_FRAME_B64 = 520 * 1024;
const boxesOk = (b, n) => Array.isArray(b) && b.length <= 60 && b.every(x => Array.isArray(x) && x.length === n && x.every(v => typeof v === 'number' && Number.isFinite(v) && v > -10000 && v < 100000));
export function validFrame(f) {
  if (!f || typeof f !== 'object' || !FRAME_ID.test(String(f.id || ''))) return 'bad frame';
  if (!Number.isInteger(f.w) || !Number.isInteger(f.h) || f.w < 64 || f.h < 64 || f.w > 8000 || f.h > 8000) return 'bad size';
  if (!boxesOk(f.boxes, 5)) return 'bad boxes';
  if (typeof f.b64 !== 'string' || f.b64.length < 100 || f.b64.length > MAX_FRAME_B64 || !/^[A-Za-z0-9+/]+=*$/.test(f.b64)) return 'bad picture';
  if (!f.b64.startsWith('/9j/')) return 'not a jpeg';
  return null;
}
const CHAN_KEY = /^[a-z0-9|]{4,60}$/, CHAN_ID = /^UC[A-Za-z0-9_-]{22}$/;
const teamKey = v => /^[A-Z0-9]{1,10}$/.test(String(v || '').toUpperCase()) ? String(v).toUpperCase() : null;

export default async function handler(req, res) {
  const E = env();
  const hasDb = !!(E.url && E.token);
  res.setHeader('Cache-Control', 'no-store');
  try {
    if (req.method === 'GET') {
      const q = req.query || {};
      if (q.status) return res.status(200).json({ db: hasDb, passcode: E.passcode.length >= MIN_PASSCODE });
      if (q.field !== undefined) {
        // The four corners of the field in one stream video, as someone marked them.
        const vid = String(q.field);
        if (!/^[A-Za-z0-9_-]{6,20}$/.test(vid)) return res.status(400).json({ error: 'field must be a video id' });
        if (!hasDb) return res.status(200).json({ db: false, field: null });
        const [raw] = await redis(E, [['GET', `vt:field:${vid}`]]);
        let field = null;
        try { field = raw ? JSON.parse(raw) : null; } catch (e) {}
        return res.status(200).json({ db: true, field });
      }
      if (q.teams !== undefined) {
        // Several teams' summaries in one go (a briefing asks for a whole event).
        const list = String(q.teams).split(',').map(teamKey).filter(Boolean).slice(0, 12);
        if (!list.length) return res.status(400).json({ error: 'teams must be team numbers' });
        if (!hasDb) return res.status(200).json({ db: false, teams: {} });
        const got = await redis(E, list.map(n => ['HGETALL', `vt:team:${n}`]));
        const teams = {};
        list.forEach((n, i) => { const flat = got[i], sums = {}; for (let k = 0; Array.isArray(flat) && k + 1 < flat.length; k += 2) { try { sums[String(flat[k])] = JSON.parse(flat[k + 1]); } catch (e) {} } teams[n] = sums; });
        return res.status(200).json({ db: true, teams });
      }
      if (q.chan !== undefined) {
        // Which YouTube channel broadcasts from this venue.
        const key = String(q.chan);
        if (!CHAN_KEY.test(key)) return res.status(400).json({ error: 'bad key' });
        if (!hasDb) return res.status(200).json({ db: false, id: null });
        const [id] = await redis(E, [['HGET', 'vt:chan', key]]);
        return res.status(200).json({ db: true, id: CHAN_ID.test(String(id || '')) ? id : null });
      }
      if (q.frames !== undefined) {
        if (!hasDb) return res.status(200).json({ db: false, ids: [] });
        const [ids] = await redis(E, [['SMEMBERS', 'vt:frames']]);
        return res.status(200).json({ db: true, ids: (ids || []).filter(v => FRAME_ID.test(String(v))) });
      }
      if (q.frame !== undefined) {
        const id = String(q.frame);
        if (!FRAME_ID.test(id)) return res.status(400).json({ error: 'bad frame' });
        if (!hasDb) return res.status(404).json({ error: 'no frame' });
        const [raw] = await redis(E, [['GET', `vt:frame:${id}`]]);
        let f = null; try { f = raw ? JSON.parse(raw) : null; } catch (e) {}
        if (!f || validFrame(f)) return res.status(404).json({ error: 'no frame' });
        return res.status(200).json({ frame: f });
      }
      if (q.labels !== undefined) {
        if (!hasDb) return res.status(200).json({ db: false, labels: {} });
        const [flat] = await redis(E, [['HGETALL', 'vt:labels']]);
        const labels = {};
        for (let k = 0; Array.isArray(flat) && k + 1 < flat.length; k += 2) { try { labels[String(flat[k])] = JSON.parse(flat[k + 1]); } catch (e) {} }
        return res.status(200).json({ db: true, labels });
      }
      if (q.jobs !== undefined) {
        if (!hasDb) return res.status(200).json({ db: false, events: [], list: [] });
        if (String(q.jobs) === '1') {
          const [evs] = await redis(E, [['SMEMBERS', 'vt:jobsets']]);
          return res.status(200).json({ db: true, events: (evs || []).filter(v => digits(v)) });
        }
        const ev = digits(q.jobs);
        if (!ev) return res.status(400).json({ error: 'jobs must be 1 or an event number' });
        const [raw] = await redis(E, [['GET', `vt:jobs:${ev}`]]);
        let list = [];
        try { list = raw ? JSON.parse(raw).filter(j => !validJob(j)) : []; } catch (e) {}
        return res.status(200).json({ db: true, list });
      }
      if (q.model !== undefined) {
        // A robot finder trained in the desktop app, stored in parts.
        if (!hasDb) return res.status(200).json({ db: false, model: null });
        if (String(q.model) === '1') {
          const [raw] = await redis(E, [['GET', 'vt:model:cur']]);
          let model = null;
          try { model = raw ? JSON.parse(raw) : null; } catch (e) {}
          return res.status(200).json({ db: true, model });
        }
        const tag = modelTag(String(q.model)), part = digits(q.part);
        if (!tag || part === null || Number(part) >= MODEL_MAX_PARTS) return res.status(400).json({ error: 'bad model part' });
        const [b64] = await redis(E, [['GET', `vt:model:${tag}:${part}`]]);
        if (!b64) return res.status(404).json({ error: 'no such part' });
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        return res.status(200).json({ b64 });
      }
      if (q.learn !== undefined) {
        const vid = String(q.learn);
        if (!/^[A-Za-z0-9_-]{6,20}$/.test(vid)) return res.status(400).json({ error: 'learn must be a video id' });
        if (!hasDb) return res.status(200).json({ db: false, learn: null });
        const [raw] = await redis(E, [['GET', `vt:learn:${vid}`]]);
        let learn = null;
        try { learn = raw ? JSON.parse(raw) : null; } catch (e) {}
        if (learn && validLearn(learn)) learn = null;
        return res.status(200).json({ db: true, learn });
      }
      if (q.cal !== undefined) {
        const ev = digits(q.cal);
        if (!ev) return res.status(400).json({ error: 'cal must be an event number' });
        if (!hasDb) return res.status(200).json({ db: false, cal: {} });
        const [flat] = await redis(E, [['HGETALL', `vt:cal:${ev}`]]);
        const cal = {};
        for (let i = 0; Array.isArray(flat) && i + 1 < flat.length; i += 2) { try { const c = JSON.parse(flat[i + 1]); if (!validCalDay(String(flat[i]), c)) cal[String(flat[i])] = c; } catch (e) {} }
        return res.status(200).json({ db: true, cal });
      }
      if (q.team !== undefined) {
        const team = teamKey(q.team);
        if (!team) return res.status(400).json({ error: 'team must be a team number' });
        if (!hasDb) return res.status(200).json({ db: false, sums: {} });
        const [flat] = await redis(E, [['HGETALL', `vt:team:${team}`]]);
        const sums = {};
        // Upstash answers a hash as [field, value, field, value, …].
        for (let i = 0; Array.isArray(flat) && i + 1 < flat.length; i += 2) { try { sums[String(flat[i])] = JSON.parse(flat[i + 1]); } catch (e) {} }
        return res.status(200).json({ db: true, sums });
      }
      const ev = digits(q.event);
      if (!ev) return res.status(400).json({ error: 'event must be a number' });
      if (!hasDb) return res.status(200).json({ db: false, ids: [] });
      if (q.match !== undefined) {
        const id = digits(q.match);
        if (!id) return res.status(400).json({ error: 'match must be a number' });
        const [raw] = await redis(E, [['GET', `vt:m:${ev}:${id}`]]);
        if (!raw) return res.status(404).json({ error: 'not tracked' });
        let rec = null;
        try { rec = JSON.parse(raw); } catch (e) {}
        return res.status(200).json({ rec });
      }
      // Only recordings that can tell robots apart count as done; a match
      // tracked before that is offered again.
      const [ids] = await redis(E, [['SMEMBERS', `vt:ev2:${ev}`]]);
      return res.status(200).json({ db: true, ids: (ids || []).filter(v => digits(v)) });
    }
    if (req.method === 'POST') {
      let body = req.body;
      if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = null; } }
      if (!body || typeof body !== 'object') return res.status(400).json({ error: 'no body' });
      if (!passcodeOk(body.passcode, E.passcode)) {
        // A wrong guess costs a moment, so guessing in bulk is slow.
        await new Promise(r => setTimeout(r, 400));
        return res.status(403).json({ error: E.passcode.length >= MIN_PASSCODE ? 'wrong passcode' : 'no passcode is set on the server' });
      }
      if (body.check) return res.status(200).json({ ok: true, db: hasDb });
      if (!hasDb) return res.status(503).json({ error: 'no database is connected' });
      if (body.field !== undefined) {
        const f = body.field;
        if (!f || typeof f !== 'object' || !/^[A-Za-z0-9_-]{6,20}$/.test(String(f.vid || '')) || !Array.isArray(f.q) || f.q.length !== 8 ||
            !f.q.every(v => typeof v === 'number' && Number.isFinite(v) && v >= -0.5 && v <= 1.5)) return res.status(400).json({ error: 'bad field' });
        // Where each goal (g, 9 points) and loader (l, 4 points) really is, if placed by hand.
        const pts = (a, n) => Array.isArray(a) && a.length === 2 * n && a.every(v => typeof v === 'number' && Number.isFinite(v) && v >= -0.5 && v <= 1.5);
        if ((f.g !== undefined && !pts(f.g, 9)) || (f.l !== undefined && !pts(f.l, 4))) return res.status(400).json({ error: 'bad field' });
        // The moment of the stream it was marked on (seconds), so the app can follow the camera from that picture.
        if (f.t !== undefined && !(typeof f.t === 'number' && Number.isFinite(f.t) && f.t >= 0 && f.t <= 200000)) return res.status(400).json({ error: 'bad field' });
        await redis(E, [['SET', `vt:field:${f.vid}`, JSON.stringify({ q: f.q, by: 'click', at: Date.now(), ...(f.g ? { g: f.g } : {}), ...(f.l ? { l: f.l } : {}), ...(f.t !== undefined ? { t: Math.round(f.t * 10) / 10 } : {}) })]]);
        return res.status(200).json({ ok: true });
      }
      if (body.chan !== undefined) {
        const c = body.chan;
        if (!c || !CHAN_KEY.test(String(c.key || '')) || !CHAN_ID.test(String(c.id || ''))) return res.status(400).json({ error: 'bad channel' });
        await redis(E, [['HSET', 'vt:chan', c.key, c.id]]);
        return res.status(200).json({ ok: true });
      }
      if (body.frame !== undefined) {
        const bad = validFrame(body.frame);
        if (bad) return res.status(400).json({ error: bad });
        const [n] = await redis(E, [['SCARD', 'vt:frames']]);
        if (Number(n) >= MAX_FRAMES_WAITING) return res.status(409).json({ error: 'full' });
        const f = body.frame;
        await redis(E, [['SET', `vt:frame:${f.id}`, JSON.stringify({ id: f.id, w: f.w, h: f.h, boxes: f.boxes, b64: f.b64 })], ['SADD', 'vt:frames', f.id]]);
        return res.status(200).json({ ok: true });
      }
      if (body.label !== undefined) {
        // A reviewed frame: its boxes are kept for the app, its picture is let go.
        const l = body.label;
        if (!l || !FRAME_ID.test(String(l.id || '')) || !boxesOk(l.boxes, 4)) return res.status(400).json({ error: 'bad label' });
        await redis(E, [['HSET', 'vt:labels', l.id, JSON.stringify({ skip: !!l.skip, boxes: l.boxes })], ['SREM', 'vt:frames', l.id], ['DEL', `vt:frame:${l.id}`]]);
        return res.status(200).json({ ok: true });
      }
      if (body.labelsdone !== undefined) {
        const ids = Array.isArray(body.labelsdone) ? body.labelsdone.filter(v => FRAME_ID.test(String(v))).slice(0, 400) : [];
        if (!ids.length) return res.status(400).json({ error: 'nothing to clear' });
        await redis(E, [['HDEL', 'vt:labels', ...ids]]);
        return res.status(200).json({ ok: true });
      }
      if (body.jobs !== undefined) {
        const J = body.jobs, jev = J && digits(J.ev);
        if (!jev) return res.status(400).json({ error: 'bad jobs' });
        if (J.done) { await redis(E, [['DEL', `vt:jobs:${jev}`], ['SREM', 'vt:jobsets', jev]]); return res.status(200).json({ ok: true }); }
        if (!Array.isArray(J.list) || !J.list.length || J.list.length > 600) return res.status(400).json({ error: 'bad jobs' });
        for (const j of J.list) { const bad = validJob(j); if (bad) return res.status(400).json({ error: bad }); }
        await redis(E, [['SET', `vt:jobs:${jev}`, JSON.stringify(J.list)], ['SADD', 'vt:jobsets', jev]]);
        return res.status(200).json({ ok: true });
      }
      if (body.model !== undefined) {
        const M = body.model;
        if (M && M.clear) { await redis(E, [['DEL', 'vt:model:cur']]); return res.status(200).json({ ok: true }); }
        const tag = M && modelTag(M.tag);
        if (!tag || !Number.isInteger(M.i) || !Number.isInteger(M.n) || M.n < 1 || M.n > MODEL_MAX_PARTS || M.i < 0 || M.i >= M.n) return res.status(400).json({ error: 'bad model' });
        if (typeof M.b64 !== 'string' || !M.b64.length || M.b64.length > MODEL_PART_B64 || !/^[A-Za-z0-9+/]+=*$/.test(M.b64)) return res.status(400).json({ error: 'bad model part' });
        const cmds = [['SET', `vt:model:${tag}:${M.i}`, M.b64]];
        // The last part makes it the one in use; the one before is let go.
        if (M.i === M.n - 1) {
          const [old] = await redis(E, [['GET', 'vt:model:cur']]);
          let prev = null; try { prev = old ? JSON.parse(old) : null; } catch (e) {}
          if (prev && modelTag(prev.tag) && prev.tag !== tag) for (let k = 0; k < Math.min(MODEL_MAX_PARTS, prev.n || 0); k++) cmds.push(['DEL', `vt:model:${prev.tag}:${k}`]);
          cmds.push(['SET', 'vt:model:cur', JSON.stringify({ tag, n: M.n, at: Date.now(), note: typeof M.note === 'string' ? M.note.replace(/[^A-Za-z0-9 .,%:-]/g, '').slice(0, 120) : '' })]);
        }
        await redis(E, cmds);
        return res.status(200).json({ ok: true });
      }
      if (body.learn !== undefined) {
        const bad = validLearn(body.learn);
        if (bad) return res.status(400).json({ error: bad });
        await redis(E, [['SET', `vt:learn:${body.learn.vid}`, JSON.stringify(body.learn)]]);
        return res.status(200).json({ ok: true });
      }
      if (body.cal !== undefined) {
        const c = body.cal, cev = c && digits(c.ev);
        if (!cev || !c.days || typeof c.days !== 'object' || Array.isArray(c.days)) return res.status(400).json({ error: 'bad cal' });
        const days = Object.keys(c.days);
        if (!days.length || days.length > 8) return res.status(400).json({ error: 'bad cal' });
        const set = [];
        for (const d of days) {
          const bad = validCalDay(d, c.days[d]);
          if (bad) return res.status(400).json({ error: bad });
          set.push(['HSET', `vt:cal:${cev}`, d, JSON.stringify(c.days[d])]);
        }
        await redis(E, set);
        return res.status(200).json({ ok: true });
      }
      const ev = digits(body.ev), id = digits(body.id);
      if (!ev || !id) return res.status(400).json({ error: 'ev and id must be numbers' });
      const cmds = [];
      if (body.rec !== undefined) {
        const bad = validRec(body.rec);
        if (bad) return res.status(400).json({ error: bad });
        const text = JSON.stringify(body.rec);
        if (text.length > MAX_REC_BYTES) return res.status(413).json({ error: 'record too large' });
        cmds.push(['SET', `vt:m:${ev}:${id}`, text], ['SADD', `vt:ev:${ev}`, id]);
        if (body.rec.v === 2) cmds.push(['SADD', `vt:ev2:${ev}`, id]);
      }
      if (body.sum !== undefined) {
        const bad = validSum(body.sum);
        if (bad) return res.status(400).json({ error: bad });
        const text = JSON.stringify(body.sum);
        cmds.push(['HSET', `vt:s:${ev}`, id, text]);
        for (const t of body.sum.red.concat(body.sum.blue)) cmds.push(['HSET', `vt:team:${t}`, `${ev}:${id}`, text]);
      }
      if (!cmds.length) return res.status(400).json({ error: 'nothing to save' });
      await redis(E, cmds);
      return res.status(200).json({ ok: true });
    }
    return res.status(405).json({ error: 'GET or POST' });
  } catch (err) {
    return res.status(502).json({ error: String((err && err.message) || err).slice(0, 200) });
  }
}
