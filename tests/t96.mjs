// t96 — a percentage has to say what it is a percentage OF.
//
// Reported with a screenshot: "why is this like this, it's hard to tell if
// it's the chance to win or the chance against that individual team."
//
// The next-match card was laid out opponents → bar → your alliance, and the
// bar carried nothing but "54%". Sitting directly under the last opponent
// block, it read as that team's number. It is the whole alliance's chance of
// winning the whole match, and nothing on the screen said so.
//
// The same number appears in the match list's last column with no header at
// all, where it could equally be read as "your odds against 7410K".
//
// The rules this file keeps:
//   · both sides of the card are named
//   · the bar comes after BOTH sides, never between them
//   · the bar carries a sentence saying whose chance it is, in the body face
//   · the list column says once, above the list, what the number means
import fs from 'fs';
import { boot, settle } from './harness.mjs';
let pass = 0, fail = 0;
const ok = (n, c, e) => { c ? (pass++, console.log('  ok   ' + n)) : (fail++, console.log('  FAIL ' + n + (e ? '\n         ' + e : ''))); };

const idx = fs.readFileSync('../index.html', 'utf8');
const src = idx.match(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/)[1];
const css = idx.slice(0, idx.indexOf('</style>'));

console.log('t96 — the win percentage says what it is');

// ══ 1. The next-match card names both sides ═════════════════════════════════
console.log('\n· the card');
// The card is built by string concatenation, so the ORDER of the appends is
// the order on screen. Find them and check they run your side, their side,
// then the number — not opponents, number, you.
const card = src.slice(src.indexOf('// Next match card'), src.indexOf('// Match list grouped by round'));
ok('the card builder was found', card.length > 200 && card.includes('md-next'));

const atAlliance = card.indexOf('YOUR ALLIANCE');
const atAgainst = card.indexOf('AGAINST');
const atOpps = card.indexOf('next.oppIds.map');
const atBar = card.indexOf('md-winbar');
ok('your alliance is labelled', atAlliance > 0);
ok('their side is labelled too', atAgainst > 0, 'an unlabelled block of team numbers is a guess');
ok('your side comes first', atAlliance < atAgainst, `${atAlliance} vs ${atAgainst}`);
ok('the opponents follow their label', atAgainst < atOpps, `${atAgainst} vs ${atOpps}`);
ok('the bar comes after BOTH sides, not between them', atBar > atOpps && atBar > atAlliance,
  `bar at ${atBar}, opponents at ${atOpps}, alliance at ${atAlliance}`);

// ══ 2. The bar says whose chance it is ══════════════════════════════════════
ok('the bar carries a label', /md-win-label/.test(card));
ok('the label names the alliance and the match',
  /Chance \$\{[^}]*\} this match/.test(card) || /your alliance wins/.test(card),
  card.slice(card.indexOf('md-win-label'), card.indexOf('md-win-label') + 160));
// A team with no partner should not be told about "your alliance".
ok('the wording adapts when there is no partner',
  /partners\.length \? 'your alliance wins' : 'you win'/.test(card));
// Prose, not a label: the body face, per the two-faces rule.
{
  const rule = (css.match(/\.md-win-label \{([^}]*)\}/) || [])[1] || '';
  ok('.md-win-label exists', !!rule);
  ok('the sentence is in the body face', /font-family: var\(--body\)/.test(rule), rule);
  ok('the sentence has prose leading', /line-height: 1\.5/.test(rule), rule);
  ok('the sentence is not shouted in caps', !/text-transform: uppercase/.test(rule), rule);
}
// And the block it sits in is separated by a rule, not boxed.
{
  const rule = (css.match(/\.md-win \{([^}]*)\}/) || [])[1] || '';
  ok('the win block is set off by a rule', /border-top: 1px solid/.test(rule), rule);
  ok('the win block is not a box', !/border: 1px/.test(rule) && !/background:/.test(rule), rule);
}

// ══ 3. The list column explains itself ══════════════════════════════════════
console.log('\n· the list');
ok('the round label can carry a key', /match-round-key/.test(idx));
ok('the key names the alliance and the match',
  /% = chance your alliance wins that match/.test(src));
// Only where there is something to explain — a played round has scores, not
// predictions, and a key over them would be noise.
ok('the key only appears where a prediction does',
  /const shows = byRound\[round\]\.some\(x => !x\.played && x\.win !== null/.test(src));
ok('the outcome cell carries the same sentence for anyone who lands on it',
  /title="Chance your alliance wins this match"/.test(src));
ok('and only while the match is unplayed',
  /\$\{m\.played \? '' : ' title="Chance your alliance wins this match"'\}/.test(src));
{
  const rule = (css.match(/\.match-round-key \{([^}]*)\}/) || [])[1] || '';
  ok('the key is prose, in the body face', /font-family: var\(--body\)/.test(rule), rule);
  ok('the key is quieter than the label', /color: var\(--text-muted\)/.test(rule), rule);
  // The round label is mono with 2px tracking; the key must not inherit it.
  ok('the key drops the label tracking', /letter-spacing: 0/.test(rule), rule);
}
{
  const rule = (css.match(/\.match-round-label \{([^}]*)\}/) || [])[1] || '';
  ok('the label makes room for the key', /display: flex/.test(rule) && /space-between/.test(rule), rule);
  ok('the label wraps rather than overflowing', /flex-wrap: wrap/.test(rule), rule);
}

// ══ 4. The rows are still rows in a real DOM ════════════════════════════════
// The border fix lives in t93; this is the half of it the user actually sees,
// checked where it renders. jsdom does not do the `medium` fallback, so the
// assertion is on the declarations reaching the element, not on pixels.
console.log('\n· the schedule is not a stack of white cards');
{
  const { win, stop } = await boot();
  await settle(win);
  const sheet = [...win.document.querySelectorAll('style')].map(s => s.textContent).join('\n');
  ok('the page really carries the fixed rule',
    /\.match-row\.upcoming \{[^}]*border-bottom-style: dashed/.test(sheet));
  ok('and no longer the four-sided one',
    !/\.match-row\.upcoming \{[^}]*[^-]border-style:/.test(sheet));
  stop();
}

console.log(`\nt96: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
