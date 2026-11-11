// t111 — v89: what the app learns from results.
//
//   · win chances checked against played matches, walk-forward, and corrected;
//   · a team's season carried into the event rating.
// (Play-style groups were removed in v90.)
import fs from 'fs';
import { boot, settle, html, FIXTURES } from './harness.mjs';

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '\n         ' + detail : '')); }
};
const idx = fs.readFileSync('../index.html', 'utf8');
console.log('t111 — v89: learned from results');

// A synthetic event with known strengths, in the API's own shape.
function rng(seed) { let a = seed >>> 0; return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
function synth(nTeams, nMatches, noise, seed) {
  const r = rng(seed);
  const gauss = () => { let u = 0, v = 0; while (!u) u = r(); v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
  const str = Array.from({ length: nTeams }, (_, i) => 8 + 44 * i / (nTeams - 1));
  const sw = Array.from({ length: nTeams }, (_, i) => (i % 3 === 0 ? 2.5 : 0.6) * noise);
  const out = [];
  for (let m = 0; m < nMatches; m++) {
    const pick = []; while (pick.length < 4) { const k = Math.floor(r() * nTeams); if (!pick.includes(k)) pick.push(k); }
    const sc = (a, b) => Math.max(0, Math.round(str[a] + str[b] + gauss() * (sw[a] + sw[b]) / 2));
    const t = new Date(Date.UTC(2026, 1, 28, 9, m * 6)).toISOString();
    out.push({ id: 5000 + m, matchnum: m + 1, round: 2, started: t, scheduled: t, alliances: [
      { color: 'red', score: sc(pick[0], pick[1]), teams: [{ team: { id: 100 + pick[0] } }, { team: { id: 100 + pick[1] } }] },
      { color: 'blue', score: sc(pick[2], pick[3]), teams: [{ team: { id: 100 + pick[2] } }, { team: { id: 100 + pick[3] } }] } ] });
  }
  return { matches: out, str };
}

const { win, router, errors } = await boot();

// ══ 1. Self-checking ═══════════════════════════════════════════════════════
console.log('\n· self-checking win chances');
{
  const P = (p, y) => ({ p, y });
  ok('too few predictions correct nothing', win.sim_calFit(Array.from({ length: 19 }, (_, i) => P(0.9, i % 2))).k === 1);
  // Says 90%, right half the time: badly overconfident.
  const over = win.sim_calFit(Array.from({ length: 200 }, (_, i) => P(0.9, i % 2)));
  ok('an overconfident model is pulled toward 50%', over.k < 0.5 && over.kRaw <= 0.25, JSON.stringify(over));
  // Says 60%, right 95% of the time: too cautious.
  const under = win.sim_calFit(Array.from({ length: 200 }, (_, i) => P(0.6, i % 20 ? 1 : 0)));
  ok('a cautious one is pushed apart', under.k > 1.5, JSON.stringify(under));
  // Says 75%, right 75% of the time.
  const fair = win.sim_calFit(Array.from({ length: 200 }, (_, i) => P(0.75, i % 4 ? 1 : 0)));
  ok('an honest one is left alone', Math.abs(fair.k - 1) <= 0.06, JSON.stringify(fair));
  const few = win.sim_calFit(Array.from({ length: 30 }, (_, i) => P(0.9, i % 2)));
  ok('thirty matches are believed half as much as the fit says', Math.abs((few.k - 1) - (few.kRaw - 1) / 2) < 0.02, JSON.stringify(few));
  ok('it counts the winners it picked', over.hits === 100 && over.n === 200);

  const r = { redWin: 80, blueWin: 16, tie: 4 };
  const half = win.sim_calApply(r, 0.5);
  ok('the correction moves a chance toward 50', half.redWin < 80 && half.redWin > 48 && half.blueWin > 16);
  ok('keeps ties and the total', half.tie === 4 && Math.abs(half.redWin + half.blueWin - 96) < 1e-9);
  ok('and k = 1 changes nothing', win.sim_calApply(r, 1) === r);
  ok('an even match stays even', Math.abs(win.sim_calApply({ redWin: 50, blueWin: 50, tie: 0 }, 0.4).redWin - 50) < 1e-9);

  const ev = synth(24, 90, 6, 7);
  const bt = win.sim_backtest(ev.matches);
  ok('the backtest predicts the later matches only', bt.n >= 40 && bt.n <= 90 - 18, JSON.stringify(bt));
  ok('on a field with real differences it picks most winners', bt.hits / bt.n > 0.7, JSON.stringify(bt));
  ok('and the correction stays in range', bt.k >= 0.2 && bt.k <= 2);
  ok('it is deterministic', JSON.stringify(win.sim_backtest(ev.matches)) === JSON.stringify(bt));
  ok('eliminations and unplayed matches are not used',
    win.sim_backtest(ev.matches.map(m => ({ ...m, round: 3 }))).n === 0 &&
    win.sim_backtest(ev.matches.map(m => ({ ...m, started: null, alliances: m.alliances.map(a => ({ ...a, score: 0 })) }))).n === 0);
  ok('garbage in is nothing out', win.sim_backtest(null).n === 0 && win.sim_backtest([null, {}, { round: 2 }]).n === 0);
  // Walk-forward: ratings come from matches BEFORE the one predicted.
  ok('ratings are refit from earlier matches', /for \(const q of played\.slice\(0, i\)\)/.test(idx));
  ok('the backtest checks the uncorrected number', /sim_matchupProbRaw\(a\.mean, a\.std, b\.mean, b\.std, 1200/.test(idx));
  ok('every other caller gets the corrected one', (idx.match(/sim_matchupProbRaw\(/g) || []).length === 3);
}

// ══ 2. The season ══════════════════════════════════════════════════════════
console.log('\n· the season, carried in');
{
  const ratings = new Map(), count = new Map(), rec = new Map();
  for (let i = 0; i < 12; i++) { ratings.set(String(i), 10 + 4 * i); count.set(String(i), 6); rec.set(String(i), { n: 20, rate: 0.2 + 0.05 * i }); }
  // One team with a single bad match here and a strong season; one not yet played.
  ratings.set('new', 5); count.set('new', 1); rec.set('new', { n: 30, rate: 0.75 });
  rec.set('unseen', { n: 30, rate: 0.75 });
  const before = ratings.get('5');
  const res = win.sim_applySeason(ratings, count, rec);
  ok('the season\'s worth is fitted on teams with matches here', res.fitOn === 12 && res.slope > 70 && res.slope < 90, JSON.stringify({ f: res.fitOn, s: res.slope }));
  ok('a team on the line does not move', Math.abs(ratings.get('5') - before) < 0.01);
  const prior = res.prior.get('new');
  ok('one match here against a strong season: the season leads', Math.abs(ratings.get('new') - (5 + 2 * prior) / 3) < 1e-9 && ratings.get('new') > 35, String(ratings.get('new')));
  ok('a team that has not played gets its season rating', ratings.get('unseen') === res.prior.get('unseen'));
  ok('and is not called season-only when others have played', res.seasonOnly === false);

  const flat = new Map(), fc = new Map(), fr = new Map();
  for (let i = 0; i < 12; i++) { flat.set(String(i), 50 - 3 * i); fc.set(String(i), 6); fr.set(String(i), { n: 20, rate: 0.2 + 0.05 * i }); }
  const snap = JSON.stringify([...flat]);
  ok('a season that predicts backwards is not used', win.sim_applySeason(flat, fc, fr).used === 0 && JSON.stringify([...flat]) === snap);

  const empty = new Map();
  const r0 = win.sim_applySeason(empty, new Map(), rec);
  ok('before any match, the season stands alone and says so', r0.seasonOnly === true && empty.size === rec.size && empty.get('0') < empty.get('11'));
  ok('too few records do nothing', win.sim_applySeason(new Map(), new Map(), new Map([['a', { n: 9, rate: 0.5 }]])).used === 0);
  ok('a few matches in, with too few teams to fit on, ratings are left alone',
    win.sim_applySeason(new Map([['0', 20]]), new Map([['0', 1]]), rec).used === 0);

  // The fetch: one request per team, this event left out, kept afterwards.
  const mark = router.seen.length;
  const got = await win.sim_seasonRecords(['9001', '9002'], 190, 55001, 2000);
  const asked = router.seen.slice(mark).filter(p => /^\/teams\/\d+\/rankings/.test(p));
  ok('it asks for each team\'s season rankings', asked.length === 2 && asked.every(p => /season/.test(p)), asked.join(' | '));
  const mark2 = router.seen.length;
  await win.sim_seasonRecords(['9001', '9002'], 190, 55001, 2000);
  ok('and not again within six hours', router.seen.slice(mark2).filter(p => /rankings/.test(p)).length === 0);
  ok('the result is a map of records', got instanceof win.Map || typeof got.get === 'function');
  ok('no season, no requests', (await win.sim_seasonRecords(['9001'], null, 55001)).size === 0);
  ok('a huge field is not fetched team by team', /teamIds\.length > 120\) return out/.test(idx));
  ok('the page is never held for it', /await Promise\.race\(\[work, new Promise\(r => setTimeout\(r, capMs \|\| 3000\)\)\]\)/.test(idx));
  ok('a record is shrunk toward even', /rate: \(w \+ 0\.5 \* t \+ 1\) \/ \(n \+ 2\)/.test(idx));
  ok('what is stored is listed on the privacy page', /season win-loss record/.test(fs.readFileSync('../privacy.html', 'utf8')));
}

// ══ 3. Play styles: removed in v90, on request ════════════════════════════
console.log('\n· play styles are gone');
ok('no play-style code or markup is left', !/tStyle|st-group|Play styles at this event|Play style'/.test(idx));

// ══ 4. On the page ═════════════════════════════════════════════════════════
console.log('\n· on the page');
{
  const note = win.sim_learnNote({ cal: { n: 40, hits: 30, k: 0.7 }, seasonUsed: 12, seasonFitOn: 10 });
  ok('the note gives the score it got', /picked the winner in 30 \(75%\)/.test(note) && /40 qualification matches/.test(note));
  ok('says which way it corrected', /too confident/.test(note) && /too cautious/.test(win.sim_learnNote({ cal: { n: 40, hits: 30, k: 1.3 } })) && /left as they are/.test(win.sim_learnNote({ cal: { n: 40, hits: 30, k: 1 } })));
  ok('says when it has not been checked yet', /Not yet checked/.test(win.sim_learnNote({ cal: { n: 3, hits: 2, k: 1 } })));
  ok('and that the season is in the rating', /12 teams' ratings blend in/.test(note));
  ok('season-only chances are labelled', /Season form only/.test(win.sim_learnNote({ cal: { n: 0, hits: 0, k: 1 }, seasonOnly: true })));
  ok('nothing to say is nothing', win.sim_learnNote(null) === '');

  FIXTURES.wideRoster = 12; FIXTURES.playedThrough = 4;
  const b = await boot();
  b.win.switchTab('tournament');
  await b.win.loadTournamentTeams(55001, 'Bots @ Bristol Signature Event', 9001, '66449A', 'RE-V5RC-25-0191');
  await settle(b.win, 300);
  await b.win.tournamentGo('picklist');
  await settle(b.win, 300);
  const pk = html(b.win, 'tournamentResults');
  ok('the pick list says the chances are not yet checked at a small event', /Not yet checked/.test(pk));
  ok('building an event\'s ratings asks for season records', b.router.seen.some(p => /^\/teams\/\d+\/rankings/.test(p)));
  ok('no errors', b.errors.length === 0 && errors.length === 0, b.errors.concat(errors).join('\n'));
  b.win.close();
  FIXTURES.wideRoster = null; FIXTURES.playedThrough = undefined;
}
ok('the three files carry one version', (v => new RegExp(`PROXY_BUILD = '${v}'`).test(fs.readFileSync('../api/proxy.js', 'utf8')) && new RegExp(`'vex-scout-${v}'`).test(fs.readFileSync('../sw.js', 'utf8')))((idx.match(/const APP_BUILD = '(v\d+)'/) || [])[1]));

win.close();
console.log(`\nt111: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
