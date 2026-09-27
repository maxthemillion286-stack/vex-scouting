// t100 — a website-wide bug sweep, kept.
//
// Asked for directly: "website wide bug check and fix as many as you can,
// take as long as you need and triple check."
//
// The sweep that produced this file ran four ways: a static scan for dangling
// references, a driven walk of every view in a real browser, a poisoned
// fixture, and an invariant probe of the arithmetic. What it found:
//
//   1. SIX stored-XSS holes, all in strings the RobotEvents API controls and
//      a team can choose — Tournament ▸ Teams, ▸ Matches, ▸ Skills, ▸ Awards,
//      the elimination bracket, and the Event Scout's location line. Measured
//      in Chromium with a payload that actually fires: 15 executions before,
//      0 after. t91 swept the Scout tab in v58 and never reached these.
//   2. vsAgo() put "NaN days ago" on the offline button whenever the stored
//      timestamp was anything but a number.
//   3. Two dead functions, one of which could only ever have thrown.
//
// The service worker's four rejection paths are in t99.
import fs from 'fs';
import { boot, settle, html, FIXTURES } from './harness.mjs';
let pass = 0, fail = 0;
const ok = (n, c, e) => { c ? (pass++, console.log('  ok   ' + n)) : (fail++, console.log('  FAIL ' + n + (e ? '\n         ' + e : ''))); };

const idx = fs.readFileSync('../index.html', 'utf8');
const src = idx.match(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/)[1];

console.log('t100 — the sweep');

// ══ 1. Every view, with every API string poisoned ═══════════════════════════
// A payload that becomes a NODE is the hole. One that comes back as text is
// the fix. jsdom will not run the onerror, so the node count is what is
// asserted — the Chromium run that found this counted executions.
console.log('\n· poisoned strings do not become tags');
{
  const P = '<img src=x onerror="window.__XSS=1">';
  const keep = {
    teams: FIXTURES.teams, awards: FIXTURES.awards, event: FIXTURES.event,
    alliance: FIXTURES.poisonAlliance, region: FIXTURES.teamRegion, spread: FIXTURES.eventSpread
  };
  FIXTURES.teams = FIXTURES.teams.map((t, i) =>
    i === 1 ? { ...t, number: P, team_name: P, organization: P } : t);
  FIXTURES.poisonAlliance = P;
  FIXTURES.awards = [{ title: P, teamWinners: [{ team: { id: 9002, name: P } }] }];
  FIXTURES.event = { ...FIXTURES.event, name: P,
    location: { ...FIXTURES.event.location, region: P, city: P, venue: P } };
  FIXTURES.teamRegion = P;
  FIXTURES.eventSpread = [{ name: P, region: P, city: P }];

  const { win, errors, stop } = await boot();
  const doc = win.document;
  const clean = where => {
    const nodes = [...doc.querySelectorAll('body *')]
      .filter(e => e.getAttribute && e.getAttribute('onerror'));
    ok(`${where} renders the payload as text, not markup`, nodes.length === 0,
      nodes.map(n => (n.parentElement || n).outerHTML.slice(0, 120)).join(' | '));
  };

  win.switchTab('tournament');
  await win.loadTournamentTeams(55001, 'Bots', 9001, '66449A', 'RE-V5RC-25-0191');
  await settle(win, 900); clean('tournament:load');
  for (const v of ['teams', 'matches', 'skills', 'awards', 'bracket', 'picklist', 'team']) {
    await win.tournamentGo(v); await settle(win, 1400); clean('tournament:' + v);
  }
  // With predictions on, the bracket and matches take another path.
  if (!win.tShowPred) { win.tTogglePred(); await settle(win, 2600); }
  for (const v of ['matches', 'bracket']) {
    await win.tournamentGo(v); await settle(win, 2000); clean('tournament:' + v + '+pred');
  }
  // The Event Scout's row renders the event's city and region.
  win.switchTab('simulator');
  doc.getElementById('simEscoutYou').value = '66449A';
  await win.runEventScout(); await settle(win, 2500); clean('escout');
  // The SKILLS RANKINGS tab. Nothing had ever rendered a row here — the
  // fixture's season-skills route answered with an empty list — which is
  // exactly how an unescaped team number and location survived in it.
  win.switchTab('skills');
  const skillsBtn = [...doc.querySelectorAll('#tab-skills button')]
    .find(b => /LOAD|RANK|SKILL/i.test(b.textContent));
  ok('the skills tab has a control to press', !!skillsBtn);
  if (skillsBtn) skillsBtn.click();
  await settle(win, 2500);
  ok('the skills list actually rendered rows',
    doc.querySelectorAll('#tab-skills .skill-row').length > 0,
    doc.querySelectorAll('#tab-skills .skill-row').length + ' rows');
  clean('skills');

  // And the Scout tab, which t91 covers, must not have regressed.
  win.switchTab('scout');
  doc.getElementById('detailTeamInput').value = '66449A';
  await win.runDetailedScout(); await settle(win, 2000); clean('scout');

  ok('nothing threw while rendering poison', errors.length === 0, errors.join('\n'));
  stop();
  FIXTURES.teams = keep.teams; FIXTURES.awards = keep.awards; FIXTURES.event = keep.event;
  FIXTURES.poisonAlliance = keep.alliance; FIXTURES.teamRegion = keep.region;
  FIXTURES.eventSpread = keep.spread;
}

// ══ 2. The six sites, named, so a revert is loud ════════════════════════════
console.log('\n· the sites that were open');
ok('Teams escapes the number cell', /<span class="tt-num">\$\{esc\(t\.number\)\}/.test(src));
ok('Skills escapes the number cell', /<div class="t-sk-team">\$\{esc\(e\.number\)\}/.test(src));
ok('Matches escapes both the handler argument and the text',
  /tournamentFocusOn\('\$\{teamAttr\(n\)\}'\)">\$\{esc\(n\)\}/.test(src));
ok('Awards does the same for its winners',
  /tournamentFocusOn\('\$\{teamAttr\(w\)\}'\)">\$\{esc\(w\)\}/.test(src));
ok('...and dropped the hand-rolled quote escape, which never worked in an attribute',
  !/replace\(\/'\/g, "\\\\'"\)/.test(src),
  'the browser decodes entities before the JS parses; escaping is not a defence there');
ok('the bracket escapes its alliance lists',
  (src.match(/\$\{(red|blue)Teams\.map\(esc\)\.join\(' '\)\}/g) || []).length === 4,
  (src.match(/\$\{(red|blue)Teams\.map\(esc\)\.join\(' '\)\}/g) || []).join(', '));
ok('...and its byes', /bracket-bye-teams">\$\{teams\.map\(esc\)\.join\(' '\)\}/.test(src));
ok('the Event Scout escapes the location line',
  /\$\{r\.loc \? ' · ' \+ esc\(r\.loc\) : ''\}/.test(src));
ok('the Jumper escapes the anchor it names',
  /you get from \$\{esc\(anchors\[0\]\.name\)\}/.test(src));
// A blanket guard, aimed at the exact shape every one of these holes had: a
// value the API controls, dropped between two tags with nothing around it.
// The property names are the ones a team or an event can actually choose.
// `label`/`title` are deliberately absent — in this codebase they are almost
// always internal strings, and a check that cries wolf gets relaxed.
{
  const RISKY = /\.(number|team_name|organization|region|city|venue)\b|^(locStr|team|num)$/;
  const raw = [];
  for (const m of src.matchAll(/[>}]\s*\$\{([A-Za-z_$][\w$]*(?:\.\w+)*)\}\s*[<$]/g)) {
    if (RISKY.test(m[1])) raw.push(m[1]);
  }
  ok('no API-controlled value reaches markup unescaped', raw.length === 0,
    [...new Set(raw)].join(', '));
}
// And the same for inline handlers, where esc() is not a defence at all.
{
  const raw = [];
  for (const m of src.matchAll(/\son\w+="[^"]*?\$\{([^}]+)\}/g)) {
    const e = m[1].trim();
    if (/^(teamAttr|listAttr|Number)\(/.test(e)) continue;
    if (/^esc\(JSON\.stringify/.test(e)) continue;           // the audited event-name pattern
    if (/^(ev|id|skuInputId|containerId)$/.test(e)) continue;  // already stripped, or internal
    if (/^[\d.]+$/.test(e) || /^(i|idx|n|j|k)(\s*\+\s*1)?$/.test(e)) continue;
    if (/^event\.|^this\b/.test(e)) continue;
    raw.push(e.slice(0, 60));
  }
  ok('every inline handler argument is stripped, not escaped', raw.length === 0,
    [...new Set(raw)].join(' | '));
}

// ══ 3. "NaN days ago" ═══════════════════════════════════════════════════════
console.log('\n· a timestamp that is not a timestamp');
{
  const { win, stop } = await boot();
  await settle(win, 300);
  const ago = v => win.eval(`vsAgo(${JSON.stringify(v)})`);
  for (const v of [undefined, null, '', 'nope', NaN, {}, []]) {
    const out = String(ago(v === undefined ? null : v));
    ok(`vsAgo(${JSON.stringify(v)}) says something a person can read`,
      !/NaN|Invalid|undefined/.test(out), JSON.stringify(out));
  }
  ok('a real timestamp still reads normally',
    /just now|min ago/.test(String(win.eval('vsAgo(Date.now() - 60000)'))),
    String(win.eval('vsAgo(Date.now() - 60000)')));
  ok('an ISO string is understood too',
    !/NaN|a while/.test(String(win.eval('vsAgo(new Date(Date.now() - 7200000).toISOString())'))),
    String(win.eval('vsAgo(new Date(Date.now() - 7200000).toISOString())')));
  // A device whose clock moved backwards must not be told "-3 days ago".
  ok('a future timestamp does not go negative',
    String(win.eval('vsAgo(Date.now() + 86400000)')) === 'just now',
    String(win.eval('vsAgo(Date.now() + 86400000)')));
  stop();
}

// ══ 4. Dead code that could only have thrown ════════════════════════════════
console.log('\n· what was removed');
ok('setLoading is gone', !/function setLoading\(/.test(src),
  'its last line reached for #scoutBtn, which no element has carried in a long time');
ok('and so is the id it reached for', !/getElementById\('scoutBtn'\)/.test(src));
// Matched on code, not on the comment that explains the removal.
ok('the old Simulator draft board is gone',
  !/function pickRender\(/.test(src) && !/function pickToggle\(/.test(src)
  && !/window\._pickCtx\s*[;=]/.test(src));
ok('...and nothing still points at its container', !/getElementById\('pickResults'\)/.test(src));
// Every id the script asks for must either exist in the markup or be one the
// script creates itself. This is the check that found both.
{
  const ids = new Set();
  for (const m of idx.matchAll(/\bid="([^"${]+)"/g)) ids.add(m[1]);
  for (const m of src.matchAll(/\.id = '([^']+)'/g)) ids.add(m[1]);
  const missing = [];
  for (const m of src.matchAll(/getElementById\(\s*'([^'${]+)'\s*\)/g)) {
    if (!ids.has(m[1])) missing.push(m[1]);
  }
  ok('every id the script looks up exists somewhere', missing.length === 0,
    missing.map(i => '#' + i).join(', '));
}

console.log(`\nt100: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
