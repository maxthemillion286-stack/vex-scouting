// t86 — why Maker Faire never auto-found, and why it took a month to say so.
//
// The event:
//   "Maker Faire OC - MS/HS - Day 1 - robotics is ez: VEX V5 Robotics
//    Competition - Override"   RE-V5RC-26-4530, 12 Sep 2026, Costa Mesa CA
//
// The app reported `page-blocked-and-no-yt-match`, which means the search DID
// run (there are separate reasons for no key and for exhausted quota) and threw
// away everything it found. Three separate reasons it would do that, all live
// in this one event name.
//
// 1. THE GRADE VETO, on an event that is BOTH grades. gradeOf() returns the
//    first grade it finds and tests middle school first, so "MS/HS" came back
//    'ms' — and any broadcast whose title said HS was then refused at an event
//    that is, by name, half high school. Every blended event in the season has
//    this shape ("Blended MS/HS" is the other common spelling).
//
// 2. THE SEASON'S GAME NAME WAS NOT A STOPWORD. 'push', 'back', 'rapid' and
//    'relay' were listed; 'override' was not. So the word every event in the
//    season carries counted as distinctive evidence — diluting recall for the
//    right video and offering false evidence for the wrong one.
//
// 3. A TITLE THAT NAMES THE EVENT AND ADDS TO IT. Organisers stream per field
//    and the field takes top billing. The two field names at this event, from
//    its own results table, are "Obsessed Cuts and Color" and "Geared4Girls":
//
//      "Obsessed Cuts and Color - Maker Faire OC - MS/HS - Day 1"
//
//    That is the event, completely named, with a field in front — and it was
//    refused, because the extra words drop precision while the event keeps
//    words the title omits, so neither half of `best` clears 0.8.
//
// And the reason all of this stayed invisible: every one of those failures
// produced the same sentence. A query that returned nothing and a right video
// thrown away on a grade veto were indistinguishable from outside. The search
// now reports which gate refused each candidate.
import fs from 'fs';
let pass = 0, fail = 0;
const ok = (n, c, e) => { c ? (pass++, console.log('  ok   ' + n)) : (fail++, console.log('  FAIL ' + n + (e ? '\n         ' + e : ''))); };
const px = fs.readFileSync('../api/proxy.js', 'utf8');
const idx = fs.readFileSync('../index.html', 'utf8');
const src = idx.match(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/)[1];

// The real matcher, not a re-description of it.
const M = new Function(
  px.slice(px.indexOf('function looksLikeEventBroadcast'), px.indexOf("// ── Find the event's broadcast by name")) +
  '; return { gradeOf, gradesNamed, eventGrade, nameTokens, scoreTitle, distinctiveWord, searchQuery, bareQuery, looksLikeEventBroadcast };'
)();

const NAME = 'Maker Faire OC - MS/HS - Day 1 - robotics is ez: VEX V5 Robotics Competition - Override';
const want = M.nameTokens(NAME);

console.log('t86 — the Maker Faire miss, and a search that explains itself');

// ── 1. A blended event vetoes on neither grade ──
ok('both grades are read out of an MS/HS name',
  [...M.gradesNamed(NAME)].sort().join(',') === 'hs,ms', [...M.gradesNamed(NAME)].join(','));
ok('so it vetoes on nothing', M.eventGrade(NAME) === null,
  'gradeOf returns ' + M.gradeOf(NAME) + ' — first match wins, and ms is tested first');
ok('the other common spelling too', M.eventGrade('5.1 VEX Battle: Los Angeles_OVERRIDE: Blended MS/HS') === null);
ok('a High-School-only event still vetoes',
  M.eventGrade('Supernova Spectacular High School Tournament: Override: High School Only') === 'hs');
ok('a Middle-School-only event still vetoes', M.eventGrade('Spring Meet (Middle School)') === 'ms');
ok('an event naming no grade vetoes nothing', M.eventGrade('Bots @ Bristol Signature Event') === null);
ok('VEX U is still recognised', M.eventGrade('VEX U Regional') === 'u');
ok('the veto uses eventGrade, not gradeOf',
  (px.match(/const wantGrade = eventGrade\(/g) || []).length === 2 &&
  !/const wantGrade = gradeOf\(/.test(px),
  'both the name search and the channel listing veto');
ok('gradeOf itself is unchanged — a TITLE naming one grade still resolves',
  M.gradeOf('Maker Faire OC HS Day 1') === 'hs' && M.gradeOf('Spring Meet Middle School') === 'ms');

// ── 2. The season's game name is boilerplate ──
ok("'override' is a stopword", !want.includes('override'), want.join(' '));
ok('the earlier games still are', !M.nameTokens('Push Back Over Under Rapid Relay').length);
ok('the tokens left are the ones that identify the event',
  want.join(' ') === 'maker faire oc ez', want.join(' '));
ok('the query keeps the whole name, minus the program suffix',
  M.searchQuery(NAME) === 'Maker Faire OC - MS/HS - Day 1 - robotics is ez', M.searchQuery(NAME));

// ── 3. A title that names the event, plus a field ──
// These two field names are the real ones, from the event's results table.
const FIELD_TITLES = [
  'Obsessed Cuts and Color - Maker Faire OC - MS/HS - Day 1',
  'Geared4Girls - Maker Faire OC - MS/HS - Day 1',
  'Maker Faire OC Day 1 - Obsessed Cuts and Color Field',
  'robotics is ez presents: Maker Faire OC Day 1 Field 1',
  'Maker Faire OC - MS/HS - Day 1 - robotics is ez',
  'Maker Faire OC - MS/HS - Day 1 - robotics is ez: VEX V5 Robotics Competition - Override'
];
for (const t of FIELD_TITLES) {
  ok(`accepted: ${JSON.stringify(t.slice(0, 56))}`, !!M.scoreTitle(want, t));
}
ok('the rule is named in the code', /const namesTheEvent = recall >= 0\.6 && distinctShared >= 2;/.test(px));
ok('and it needs TWO rare words, not one',
  /const distinctShared = shared\.filter\(distinctiveWord\)\.length;/.test(px));
ok('the acceptance says which route it took',
  /via: best >= 0\.8 \? 'score' : 'names-event'/.test(px));

// ── 4. ...without letting unrelated video in ──
const NEG = [
  'Maker Faire Bay Area 2026 Highlights',
  'Maker Faire Rome - the whole show',
  'How to build a VEX V5 robot - Override strategy',
  'OC Regional Championship Day 1',
  'VEX Override Reveal Video',
  'Best Maker Projects of 2026'
];
for (const t of NEG) {
  ok(`refused: ${JSON.stringify(t.slice(0, 48))}`, !M.scoreTitle(want, t),
    JSON.stringify(M.scoreTitle(want, t)));
}

// A title that is ONLY the event's name is a strong match and always was —
// precision 1.0, nothing in it that the event does not explain. It reaches the
// scorer by the ordinary route, not the new one, and the date window and
// duration decide it from there.
{
  const bare = M.scoreTitle(want, 'Maker Faire OC');
  ok('a title that is just the event name matches on the ordinary route',
    bare && bare.via === 'score' && bare.precision === 1);
}

// A title that names the event and adds words is the WEAKER route, so it has
// to look like a real broadcast — hours, not a clip.
const weak = M.scoreTitle(want, 'Maker Faire OC — cosplay contest');
ok('a clip that merely names the event matches by the weaker route',
  weak && weak.via === 'names-event');
ok('...and a 12-minute upload is then refused',
  M.looksLikeEventBroadcast({ durationSec: 12 * 60 }, true) === false);
ok('...while a four-hour one is kept',
  M.looksLikeEventBroadcast({ durationSec: 4 * 3600 }, true) === true);
ok('a close title still only needs 20 minutes',
  M.looksLikeEventBroadcast({ durationSec: 25 * 60 }, false) === true);
ok('an unknown duration is trusted on the strong route only',
  M.looksLikeEventBroadcast({ durationSec: null }, false) === true &&
  M.looksLikeEventBroadcast({ durationSec: null }, true) === false);
ok('a genuine live broadcast is always kept',
  M.looksLikeEventBroadcast({ actualStartTime: '2026-09-12T16:30:00Z', durationSec: 60 }, true) === true);
ok('the strict test is applied to the weaker route',
  /looksLikeEventBroadcast\(v, sc\.via === 'names-event'\)/.test(px));

// ── 5. A failed search explains itself ──
ok('every refusal is recorded', /const rejects = \[\];/.test(px));
ok('with the gate that did it',
  ["'title'", "'aired'", "'duration'", "'grade'"].every(g => px.includes(`, ${g},`)),
  'title / aired / duration / grade');
ok('the list is capped', /if \(rejects\.length < 12\)/.test(px));
ok('titles are truncated, not dumped', /String\(title \|\| ''\)\.slice\(0, 120\)/.test(px));
ok('they ride back on the returned array, so no caller changes',
  /arr\.rejects = rejects; arr\.searched = searched; return arr;/.test(px));
ok('an empty search result says so too', /return withRejects\(\[\], \[\], 0\);/.test(px));
ok('the route sends them only when the search ran and found nothing',
  /search: \(searched && !found\.length && searchHits\) \? \{/.test(px),
  'no point spending bytes on a success');
ok('it reports the query that was actually used', /query: searchQuery\(evName\)/.test(px));
ok('the tokens it matched on', /want: nameTokens\(evName\)/.test(px));
ok('whether a grade veto was in force', /wantGrade: eventGrade\(evName\)/.test(px));
ok('and how many videos YouTube returned at all', /returned: searchHits\.searched \?\? 0/.test(px));

// ── 6. The panel reads it out ──
ok('the self-check prints the query and tokens',
  /Searched YouTube for "\$\{se\.query\}"/.test(src));
ok('"YouTube returned nothing" is called out as its own case',
  /YouTube returned NOTHING for /.test(src),
  'not on YouTube, not public, or unreachable by that query — a different fix each');
ok('the gates are tallied', /Object\.entries\(byGate\)\.map/.test(src));
ok('and the individual refusals listed', /refused \(\$\{r\.gate\}\): "\$\{r\.title\}"/.test(src));
ok('it says what to do if one of them is the right video',
  /names exactly which rule threw it away/.test(src));

// ── 7. A second, trimmed query when the full name reaches nothing ──
//
// RobotEvents names carry a season, a day marker, a grade and a programme
// string that no organiser repeats in a stream title. A long enough name stops
// matching anything and the search comes back EMPTY — which reads exactly like
// "no stream exists", and is the one failure the refusal list above cannot
// explain, because there is nothing to refuse.
//
// Reported for "California region 3 states", whose broadcast the full name
// never reached.
ok('a trimmer exists', /function bareQuery\(name\)/.test(px));
ok('it is only a SECOND attempt, after the full name finds nothing',
  /const first = await runQuery\(full\);\s*\n\s*if \(first\.length\) return first;/.test(px),
  'a hit never pays for it');
ok('...and is skipped when it would just repeat the first',
  /if \(!bare \|\| bare === full \|\| nameTokens\(bare\)\.length === 0\) return first;/.test(px));
ok('...and only runs once', (px.match(/await runQuery\(/g) || []).length === 2);
ok('both attempts are reported when neither works',
  /first\.rejects = \(first\.rejects \|\| \[\]\)\.concat\(second\.rejects \|\| \[\]\)/.test(px) &&
  /first\.retried = bare;/.test(px));
ok('the route passes the retry through', /retried: searchHits\.retried \|\| undefined,/.test(px));
ok('the panel names the second query', /and then, finding nothing, for "\$\{se\.retried\}"/.test(src));
ok('...and says "either query" when both came back empty',
  /YouTube returned NOTHING for \$\{se\.retried \? 'either query' : 'that query'\}/.test(src));

const trims = [
  ['2026 CA Region 3 State Championship - High School: VEX V5 Robotics Competition - Override',
   'CA Region 3 State Championship'],
  ['California Region 3 V5RC State Championship 2025-2026', 'California Region 3 State Championship'],
  ['2026 Northern California Region 3 Championship (High School) Day 2',
   'Northern California Region 3 Championship'],
  ['Maker Faire OC - MS/HS - Day 1 - robotics is ez: VEX V5 Robotics Competition - Override',
   'Maker Faire OC - robotics is ez']
];
for (const [name, want] of trims) {
  ok(`trims to ${JSON.stringify(want)}`, M.bareQuery(name) === want, M.bareQuery(name));
}
ok('separators left behind by the trimming are collapsed',
  !/ - - /.test(M.bareQuery('Maker Faire OC - MS/HS - Day 1 - robotics is ez')),
  '"Maker Faire OC - - - robotics is ez" is not a query anyone would type');
ok('a bare "VEX" survives — it is in real titles, Worlds among them',
  M.bareQuery('VEX Robotics World Championship') === 'VEX Robotics World Championship');
ok('a name with nothing to trim produces no retry',
  M.bareQuery('Bots @ Bristol Signature Event (Middle School)') ===
  M.searchQuery('Bots @ Bristol Signature Event (Middle School)'));

// The lookup version has to move, or yesterday's cached miss outlives the fix.
ok('the lookup version was bumped', /const RW_STREAM_LOGIC = 'L4';/.test(src),
  'the proxy caches a miss; shipping a matching change without bumping it is invisible');

console.log(`\nt86: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
