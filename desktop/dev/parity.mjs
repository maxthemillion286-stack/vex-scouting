import fs from 'fs';
const src = fs.readFileSync('/home/claude/vex-scouting/src/index.html', 'utf8');
const grab = n => { const i = src.indexOf('\nfunction ' + n + '('); let d = 0, j = src.indexOf('{', i); for (let k = j; ; k++) { if (src[k] === '{') d++; else if (src[k] === '}') { d--; if (!d) return src.slice(i, k + 1); } } };
const code = ['vtColorOf', 'vtSigOf', 'vtPlateBox', 'vtPackFrame', 'vtEdit', 'vtNearTeam', 'vtWhoFromText', 'vtMatchLabel', 'vtTimerText'].map(grab).join('\n') +
  "\nconst VT_SIZE=640; const VT_LOOKALIKE = ['0ODQ', '1IL', '8B', '5S', '2Z', '6G']; const vtSigPack = g => g ? [0, 4, 8].map(o => g[o] | g[o + 1] << 4 | g[o + 2] << 8 | g[o + 3] << 12) : [0, 0, 0];\nreturn {vtColorOf, vtSigOf, vtPlateBox, vtPackFrame, vtEdit, vtWhoFromText, vtMatchLabel, vtTimerText};";
const F = new Function(code)();
const py = JSON.parse(fs.readFileSync('py.json', 'utf8'));
let bad = 0, n = 0;
const eq = (a, b, what) => { n++; if (JSON.stringify(a) !== JSON.stringify(b)) { bad++; if (bad < 8) console.log('DIFF', what, JSON.stringify(a), JSON.stringify(b)); } };
py.cases.forEach((c, k) => {
  const rgba = new Uint8Array(fs.readFileSync('img' + k + '.rgba')), crop = new Uint8Array(fs.readFileSync('crop' + k + '.rgba'));
  eq(F.vtColorOf(rgba, 640, 640, c.box), c.c, 'colour ' + k);
  eq(F.vtSigOf(rgba, 640, 640, c.box, 1), c.g1, 'sig1 ' + k);
  eq(F.vtSigOf(rgba, 640, 640, c.box, 2), c.g2, 'sig2 ' + k);
  for (const col of [1, 2]) { const p = F.vtPlateBox(crop, 240, 80, col); eq(p ? [p.x, p.y, p.w, p.h] : null, c['p' + col], 'plate' + col + ' ' + k); }
});
eq(F.vtPackFrame(12.34, py.boxes, 1280), py.pack, 'pack');
eq(['66449A', '6G449A', '6722', '6722B', 'X1234X', 'ABC', '12'].map(t => F.vtWhoFromText(t, ['66449A', '6722A', '6722B', '1234X'])), py.who, 'who');
eq(F.vtEdit('66449A', 'GG44QA'), py.edit, 'edit');
eq(['Qualification 12', 'Q103', 'SF 1-1', 'hello', 'QUAL #7', 'Practice 3'].map(t => { const l = F.vtMatchLabel(t); return l ? { round: l.round, num: l.num } : null; }), py.lab, 'label');
eq(['1:45', '0:07', '15', '10:45'].map(F.vtTimerText), py.tm, 'timer');
console.log(n + ' comparisons, ' + bad + ' differ');
