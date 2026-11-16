import fs from 'fs';
const src = fs.readFileSync('/home/claude/vex-scouting/src/index.html', 'utf8');
const grab = n => { const i = src.indexOf('\nfunction ' + n + '('); let d = 0, j = src.indexOf('{', i); for (let k = j; ; k++) { if (src[k] === '{') d++; else if (src[k] === '}') { d--; if (!d) return src.slice(i, k + 1); } } };
const F = new Function(grab('vtPlateTilts') + grab('vtPlateStrip') + '\nconst vtJround = v => Math.floor(v + 0.5);\nreturn { vtPlateTilts, vtPlateStrip };')();
let bad = 0, n = 0;
for (const c of JSON.parse(fs.readFileSync('py.json', 'utf8'))) {
  const rgba = new Uint8Array(fs.readFileSync('c' + c.n + '.rgba')), ts = F.vtPlateTilts(rgba, c.w, c.h, c.col);
  n++; if (ts.length !== c.tilts.length || ts.some((t, k) => t.some((v, j) => Math.abs(v - c.tilts[k][j]) > 1e-6))) { bad++; console.log('TILT DIFF', c.n, c.col, JSON.stringify(ts), JSON.stringify(c.tilts)); continue; }
  let k = 0;
  for (const t of ts) for (const fl of [0, 1]) {
    const st = F.vtPlateStrip(rgba, c.w, c.h, t, fl, 1.3), want = c.strips[k++]; let sum = 0;
    for (let i = 0; i < st.data.length; i += 4) sum += st.data[i] + st.data[i + 1] + st.data[i + 2];
    n++; if (st.used !== want.used || Math.abs(sum - want.sum) > 40) { bad++; console.log('STRIP DIFF', c.n, c.col, fl, st.used, want.used, sum, want.sum); }
  }
}
console.log(n + ' comparisons, ' + bad + ' differ');
