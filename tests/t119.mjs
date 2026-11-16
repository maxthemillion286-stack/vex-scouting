// t119 — v115: counting pins, and the short report.
//
// Asked: "why is it unable to count pins scored? if a human can so should a
// machine", with the manual's figure of a pin (40 mm across, 165 mm tall, two
// halves, each red, blue or yellow) as the baseline. Pins are found by colour
// and size; with the field marked they become halves set down, credited to
// the robot that was there.
//
// The fixture is a recording made by the DESKTOP APP from a drawn match
// (desktop/dev/pins.py): red's first robot sets down six yellow pins (12
// halves) in the left of the field, its second two red-over-yellow pins, blue
// sets down none, four yellow pins in midfield are never touched, and one
// robot carries a pin all match. The page then counts from that recording,
// so this also checks that the app and the page mean the same thing.
import fs from 'fs';
import { boot, settle } from './harness.mjs';
let pass = 0, fail = 0;
const ok = (name, cond, detail) => { if (cond) { pass++; console.log('  ok   ' + name); } else { fail++; console.log('  FAIL ' + name + (detail ? '\n         ' + detail : '')); } };
const idx = fs.readFileSync('../index.html', 'utf8'), app = fs.readFileSync('../desktop/vex_trainer.py', 'utf8');
console.log('t119 — v115: pins');
const { win } = await boot();
await settle(win);
const f = n => win.eval(n);

// ── one pixel ──
{
  const C = f('vtPinClass');
  ok('pin yellow is yellow', C(235, 205, 40) === 3 && C(250, 220, 60) === 3);
  ok('pin red is red, pin blue is blue', C(225, 35, 35) === 1 && C(35, 60, 225) === 2);
  ok('grey tiles, white lines and black are nothing', C(120, 120, 120) === 0 && C(250, 250, 250) === 0 && C(10, 10, 10) === 0);
  ok('a wooden floor is not yellow', C(190, 150, 110) === 0);
  ok('orange is not yellow', C(240, 120, 20) !== 3);
  ok('green is not yellow', C(60, 200, 60) === 0);
}
// ── finding them in a picture ──
{
  const W = 200, H = 120, px = new Uint8Array(W * H * 4);
  const rect = (x, y, w, h, r, g, b) => { for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) { const o = 4 * (j * W + i); px[o] = r; px[o + 1] = g; px[o + 2] = b; px[o + 3] = 255; } };
  rect(0, 0, W, H, 110, 110, 110);
  rect(20, 30, 5, 10, 235, 205, 40);                // a yellow half
  rect(20, 40, 5, 10, 225, 35, 35);                 // on a red half
  rect(80, 60, 5, 20, 35, 60, 225);                 // a blue pin
  rect(150, 10, 40, 60, 235, 205, 40);              // a yellow banner: too big
  rect(120, 100, 2, 2, 235, 205, 40);               // a speck
  rect(60, 20, 6, 12, 235, 205, 40);                // a pin in a robot's grip
  win.__px119 = px;
  const got = win.eval('vtPinBlobs(__px119, 200, 120, [[50, 5, 30, 40]])');
  const blobs = []; for (let i = 0; i < got.n; i++) blobs.push(got.flat.slice(6 * i, 6 * i + 6));
  ok('three pin parts are found', got.n === 3, JSON.stringify(blobs));
  const y = blobs.find(b => b[5] === 3), r = blobs.find(b => b[5] === 1), b = blobs.find(b => b[5] === 2);
  ok('each with its colour, size and where its foot is', y && r && b && y[4] === 50 && y[1] === 40 && r[1] === 50 && b[4] === 100 && b[2] === 5 && b[3] === 20, JSON.stringify(blobs));
  ok('a banner, a speck and a carried pin are not pins set down', !blobs.some(q => q[4] > 150 || q[4] < 10) && !blobs.some(q => q[0] > 55 && q[0] < 70));
}
// ── counting, from the app's recording ──
const fx = JSON.parse(fs.readFileSync('./fixtures/pins_rec.json', 'utf8'));
win.__rec119 = fx.rec; win.__quad119 = { q: fx.quad, by: 'click' };
const sum = win.eval('vtSummarise(__rec119, __quad119, null)');
{
  ok('the app\'s recording carries pin sightings', Array.isArray(fx.rec.pn) && fx.rec.pn.length > 1000 && fx.rec.pw === 960);
  ok('the match is summarised with pins counted', sum.ok === 1 && sum.pk >= 60, JSON.stringify({ ok: sum.ok, pk: sum.pk }));
  const red = [sum.Ra, sum.Rb].sort((a, b) => b.ys - a.ys), blue = [sum.Ba, sum.Bb];
  // Drawn pins come out a pixel wider than a real one would, so the count
  // runs about a third high here; the ranges allow for it.
  ok('the robot that set down six yellow pins is credited with about twelve halves', red[0].ys >= 10 && red[0].ys <= 18, String(red[0].ys));
  ok('its partner, with two half-yellow pins, with about two', red[1].ys >= 1.5 && red[1].ys <= 4, String(red[1].ys));
  ok('and with its own colour\'s halves too', red[1].as >= 1.5 && red[1].as <= 4 && red[0].as === 0, JSON.stringify([red[0].as, red[1].as]));
  ok('robots that set nothing down get nothing', blue.every(r => r.ys === 0 && r.as === 0), JSON.stringify(blue.map(r => [r.ys, r.as])));
  ok('pins nobody touched are not counted', sum.py >= 11.5 && sum.py <= 21, String(sum.py));
  ok('no blue was set down', sum.pb === 0);
  const mod = await import('../api/tracker.js');
  ok('the server accepts a recording with pin sightings', mod.validRec(fx.rec) === null, String(mod.validRec(fx.rec)));
  ok('and its summary', mod.validSum(JSON.parse(JSON.stringify(sum))) === null, String(mod.validSum(JSON.parse(JSON.stringify(sum)))));
  ok('pin sightings must be whole numbers', mod.validRec({ ...fx.rec, pn: [1.5, 0] }) === 'bad pins' && mod.validRec({ ...fx.rec, pn: ['<b>'] }) === 'bad pins');
  // Without the field marked there is nothing to count against.
  const none = win.eval('vtSummarise(__rec119, null, null)');
  ok('with the field not marked, nothing is claimed', none.ok === 1 && none.py === undefined && none.Ra.ys === undefined);
  // A recording from before pins.
  const old = { ...fx.rec }; delete old.pn; delete old.pw; delete old.ph; win.__old119 = old;
  const o = win.eval('vtSummarise(__old119, __quad119, null)');
  ok('a recording from before pins still summarises, without them', o.ok === 1 && o.py === undefined);
}
// ── said plainly ──
{
  const L = f('vtPinLine');
  const line = L([{ ys: 12, qh: 0.5, qs: 0, qo: 0 }, { ys: 10, qh: 0.5, qs: 0, qo: 0 }, { ys: 14, qh: 0.5, qs: 0, qo: 0 }], [{ ys: 4 }, { ys: 6 }], true);
  ok('a team\'s pins are an average with what it is worth', /about 12\.0 yellow halves a match \(worth 120 when its alliance holds that toggle\)/.test(line.text), line.text);
  ok('and a pace', /one every 4 s of stacking/.test(line.text), line.text);
  ok('against the robots it faced', /the robots it faced: 5\.0/.test(line.text));
  ok('one match is not enough to say', L([{ ys: 12 }], [], true) === null);
  ok('matches without pins counted say nothing', L([{ act: 1 }, { act: 2 }], [], true) === null);
}
// ── the short report ──
{
  const H = f('vtReportHtml');
  const rep = { n: 5, total: 5, own: true, how: { plate: 3, look: 2 }, picked: 5, wins: 3, losses: 2, vis: 0.9, game: { n: 0, strong: [], weak: [], autos: [], role: [], toggles: [], where: [], shift: [], paths: [] },
    lines: { good: ['Fast.'], weak: ['Stops.'], auto: ['Moved in 5 of 5.'], habits: [], lose: [], use: [] }, brief: { auto: 'a → b (5 of 5).', strat: 'Stacker: works the pins.', speed: 'Sets down about 12.0 yellow halves a match.' } };
  win.__rep119 = rep;
  win.document.body.insertAdjacentHTML('beforeend', '<div id="t119"></div>');
  win.document.getElementById('t119').innerHTML = win.eval(`vtReportHtml('66449A', __rep119)`);
  const host = win.document.getElementById('t119');
  const short = [...host.querySelectorAll('.vr-short > div')].map(d => d.textContent);
  ok('the report opens with five short lines', short.length === 5 && /^Autonomous/.test(short[0]) && /^Strategy/.test(short[1]) && /^Scoring/.test(short[2]) && /^Best at/.test(short[3]) && /^Watch for/.test(short[4]), JSON.stringify(short));
  const more = host.querySelector('details.vr-more');
  ok('everything measured is kept, folded away', more && !more.open && more.querySelectorAll('.vr-sec').length >= 5 && /Everything it measured/.test(more.querySelector('summary').textContent));
  delete rep.brief; rep.lines.good = []; rep.lines.weak = [];
  win.document.getElementById('t119').innerHTML = win.eval(`vtReportHtml('66449A', __rep119)`);
  ok('with nothing short to say, the full report is simply shown', win.document.querySelector('#t119 details.vr-more').open && !win.document.querySelector('#t119 .vr-short'));
}
// ── both trackers record them ──
{
  ok('the page looks for pins every two seconds while it watches', /if \(est >= pinAt \+ 2 && rec\.pn\.length < VT_PIN_MAX_INTS\)/.test(idx));
  ok('and while it follows a live stream', /cur\.pinAt = now;/.test(idx));
  ok('what it takes for pins is drawn on the preview', /const P = run\.pins;/.test(idx));
  ok('the app uses the same tests and limits', /def pin_blobs/.test(app) && /\(r >= 140\) & \(g >= 105\) & \(b < 0\.55 \* np\.minimum\(r, g\)\)/.test(app) && /PIN_W, PIN_MAX_INTS, PIN_MAX_BLOBS = 960, 36000, 60/.test(app));
  ok('the app\'s window keeps its details folded away', /<details class="more"><summary>Details<\/summary><pre id="log">/.test(app) && /<details class="more"><summary>More: learn from another video<\/summary>/.test(app));
}
// ── v125: a look taken mid-cut or mid-fade is passed over ──
{
  const C = f('vtCut'), lb = { px: 0, py: 140, nw: 640, nh: 360 };
  const pic = (base, robotX) => { const px = new Uint8Array(640 * 640 * 4); for (let y = 140; y < 500; y++) for (let x = 0; x < 640; x++) { const o = 4 * (y * 640 + x), v = base(x, y); px[o] = px[o + 1] = px[o + 2] = (x >= robotX && x < robotX + 70 && y >= 300 && y < 370) ? 90 : v; } return px; };
  const A = (x, y) => 60 + ((x >> 5) + (y >> 5)) % 2 * 120, B = (x, y) => 200 - ((x >> 6) + (y >> 4)) % 2 * 150;
  const mix = (a, b, k) => { const o = new Uint8Array(a.length); for (let i = 0; i < a.length; i++) o[i] = a[i] * (1 - k) + b[i] * k; return o; };
  const run = frames => { const slot = {}; return frames.map((px, i) => C(slot, px, lb, i / 6) ? 'X' : '.').join(''); };
  const steady = run(Array.from({ length: 30 }, (_, i) => pic(A, 100 + i * 12)));
  ok('one scene with a robot crossing is never passed over', !/X/.test(steady), steady);
  const cut = run(Array.from({ length: 40 }, (_, i) => pic(i < 18 ? A : B, 100 + i * 5)));
  ok('a hard cut is passed over, for about a second', cut[18] === 'X' && !/X/.test(cut.slice(0, 18)) && !/X/.test(cut.slice(-8)), cut);
  const fade = run(Array.from({ length: 60 }, (_, i) => { const t = i / 6; return t < 3 ? pic(A, 200) : t < 4 ? mix(pic(A, 200), pic(B, 200), t - 3) : pic(B, 200); }));
  ok('a one-second fade between two fields is passed over too', (fade.slice(18, 32).match(/X/g) || []).length >= 6 && !/X/.test(fade.slice(0, 18)) && !/X/.test(fade.slice(-12)), fade);
  ok('the page skips the look, and frees itself to take the next', /if \(vtCut\(slot, square\.data, lb, est\)\) \{ run\.cuts = \(run\.cuts \|\| 0\) \+ 1; busy = false; return; \}/.test(idx));
  ok('the app does the same, and never keeps such a frame for review', /if cuts\.changing\(frame, t\):/.test(app) && /if cuts\.changing\(frame, seen \* every_sec\):/.test(app));
}
// ── v130: the toggles, and each alliance's own score ──
{
  ok('the app\'s recording carries toggle readings', Array.isArray(fx.rec.tg) && fx.rec.tg.length >= 9 * 60 && fx.rec.tg.length % 9 === 0);
  const own = [sum.tw % 3, Math.floor(sum.tw / 3) % 3, Math.floor(sum.tw / 9) % 3, Math.floor(sum.tw / 27) % 3];
  ok('each toggle is read: red\'s wall and one side red, the other two blue', own.join() === '1,2,1,2', own.join());
  ok('yellow goes to whoever holds the quadrant\'s toggle, not to who stacked it', sum.er > 0 && sum.eb > 40 && Math.abs(sum.er + sum.eb - (5 * (sum.pr + sum.pb) + 10 * sum.py)) < 12, JSON.stringify([sum.er, sum.eb, sum.py, sum.pr]));
  const P = f('vtTogglePoints')(fx.quad, 16 / 9);
  ok('the points looked at sit above the middle of each wall', P.length === 4 && P.every(w => w.length === 120) && P[0].every(p => Math.abs(p[0] - 0.5) < 0.06 && p[1] < fx.quad[1]), JSON.stringify(P[0].slice(0, 2)));
  const R = f('vtToggleRead');
  const rows = (...v) => { const a = []; for (let i = 0; i < 6; i++) a.push(1200 + i * 20, ...v); return { tg: a }; };
  ok('a wall that is mostly red is red; mostly blue, blue', R(rows(60, 0, 0, 70, 5, 5, 0, 0), 0, { end: 123 }).join() === '0,2,1,0', R(rows(60, 0, 0, 70, 5, 5, 0, 0), 0, { end: 123 }).join());
  ok('a wall with both colours in it is not guessed', R(rows(30, 25, 0, 0, 0, 0, 0, 0), 0, { end: 123 })[2] === 0);
  ok('a few stray points are not a colour', R(rows(5, 0, 0, 6, 0, 0, 0, 0), 0, { end: 123 }).join() === '0,0,0,0');
  ok('no readings, no answer', R({ tg: [] }, 0, { end: 123 }) === null);
  const mod = await import('../api/tracker.js');
  ok('the server accepts toggle readings', mod.validRec(fx.rec) === null && mod.validRec({ ...fx.rec, tg: [1, 2, 3] }) === 'bad toggles' && mod.validRec({ ...fx.rec, tg: ['<b>', 0, 0, 0, 0, 0, 0, 0, 0] }) === 'bad toggles');
  ok('and the summary with estimated scores', mod.validSum(JSON.parse(JSON.stringify(sum))) === null);
  // The per-alliance check.
  const C = f('vtPinCheck'), T = f('vtPinCheckText');
  const mk = (i, good) => { const pr = 6 + i, pb = 4 + i, yr = 8 + i, yb = 5; const s = { ok: 1, pk: 70, pr, pb, py: yr + yb, er: 5 * pr + 10 * (good ? yr : yb), eb: 5 * pb + 10 * (good ? yb : yr), mr: 1, mb: 0, Ra: { eg: 1 }, Rb: {}, Ba: {}, Bb: {} }; s.rs = 5 * pr + 10 * yr + 8 + 6; s.bs = 5 * pb + 10 * yb + 6; return s; };
  const right = C([0, 1, 2, 3, 4].map(i => mk(i, true))), wrong = C([0, 1, 2, 3, 4].map(i => mk(i, false)));
  ok('when the toggles are read right, each alliance\'s score comes out close', right.side !== null && right.side < 0.05, String(right.side));
  ok('when they are read wrong, the check shows it', wrong.side > 0.15, String(wrong.side));
  ok('and it is said', /With the toggles read \(5 matches\), each alliance's own score comes out within \d+%/.test(T(right)), T(right));
  ok('a toggle is never counted as a pin', /Not a toggle: a red or blue bar at the middle of a wall/.test(idx));
  ok('the page looks for toggles where the field\'s corners put them', /slot\.quad = await vtFieldGet\(m\.vid\)/.test(idx) && /P\.tg = slot\.quad && slot\.quad\.q \? vtToggleLook\(data, W, H, slot\.quad\.q\) : null/.test(idx));
  ok('the app asks the website for the corners and does the same', /site\.get\('\?field=' \+ job\['vid'\]\)/.test(app) && /def toggle_look\(frame, q\)/.test(app));
  ok('Mark the field offers the tracker\'s own outline to keep', /id="vtMarkKeep">It is right: keep it</.test(idx) && /await vtFieldSet\(String\(cal\.videoId\), guess\.q, 'click'\)/.test(idx));
}
ok('release is v115 or later', /const APP_BUILD = 'v1(1[5-9]|[2-9]\d)'/.test(idx));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
