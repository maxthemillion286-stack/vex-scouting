// t84 — the button that opens the event on RobotEvents.
//
// Asked for directly. Three things have to hold for it to be worth having.
//
// 1. THE ADDRESS HAS TO BE RIGHT. The page is addressed by SKU with a program
//    segment that must match the SKU's program, or it 404s. api/proxy.js
//    already derives that mapping for scraping, so there are now two copies of
//    it and they have to agree — this file checks that they do.
//
//    The host is events.vex.com, not robotevents.com. Both the API and the
//    public site moved there in the VEX/RECF split, and §10-D of HANDOFF.md
//    records robotevents.com serving clean 404s for these SKUs afterwards.
//    (The proxy's own scrape is blocked from Vercel's IPs — §2 — but a link
//    opens in the user's browser, which is not.)
//
// 2. IT MUST BELONG TO THE EVENT ON SCREEN. The SKU is per-event state, and
//    this project's recurring bug is per-event state outliving its event. It is
//    cleared in loadTournamentTeams with the rest; t82 drives the two-event
//    case end to end.
//
// 3. A POPUP BLOCKER MUST NOT EAT IT. Where the SKU is known it is a plain
//    <a href>, which nothing can block. The fallback opens the blank window
//    inside the click and navigates it after the lookup — open it after the
//    await instead and mobile Safari swallows it silently.
import fs from 'fs';
let pass = 0, fail = 0;
const ok = (n, c, e) => { c ? (pass++, console.log('  ok   ' + n)) : (fail++, console.log('  FAIL ' + n + (e ? '\n         ' + e : ''))); };
const idx = fs.readFileSync('../index.html', 'utf8');
const src = idx.match(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/)[1];
const px = fs.readFileSync('../api/proxy.js', 'utf8');

console.log('t84 — open the event on RobotEvents');

// ── 1. The address ──
const urlSrc = src.slice(src.indexOf('function reProgramSegment'), src.indexOf('// Open it, from a button'));
const { reEventUrl, reProgramSegment: seg } =
  new Function(urlSrc + '; return { reEventUrl, reProgramSegment };')();

ok('a V5RC sku resolves',
  reEventUrl('RE-V5RC-25-0191') ===
  'https://events.vex.com/robot-competitions/vex-robotics-competition/RE-V5RC-25-0191.html');
ok('it points at events.vex.com, the live host',
  /events\.vex\.com/.test(reEventUrl('RE-V5RC-25-0191')),
  'robotevents.com serves clean 404s for these SKUs — §10-D');
ok('a lowercase sku is normalised', reEventUrl('re-v5rc-25-0191').includes('RE-V5RC-25-0191'));
ok('surrounding whitespace is tolerated', reEventUrl('  RE-V5RC-25-0191  ') !== null);

ok('VIQRC gets the IQ segment', seg('RE-VIQRC-25-1234') === 'vex-iq-competition');
ok('the older VIQC spelling too', seg('RE-VIQC-24-1234') === 'vex-iq-competition');
ok('VURC gets the university segment', seg('RE-VURC-24-0007') === 'vex-u-robotics-competition');
ok('the older VEXU spelling too', seg('RE-VEXU-23-0007') === 'vex-u-robotics-competition');
ok('ADC gets the drone segment', seg('RE-ADC-25-0055') === 'aerial-drone-competition');
ok('VAIC too', seg('RE-VAIC-25-0055') === 'aerial-drone-competition');
ok('anything else falls back to V5RC', seg('RE-V5RC-25-0191') === 'vex-robotics-competition');

// Nothing that is not a SKU becomes a URL — this string ends up in an href.
for (const junk of ['', null, undefined, 'garbage', 'RE-', 'RE-V5RC-25',
                    'javascript:alert(1)', 'RE-V5RC-25-0191" onmouseover="x',
                    'RE-V5RC-25-0191/../../evil', 'https://evil.test/RE-V5RC-25-0191']) {
  ok(`rejected: ${JSON.stringify(junk)}`, reEventUrl(junk) === null);
}

// ── 2. The two copies of the program mapping agree ──
// The proxy builds the same URL to scrape. If one gains a program and the other
// doesn't, the button silently 404s for that program only.
const pxSeg = px.slice(px.indexOf('const progs = [];'), px.indexOf('// Only two candidates'));
for (const [pat, expected] of [
  ['VIQRC|VIQC', 'vex-iq-competition'],
  ['VURC|VEXU', 'vex-u-robotics-competition'],
  ['ADC|VAIC', 'aerial-drone-competition']
]) {
  ok(`the proxy maps ${pat} the same way`,
    new RegExp(`\\(${pat.replace('|', '\\|')}\\)[\\s\\S]{0,60}'${expected}'`).test(pxSeg),
    'two copies of this mapping now exist and they have to agree');
}
ok('the proxy also defaults to the V5RC segment',
  /progs\.push\('vex-robotics-competition'/.test(pxSeg));

// ── 3. It renders, and it is a real link when it can be ──
ok('one helper renders it everywhere', /function reEventLink\(eventId, sku, cls\)/.test(src));
ok('a known sku is a plain anchor',
  /return `<a class="\$\{klass\}" href="\$\{url\}" target="_blank" rel="noopener noreferrer"/.test(src),
  'nothing can block an <a>');
ok('an unknown sku is a button that looks the same',
  /<button class="\$\{klass\}" onclick="openEventPage\('\$\{id\}'\)"/.test(src));
ok('it opens in a new tab, not over the app',
  /target="_blank"/.test(src.slice(src.indexOf('function reEventLink'), src.indexOf('const reSkuAttr'))));
ok('and cannot reach back through window.opener',
  /rel="noopener noreferrer"/.test(src));

// The nav is rendered by every tournament sub-view, so putting it there puts it
// on all six at once.
ok('the tournament nav carries it',
  /\$\{tournamentEventId \? reEventLink\(tournamentEventId, tournamentEventSku\) : ''\}/.test(src));
ok('the Jumper carries it too, for the event actually open',
  /reEventLink\(ctx\.eventId, openEv && openEv\.sku\)/.test(src));
ok('the Jumper picks the open event, not the first in the list',
  /ctx\.events\.find\(e => String\(e\.id\) === String\(ctx\.eventId\)\)/.test(src));

// ── 4. Per-event state, cleared like the rest ──
ok('the sku is declared as per-event state', /let tournamentEventSku = null;/.test(src));
ok('it is set from the argument when an event opens, and cleared otherwise',
  /tournamentEventSku = sku \|\| null;/.test(src));
ok('...in the same block as the other per-event caches',
  /tournamentTeamCache = null;\s*\n\s*tournamentEventSku = sku \|\| null;/.test(src));
ok('loadTournamentTeams accepts it',
  /async function loadTournamentTeams\(eventId, eventName, focusTeamId, focusTeamNumber, sku\)/.test(src));
ok('every search result passes the sku it already has',
  (src.match(/reSkuAttr\(ev\.sku\)/g) || []).length >= 2);
ok('the sku-lookup and single-result paths pass it too',
  /loadTournamentTeams\(events\[0\]\.id, events\[0\]\.name, null, '', events\[0\]\.sku\)/.test(src) &&
  /loadTournamentTeams\(ev\.id, ev\.name, null, '', ev\.sku\)/.test(src));
ok('views that fetch event detail fill it in when it was not passed',
  (src.match(/if \(!tournamentEventSku\) tournamentEventSku = ev/g) || []).length >= 2);

// ── 5. The popup-blocker dance ──
const open = src.slice(src.indexOf('async function openEventPage'), src.indexOf('// ── Storage that cannot'));
ok('a known sku skips the lookup entirely', /let url = reEventUrl\(knownSku\);\s*\n\s*if \(url\) \{ window\.open/.test(open));
ok('the blank window is opened BEFORE the await',
  open.indexOf("window.open('', '_blank')") < open.indexOf('await apiGet'),
  'opening it afterwards is what mobile Safari blocks');
ok('it is navigated after the lookup', /w\.location = url;/.test(open));
ok('the opener reference is cut', /w\.opener = null;/.test(open));
ok('a failed lookup closes the blank window rather than leaving it hanging',
  /if \(!url\) \{\s*\n\s*if \(w\) w\.close\(\);/.test(open));
ok('...and says so', /Could not work out this event/.test(open));
ok('a blocked window still tries the direct route', /else window\.open\(url, '_blank', 'noopener'\);/.test(open));

// ── 6. Nothing unsanitised reaches an inline handler ──
ok('event ids are narrowed to digits', /String\(eventId == null \? '' : eventId\)\.replace\(\/\[\^0-9\]\/g, ''\)/.test(src));
ok('a non-numeric id renders nothing rather than a broken handler', /if \(!id\) return '';/.test(src));
ok('skus are narrowed before going in an attribute', /const reSkuAttr = \(sku\) =>[\s\S]{0,120}replace\(\/\[\^A-Z0-9-\]\/g, ''\)/.test(src));

const attr = new Function('return (sku) => String(sku || "").toUpperCase().replace(/[^A-Z0-9-]/g, "");')();
ok('a quote cannot escape the handler', !attr(`RE-V5RC-25-0191' ,alert(1),'`).includes("'"));
ok('a real sku passes through untouched', attr('RE-V5RC-25-0191') === 'RE-V5RC-25-0191');

// ── 7. It is styled as a way OUT, not another view ──
ok('it has its own class', /\.t-nav-link \{/.test(idx));
ok('it does not stretch like the tabs', /\.t-nav-link \{[\s\S]{0,120}flex: 0 0 auto;/.test(idx));
ok('it gets its own row on a phone',
  /\.t-nav-link \{[^}]*flex: 1 0 100%;/.test(idx), 'a cramped stub beside five tabs is unreadable');
ok('it has a hover state like everything else', /\.t-nav-link:hover/.test(idx));

console.log(`\nt84: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
