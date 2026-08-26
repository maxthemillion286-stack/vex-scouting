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
// Asserted on substance rather than exact phrasing, so improving the wording
// isn't a test failure. What matters is that it names the platform, says why
// it can't sync, and points at the manual anchor rather than reading as a
// dead end — manual calibration is the whole reason this path stays open (§6).
const vexMsg = (sync.match(/return fail\((["'])(?:(?!\1).)*VEX TV(?:(?!\1).)*\1\)/) || [''])[0];
ok('the refusal goes through fail(), so the reason is recorded', vexMsg.length > 0, sync.slice(0, 200));
ok('it names the platform', /VEX TV/.test(vexMsg));
// The reason had to change once the BoxCast capture arrived. VEX TV DOES
// publish a broadcast start (starts_at) — the earlier message said it did not,
// which was simply wrong. What can fail now is reading the channel's broadcast
// list, and that is what it says.
ok('it says why the automatic path did not work',
  /broadcast list couldn't be read automatically/.test(vexMsg), vexMsg);
ok('it no longer claims VEX TV publishes no start time',
  !/doesn't publish when a broadcast began/.test(vexMsg),
  'starts_at is right there in the captured broadcast object');
ok('it points at setting one anchor by hand', /anchor by hand|Set one anchor/i.test(vexMsg));
ok('it is honest that jumping is not possible', /can't jump inside VEX TV/.test(vexMsg));
ok('it promises the thing that still works — the offset',
  /how far in each match is/.test(vexMsg));
ok('it is checked before the Vimeo branch',
  sync.indexOf("=== 'vexworldstv'") < sync.indexOf("!== 'youtube'"),
  'otherwise it falls into Vimeo resolution and fails obscurely');

// ── 5. A hand-anchored VEX TV day still computes and still opens out ──
const embed = new Function('return ' + src.slice(src.indexOf('function rwEmbedSrc'), src.indexOf('function rwWatchUrl')))();
const watch = new Function('return ' + src.slice(src.indexOf('function rwWatchUrl'), src.indexOf('// Accepts 12542')))();

const vexCal = { platform: 'vexworldstv', videoId: 'jmhkmkbdwsh3fg4pfoqn', url: REAL };
ok('there is no embed for it — nothing stable to point an iframe at',
  embed(vexCal, 1200) === null, 'CloudFront signed HLS expires and is per-viewer');
ok('the watch link is the page we were given', watch(vexCal, 1200) === REAL);
ok('a missing url still yields something openable',
  watch({ platform: 'vexworldstv' }, 0) === 'https://www.vexworlds.tv/');
ok('no invented timestamp is appended', !/[#?&]t=/.test(watch(vexCal, 1200)),
  'a made-up deep-link format would silently open at zero');

// YouTube and Vimeo must be untouched by all of this.
ok('YouTube still embeds with a start', embed({ platform: 'youtube', videoId: 'abc' }, 90) === 'https://www.youtube.com/embed/abc?start=90&autoplay=1');
ok('Vimeo still embeds with #t=', /#t=90s$/.test(embed({ platform: 'vimeo', videoId: '123', hash: 'h' }, 90)));
ok('YouTube watch links still carry the time', /&t=90s$/.test(watch({ platform: 'youtube', videoId: 'abc' }, 90)));

// The calibration form has to keep the url, since there is no seekable id.
const calib = src.slice(src.indexOf('function rewatchCalibrate(day)'), src.indexOf('function rewatchClearCal'));
ok('the page url is stored on the calibration', /cur\.url = srcInfo\.url \|\| null;/.test(calib));
ok('the channel id stands in for a video id',
  /if \(srcInfo\.platform === 'vexworldstv'\) cur\.videoId = srcInfo\.channelId \|\| 'vextv';/.test(calib));

// The player block must not render a broken iframe when there is no embed.
const player = src.slice(src.indexOf('// Player sits above the day list'), src.indexOf('// Why auto-find came up empty'));
ok('the player branches on whether an embed exists', /const embed = rwEmbedSrc\(pcal, ctx\.playing\.off\);/.test(player));
ok('no iframe is rendered without one', /\$\{embed \? `<div class="rw-embed">/.test(player));
ok('the computed position is shown large instead', /rw-vextv-time/.test(player));
ok('and it says why there is no player', /can't be embedded or seeked from here/.test(player));
ok('the class it uses is actually styled', /\.rw-vextv-time \{/.test(idx));

// ── 4. The miss message stops implying a near-miss ──
ok('a YouTube miss mentions where championships actually stream',
  (src.match(/streamed on vexworlds\.tv instead/g) || []).length >= 2,
  'both the blocked-page and no-link miss reasons need it');


// ── 6. BoxCast is attempted before falling back to the manual anchor ──
ok('the boxcast route is called for a VEX TV link',
  /'boxcast:' \+ chan/.test(sync), 'VEX TV is BoxCast, and BoxCast publishes starts_at');
ok('the event window is passed so other events are not returned',
  /rwEventDays\[0\]/.test(sync) && /rwEventDays\[rwEventDays\.length - 1\]/.test(sync));
ok('the broadcast list goes through the same day picker',
  /rwPickStreamForDay\(list, day, rwEventDayOrdinal\(day, 0\)\)/.test(sync),
  'so the grade veto and day ranking apply with no special case');
ok('starts_at is what the anchor is computed from',
  /Date\.parse\(b\.actualStartTime \|\| ''\)/.test(sync));
ok('the same pre-start grace applies', /secs >= -RW_PRESTART_GRACE_SEC/.test(sync));
ok('a saved VEX TV calibration keeps the page url', /platform: 'vexworldstv', url: b\.url \|\| srcInfo\.url/.test(sync));
ok('the attempt is recorded for debugging',
  /vsDebug\.boxcast = \{ channel: chan, http: r\.status, body: j \}/.test(sync),
  'the list endpoint query shape is the one thing still unconfirmed');
ok('the debug report renders it', /boxcast: vsDebug\.boxcast/.test(src));
ok('a failure still falls back to the manual anchor rather than throwing',
  /catch \(e\) \{ vsNote\('boxcast'/.test(sync));

console.log(`\nt74 extra: covered the BoxCast attempt`);

console.log(`\nt74: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
