// t90 — "2026 California Region 3 Middle School Championship", and why nothing
// about it could be found.
//
//   name: 2026 California Region 3 Middle School Championship:
//         VEX V5 Event Regional Championship: Push Back
//   sku:  RE-V5RC-25-1741   ·   13 Mar 2026   ·   California
//   the broadcast: youtube.com/watch?v=h5z9KrWGH6U
//
// Three faults in that one name, and they compound.
//
// 1. THE PROGRAMME SUFFIX WAS NOT STRIPPED. searchQuery only knew the shape
//    "…: VEX <something> Competition". This one ends "…: VEX V5 Event Regional
//    Championship: Push Back", so the query sent to YouTube was the entire
//    98-character name. Nothing is titled that, so the search came back empty —
//    the one failure the v50 refusal list cannot explain, because there is
//    nothing to refuse.
//
// 2. THE 3 WAS THROWN AWAY. nameTokens drops single characters, so the name
//    reduced to [california, region] — every other word being boilerplate this
//    file already stopwords. The one thing separating Region 3 from Regions 1,
//    2 and 4 was gone, and "california" alone is a whole state. "region" was
//    not even a stopword, though "regional" was.
//
// 3. "CA" AND "CALIFORNIA" NEVER SHARED A TOKEN. Organisers abbreviate and
//    RobotEvents spells it out, so a title reading "CA Region 3" matched on
//    region3 alone and was refused for it.
import fs from 'fs';
let pass = 0, fail = 0;
const ok = (n, c, e) => { c ? (pass++, console.log('  ok   ' + n)) : (fail++, console.log('  FAIL ' + n + (e ? '\n         ' + e : ''))); };
const px = fs.readFileSync('../api/proxy.js', 'utf8');
const M = new Function(
  px.slice(px.indexOf('function looksLikeEventBroadcast'), px.indexOf("// ── Find the event's broadcast by name")) +
  '; return { nameTokens, scoreTitle, searchQuery, bareQuery, eventGrade, sameWord, STATE_CODE };'
)();

const NAME = '2026 California Region 3 Middle School Championship: VEX V5 Event Regional Championship: Push Back';
const want = M.nameTokens(NAME);

console.log('t90 — California Region 3, and the three faults in its name');

// ── 1. The programme suffix ──
ok('the suffix pattern is named once and shared', /const PROGRAM_SUFFIX = /.test(px));
ok('it is not limited to "…Competition"',
  /Competition\|Championship\|League\|Event\|Series/.test(px));
ok('the query is something a person would type',
  M.searchQuery(NAME) === '2026 California Region 3 Middle School Championship', M.searchQuery(NAME));
ok('the trimmed retry too',
  M.bareQuery(NAME) === 'California Region 3 Championship', M.bareQuery(NAME));
ok('both the query and the trimmer use it',
  (px.match(/\.replace\(PROGRAM_SUFFIX/g) || []).length === 2);
// The shapes it already handled must keep working.
for (const [n, q] of [
  ['Maker Faire OC - MS/HS - Day 1 - robotics is ez: VEX V5 Robotics Competition - Override',
   'Maker Faire OC - MS/HS - Day 1 - robotics is ez'],
  ['Bots @ Bristol Signature Event (Middle School)', 'Bots @ Bristol Signature Event'],
  ['VEX Robotics World Championship', 'VEX Robotics World Championship'],
  ['Speedway: Override VEX V5 Blended Signature Event: VEX V5 Robotics Competition, Presented by the Chrysalis Global Foundation',
   'Speedway: Override VEX V5 Blended Signature Event']
]) {
  ok(`unchanged: ${JSON.stringify(n.slice(0, 40))}…`, M.searchQuery(n) === q, M.searchQuery(n));
}

// ── 2. The number belongs to the word ──
ok('the pair is joined into one token', want.join(' ') === 'california region3', want.join(' '));
ok('so is the already-joined spelling',
  M.nameTokens('Region3 Championship').includes('region3'));
ok('"region" on its own is a stopword now, like "regional" already was',
  !M.nameTokens('Southern California Region Championship').includes('region'));
ok('other numbered identifiers too',
  M.nameTokens('Division 2 Finals').includes('division2') &&
  M.nameTokens('Field 1 Coverage').includes('field1'));
ok('"Day 1" is deliberately NOT joined',
  !M.nameTokens('Bristol Day 1').some(t => /^day\d/.test(t)),
  'the per-day logic owns that; a day1/day2 split here would hurt every multi-day title');
ok('a number on its own is still dropped', !M.nameTokens('Event 3').includes('3'));
ok('"champs" joins "championship" as boilerplate',
  !M.nameTokens('Region 3 Champs').includes('champs'));

// ── 3. A state code is the state ──
ok('the equivalence is a compare, not a rewrite', /const sameWord = \(a, b\) =>/.test(px),
  'rewriting could resurrect a token the stopword list drops');
ok('CA is California', M.sameWord('ca', 'california') && M.sameWord('california', 'ca'));
ok('TX is Texas', M.sameWord('tx', 'texas'));
ok('two unrelated words are not', !M.sameWord('ca', 'texas'));
ok('a code and a different state are not', !M.sameWord('tx', 'california'));
for (const code of ['ms', 'hs', 'in', 'or', 'ok', 'hi', 'de', 'me', 'la', 'id']) {
  ok(`"${code}" is left out — it is a grade or an English word first`,
    !(code in M.STATE_CODE));
}

// ── 4. Together: what should and should not match ──
for (const t of [
  '2026 California Region 3 Middle School Championship',
  'California Region 3 MS Championship - Push Back',
  'CA Region 3 Middle School Champs 2026',
  'CA REGION 3 MS CHAMPIONSHIP',
  'Region 3 Championship - Middle School',
  'Region3 MS Champs'
]) ok(`matches: ${JSON.stringify(t)}`, !!M.scoreTitle(want, t));

for (const t of [
  '2026 California Region 1 Middle School Championship',
  'California Region 2 High School Championship',
  'Texas Region 3 Championship',
  'TX Region 3 Championship',
  'Southern California Regional Championship',
  'How to build a VEX robot'
]) ok(`refused: ${JSON.stringify(t)}`, !M.scoreTitle(want, t),
      JSON.stringify(M.scoreTitle(want, t)));

// The v50 guards have to survive all of it.
const mf = M.nameTokens('Maker Faire OC - MS/HS - Day 1 - robotics is ez: VEX V5 Robotics Competition - Override');
ok('a field-prefixed title still matches its event',
  !!M.scoreTitle(mf, 'Obsessed Cuts and Color - Maker Faire OC - MS/HS - Day 1') &&
  !!M.scoreTitle(mf, 'Geared4Girls - Maker Faire OC - MS/HS - Day 1'));
ok('a different Maker Faire still does not',
  !M.scoreTitle(mf, 'Maker Faire Bay Area 2026 Highlights'));
ok('a blended event still vetoes on no grade',
  M.eventGrade('Maker Faire OC - MS/HS - Day 1') === null);
ok('this event is Middle School, and says so', M.eventGrade(NAME) === 'ms');

console.log(`\nt90: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
