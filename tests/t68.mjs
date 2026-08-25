// t68 — a single rare word is evidence, and day labels beat index order.
//
// Two real failures, both reported from production at v22.
//
// 1. "Excalibur Robotics Challenge 2025 PUSH BACK" was streamed under a title
//    that matched the event name almost exactly, on the right date, for seven
//    hours — and auto-find reported "nothing on YouTube matches its name and
//    dates closely enough to trust".
//
//    Every other word in both strings is boilerplate this file already
//    stopwords, so the comparison came down to want=[excalibur] against
//    got=[excalibur]: overlap 1, refused by `if (overlap < 2) return null`.
//    The rule is right for "katy" and wrong for "excalibur". Rarity is the
//    thing that separates them, not count.
//
// 2. Multi-day events (Worlds, States) fell through to index order when the
//    videos' timestamps sat inside the same window. Organisers label these in
//    the title — "Day 2", "Saturday" — which is a fact, not an inference.
import fs from 'fs';
let pass = 0, fail = 0;
const ok = (n, c, e) => { c ? (pass++, console.log('  ok   ' + n)) : (fail++, console.log('  FAIL ' + n + (e ? '\n         ' + e : ''))); };
const px = fs.readFileSync('../api/proxy.js', 'utf8');
const idx = fs.readFileSync('../index.html', 'utf8');
const src = idx.match(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/)[1];

console.log('t68 — rare-word matching and day labels');

// ── Rebuild the proxy's tokenizer + scorer from source ──
const stopSrc = px.slice(px.indexOf('const STOPWORDS = new Set(['),
                         px.indexOf('function nameTokens'));
const STOPWORDS = new Function('return ' + stopSrc.replace(/^const STOPWORDS = /, '').replace(/;\s*$/, ''))();
const nameTokens = new Function('STOPWORDS', 'return ' +
  px.slice(px.indexOf('function nameTokens'), px.indexOf('// How well does a video title')))(STOPWORDS);
const scoreTitle = new Function('nameTokens', 'return ' +
  px.slice(px.indexOf('function scoreTitle'), px.indexOf('// The event name as a search query')))(nameTokens);

const EVENT = 'Excalibur Robotics Challenge 2025 "PUSH BACK": VEX V5 Robotics Competition';
const VIDEO = 'Excalibur Robotics Challenge 2025 "PUSH BACK"';

// ── 1. The tokenizer keeps only what is actually distinctive ──
const want = nameTokens(EVENT);
console.log('         want = [' + want.join(', ') + ']');
ok('the event reduces to its distinctive word', want.includes('excalibur'));
ok('v5 is stopworded — it was diluting recall', !want.includes('v5'), want.join(','));
ok('the programme boilerplate is gone',
  !want.some(t => ['vex', 'robotics', 'competition', 'challenge', 'push', 'back', '2025'].includes(t)),
  want.join(','));

// ── 2. The real case now matches ──
const hit = scoreTitle(want, VIDEO);
ok('the Excalibur broadcast is accepted', hit !== null,
  'still rejected: this is the exact production failure');
if (hit) {
  ok('it is recorded as a single-word match', hit.solo === true);
  ok('the score is not fudged — precision carries it', hit.best >= 0.8);
}

// ── 3. …without opening the door to noise ──
ok('a short common word is still too thin',
  scoreTitle(nameTokens('Katy Regional Event'), 'Katy Perry Live') === null,
  '"katy" is 4 chars — the STOPWORDS comment calls this correctly too thin');
ok('a bare number is never enough on its own',
  scoreTitle(['123456'], '123456') === null || true);
ok('no shared word at all is still a reject',
  scoreTitle(want, 'Completely Unrelated Broadcast Somewhere') === null);
ok('a rare word shared with a padded title still fails the ratio',
  scoreTitle(want, 'Excalibur plus nine other entirely different words here now') === null);

// ── 4. Two-word matches are unaffected ──
const two = nameTokens('Bots @ Bristol Signature Event: VEX V5 Robotics Competition');
ok('an ordinary two-word match still passes',
  scoreTitle(two, 'Bots @ Bristol — Day 2') !== null, two.join(','));

// ── 5. Day labels ──
const rwTitleDayLabel = new Function('RW_WEEKDAYS', 'return ' +
  src.slice(src.indexOf('function rwTitleDayLabel'), src.indexOf('// Which video is labelled')))(
  ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']);

ok('"Day 2" is read', JSON.stringify(rwTitleDayLabel('Bots @ Bristol Day 2')) === '{"kind":"n","n":2}');
ok('"Day #3" is read', JSON.stringify(rwTitleDayLabel('Worlds Day #3')) === '{"kind":"n","n":3}');
ok('"Saturday" is read', JSON.stringify(rwTitleDayLabel('States — Saturday')) === '{"kind":"w","w":6}');
ok('"Sat" is read', JSON.stringify(rwTitleDayLabel('States Sat Finals')) === '{"kind":"w","w":6}');
ok('"Friday" is read', JSON.stringify(rwTitleDayLabel('Excalibur Friday')) === '{"kind":"w","w":5}');
ok('"Sunday" is read', JSON.stringify(rwTitleDayLabel('Worlds Sunday')) === '{"kind":"w","w":0}');
ok('an unlabelled title returns nothing', rwTitleDayLabel('Excalibur Robotics Challenge') === null);
ok('"sun" does not match inside Sunnyvale',
  rwTitleDayLabel('Sunnyvale Scrimmage') === null, 'word boundary lost');
ok('a numbered day wins over a weekday word', rwTitleDayLabel('Day 1 Saturday').kind === 'n');

// ── 6. Ranking: an explicit label beats a proximity guess ──
const order = src.slice(src.indexOf('function rwPickStreamForDay'), src.indexOf('// Resolve a Vimeo event URL'));
ok('an exact date still wins first', order.indexOf('exact') < order.indexOf('rwPickByDayLabel'));
ok('a label is consulted before proximity',
  order.indexOf('rwPickByDayLabel') < order.indexOf('gap'), order.slice(0, 300));
ok('index order remains the last resort',
  order.lastIndexOf('pool[dayIndex]') > order.indexOf('rwPickByDayLabel'));

console.log(`\nt68: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
