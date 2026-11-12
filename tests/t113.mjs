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
  const o = { lead: 4, redStop: null, redAuto: true, redUp: true, pressBlue: true, ...opts };
  const f = [];
  const lerp = (a, b, k) => a + (b - a) * Math.max(0, Math.min(1, k));
  const wob = (t, s) => 14 * Math.sin(t * 0.9 + s);
  const robots = t => {
    const m = t - 0;                                    // match clock
    const red = i => {
      const y = i ? 250 : 130;
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
    for (const [x, y, c] of robots(t)) fr.push(Math.round(x - 20), Math.round(y - 40), 40, 40, 90, c);
    f.push(fr);
  }
  return { v: 1, name: 'Qualification ' + (o.n || 1), round: 2, num: o.n || 1, red: o.red || ['66449A', '1234X'], blue: o.blue || ['12345B', '777Z'],
    rs: o.rs ?? 40, bs: o.bs ?? 20, vid: 'abcDEF12345', off: 100, rate: 2, w: 640, h: 360, model: 'det1', at: 1, f };
}

const { win, errors } = await boot();

console.log('\n· one match');
{
  const s = win.vtSummarise(match({}));
  ok('a match is summarised', s.ok === 1 && s.sv === 1 && !!s.R && !!s.B, JSON.stringify(s).slice(0, 300));
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
  ok('the block has all five sections', ['Good at', 'Autonomous', 'Does repeatedly', 'When it loses', 'How to use this'].every(h => html.includes(h)));
  ok('says these are alliance measures', /describe the <strong>alliance<\/strong>/.test(html));
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
  ok('an oversized summary is refused', await bad({ R: Object.fromEntries(Array.from({ length: 30 }, (_, i) => ['k' + String.fromCharCode(97 + i % 26), 1])) }) === 400);
  r = await call('GET', { team: "x';--" });
  ok('a team that is not a team number is refused', r.code === 400);
  r = await call('POST', {}, { passcode: 'correct horse battery', ev: '55001', id: '9' });
  ok('saving nothing is an error', r.code === 400);
  globalThis.fetch = realFetch;
  delete E.KV_REST_API_URL; delete E.KV_REST_API_TOKEN; delete E.TRACKER_PASSCODE;
}

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
