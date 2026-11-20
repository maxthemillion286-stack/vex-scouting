// t160 — v174: "i met all the fixes and it didnt fix". The field was marked
// after the matches were summarised; the team page now makes those again.
import fs from 'fs';
import { boot, settle } from './harness.mjs';
let pass = 0, fail = 0;
const ok = (name, cond, detail) => { if (cond) { pass++; console.log('  ok   ' + name); } else { fail++; console.log('  FAIL ' + name + (detail ? '\n         ' + detail : '')); } };
const src = fs.readFileSync('../src/index.html', 'utf8');
console.log('t160 — v174');
const { win } = await boot();
await settle(win);
const f = n => win.eval(n);
const field = { q: [0.1, 0.8, 0.9, 0.8, 0.8, 0.2, 0.2, 0.2], g: new Array(18).fill(0.5), l: new Array(8).fill(0.5) };
const mark = f('vtQuadMark')(field);
win.eval(`vtFieldGet = async vid => vid === 'streamAAAAA' ? ${JSON.stringify(field)} : null;
vtSummarise = rec => ({ ok: 1, sv: VT_SUM_V, rv: 999, fq: vtQuadMark(${JSON.stringify(field)}), vid: rec.vid, red: rec.red, blue: rec.blue, remade: 1 });
vtApi = async (m, q) => m === 'GET' && /match=/.test(q) ? { ok: true, body: { rec: { f: [[0, 0]], vid: 'streamAAAAA', red: ['66449A', '1X'], blue: ['2Y', '3Z'] } } } : { ok: true, body: {} };`);
const S = (fq, vid) => ({ ok: 1, sv: f('VT_SUM_V'), rv: 999, fq, vid, red: ['66449A', '1X'], blue: ['2Y', '3Z'] });
const sums = new win.Map([['900:1', S(0, 'streamAAAAA')], ['900:2', S(mark, 'streamAAAAA')], ['900:3', S(0, 'streamBBBBB')]]);
const moved = await f('vtFieldStale')(sums);
ok('a summary made before its stream was marked is found', moved.has('900:1') && !moved.has('900:2') && !moved.has('900:3'), [...moved.keys()].join());
const n = await f('vtSumsRefresh')(sums);
ok('and made again with the mark', n === 1 && sums.get('900:1').remade === 1 && sums.get('900:1').fq === mark, String(n));
ok('not again once it has the mark', (await f('vtSumsRefresh')(sums)) === 0);
ok('the table and report always look for these, not only for older versions', !/host\.dataset\.fresh && \[\.\.\.sums\.values\(\)\]\.some\(vtStale\)/.test(src));
ok('a mark saved elsewhere (the app) replaces an older one marked here', /the shared mark is the newer one/.test(src));
ok('release is v174 or later', /const APP_BUILD = 'v1(7[4-9]|[89]\d)'/.test(src));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
