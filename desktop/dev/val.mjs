import fs from 'fs';
const m = await import('/home/claude/vex-scouting/api/tracker.js');
const rec = JSON.parse(fs.readFileSync('rec_posted.json', 'utf8'));
console.log('validRec:', m.validRec(rec), 'bytes:', JSON.stringify(rec).length);
// the real handler takes the model parts and gives them back
const store = {};
globalThis.fetch = async (u, o) => { const cmds = JSON.parse(o.body); return { ok: true, json: async () => cmds.map(c => { if (c[0] === 'SET') { store[c[1]] = c[2]; return { result: 'OK' }; } if (c[0] === 'GET') return { result: store[c[1]] ?? null }; if (c[0] === 'DEL') { delete store[c[1]]; return { result: 1 }; } return { result: null }; }) }; };
process.env.KV_REST_API_URL = 'https://db.example'; process.env.KV_REST_API_TOKEN = 't'; process.env.TRACKER_PASSCODE = 'correct-horse';
const call = async (method, query, body) => { let code = 0, out = null; const res = { setHeader() {}, status(c) { code = c; return this; }, json(j) { out = j; return this; } }; await m.default({ method, query, body }, res); return { code, out }; };
const parts = JSON.parse(fs.readFileSync('model_posts.json', 'utf8'));
for (const p of parts) { const r = await call('POST', {}, { passcode: 'correct-horse', model: p }); if (r.code !== 200) console.log('part refused', r.out); }
const cur = await call('GET', { model: '1' });
let bytes = 0; for (let i = 0; i < cur.out.model.n; i++) bytes += Buffer.from((await call('GET', { model: cur.out.model.tag, part: String(i) })).out.b64, 'base64').length;
console.log('model back:', cur.out.model.tag, cur.out.model.n, 'parts,', bytes, 'bytes', '| note:', cur.out.model.note);
