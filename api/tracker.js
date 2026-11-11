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
//   POST { passcode, check }     → { ok }             is this passcode right
//   POST { passcode, ev, id, rec } → { ok }           save one match
//
// Environment:
//   KV_REST_API_URL / KV_REST_API_TOKEN            (set by the Upstash integration)
//   UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN   (its other spelling)
//   TRACKER_PASSCODE                               (made up by the site owner)

import crypto from 'crypto';

export const config = { maxDuration: 15 };

const MAX_REC_BYTES = 400 * 1024;      // one match is ~50 KB; this is a ceiling, not a target
const MAX_FRAMES = 2000;
const MIN_PASSCODE = 8;

function env() {
  const e = process.env;
  return {
    url: String(e.KV_REST_API_URL || e.UPSTASH_REDIS_REST_URL || '').replace(/\/+$/, ''),
    token: String(e.KV_REST_API_TOKEN || e.UPSTASH_REDIS_REST_TOKEN || ''),
    passcode: String(e.TRACKER_PASSCODE || '')
  };
}

// Compared as digests, in constant time: the length of the real passcode and
// how much of a guess was right must not show in how long the answer takes.
function passcodeOk(given, real) {
  if (!real || real.length < MIN_PASSCODE || typeof given !== 'string' || !given) return false;
  const a = crypto.createHash('sha256').update(given).digest();
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
  if (rec.v !== 1) return 'unknown version';
  const str = (v, n) => typeof v === 'string' && v.length <= n;
  const num = v => typeof v === 'number' && Number.isFinite(v);
  if (!str(rec.name || '', 60) || !str(rec.vid || '', 20) || !/^[A-Za-z0-9_-]*$/.test(rec.vid || '')) return 'bad text';
  for (const k of ['off', 'rate', 'w', 'h']) if (!num(rec[k])) return 'bad ' + k;
  for (const side of ['red', 'blue']) {
    if (!Array.isArray(rec[side]) || rec[side].length > 4 || !rec[side].every(t => str(t, 10) && /^[A-Z0-9]*$/.test(t))) return 'bad teams';
  }
  if (!Array.isArray(rec.f) || rec.f.length > MAX_FRAMES) return 'bad frames';
  for (const fr of rec.f) {
    if (!Array.isArray(fr) || fr.length > 2 + 6 * 40 || !fr.every(v => Number.isInteger(v) && v > -100000 && v < 100000)) return 'bad frame';
    if (fr.length < 2 || fr.length !== 2 + 6 * fr[1]) return 'bad frame length';
  }
  const allowed = ['v', 'name', 'round', 'num', 'red', 'blue', 'rs', 'bs', 'vid', 'off', 'rate', 'w', 'h', 'model', 'at', 'f'];
  for (const k of Object.keys(rec)) if (!allowed.includes(k)) return 'unknown field ' + k.slice(0, 20);
  for (const k of ['round', 'num', 'rs', 'bs', 'at']) if (rec[k] != null && !num(rec[k])) return 'bad ' + k;
  if (rec.model != null && !str(rec.model, 20)) return 'bad model';
  return null;
}

export default async function handler(req, res) {
  const E = env();
  const hasDb = !!(E.url && E.token);
  res.setHeader('Cache-Control', 'no-store');
  try {
    if (req.method === 'GET') {
      const q = req.query || {};
      if (q.status) return res.status(200).json({ db: hasDb, passcode: E.passcode.length >= MIN_PASSCODE });
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
      const [ids] = await redis(E, [['SMEMBERS', `vt:ev:${ev}`]]);
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
      const ev = digits(body.ev), id = digits(body.id);
      if (!ev || !id) return res.status(400).json({ error: 'ev and id must be numbers' });
      const bad = validRec(body.rec);
      if (bad) return res.status(400).json({ error: bad });
      const text = JSON.stringify(body.rec);
      if (text.length > MAX_REC_BYTES) return res.status(413).json({ error: 'record too large' });
      await redis(E, [['SET', `vt:m:${ev}:${id}`, text], ['SADD', `vt:ev:${ev}`, id]]);
      return res.status(200).json({ ok: true });
    }
    return res.status(405).json({ error: 'GET or POST' });
  } catch (err) {
    return res.status(502).json({ error: String((err && err.message) || err).slice(0, 200) });
  }
}
