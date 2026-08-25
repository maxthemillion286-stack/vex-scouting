// t71 — the search's entry check and the scorer must agree.
//
// v23 taught scoreTitle to accept a single rare word, for events whose whole
// distinctive content is one token. It did not work, because the function that
// calls it bailed first:
//
//     const want = nameTokens(name);
//     if (want.length < 2) return [];      // ← never reaches the scorer
//
// "Excalibur Robotics Challenge 2025 PUSH BACK" reduces to [excalibur]. The
// VEX World Championship reduces to [world]. Both returned at that line, so
// the search never ran and the v23 fix was dead code for exactly the events it
// was written for. Bristol worked only because it has two tokens.
//
// Fourth instance in this project of a path returning before it reaches the
// code that would have worked (HANDOFF §11).
//
// t68 did not catch it because it exercised scoreTitle in isolation and never
// asked whether anything could reach it. This one tests the PATH: the guard and
// the scorer share distinctiveWord(), and both are checked against the same
// real event names.
import fs from 'fs';
let pass = 0, fail = 0;
const ok = (n, c, e) => { c ? (pass++, console.log('  ok   ' + n)) : (fail++, console.log('  FAIL ' + n + (e ? '\n         ' + e : ''))); };
const px = fs.readFileSync('../api/proxy.js', 'utf8');

console.log('t71 — the search entry check reaches the scorer');

// Rebuild the real tokenizer, scorer and helper from source.
const stopSrc = px.slice(px.indexOf('const STOPWORDS = new Set(['), px.indexOf('function nameTokens'));
const STOPWORDS = new Function('return ' + stopSrc.replace(/^const STOPWORDS = /, '').replace(/;\s*$/, ''))();
const nameTokens = new Function('STOPWORDS', 'return ' +
  px.slice(px.indexOf('function nameTokens'), px.indexOf('// How well does a video title')))(STOPWORDS);
const distinctiveWord = new Function('return ' +
  px.slice(px.indexOf('function distinctiveWord'), px.indexOf('// The event name as a search query')))();
const scoreTitle = new Function('nameTokens', 'distinctiveWord', 'return ' +
  px.slice(px.indexOf('function scoreTitle'), px.indexOf('// Is one word, on its own')))(nameTokens, distinctiveWord);

// The guard, lifted verbatim from searchYouTubeByName.
const guard = new Function('want', 'distinctiveWord', `
  if (!want.length) return false;
  if (want.length === 1 && !distinctiveWord(want[0])) return false;
  return true;`);
const searchRuns = name => guard(nameTokens(name), distinctiveWord);

// ── 1. Both checks are driven by the same helper ──
ok('the guard is expressed with distinctiveWord',
  /want\.length === 1 && !distinctiveWord\(want\[0\]\)/.test(px));
ok('the scorer is expressed with distinctiveWord',
  /if \(!distinctiveWord\(shared\[0\]\)\) return null;/.test(px));
ok('neither restates a length threshold of its own',
  !/solo\.length < \d/.test(px), 'a second literal threshold is how these drift apart');
ok('the old two-token guard is gone', !/if \(want\.length < 2\) return \[\];/.test(px));

// ── 2. Real event names get past the entry check ──
const EXCALIBUR = 'Excalibur Robotics Challenge 2025 "PUSH BACK": VEX V5 Robotics Competition';
const WORLDS = 'VEX Robotics World Championship: VEX V5 Robotics Competition';
const BRISTOL = 'Bots @ Bristol Signature Event (Middle School): VEX V5 Robotics Competition';

console.log('         excalibur → [' + nameTokens(EXCALIBUR).join(', ') + ']');
console.log('         worlds    → [' + nameTokens(WORLDS).join(', ') + ']');
console.log('         bristol   → [' + nameTokens(BRISTOL).join(', ') + ']');

ok('Excalibur reaches the search', searchRuns(EXCALIBUR) === true, 'reported broken at v23');
ok('Worlds reaches the search', searchRuns(WORLDS) === true, 'reported broken at v25');
ok('Bristol still reaches the search', searchRuns(BRISTOL) === true);
ok('an all-boilerplate name is still refused',
  searchRuns('VEX V5 Robotics Competition') === false, 'a search on nothing is a coin flip');
ok('a short lone word is still refused', searchRuns('Katy Regional Event') === false);

// ── 3. …and then actually match their broadcasts ──
ok('the Excalibur broadcast scores',
  scoreTitle(nameTokens(EXCALIBUR), 'Excalibur Robotics Challenge 2025 "PUSH BACK"') !== null);
ok('a Worlds division stream scores',
  scoreTitle(nameTokens(WORLDS), '2026 VEX Robotics World Championship - Research Division Day 2') !== null,
  '"world" is five characters — a six-character rule excluded Worlds by one letter');
ok('a Worlds day-1 stream scores',
  scoreTitle(nameTokens(WORLDS), 'VEX World Championship Day 1 — Opportunity Division') !== null);
ok('the Bristol day-2 stream still scores',
  scoreTitle(nameTokens(BRISTOL), 'Bots @ Bristol Signature Event (Middle School) Day 2') !== null);

// ── 4. The threshold change did not open the floor ──
ok('four characters is still too thin', distinctiveWord('katy') === false);
ok('five characters is enough', distinctiveWord('world') === true);
ok('nine characters is enough', distinctiveWord('excalibur') === true);
ok('a bare number is never enough', distinctiveWord('2025') === false);
ok('an empty token is never enough', distinctiveWord('') === false);
ok('undefined is handled', distinctiveWord(undefined) === false);

ok('an unrelated broadcast sharing one rare word is still refused',
  scoreTitle(nameTokens(WORLDS), 'World of Warcraft nine hour unrelated marathon stream today') === null);
ok('no shared word at all is still refused',
  scoreTitle(nameTokens(EXCALIBUR), 'Some Other Tournament Entirely') === null);

console.log(`\nt71: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
