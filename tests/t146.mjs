// t146 — v157: the accuracy test. Asked: measure the tracker against a person
// ("you'd mark every placement in a few matches") and let it tune itself.
import fs from 'fs';
import { boot, settle } from './harness.mjs';
let pass = 0, fail = 0;
const ok = (name, cond, detail) => { if (cond) { pass++; console.log('  ok   ' + name); } else { fail++; console.log('  FAIL ' + name + (detail ? '\n         ' + detail : '')); } };
const src = fs.readFileSync('../src/index.html', 'utf8');
console.log('t146 — v157');
const { win } = await boot();
await settle(win);
const acc = win.eval('vtAccuracy'), tune = win.eval('vtTune');
// A stream where the field fills the picture: corners at the picture's corners.
const quad = { q: [0.1, 0.1, 0.9, 0.1, 0.9, 0.9, 0.1, 0.9] };
const H = 360, W = 640;
// Four robots, each a path in picture fractions over 60 s.
const paths = [
  t => [0.2 + 0.005 * t, 0.3], t => [0.25, 0.7 - 0.004 * t],
  t => [0.8 - 0.005 * t, 0.35], t => [0.75, 0.75 - 0.003 * t],
];
const mkRec = (miss) => {
  const f = [];
  for (let k = 0; k <= 240; k++) {
    const t = k / 4, fr = [Math.round(t * 10), 0];
    paths.forEach((p, i) => {
      if (miss && miss(i, t)) return;
      const [x, y] = p(t), bw = 50, bh = 40;
      fr.push(Math.round(x * W - bw / 2), Math.round(y * H - bh), bw, bh, 90, i < 2 ? 1 : 2, 0, 0, 0, 0);
      fr[1]++;
    });
    f.push(fr);
  }
  return { v: 2, h: H, w: W, off: 100, red: ['1A', '2B'], blue: ['3C', '4D'], f };
};
const samples = [];
for (let t = 2; t <= 58; t += 4) samples.push({ t: 100 + t, p: paths.map(p => p(t)) });
const good = acc(mkRec(), quad, samples);
ok('a tracker that sees every robot finds them all', good && good.found > 0.95 && good.n === samples.length * 4, JSON.stringify(good));
ok('typically well under a foot off', good && good.err < 0.5, JSON.stringify(good));
ok('no swaps', good && good.swaps === 0);
const half = acc(mkRec((i, t) => i === 0 && t > 30), quad, samples);
ok('a robot it lost shows as not found', half && half.found < 0.95 && half.found > 0.7, JSON.stringify(half));
const gone = samples.map(s => ({ t: s.t, p: [null, s.p[1], s.p[2], null] }));
ok('robots marked not in view are not counted', acc(mkRec(), quad, gone).n === gone.length * 2);
ok('without a field mark there is nothing to compare', acc(mkRec(), null, samples) === null);
const T = tune([{ rec: mkRec(), quad, samples }]);
ok('tuning runs and never does worse than where it started', T && T.best >= T.start && Object.keys(T.settings).length === 5, JSON.stringify(T));
ok('and leaves the settings as they were', JSON.stringify(win.eval('VT_TRACK')) === JSON.stringify({ gate0: 0.12, gateK: 0.3, weak0: 0.06, slack: 0.1, smooth: 0.03 }));
ok('the tracker reads its distances from one place', /const gate = VT_TRACK\.gate0 \+ VT_TRACK\.gateK \* Math\.min\(3, f\.t - tr\.t\);/.test(src) && /dd \/ VT_TRACK\.smooth/.test(src) && /VT_TRACK\.slack \+ VT_VMAX \* gap/.test(src));
ok('marking and scoring are on the tracker panel', /onclick="vtAccMark\(\)">Mark robots here<\/button>/.test(src) && /onclick="vtAccShow\(\)">Score the tracker<\/button>/.test(src));
ok('marks go through the same field mapping as the tracker', /const out = vtSlots\(F\.frames\), toField = vtHomography\(quad\.q\);/.test(src));
ok('release is v157 or later', /const APP_BUILD = 'v1(5[7-9]|[6-9]\d)'/.test(src));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
