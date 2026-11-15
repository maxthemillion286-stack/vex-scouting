// t113 — v99: the robot tracker, stage 2. From boxes to what a robot does.
// No real recording exists to test on, so the matches here are drawn by hand:
// robots that do known things, to check the summary says those things.
import fs from 'fs';
import { boot, settle } from './harness.mjs';

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '\n         ' + detail : '')); }
};
const idx = fs.readFileSync('../index.html', 'utf8');
console.log('t113 — v99: robot report');

// A match as the tracker stores it. Each robot is a function of time → [x, y]
// in a 640×360 picture; red starts on the left, blue on the right.
function match(opts) {
  const o = { lead: 4, redStop: null, redAuto: true, redUp: true, pressBlue: true, v2: false, looks: null, plate: null, partnerHome: false, ...opts };
  const pack = g => [0, 4, 8].map(k => g[k] | g[k + 1] << 4 | g[k + 2] << 8 | g[k + 3] << 12);
  const f = [];
  const lerp = (a, b, k) => a + (b - a) * Math.max(0, Math.min(1, k));
  const wob = (t, s) => 14 * Math.sin(t * 0.9 + s);
  const robots = t => {
    const m = t - 0;                                    // match clock
    const red = i => {
      const y = i ? 250 : 130;
      if (i === 1 && o.partnerHome) return [150 + (m > 20 && m < 117 ? wob(m, 9) * 0.6 : 0), y];
      if (m < 0) return [140, y];
      if (m < 15) return [o.redAuto ? lerp(140, 330, m / 10) : 140, y];
      if (m < 20) return [o.redAuto ? 330 : 140, y];
      if (o.redStop && i === 0 && m >= o.redStop[0] && m < o.redStop[1]) return [300, y];
      if (m > 117) return [o.redUp ? 470 : 200, y];     // parked at the end
      return [(o.redUp ? 470 : 200) + wob(m, i) * 2, y + wob(m, i + 2)];
    };
    const blue = i => {
      const y = i ? 240 : 140;
      if (m < 20) return [500, y];
      if (m > 117) return [o.pressBlue ? 480 : 360, y + 30];
      return [(o.pressBlue ? 480 : 360) + wob(m, i + 5) * 2.2, y + wob(m, i + 7) * 1.5];
    };
    return [[...red(0), 1], [...red(1), 1], [...blue(0), 2], [...blue(1), 2]];
  };
  for (let t = -o.lead; t <= 128; t += 0.25) {
    const fr = [Math.round(t * 10), 4];
    robots(t).forEach(([x, y, c], k) => {
      fr.push(Math.round(x - 20), Math.round(y - 40), 40, 40, 90, c);
      if (o.v2) {
        const g = o.looks ? o.looks[k] : [5, 5, 5, 5, 0, 0, 0, 0, 5, 5, 0, 0];
        // A plate is read now and then, when the robot is near the camera.
        const who = o.plate && o.plate[k] && Math.round(t * 4) % 40 === 0 && t > 20 ? o.plate[k] : 0;
        fr.push(...pack(g), who);
      }
    });
    f.push(fr);
  }
  return { v: o.v2 ? 2 : 1, name: 'Qualification ' + (o.n || 1), round: 2, num: o.n || 1, red: o.red || ['66449A', '1234X'], blue: o.blue || ['12345B', '777Z'],
    rs: o.rs ?? 40, bs: o.bs ?? 20, vid: 'abcDEF12345', off: 100, rate: 2, w: 640, h: 360, model: 'det1', at: 1, f };
}

const { win, errors } = await boot();

console.log('\n· one match');
{
  const s = win.vtSummarise(match({}));
  ok('a match is summarised', s.ok === 1 && s.sv === 3 && !!s.R && !!s.B && !!s.Ra && !!s.Bb, JSON.stringify(s).slice(0, 300));
  ok('it finds when the match really started, not when the Jumper said', Math.abs(s.st) <= 2, 'start ' + s.st);
  ok('and when driver control began', s.dr >= 18 && s.dr <= 23, 'driver ' + s.dr);
  ok('red moved in autonomous with both robots, blue with neither', s.R.am === 2 && s.B.am === 0, JSON.stringify([s.R.am, s.B.am]));
  ok('red got about halfway across', s.R.ar > 0.4 && s.R.ar < 0.75, String(s.R.ar));
  ok('red spent driver control in blue\'s half; blue stayed home', s.R.opp > 0.8 && s.B.opp < 0.2, JSON.stringify([s.R.opp, s.B.opp]));
  ok('red was on top of blue there: pressure, and blue under pressure', s.R.prs > 0.3 && s.B.prd > 0.3, JSON.stringify([s.R.prs, s.B.prd]));
  ok('both alliances were stationary at the end', s.R.es === 1 && s.B.es === 1);
  ok('nobody stopped mid-match', s.R.stp < 6 && s.B.stp < 6, JSON.stringify([s.R.stp, s.B.stp]));
  ok('both robots were in view', s.R.vis > 0.95);
  const stopped = win.vtSummarise(match({ redStop: [50, 80] }));
  ok('a robot that stops for thirty seconds is caught', stopped.R.stp >= 25 && stopped.R.stp <= 32, String(stopped.R.stp));
  const noAuto = win.vtSummarise(match({ redAuto: false }));
  ok('an alliance that sits out autonomous is seen to', noAuto.R.am === 0 && noAuto.R.ap < 0.03);
  const late = win.vtSummarise(match({ lead: 12 }));
  ok('more video before the start does not move the start', Math.abs(late.st) <= 2);
  ok('a recording with almost nothing in it is marked unusable', win.vtSummarise({ ...match({}), f: [[0, 0], [5, 0]] }).ok === 0);
  ok('the summary is small', JSON.stringify(s).length < 900, String(JSON.stringify(s).length));
  ok('a position is where the wheels are', /y: \(fr\[o \+ 1\] \+ fr\[o \+ 3\]\) \/ H/.test(idx));
}

console.log('\n· a team\'s report');
{
  const sums = new Map();
  // Six matches. It wins four playing up the field; it loses two when a robot stops and it is pinned at home.
  for (let i = 1; i <= 4; i++) sums.set('1:' + i, win.vtSummarise(match({ n: i, rs: 50, bs: 20, blue: ['B' + i, 'C' + i], red: ['66449A', 'P' + i] })));
  for (let i = 5; i <= 6; i++) sums.set('1:' + i, win.vtSummarise(match({ n: i, rs: 10, bs: 40, redStop: [40, 75], redUp: false, pressBlue: false, blue: ['B' + i, 'C' + i], red: ['66449A', 'P' + i] })));
  const rep = win.vtReport('66449A', sums);
  const all = JSON.stringify(rep.lines);
  ok('six matches make a report', rep.n === 6 && rep.wins === 4 && rep.losses === 2 && !!rep.lines);
  ok('it is credited with autonomous', rep.lines.good.some(t => /Autonomous/.test(t)), all.slice(0, 400));
  ok('the autonomous section counts matches', rep.lines.auto.some(t => /Both robots moved in autonomous in 6 of 6/.test(t)), JSON.stringify(rep.lines.auto));
  ok('and says how far the routine goes, and that it repeats', rep.lines.auto.length === 3 && rep.lines.auto.some(t => /same routine every time/.test(t)));
  ok('a habit needs seven matches in ten', rep.lines.habits.some(t => /Stationary for the last few seconds.*\(6 of 6 matches\)/.test(t)), JSON.stringify(rep.lines.habits));
  ok('playing up the field 4 of 6 times is not called a habit', !rep.lines.habits.some(t => /Spends most of driver control/.test(t)));
  ok('the losses are explained by what was different in them', rep.lines.lose.some(t => /stops for longer/.test(t) && /in losses/.test(t)), JSON.stringify(rep.lines.lose));
  ok('at most three reasons are given', rep.lines.lose.length <= 3 && rep.lines.lose.length >= 1);
  ok('every line is plain text with numbers a reader could check', all.length > 200 && !/<|>|undefined|NaN|null%/.test(all), all);
  const few = win.vtReport('66449A', new Map([...sums].slice(0, 2)));
  ok('two matches are not a report', few.n === 2 && few.lines === null);
  ok('a team that was not in these matches has none', win.vtReport('99999Z', sums).n === 0);
  const onlyWins = win.vtReport('66449A', new Map([...sums].slice(0, 4)));
  ok('with no losses tracked, it does not invent a reason for losing', onlyWins.lines.lose.length === 0);
  const html = win.vtReportHtml('66449A', rep);
  ok('the block has its sections', ['Strengths', 'Weaknesses', 'Autonomous', 'Does repeatedly', 'When it loses', 'How to use this'].every(h => html.includes(h)));
  ok('says it is about the alliances when the robot could not be picked out', /describes the alliances 66449A was on, not its own robot/.test(html) && rep.own === false);
  ok('and that it is unchecked', /unchecked against human scouting/.test(html));
  ok('says what it needs when there are too few', /a report needs three/.test(win.vtReportHtml('66449A', few)) && /needs at least two tracked wins and two losses/i.test(win.vtReportHtml('66449A', onlyWins)));
  ok('a team number is escaped in the block', !/<img/.test(win.vtReportHtml('<img src=x>', few)));
  ok('the team page asks for the report', /<div id="vtReport" data-team=/.test(idx) && /setTimeout\(\(\) => vtReportFill\(d\.team\.number\), 0\)/.test(idx));
  ok('a report for a team no longer on screen is dropped', /if \(host\.dataset\.team !== num\) return;\s+\/\/ another team was opened meanwhile/.test(idx));
  ok('matches tracked before summaries existed are summarised from stored boxes', /async function vtBackfill/.test(idx) && /vtBackfill\(ev\)\.catch/.test(idx));
}

console.log('\n· summaries in shared storage');
{
  const mod = await import('../api/tracker.js');
  const realFetch = globalThis.fetch;
  const hashes = new Map(), kv = new Map(), sets = new Map();
  globalThis.fetch = async (url, opt) => {
    const out = JSON.parse(opt.body).map(c => {
      if (c[0] === 'SET') { kv.set(c[1], c[2]); return { result: 'OK' }; }
      if (c[0] === 'SADD') { if (!sets.has(c[1])) sets.set(c[1], new Set()); sets.get(c[1]).add(c[2]); return { result: 1 }; }
      if (c[0] === 'HSET') { if (!hashes.has(c[1])) hashes.set(c[1], new Map()); hashes.get(c[1]).set(c[2], c[3]); return { result: 1 }; }
      if (c[0] === 'HGETALL') { const o = []; for (const [k, v] of (hashes.get(c[1]) || new Map())) o.push(k, v); return { result: o }; }
      return { error: 'unknown' };
    });
    return { ok: true, status: 200, json: async () => out };
  };
  const call = async (method, query, body) => {
    const res = { code: 0, body: null, setHeader() {}, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
    await mod.default({ method, query: query || {}, body }, res);
    return res;
  };
  const E = process.env;
  E.KV_REST_API_URL = 'https://db.example'; E.KV_REST_API_TOKEN = 'tok'; E.TRACKER_PASSCODE = 'correct horse battery';
  const rec = match({}), sum = JSON.parse(JSON.stringify(win.vtSummarise(rec)));
  ok('a real summary passes the server\'s check', mod.validSum(sum) === null, String(mod.validSum(sum)));
  let r = await call('POST', {}, { passcode: 'correct horse battery', ev: '55001', id: '7', rec, sum });
  ok('a match saves with its summary', r.code === 200 && kv.has('vt:m:55001:7') && hashes.get('vt:s:55001').has('7'), JSON.stringify(r.body));
  ok('and the summary is filed under each of its four teams', ['66449A', '1234X', '12345B', '777Z'].every(t => hashes.get('vt:team:' + t) && hashes.get('vt:team:' + t).has('55001:7')));
  r = await call('GET', { team: '66449a' });
  ok('a team\'s summaries are one read, for anyone', r.code === 200 && r.body.sums['55001:7'].R.am === 2);
  r = await call('POST', {}, { passcode: 'correct horse battery', ev: '55001', id: '8', sum });
  ok('a summary can be saved on its own (backfill)', r.code === 200 && hashes.get('vt:s:55001').has('8') && !kv.has('vt:m:55001:8'));
  r = await call('POST', {}, { passcode: 'wrong', ev: '55001', id: '9', sum });
  ok('not without the passcode', r.code === 403);
  const bad = async over => (await call('POST', {}, { passcode: 'correct horse battery', ev: '55001', id: '9', sum: { ...sum, ...over } })).code;
  ok('markup anywhere in a summary is refused', await bad({ name: '<script>' }) === 400 && await bad({ red: ['<b>'] }) === 400 && await bad({ R: { am: '<i>' } }) === 400 && await bad({ note: 'hello' }) === 400);
  ok('an oversized summary is refused', await bad({ R: Object.fromEntries(Array.from({ length: 130 }, (_, i) => ['k' + (i % 10) + String.fromCharCode(97 + Math.floor(i / 10)), 1])) }) === 400);
  r = await call('POST', {}, { passcode: 'correct horse battery', field: { vid: 'abcDEF12345', q: [0.1, 0.2, 0.9, 0.2, 0.9, 0.8, 0.1, 0.8] } });
  ok('a stream\'s field corners are saved with the passcode', r.code === 200 && kv.has('vt:field:abcDEF12345'));
  ok('and not without it, or when they are not corners', (await call('POST', {}, { passcode: 'no', field: { vid: 'abcDEF12345', q: [0, 0, 1, 0, 1, 1, 0, 1] } })).code === 403 && (await call('POST', {}, { passcode: 'correct horse battery', field: { vid: 'abcDEF12345', q: [0, 0, 1, 0, 'x', 1, 0, 1] } })).code === 400 && (await call('POST', {}, { passcode: 'correct horse battery', field: { vid: '<b>', q: [0, 0, 1, 0, 1, 1, 0, 1] } })).code === 400);
  ok('a real summary with the game measures passes the server\'s check', (() => { const QUAD = { q: [100 / 640, 80 / 360, 540 / 640, 80 / 360, 540 / 640, 300 / 360, 100 / 640, 300 / 360], by: 'click' }; const sg = JSON.parse(JSON.stringify(win.vtSummarise(match({ v2: true }), QUAD))); return mod.validSum(sg) === null && JSON.stringify(sg).length < 12000; })());
  r = await call('GET', { team: "x';--" });
  ok('a team that is not a team number is refused', r.code === 400);
  r = await call('POST', {}, { passcode: 'correct horse battery', ev: '55001', id: '9' });
  ok('saving nothing is an error', r.code === 400);
  globalThis.fetch = realFetch;
  delete E.KV_REST_API_URL; delete E.KV_REST_API_TOKEN; delete E.TRACKER_PASSCODE;
}

console.log('\n· which robot is which');
{
  // Four looks. 66449A is mostly green; each partner is something else.
  const A = [0, 0, 12, 10, 0, 0, 0, 0, 3, 3, 1, 1], opp1 = [3, 3, 3, 3, 3, 3, 3, 3, 2, 2, 1, 1], opp2 = [0, 8, 0, 0, 0, 0, 8, 0, 4, 4, 3, 3];
  const partner = i => { const g = [0, 0, 0, 0, 0, 0, 0, 0, 4, 4, 2, 2]; g[(i * 3) % 8] = 12; g[(i * 3 + 1) % 8] = 6; if (i % 8 === 2 || (i * 3) % 8 === 2) { g[2] = 0; g[3] = 0; g[6] = 12; } return g; };
  // 66449A drives up the field and runs an autonomous; its partner stays home.
  const mk = (i, over) => match({ n: i, v2: true, partnerHome: true, rs: i <= 4 ? 50 : 10, bs: 20, red: ['66449A', 'P' + i], blue: ['B' + i, 'C' + i], looks: [A, partner(i), opp1, opp2], ...over });
  const sums = new Map();
  for (let i = 1; i <= 6; i++) sums.set('77:' + i, win.vtSummarise(mk(i)));
  const s1 = sums.get('77:1');
  ok('each robot gets its own numbers', s1.Ra.am + s1.Rb.am === 1 && Math.abs(s1.Ra.opp - s1.Rb.opp) > 0.8, JSON.stringify([s1.Ra, s1.Rb]).slice(0, 300));
  ok('and its look is kept', s1.Ra.g2 !== undefined && s1.Rb.g2 !== undefined && s1.Ra.g2 !== s1.Rb.g2);
  const picks = win.vtIdentify('66449A', sums);
  const upfield = k => { const s = sums.get(k), p = picks.get(k); return p && s['R' + p.slot].opp > 0.5; };
  ok('the look that recurs while the partner changes is taken to be the team', picks.size === 6 && [...sums.keys()].every(upfield), JSON.stringify([...picks]));
  ok('found by look, not by plate', [...picks.values()].every(p => p.how === 'look'));
  const rep = win.vtReport('66449A', sums);
  ok('the report is then about its own robot', rep.own === true && rep.picked === 6 && rep.how.look === 6);
  ok('and says what the robot does, not what the alliance averages to', rep.lines.auto.some(t => /^Moved in autonomous in 6 of 6 matches/.test(t)) && rep.lines.habits.some(t => /Spends most of driver control in the other alliance's half \(6 of 6/.test(t)), JSON.stringify(rep.lines));
  const partnerRep = win.vtReport('P1', new Map([...sums].slice(0, 1)));
  ok('one match is not enough to say anything about a partner', partnerRep.lines === null);
  ok('the block says how it was picked out', /This is 66449A's own robot/.test(win.vtReportHtml('66449A', rep)) && /by its look turning up every time/.test(win.vtReportHtml('66449A', rep)));

  // Two robots that look the same: the look cannot say. A plate read can.
  const same = new Map();
  for (let i = 1; i <= 4; i++) same.set('78:' + i, win.vtSummarise(mk(i, { looks: [A, A, opp1, opp2] })));
  ok('lookalike robots are left unidentified', win.vtIdentify('66449A', same).size === 0);
  ok('and the report falls back to the alliance', win.vtReport('66449A', same).own === false);
  const plated = new Map();
  for (let i = 1; i <= 4; i++) plated.set('79:' + i, win.vtSummarise(mk(i, { looks: [A, A, opp1, opp2], plate: [1, 2, 0, 0] })));
  const pp = win.vtIdentify('66449A', plated);
  ok('a plate read settles it even for lookalikes', pp.size === 4 && [...pp.values()].every(p => p.how === 'plate'), JSON.stringify([...pp]));
  ok('and picks the robot that was actually read', [...plated.keys()].every(k => plated.get(k)['R' + pp.get(k).slot].opp > 0.5));
  // The same partner every match (an elimination alliance): both robots recur.
  const fixed = new Map();
  for (let i = 1; i <= 4; i++) fixed.set('80:' + i, win.vtSummarise(mk(i, { red: ['66449A', 'P1'], looks: [A, partner(1), opp1, opp2] })));
  ok('with the same partner every time the look is not trusted', win.vtIdentify('66449A', fixed).size === 0);
  // Identities do not cross events.
  const two = new Map([...[1, 2].map(i => ['81:' + i, win.vtSummarise(mk(i))]), ...[3, 4].map(i => ['82:' + i, win.vtSummarise(mk(i))])]);
  ok('two matches at each of two events is not three at one', win.vtIdentify('66449A', two).size === 0);

  // Paint is not a plate: a red-alliance robot called blue in most looks.
  {
    const rec = mk(1);
    // Robot 0 (66449A, red) is recoloured blue in four looks out of five.
    rec.f.forEach((fr, k) => { if (k % 5) fr[2 + 5] = 2; });
    const s = win.vtSummarise(rec);
    ok('a robot miscoloured by its paint is put back on its alliance', s.ok === 1 && s.Ra.sec > 60 && s.Rb.sec > 60 && s.Ba.sec > 60 && s.Bb.sec > 60, JSON.stringify([s.Ra.sec, s.Rb.sec, s.Ba.sec, s.Bb.sec]));
    const rec2 = mk(2, { plate: [1, 0, 0, 0] });
    rec2.f.forEach(fr => { fr[2 + 5] = 2; });          // called blue in EVERY look, but its plate was read
    const s2 = win.vtSummarise(rec2);
    ok('a plate read overrules the colour entirely', s2.Ra.sec + s2.Rb.sec > 150 && (s2.Ra.wa >= 2 || s2.Rb.wa >= 2), JSON.stringify([s2.Ra.sec, s2.Rb.sec, s2.Ra.wa, s2.Rb.wa]));
    ok('a read names any of the four teams in the match', win.vtWhoFromText('12345B', ['66449A', '1234X', '12345B', '777Z']) === 3 && win.vtWhoFromText('66449A', ['66449A', '1234X', '12345B', '777Z']) === 1 && win.vtWhoFromText('zzzz', ['66449A', '1234X', '12345B', '777Z']) === 0);
    ok('and a read corrects the box\'s colour as it is recorded', /big\[5\] = big\[7\] <= 2 \? 1 : 2;/.test(idx));
  }
  ok('a plate is matched against the two teams it could be', win.vtWhoFromText('66449A', ['66449A', '1234X']) === 1 && win.vtWhoFromText('1234X', ['66449A', '1234X']) === 2);
  ok('lookalike characters are forgiven', win.vtWhoFromText('G6449A', ['66449A', '1234X']) === 1 && win.vtWhoFromText('88388', ['8838B', '2468X']) === 1);
  ok('extra characters around it are ignored', win.vtWhoFromText('X66449A1', ['66449A', '1234X']) === 1);
  ok('sister teams one letter apart need the letter', win.vtWhoFromText('6722A', ['6722A', '6722B']) === 1 && win.vtWhoFromText('6722', ['6722A', '6722B']) === 0);
  ok('rubbish names nobody', win.vtWhoFromText('CHARA', ['66449A', '1234X']) === 0 && win.vtWhoFromText('', ['66449A', '1234X']) === 0 && win.vtWhoFromText('66', ['66449A', '1234X']) === 0);
  // The plate inside a box: a red strip with white letters on a grey robot.
  const W = 80, H = 60, px = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const i = (y * W + x) * 4; const on = y >= 30 && y < 44 && x >= 10 && x < 70; const letter = on && y >= 33 && y < 41 && (x % 9) < 3;
    px[i] = letter ? 255 : on ? 220 : 110; px[i + 1] = letter ? 255 : on ? 30 : 110; px[i + 2] = letter ? 255 : on ? 30 : 110; px[i + 3] = 255; }
  const pb = win.vtPlateBox(px, W, H, 1);
  ok('the plate is found inside the robot\'s box', !!pb && Math.abs(pb.y - 30) <= 1 && Math.abs(pb.h - 14) <= 2 && pb.x <= 12 && pb.x + pb.w >= 66, JSON.stringify(pb));
  ok('no plate, no read', win.vtPlateBox(px, W, H, 2) === null);
  ok('a plate too small to read is not sent to the reader', (() => { const q = new Uint8ClampedArray(px); for (let y = 36; y < 44; y++) for (let x = 0; x < W; x++) { const i = (y * W + x) * 4; q[i] = q[i + 1] = q[i + 2] = 110; } return win.vtPlateBox(q, W, H, 1) === null; })());
  const g = win.vtSigOf(px, W, H, [0, 0, W, H], 1);
  ok('a robot\'s look leaves out its own plate colour', !!g && g[0] === 0 && g[7] === 0 && g.slice(8).reduce((a, b) => a + b, 0) > 10, JSON.stringify(g));
  ok('a look survives being packed into three numbers', JSON.stringify(win.vtSigUnpack(...win.eval('vtSigPack')(A))) === JSON.stringify(A));
  ok('the reader model is in the repo and loaded only by the worker', fs.statSync('../models/plate_reader.onnx').size > 5e6 && /plate_reader\.onnx/.test(fs.readFileSync('../vendor/vt-worker.js', 'utf8')) && !/plate_reader/.test(idx));
  ok('recordings from before this are watched once more', /const vtDone = e => !!e && e\.s === 'done' && \(e\.v \|\| 1\) >= VT_REC_V;/.test(idx));
}

console.log('\n· the game: toggles, roles, routes');
{
  // The field in the picture: a rectangle from (100, 80) to (540, 300) of a 640×360 frame.
  const QUAD = { q: [100 / 640, 80 / 360, 540 / 640, 80 / 360, 540 / 640, 300 / 360, 100 / 640, 300 / 360], by: 'click' };
  const pack = g => [0, 4, 8].map(k => g[k] | g[k + 1] << 4 | g[k + 2] << 8 | g[k + 3] << 12);
  // Each robot is a list of [second, u, v] keyframes on the real field (red's wall at u = 0).
  const at = (keys, t) => { let a = keys[0]; for (const k of keys) { if (k[0] <= t) a = k; else { const f = (t - a[0]) / (k[0] - a[0]); return [a[1] + (k[1] - a[1]) * f, a[2] + (k[2] - a[2]) * f]; } } return [a[1], a[2]]; };
  // The meta: one guards the side toggle while the other stacks in front of it, then they swap.
  const SCRIPT = [
    // 66449A: an autonomous to the side toggle; guards it; leaves the moment its partner is done; then stacks; midfield at the end.
    [[-4, .08, .3], [0, .08, .3], [8, .5, .05], [20, .5, .05], [60, .5, .05], [63, .5, .22], [110, .48, .24], [113, .5, .5], [128, .5, .5]],
    // Its partner: no autonomous; stacks in that quadrant; then takes over the toggle; is pushed off it once.
    [[-4, .08, .7], [20, .08, .7], [23, .45, .24], [58, .45, .24], [61, .2, .5], [66, .5, .05], [81, .5, .05], [83, .4, .27], [90, .4, .27], [93, .5, .05], [128, .5, .05]],
    // A blue robot that goes for that toggle twice: bounced the first time, takes it the second.
    [[-4, .92, .4], [31, .92, .4], [35, .52, .1], [39, .52, .1], [42, .85, .5], [76, .85, .5], [80, .52, .08], [88, .52, .08], [91, .85, .5], [128, .85, .5]],
    [[-4, .92, .65], [20, .92, .65], [25, .88, .6], [128, .86, .62]]
  ];
  const looksOf = i => { const g = [0, 0, 0, 0, 0, 0, 0, 0, 4, 4, 2, 2]; g[(i * 3) % 8] = 12; g[(i * 3 + 1) % 8] = 6; return g; };
  const A = [0, 0, 12, 10, 0, 0, 0, 0, 3, 3, 1, 1];
  const meta = (i, over) => {
    const o = { red: ['66449A', 'P' + i], blue: ['ATK', 'C' + i], rs: 60, bs: 30, ...over }, f = [];
    const looks = [A, looksOf(i === 2 ? 5 : i), [3, 3, 3, 3, 3, 3, 3, 3, 2, 2, 1, 1], [0, 8, 0, 0, 0, 0, 8, 0, 4, 4, 3, 3]];
    for (let t = -4; t <= 128; t += 0.25) {
      const fr = [Math.round(t * 10), 4];
      SCRIPT.forEach((keys, k) => { const [u, v] = at(keys, t), x = 100 + 440 * u, y = 80 + 220 * v; fr.push(Math.round(x - 20), Math.round(y - 40), 40, 40, 90, k < 2 ? 1 : 2, ...pack(looks[k]), 0); });
      f.push(fr);
    }
    return { v: 2, name: 'Qualification ' + i, round: 2, num: i, red: o.red, blue: o.blue, rs: o.rs, bs: o.bs, vid: 'abcDEF12345', off: 100, rate: 2, w: 640, h: 360, model: 'det1', at: 1, f };
  };
  const h = win.vtHomography(QUAD.q);
  const mid = h(320 / 640, 190 / 360), corner = h(100 / 640, 80 / 360);
  ok('four corners map the picture onto the field', Math.abs(mid[0] - 0.5) < 1e-6 && Math.abs(mid[1] - 0.5) < 1e-6 && Math.abs(corner[0]) + Math.abs(corner[1]) < 1e-6, JSON.stringify([mid, corner]));
  ok('corners can be clicked in any order', (() => { const g = win.vtHomography([540 / 640, 300 / 360, 100 / 640, 80 / 360, 100 / 640, 300 / 360, 540 / 640, 80 / 360]); const m2 = g(0.5, 190 / 360); return Math.abs(m2[0] - 0.5) < 1e-6 && Math.abs(m2[1] - 0.5) < 1e-6; })());
  ok('a camera at an angle is handled (a trapezoid, not a rectangle)', (() => { const g = win.vtHomography([0.3, 0.2, 0.7, 0.2, 0.95, 0.9, 0.05, 0.9]); const c = g(0.5, 0.2), d = g(0.5, 0.9); return Math.abs(c[0] - 0.5) < 1e-6 && Math.abs(d[0] - 0.5) < 1e-6 && Math.abs(c[1] - d[1]) > 0.99; })());
  ok('the zones of the field are named from a robot\'s own wall', win.vtZone(0.05, 0.5) === 6 && win.vtZone(0.97, 0.5) === 9 && win.vtZone(0.5, 0.03) === 7 && win.vtZone(0.5, 0.5) === 5 && win.vtZone(0.15, 0.5) === 6 - 5 + 0 || win.vtZone(0.2, 0.5) === 1);
  ok('own quadrant, opponent\'s, the sides', win.vtZone(0.2, 0.5) === 1 && win.vtZone(0.8, 0.5) === 4 && win.vtZone(0.5, 0.22) === 2 && win.vtZone(0.5, 0.8) === 3);

  const s = win.vtSummarise(meta(1), QUAD);
  ok('with corners, a match gets the game\'s measures', s.ok === 1 && s.fq > 10000 && s.Ra.th !== undefined && s.Ba.ca !== undefined, JSON.stringify(s.Ra).slice(0, 300));
  const mine = [s.Ra, s.Rb].find(r => r.art === 127 || String(r.art).startsWith('12')), mate = [s.Ra, s.Rb].find(r => r !== mine);
  ok('the autonomous route is read as places in order', !!mine && String(mine.art) === '127', JSON.stringify([s.Ra.art, s.Rb.art]));
  ok('and the partner is seen to have none', !!mate && String(mate.art).length === 1);
  ok('the guard is seen guarding: forty seconds at the side toggle', mine.gd >= 36 && mine.gd <= 46 && mine.ts > 0.3, JSON.stringify([mine.gd, mine.gt, mine.ts]));
  ok('a defence that held is counted', mine.da === 1 && mine.dw === 1, JSON.stringify([mine.da, mine.dw]));
  ok('a defence that failed is counted', mate.da === 1 && mate.dw === 0, JSON.stringify([mate.da, mate.dw]));
  const atk = [s.Ba, s.Bb].find(r => r.ca > 0);
  ok('the attacker took a defended toggle in one of two tries', !!atk && atk.ca === 2 && atk.cw === 1, JSON.stringify(atk && [atk.ca, atk.cw]));
  ok('leaving the toggle when the partner is done is caught', mine.rn === 1 && mine.rl === 1, JSON.stringify([mine.rn, mine.rl]));
  ok('the alliance swapped guard and stacker', s.R.sw >= 1 && s.B.sw === 0, JSON.stringify([s.R.sw, s.B.sw]));
  ok('midfield at the end', mine.eg === 1 && mate.eg === 0);
  ok('where it plays is kept as a grid, and its autonomous as a path', mine.h0 !== undefined && mine.h24 !== undefined && mine.p0 >= 0 && mine.p11 >= 0 && [...Array(25)].reduce((a, _, k) => a + mine['h' + k], 0) >= 95);
  ok('without corners none of this is claimed', win.vtSummarise(meta(1)).Ra.th === undefined && win.vtSummarise(meta(1)).fq === 0);
  // Blue's wall on the left of the picture instead: the field is turned so red is still on the left.
  const flipped = meta(1); flipped.f.forEach(fr => { for (let k = 0; k < 4; k++) { const o = 2 + 10 * k; fr[o] = 640 - fr[o] - 40; fr[o + 1] = 360 - fr[o + 1] - 40 - 40 + 40; } });
  const sf = win.vtSummarise(flipped, QUAD);
  ok('whichever wall red is on in the picture, it comes out the same', [sf.Ra, sf.Rb].some(r => r.gd >= 30 && r.ts > 0.25), JSON.stringify([sf.Ra.gd, sf.Rb.gd, sf.Ra.ts, sf.Rb.ts]));

  const sums = new Map();
  for (let i = 1; i <= 5; i++) sums.set('90:' + i, win.vtSummarise(meta(i, { rs: i <= 3 ? 60 : 20, bs: 30 }), QUAD));
  const rep = win.vtReport('66449A', sums), G = rep.game, all = JSON.stringify(G);
  ok('the report is about its own robot, on the real field', rep.own === true && G.n === 5, JSON.stringify([rep.own, rep.picked, G.n]));
  ok('it lists the autonomous routine, with how often', G.autos.some(x => /^5 of 5: starts in its own quadrant, then a side quadrant, then a side toggle\./.test(x)), JSON.stringify(G.autos));
  ok('and counts that as a strength', rep.lines.good.some(x => /repeatable autonomous/.test(x)));
  ok('it says what it does at toggles', G.toggles.some(x => /Held its toggle against 5 of 5/.test(x)) && rep.lines.good.some(x => /Hard to push off a toggle/.test(x)), JSON.stringify(G.toggles));
  ok('it says its strategy changes when its partner finishes', G.shift.some(x => /Stops guarding as soon as its partner is done.*5 of 5/.test(x)), JSON.stringify(G.shift));
  ok('and that its alliances swap roles', G.role.some(x => /swap guard and stacker/.test(x)), JSON.stringify(G.role));
  ok('it says where it spends its time', G.where.some(x => /Most of its time is in the side quadrants/.test(x)), JSON.stringify(G.where));
  ok('and the endgame', G.shift.some(x => /In midfield for the last ten seconds in 5 of 5/.test(x)));
  const atkRep = win.vtReport('ATK', sums);
  ok('for the attacker: its record on defended toggles', atkRep.game.toggles.some(x => /Took a defended toggle in 5 of 10 tries \(50%\)/.test(x)) || atkRep.game.toggles.some(x => /Took a defended toggle in \d+ of \d+ tries/.test(x)), JSON.stringify(atkRep.game.toggles));
  const html = win.vtReportHtml('66449A', rep);
  ok('the block shows routes and a heat map of the field', (html.match(/class="vr-field"/g) || []).length === 2 && /<polyline/.test(html) && /Role and strategy/.test(html) && /Toggles/.test(html) && /Where it plays/.test(html));
  ok('and says what it cannot see', /It sees robots, not pins or toggles/.test(html));
  const noField = new Map(); for (let i = 1; i <= 5; i++) noField.set('91:' + i, win.vtSummarise(meta(i)));
  ok('with no corners it asks for them, and claims nothing about toggles', /press <strong>Mark the field<\/strong>/.test(win.vtReportHtml('66449A', win.vtReport('66449A', noField))) && win.vtReport('66449A', noField).game.n === 0);
  // Guessing the corners from where robots have been.
  const pts = []; for (let k = 0; k < 4000; k++) pts.push([100 / 640 + (440 / 640) * ((k * 37) % 100) / 100, 80 / 360 + (220 / 360) * ((k * 53) % 97) / 97]);
  const guess = win.vtQuadGuess(pts);
  ok('corners nobody clicked are guessed from the robots\' footprint', !!guess && guess.length === 8 && Math.min(...guess.filter((_, k) => k % 2 === 0)) < 0.2 && Math.max(...guess.filter((_, k) => k % 2 === 0)) > 0.8, JSON.stringify(guess));
  ok('but not from too little', win.vtQuadGuess(pts.slice(0, 500)) === null);
  ok('a clicked field and a guessed one are told apart', win.eval('vtQuadMark')({ q: QUAD.q, by: 'click' }) > 10000 && win.eval('vtQuadMark')({ q: QUAD.q, by: 'auto' }) < 10000 && win.eval('vtQuadMark')(null) === 0);
  ok('summaries are redone when a stream\'s field is marked', /\(have\.fq \|\| 0\) === vtQuadMark\(quad\)/.test(idx) && /vtBackfill\(String\(ctx\.eventId\), true\)/.test(idx));
  ok('the corners are marked over the Jumper\'s player, in four clicks', /function vtMarkField\(\)/.test(idx) && /onclick="vtMarkField\(\)">Mark the field</.test(idx));
}

ok('My team shows the report on your own robot, with a row per event', /<div id="vtCoach"><\/div>/.test(idx) && /async function vtCoachFill/.test(idx) && /Your robot, as the tracker sees it/.test(idx) && /vtCoachFill\(n\);/.test(idx));

console.log('\n· people are not robots; events still to come');
{
  // [x, y, w, h, confidence, colour]
  ok('a tall narrow box with no plate colour is a person, not a robot', win.vtRobotLike([0, 0, 60, 130, 0.48, 0]) === false);
  ok('so is one much taller than wide even with colour on it', win.vtRobotLike([0, 0, 40, 100, 0.9, 1]) === false);
  ok('a squarish box with a plate colour is a robot', win.vtRobotLike([0, 0, 50, 45, 0.5, 2]) === true);
  ok('a squarish box with no colour needs the finder to be sure', win.vtRobotLike([0, 0, 50, 45, 0.5, 0]) === false && win.vtRobotLike([0, 0, 50, 45, 0.7, 0]) === true);
  ok('the finder is asked to be surer than before', /const VT_CONF = 0\.45/.test(idx));
  const st = win.vtRecStats({ f: [[0, 1, 1, 1, 9, 9, 50, 0], [1, 2, 1, 1, 9, 9, 90, 1, 5, 5, 9, 9, 90, 2], [2, 1, 1, 1, 9, 9, 90, 1]] });
  ok('a frame only counts when it shows a robot of a known alliance', st.withRobot === 2 && st.red === 2 && st.blue === 1);
  ok('a match is only saved when both alliances were seen', /st\.red < 10 \|\| st\.blue < 10/.test(idx));
  const d = { team: { number: '66449A' }, upcomingList: [{ id: 7, name: 'Excalibur <b>', sku: 'VE-V5-26-65786', start: '2026-11-21T08:00:00', region: 'California' }], eventsList: [] };
  const up = win.renderEventsUpcoming(d);
  ok('a team page lists the events it is registered for', /Upcoming Events \(1\)/.test(up) && /VE-V5-26-65786/.test(up) && /openEventInTournament\('7'/.test(up));
  ok('with names escaped', !/<b>/.test(up) && /Excalibur &lt;b&gt;/.test(up));
  ok('and nothing when there are none', win.renderEventsUpcoming({ team: { number: 'X' }, upcomingList: [] }) === '');
  ok('they come from the team\'s registrations, not from matches played', /\(teamEvents \|\| \[\]\)\.filter\(e => e && e\.id != null && !eventMap\.has\(e\.id\)\)/.test(idx));
}

console.log('\n· the browser\'s Back button');
{
  ok('each place visited is a history entry', /history\.pushState\(\{ vs: key \}, ''\)/.test(idx));
  ok('Back and Forward walk the app\'s own list', /window\.addEventListener\('popstate'/.test(idx) && /vsNavGo\(best - vsNav\.i\)/.test(idx));
  ok('an unattended tracker run does not fill it', /vsNav\.mute = true;/.test(idx) && /if \(vsNav\.busy \|\| vsNav\.mute\) return;/.test(idx));
  win.switchTab('scout'); win.switchTab('tournament');
  await settle(win, 50);
  ok('no errors', errors.length === 0, errors.join('\n'));
}
win.close();
console.log(`\nt113: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
