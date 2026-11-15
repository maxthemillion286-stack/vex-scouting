// t115 — v107: the tracker watches like a person, and learns from each match.
// Plate attention across every robot, and what is kept per stream: the clock's
// place, scenery that is not a robot, and how sure the finder must be.
import fs from 'fs';
import { boot, settle } from './harness.mjs';

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '\n         ' + detail : '')); }
};
const idx = fs.readFileSync('../index.html', 'utf8');
console.log('t115 — v107: attention and learning');
const { win } = await boot();
await settle(win);
const f = n => win.eval(n);

// ── attention ──
{
  const A = f('vtAttend');
  const box = (x, y, c, w = 60) => [x, y, w, w, 0.9, c, null, 0];
  const four = () => [box(50, 50, 1, 90), box(300, 60, 1), box(500, 200, 2), box(100, 250, 2)];
  const att = [], reads = new Map();
  for (let t = 0; t < 20; t++) {
    const picks = A(att, four(), t * 0.3, 640, 2);
    for (const p of picks) { p.tr.tries++; reads.set(p.tr, (reads.get(p.tr) || 0) + 1); }
  }
  ok('four robots are followed as four', att.length === 4, String(att.length));
  ok('every robot has its plate tried, not just the biggest', reads.size === 4 && [...reads.values()].every(v => v >= 8), JSON.stringify([...reads.values()]));
  // Once one is known, the others get the looks.
  const att2 = [], r2 = new Map();
  for (let t = 0; t < 20; t++) {
    const picks = A(att2, four(), t * 0.3, 640, 1);
    for (const p of picks) { p.tr.tries++; if (Math.abs(p.tr.x - 95 / 640) < 0.01) p.tr.hits++; r2.set(p.tr, (r2.get(p.tr) || 0) + 1); }
  }
  const big = att2.find(tr => Math.abs(tr.x - 95 / 640) < 0.01);
  ok('a robot whose plate has been read is looked at least', r2.get(big) <= 2 && [...r2.values()].reduce((a, b) => a + b, 0) === 20, JSON.stringify([...r2.values()]));
  // A robot that moves is still the same robot.
  const att3 = [];
  for (let t = 0; t < 30; t++) A(att3, [box(50 + t * 12, 100, 1)], t * 0.3, 640, 1);
  ok('a moving robot stays one robot', att3.length === 1);
  ok('one that has left is dropped', (A(att3, [], 100, 640, 1), att3.length === 0));
  ok('people and far-off specks are not read', A([], [[10, 10, 30, 90, 0.9, 1, null, 0], box(200, 200, 0), box(300, 300, 1, 20)], 0, 640, 2).length === 0);
  ok('with no graphics card one plate a look, else two', /run\.backend === 'processor' \? 1 : 2/.test(idx));
  ok('plates are tried on every look', /looks\+\+;\n        await vtPlates\(/.test(idx) && !/\(looks\+\+ & 1\) === 0/.test(idx));
}

// ── learning ──
const pack = f('vtPackFrame');
const mkRec = (extra, robots = 4, n = 300) => {
  const fr = [];
  for (let i = 0; i < n; i++) {
    const t = i * 0.5, bs = [];
    for (let r = 0; r < robots; r++) bs.push([100 + r * 120 + 60 * Math.sin(t * 0.7 + r), 80 + 50 * Math.cos(t * 0.5 + r) + r * 30, 50, 50, 0.9, r < robots / 2 ? 1 : 2, null, 0]);
    for (const e of extra) bs.push(e);
    fr.push(pack(t, bs, 640));
  }
  return { v: 2, name: 'Qualification 1', round: 2, num: 1, red: ['66449A', '1A'], blue: ['2B', '3C'], rs: 5, bs: 3, vid: 'abcdefghijk', off: 0, rate: 2, w: 640, h: 360, f: fr, tm: [] };
};
{
  const LF = f('vtLearnFrom'), known = f('vtStillKnown'), on = f('vtOnStill');
  const fresh = () => ({ n: 0, conf: 0.45, still: [], clock: null, hi: 0, lo: 0 });
  const sign = [560, 20, 40, 40, 0.7, 1, null, 0];             // a red sign in the corner, boxed every look
  let L = fresh();
  LF(mkRec([sign]), L);
  ok('one match is not enough to call something scenery', known(L).length === 0 && L.still.length === 1);
  LF(mkRec([sign]), L); LF(mkRec([sign]), L);
  ok('the same spot in three matches is', known(L).length === 1, JSON.stringify(L.still));
  ok('it is where the sign is', on(known(L), 580 / 640, 40 / 360));
  ok('robots that move are never scenery', L.still.length === 1);
  // It is left out of the summary, and the recording is untouched.
  const F = f('vtFrames'), rec = mkRec([sign]);
  const before = F(rec, null, null).frames[10].pts.length, after = F(rec, null, L).frames[10].pts.length;
  ok('scenery is left out when a match is summarised', before === 5 && after === 4, before + ' → ' + after);
  ok('the recording keeps everything', rec.f[10][1] === 5);
  // Something that was there once and not again is forgotten.
  let L2 = fresh(); LF(mkRec([sign]), L2);
  for (let i = 0; i < 6; i++) LF(mkRec([]), L2);
  ok('a one-off is forgotten', L2.still.length === 0, JSON.stringify(L2.still));
  // The finder's threshold.
  let L3 = fresh(); for (let i = 0; i < 3; i++) LF(mkRec([], 6), L3);
  ok('six "robots" a look makes the finder stricter', L3.conf === 0.47, String(L3.conf));
  let L4 = fresh(); for (let i = 0; i < 3; i++) LF(mkRec([], 2), L4);
  ok('two a look makes it looser', L4.conf === 0.43, String(L4.conf));
  let L5 = fresh(); for (let i = 0; i < 9; i++) LF(mkRec([], 4), L5);
  ok('four a look leaves it alone', L5.conf === 0.45 && L5.n === 9);
  let L6 = fresh(); for (let i = 0; i < 60; i++) LF(mkRec([], 2), L6);
  ok('it never goes below its floor', L6.conf === f('VT_CONF_MIN'), String(L6.conf));
  let L7 = fresh(); for (let i = 0; i < 60; i++) LF(mkRec([], 7), L7);
  ok('or above its ceiling', L7.conf === f('VT_CONF_MAX'), String(L7.conf));
  let L8 = fresh(); for (let i = 0; i < 3; i++) LF(mkRec([sign], 4), L8); for (let i = 0; i < 3; i++) LF(mkRec([sign], 4), L8);
  ok('scenery does not count as a fifth robot', L8.conf === 0.45, String(L8.conf));
  ok('a short recording teaches nothing', LF(mkRec([], 4, 20), fresh()).n === 0);
  ok('the finder is asked with the learned threshold', /lb, w, h, L\.conf\)/.test(idx) && /conf \|\| VT_CONF\), VT_IOU/.test(idx));
}

// ── the clock's place ──
{
  const R = f('vtClockRead');
  const stage = { getBoundingClientRect: () => ({ left: 0, top: 0, width: 640, height: 360 }) };
  const video = { videoWidth: 640, videoHeight: 360 };
  let finds = 0, reads = 0, text = '1:30';
  const cx = { fillRect() {}, drawImage() {}, getImageData: () => ({}) };
  const slot = { detCx: cx, lineCx: cx, finder: { findText: async () => { finds++; return [[300, 10, 60, 20]]; }, read: async () => { reads++; return { text, conf: 0.9 }; } } };
  const L = { clock: null };
  const c1 = await R({}, slot, video, stage, stage, L);
  ok('the first time, the clock is searched for', c1 === 90 && finds === 1 && Array.isArray(L.clock) && L.clock.length === 4, JSON.stringify(L.clock));
  text = '1:29';
  const c2 = await R({}, slot, video, stage, stage, L);
  ok('after that it is read from where it was, with no search', c2 === 89 && finds === 1);
  text = 'Qualification 4';
  for (let i = 0; i < 7; i++) await R({}, slot, video, stage, stage, L);
  ok('a few misses do not lose the place', L.clock !== null);
  await R({}, slot, video, stage, stage, L);
  ok('eight in a row and the place is forgotten', L.clock === null);
  ok('a known place is read every second, an unknown one searched every five', /clockAt \+ \(L\.clock \? 1 : 5\)/.test(idx));
}

// ── kept, shown ──
{
  const store = new Map();
  win.__st115 = store;
  win.eval(`idbGet = async k => (__st115.has(k) ? JSON.parse(__st115.get(k)) : null); idbSet = async (k, v) => { __st115.set(k, JSON.stringify(v)); }; vtLearnMem = null;`);
  const G = f('vtLearnGet'), S = f('vtLearnSave'), line = f('vtLearnLine');
  ok('nothing learned, nothing claimed', (await line(['abcdefghijk'])) === '');
  const L = await G('abcdefghijk'); L.n = 12; L.clock = [0.4, 0.02, 0.1, 0.05]; L.conf = 0.47; L.still = [{ x: 0.9, y: 0.1, m: 4, a: 4 }];
  await S();
  win.eval('vtLearnMem = null');
  const back = await G('abcdefghijk');
  ok('what is learned is kept on the device', back.n === 12 && back.conf === 0.47 && back.clock.length === 4);
  const text = await line(['abcdefghijk']);
  ok('and said plainly', /12 matches/.test(text) && /clock/.test(text) && /ignores 1 thing/.test(text) && /adjusted/.test(text), text);
  ok('the tracker box shows it', /id="vtLearned"/.test(idx));
  ok('each kept match is learned from before it is summarised', /L = vtLearnFrom\(rec, await vtLearnGet\(m\.vid\)\); await vtLearnSave\(\);/.test(idx));
  ok('the status says how many plates were tried', /plates read of \$\{run\.plateTries/.test(idx));
}

ok('release is v107', /const APP_BUILD = 'v107'/.test(idx));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
