// t123 — v133: a vision model on the tracking computer, free.
//
// Asked: "work on building for the open vision model that's free with no
// fees". The app shows a few frames a match to a model run by Ollama on that
// computer; the website gives each answer to the robot the tracker had there.
// No model can be downloaded where this is built, so the app's side is tested
// against a stand-in server (desktop/dev/think.py); here: the join, the
// counting, the identity rule, the report, and what the server accepts.
import fs from 'fs';
import { boot, settle } from './harness.mjs';
import { validRec } from '../api/tracker.js';
let pass = 0, fail = 0;
const ok = (name, cond, detail) => { if (cond) { pass++; console.log('  ok   ' + name); } else { fail++; console.log('  FAIL ' + name + (detail ? '\n         ' + detail : '')); } };
const src = fs.readFileSync('../src/index.html', 'utf8'), app = fs.readFileSync('../desktop/vex_trainer.py', 'utf8');
console.log('t123 — v133');
const { win } = await boot();
await settle(win);
const f = n => win.eval(n);

// A match: two red robots on the left, two blue on the right, every half second.
const box = (x, y, col, who) => [x, y, 60, 60, 90, col, 0, 0, 0, who || 0];
const rec = { v: 2, name: 'Q1', red: ['2499B', '66449A'], blue: ['6722A', '8838C'], vid: 'abcdefghijk', off: 100, rate: 4, w: 640, h: 360, f: [], tm: [], pn: [], tg: [] };
for (let k = 0; k < 280; k++) {
  const j = k % 7;
  rec.f.push([k * 5, 4, ...box(60 + j, 60, 1), ...box(80 + j, 250, 1), ...box(500 - j, 70, 2), ...box(520 - j, 240, 2)]);
}
// The model spoke about frames 60, 120, 180, 240: first red robot stacking and
// read as 66449A; second red driving; first blue at a toggle.
const vo = [];
for (const k of [60, 120, 180, 240]) {
  const fr = rec.f[k];
  vo.push(fr[0], fr[2], fr[3], 1, 2, fr[0], fr[12], fr[13], 6, 0, fr[0], fr[22], fr[23], 4, 0);
}
rec.vo = vo;
{
  ok('the server takes the notes with a recording', validRec(rec) === null || validRec(rec) === undefined || validRec(rec) === '', String(validRec(rec)));
  ok('but not misshapen or oversized ones', validRec({ ...rec, vo: [1, 2, 3] }) === 'bad vision notes' && validRec({ ...rec, vo: new Array(605).fill(1) }) === 'bad vision notes' && validRec({ ...rec, vo: [1, 2, 3, 4, 'x'] }) === 'bad vision notes');
  const F = f('vtFrames')(rec, null, null);
  ok('each note finds its sighting again', F.acts.length === 12 && F.acts[0].act === 1 && F.acts[0].who === 2 && F.acts[0].t === 30);
  const sum = f('vtSummarise')(rec, null, null);
  ok('the match still summarises', sum && sum.ok === 1, JSON.stringify(sum).slice(0, 200));
  const reds = [sum.Ra, sum.Rb], blues = [sum.Ba, sum.Bb];
  const stacker = reds.find(r => r.v1), driver = reds.find(r => r.v6), tog = blues.find(r => r.v4);
  ok('the robot that was stacking gets four looks of stacking', stacker && stacker.v1 === 4 && !stacker.v6, JSON.stringify(reds.map(r => [r.v1, r.v6])));
  ok('its partner gets the driving', driver && driver !== stacker && driver.v6 === 4);
  ok('and a blue robot the toggle', tog && tog.v4 === 4 && !blues.some(r => r.v1 || r.v6));
  ok('plates the model read are kept apart from the reader\'s', stacker.xb === 4 && !stacker.xa && !stacker.wa && !stacker.wb);
  // identity from them
  const sums = new Map([['1:1', sum]]), pick = f('vtIdentify')('66449A', sums).get('1:1');
  ok('four clear reads name the robot, marked as the vision model\'s', pick && pick.how === 'vision' && sum['R' + pick.slot] === stacker, JSON.stringify(pick));
  const partner = f('vtIdentify')('2499B', sums).get('1:1');
  ok('and its partner is the other one', partner && sum['R' + partner.slot] === driver);
  const weak = JSON.parse(JSON.stringify(sum)); for (const r of [weak.Ra, weak.Rb]) if (r.xb) r.xb = 2;
  ok('two reads are not enough', !f('vtIdentify')('66449A', new Map([['1:1', weak]])).has('1:1'));
  const split = JSON.parse(JSON.stringify(sum)); for (const r of [split.Ra, split.Rb]) { if (r.xb) { r.xb = 4; r.xa = 3; } }
  ok('nor reads that disagree', !f('vtIdentify')('66449A', new Map([['1:1', split]])).has('1:1'));
  const read = JSON.parse(JSON.stringify(sum)); const other = read.Ra.xb ? read.Rb : read.Ra; other.wb = 5;
  const p2 = f('vtIdentify')('66449A', new Map([['1:1', read]])).get('1:1');
  ok('the plate reader outranks the model when they differ', p2 && p2.how === 'plate' && read['R' + p2.slot] === other);
  ok('a red team\'s number on a blue robot counts for nothing', (() => { const r2 = JSON.parse(JSON.stringify(rec)); const fr = r2.f[60]; r2.vo = [fr[0], fr[22], fr[23], 4, 2]; const s2 = f('vtSummarise')(r2, null, null); return ![s2.Ra, s2.Rb, s2.Ba, s2.Bb].some(r => r.xa || r.xb) && [s2.Ba, s2.Bb].some(r => r.v4 === 1); })());
  ok('a recording without notes is unchanged', (() => { const r3 = { ...rec }; delete r3.vo; const s3 = f('vtSummarise')(r3, null, null); return ![s3.Ra, s3.Rb, s3.Ba, s3.Bb].some(r => Object.keys(r).some(k => /^v\d$|^x[ab]$/.test(k))); })());
}
// ── the report ──
{
  const S = f('vtSeenOf')([{ v1: 6, v6: 2 }, { v1: 3, v4: 1 }, { th: 0.1 }]);
  ok('looks add up over matches', S.n === 12 && S.counts[1] === 9 && S.matches === 2);
  const html = f('vtReportSeen')(S);
  ok('shown as bars, most first, with where it came from', /Seen doing/.test(html) && html.indexOf('Stacking pins on a goal') < html.indexOf('Driving') && /75%/.test(html) && /12 looks in 2 matches by a vision model on the tracking computer/.test(html) && /can be wrong/.test(html));
  ok('too few looks, no section', f('vtReportSeen')(f('vtSeenOf')([{ v1: 3 }])) === '' && f('vtReportSeen')(null) === '');
  ok('the lists match between app and website', (() => { const m = app.match(/THINK_DOING = \[([^\]]+)\]/s); const names = [...m[1].matchAll(/'([^']+)'/g)].map(x => x[1]); return names.length === 9 && names[0] === 'cannot tell' && f('VT_DOING').length === 9 && names[1] === 'stacking pins on a goal' && f('VT_DOING')[1] === 'Stacking pins on a goal' && names[8].startsWith('tipped') && f('VT_DOING')[8].startsWith('Tipped'); })());
  ok('the report says when the model named the robot', /by the vision model reading it in \$\{h\.vision\}/.test(src));
}
// ── the app ──
{
  ok('off unless switched on, in settings, with what it costs said first', /id="sThink"/.test(app) && /about 6 GB, once/.test(app) && /nothing is sent anywhere/.test(app) && /cfg\['think'\] = bool\(body\.get\('think'\)\)/.test(app));
  ok('it talks only to this computer', /OLLAMA = 'http:\/\/127\.0\.0\.1:11434'/.test(app) && !/api\.openai|anthropic\.com|googleapis\.com\/v1beta/.test(app));
  ok('answers come from fixed lists, never free writing', /'enum': teams \+ \['unreadable'\]/.test(app) && /'enum': THINK_DOING/.test(app) && /'temperature': 0/.test(app));
  ok('told not to guess plates; one number on two robots counts for neither', /Never guess from colour alone/.test(app) && /twice = set\(p for p in plates if plates\.count\(p\) > 1\)/.test(app));
  ok('the model is fetched with the bar showing', /progress\('Downloading the vision model', d\.get\('completed', 0\), d\['total'\]\)/.test(app) && /--think-setup/.test(app));
  ok('tracking goes on without it if it is not there', /Tracking without the vision model this time\./.test(app) && /_THINK\['failed'\] >= 3/.test(app));
  ok('private working values are not written to the settings file', /if not k\.startswith\('_'\)/.test(app));
}
ok('release is v133 or later', /const APP_BUILD = 'v1[3-9]\d'/.test(src) && !/const APP_BUILD = 'v13[0-2]'/.test(src));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
