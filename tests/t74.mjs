// t74 — vexworlds.tv is recognised, and said so honestly.
//
// The World Championship is not on YouTube. It streams on vexworlds.tv:
//
//   https://www.vexworlds.tv/#/channels/jmhkmkbdwsh3fg4pfoqn
//
// Which means no amount of improving the YouTube search was ever going to find
// Worlds — there is nothing there to find. Several rounds went into tuning the
// scorer against an event that was never a scoring problem, because the app
// reported "nothing matches its name and dates closely enough to trust". That
// sentence describes a near-miss. This was an absence.
//
// A vexworlds.tv link also parsed as null, so pasting one by hand answered
// "that doesn't look like a YouTube or Vimeo link" — true, and useless.
//
// NOT seekable, deliberately. How the site serves video has not been observed
// from here (the sandbox's network policy refuses the host outright), and
// HANDOFF §10-C already carries one integration written against expected
// rather than observed markup. A second guess would add a second §10-C.
// Recognising a source and declining to fake support for it is the honest
// position, and it is what this file pins down.
import fs from 'fs';
let pass = 0, fail = 0;
const ok = (n, c, e) => { c ? (pass++, console.log('  ok   ' + n)) : (fail++, console.log('  FAIL ' + n + (e ? '\n         ' + e : ''))); };
const idx = fs.readFileSync('../index.html', 'utf8');
const src = idx.match(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/)[1];

const rwParseSource = new Function('return ' +
  src.slice(src.indexOf('function rwParseSource'), src.indexOf('// Back-compat: existing callers')))();

console.log('t74 — vexworlds.tv recognised, not faked');

// ── 1. The real URL parses ──
const REAL = 'https://www.vexworlds.tv/#/channels/jmhkmkbdwsh3fg4pfoqn';
const p = rwParseSource(REAL);
ok('a vexworlds.tv link is no longer null', p !== null, 'it read as "not a YouTube or Vimeo link"');
ok('it is identified as its own platform', p && p.platform === 'vexworldstv');
ok('it is marked unsupported rather than seekable', p && p.kind === 'unsupported');
ok('the channel id is picked out of the hash route',
  p && p.channelId === 'jmhkmkbdwsh3fg4pfoqn', JSON.stringify(p));
ok('it carries no video id, because none was observed', p && p.id === null);

ok('a bare channel path still parses', rwParseSource('vexworlds.tv/#/channels/abc123') !== null);
ok('the host alone parses', rwParseSource('https://www.vexworlds.tv/') !== null);
ok('an unknown vexworlds.tv shape yields a null channel id',
  rwParseSource('https://www.vexworlds.tv/#/something-else').channelId === null);

// ── 2. It must not be mistaken for the platforms we DO handle ──
ok('it is not read as YouTube', p.platform !== 'youtube');
ok('it is not read as Vimeo', p.platform !== 'vimeo');
ok('YouTube links still parse', rwParseSource('https://www.youtube.com/watch?v=oGL8pNZSdlo').platform === 'youtube');
ok('Vimeo links still parse', rwParseSource('https://vimeo.com/123456789').platform === 'vimeo');
ok('Vimeo events still parse', rwParseSource('https://vimeo.com/event/123456').platform === 'vimeo');
ok('a bare 11-char id is still YouTube', rwParseSource('oGL8pNZSdlo').platform === 'youtube');
ok('a bare number is still Vimeo', rwParseSource('123456789').platform === 'vimeo');
ok('nonsense is still null', rwParseSource('not a link at all') === null);
ok('an empty string is still null', rwParseSource('') === null);

// ── 3. Auto-sync refuses it with a reason, before the Vimeo branch ──
const sync = src.slice(src.indexOf('async function rwTryAutoSync'), src.indexOf('function rewatchCalibrate'));
ok('auto-sync handles it explicitly', /srcInfo\.platform === 'vexworldstv'/.test(sync));
ok('it names the platform in the message', /VEX TV \/ vexworlds\.tv stream/.test(sync));
ok('it explains what to do instead', /open the stream in a tab and use the match times/.test(sync));
ok('it is checked before the Vimeo branch',
  sync.indexOf("=== 'vexworldstv'") < sync.indexOf("!== 'youtube'"),
  'otherwise it falls into Vimeo resolution and fails obscurely');
ok('the refusal goes through fail(), so the reason is recorded',
  /return fail\('That is a VEX TV/.test(sync));

// ── 4. The miss message stops implying a near-miss ──
ok('a YouTube miss mentions where championships actually stream',
  (src.match(/streamed on vexworlds\.tv instead/g) || []).length >= 2,
  'both the blocked-page and no-link miss reasons need it');

console.log(`\nt74: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
