// t127 — v137: the Scoring line is short. Asked: "way too much info for scoring."
import fs from 'fs';
import { boot, settle } from './harness.mjs';
let pass = 0, fail = 0;
const ok = (name, cond, detail) => { if (cond) { pass++; console.log('  ok   ' + name); } else { fail++; console.log('  FAIL ' + name + (detail ? '\n         ' + detail : '')); } };
const src = fs.readFileSync('../src/index.html', 'utf8');
console.log('t127 — v137');
const { win } = await boot();
await settle(win);
win.eval('VT_HPP = 2');   // v204: these numbers were written with a pin as two halves
const L = win.eval('vtPinLine');
const rows = [{ ys: 4, vs: 12, vh: 4, k10: 30 }, { ys: 4, vs: 12, vh: 4, k10: 34 }, { ys: 4, vs: 12, vh: 4, k10: 32 }];
const p = L(rows, null, true, { ok: true, k: 1, raw: 1, err: 0.21, n: 9 });
ok('one short line: halves, how sure, a pin every, five pins in (v204: its fastest five, getting them included)', p.short === '4.0 yellow halves a match (±21%) · 5 pins in 32 s · 6.0 s a pin', p.short);
ok('under 80 characters', p.short.length < 80);
ok('unchecked: no ±', L(rows, null, true, null).short === '4.0 yellow halves a match · 5 pins in 32 s · 6.0 s a pin');
ok('the report\'s Scoring line uses it', /if \(pin\) B\.speed = pin\.short;/.test(src));
ok('the full version is still there, folded away, as points', /vr-h">How it scores</.test(src));
ok('release is v137 or later', /const APP_BUILD = 'v(1[3-9]\d|[2-9]\d\d)'/.test(src) && !/const APP_BUILD = 'v13[0-6]'/.test(src));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
