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
// VEX TV CAN be embedded now. rest.boxcast.com answered 200, so the platform
// is confirmed BoxCast, and BoxCast publishes a player at
// boxcast.tv/view-embed/<broadcast id>. What was said before was broader than
// what was true: the MEDIA is per-viewer signed HLS, so nothing stable can be
// pointed at directly — the embed page holds its own session, which is the
// problem it exists to solve. It still cannot be opened at a position.
ok('a known broadcast embeds through BoxCast',
  embed({ platform: 'vexworldstv', videoId: 'efkb0bx8283bgyqvm396', url: 'https://www.vexworlds.tv/#/broadcasts/efkb0bx8283bgyqvm396' }, 1200)
    === 'https://boxcast.tv/view-embed/efkb0bx8283bgyqvm396');
ok('the broadcast id is read out of the url when present',
  embed({ platform: 'vexworldstv', videoId: 'whatever', url: 'https://www.vexworlds.tv/#/broadcasts/ihw6kx3ipx1ot9b7aitr' }, 0)
    === 'https://boxcast.tv/view-embed/ihw6kx3ipx1ot9b7aitr');
ok('a CHANNEL still has no embed — it names ten parallel divisions',
  embed({ platform: 'vexworldstv', videoId: 'jmhkmkbdwsh3fg4pfoqn', url: REAL }, 1200) === null,
  'a channel is not a thing to play');
ok('no start parameter is invented on the embed',
  !/[?&#](t|start|startTime)=/.test(String(embed({ platform: 'vexworldstv', videoId: 'efkb0bx8283bgyqvm396', url: 'https://www.vexworlds.tv/#/broadcasts/efkb0bx8283bgyqvm396' }, 1200))),
  'BoxCast seek syntax is unobserved; a guess opens silently at zero');
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
ok('when it does embed, the position stays on screen beside it',
  /VEX TV plays here, but it can't be opened at a position/.test(player),
  'an embed that cannot seek is a downgrade without the timestamp');
ok('the channel-only case still explains why there is no player',
  /anchored to a VEX TV channel rather than one broadcast/.test(player));

// ── 7. Division, which is the whole answer at Worlds ──
ok('the team\'s division is read from its own matches',
  /const mineDiv = ctx\.allMatches\.find\(m => m\.mine && m\.divName\)/.test(src));
ok('every division match is tagged with its division name',
  /m\.__divId = d\.id; m\.__divName = d\.name \|\| null;/.test(idx));
ok('the ranking weights division above everything else',
  /if \(dm === true\) score \+= 1000;[\s\S]{0,60}score -= 1000;/.test(src),
  'ten Worlds broadcasts share a day, a grade and a start minute');
ok('the division match is word-bounded', /\\\\b\$\{d\.replace/.test(src),
  '"Arts" must not match inside "Smarts"');
ok('an unknown division abstains rather than guessing',
  /if \(!division\) return null;/.test(src));
ok('the division is stated in the panel', /this team is in <strong>\$\{ctx\.teamDivision\}<\/strong>/.test(src));
ok('an unreadable division warns instead of staying silent',
  /couldn't be read\. Check the stream below is the right division/.test(src));
ok('the debug report carries it', /teamDivision: rwTeamDivision/.test(src));
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


// ── 8. A wrong channel must say WHICH days it holds ──
// The first channel tried held 20 broadcasts, all Apr 23-24, against an event
// running Apr 25-27. Refusing was right; refusing without saying so was a dead
// end — it did not distinguish "this channel is wrong" from "the app is wrong",
// and gave no way forward.
ok('the days a channel covers are computed', /function rwVexDaysNote\(list\)/.test(src));
ok('the refusal names them', /rwVexDaysNote\(list\)/.test(sync));
ok('it also names the days the event needs', /This event runs \$\{rwEventDays\.join/.test(src));
ok('it says to go and find the right channel', /Find the VEX TV channel for/.test(sync));
ok('a channel with no dated broadcasts says that instead',
  /lists no dated broadcasts/.test(src));

const daysNote = new Function('list', 'rwEventDays', 'rwDayKey', `
  const days = [...new Set((list || [])
    .map(b => Date.parse(b.actualStartTime || ''))
    .filter(t => !isNaN(t))
    .map(t => rwDayKey(t)))].sort();
  if (!days.length) return 'none';
  return days.join(',');`);
const dayKey = new Function('return ' + src.slice(src.indexOf('function rwDayKey'), src.indexOf('function rwDayLabel')))();
ok('the real Worlds capture reduces to its two days',
  daysNote([
    { actualStartTime: '2026-04-23T13:15:00Z' },
    { actualStartTime: '2026-04-23T13:15:00Z' },
    { actualStartTime: '2026-04-24T13:15:00Z' }
  ], [], dayKey).split(',').length === 2,
  'twenty broadcasts, two distinct days');
ok('an undated list reports none', daysNote([{}], [], dayKey) === 'none');
ok('an empty list reports none', daysNote([], [], dayKey) === 'none');

console.log(`\nt74: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
