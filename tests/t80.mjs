// t80 — the app diagnoses itself, and a reload can actually be forced.
//
// Two things asked for directly: "I don't think ctrl shift R is hard
// reloading", and "instead of me telling you over and over that it didn't
// work, add something to debug or ask specific questions to actually get this
// fixed".
//
// Both are fair, and the second describes a loop this project had fallen into:
// ship a fix, hear "it didn't work", ask for a capture, read the JSON, find
// the real cause was something else entirely. Every round cost a release. The
// information was always in the report — it just needed reading, and the thing
// best placed to read it is the code that produced it.
//
// On the reload: Ctrl+Shift+R bypasses the HTTP cache but NOT a service worker
// that has already claimed the page, and not the proxy's own 24h answer cache.
// Since v41 the proxy cache is keyed on the lookup version rather than the
// release — deliberately, so a deploy stops re-billing every event's YouTube
// search — which means nothing invalidates it for a day. That has to be a
// button, or a shipped fix is invisible until tomorrow.
import fs from 'fs';
let pass = 0, fail = 0;
const ok = (n, c, e) => { c ? (pass++, console.log('  ok   ' + n)) : (fail++, console.log('  FAIL ' + n + (e ? '\n         ' + e : ''))); };
const idx = fs.readFileSync('../index.html', 'utf8');
const src = idx.match(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/)[1];

console.log('t80 — self-check, forced refresh, hard reset');

// ── 1. The self-check exists and states verdicts ──
const fn = src.slice(src.indexOf('function vsSelfCheck'), src.indexOf('function rwCopyDiag'));
ok('the self-check exists', fn.length > 500);
ok('it is rendered above the raw JSON', /const checks = vsSelfCheck\(\);/.test(src));
ok('every line carries a state', /rw-check rw-check-\$\{c\.state\}/.test(src));
ok('the states are styled', /\.rw-check-fail \.rw-check-tag/.test(idx) && /\.rw-check-pass \.rw-check-tag/.test(idx));
ok('it cannot take the panel down with it',
  /The self-check itself threw/.test(fn), 'a diagnostic that crashes diagnoses nothing');

// ── 2. It checks the things that have actually gone wrong ──
ok('build agreement between app and proxy', /One of them didn't deploy/.test(fn));
ok('a stale service worker, and that Ctrl+Shift+R will not fix it',
  /Ctrl\+Shift\+R does NOT replace it/.test(fn));
ok('an answer computed by an older build — i.e. a cached one',
  /you're seeing a cached result/.test(fn));
ok('a missing RobotEvents token', /No RobotEvents token is configured/.test(fn));
ok('a missing YouTube key', /YOUTUBE_API_KEY is not set/.test(fn));
ok('quota exhaustion, and that it is not a verdict about the event',
  /this is not a verdict about the event/.test(fn));
ok('a YouTube error that is NOT quota is called out separately',
  /That's a server or key problem, not a matching problem/.test(fn));
ok('what auto-find returned, and by which route', /Auto-find returned \$\{j\.streams\.length\}/.test(fn));
ok('whether channel expansion ran and which days it covered',
  /Channel expansion \$\{j\.expand\.ran/.test(fn));
ok('the VEX TV case is named rather than left as a mystery',
  /the Jumper can't discover VEX TV on its own/.test(fn));
ok('the team division, when several exist', /This team is in the \$\{da\.teamDivision\} division/.test(fn));
ok('a division that could not be read is a warning, not silence',
  /the stream picked may be another field/.test(fn));
ok('every day is reported individually', /for \(const d of da\.byDay\)/.test(fn));
ok('a day that synced says so', /: synced to \$\{d\.calVideoId\}/.test(fn));
ok('a day that picked but failed says why', /a broadcast was picked but not synced/.test(fn));
ok('a case needing a human says exactly what to send',
  (fn.match(/Send me this (whole )?block/g) || []).length >= 2,
  'the ask has to be specific or it costs another round');

// The three states must all be reachable.
for (const st of ['pass', 'warn', 'fail']) {
  ok(`the ${st} state is used`, new RegExp(`add\\('${st}'`).test(fn));
}

// ── 3. Reporting a problem is one action ──
ok('a copy button exists', /onclick="rwCopyDiag\(this\)"/.test(src));
ok('it copies the self-check AND the report',
  /selfCheck: vsSelfCheck\(\), report: vsDebugReport\(\)/.test(src));
ok('it falls back to selecting the text when the clipboard is refused',
  /el\.value = text; el\.select\(\)/.test(src));

// ── 4. A fresh lookup can be forced, but is never automatic ──
ok('a re-check button exists', /onclick="rwRecheckStreams\(\)"/.test(src));
ok('it sets the flag and reloads the event', /rwForceRefresh = true;[\s\S]{0,200}rewatchSelectEvent\(ctx\.eventId\)/.test(src));
ok('it clears the memo so the event is genuinely refetched', /rwMemoReset\(ctx\.eventId\)/.test(src));
ok('the buster is opt-in, never unconditional',
  /\(\(rwDebugOn\(\) \|\| rwForceRefresh\) \? `&_t=\$\{Date\.now\(\)\}` : ''\)/.test(src),
  'busting on every lookup is the largest quota leak there is (§3)');
ok('no lookup busts the cache unconditionally',
  !/&_t=\$\{Date\.now\(\)\}`\s*\+/.test(src.replace(/\(\(rwDebugOn\(\) \|\| rwForceRefresh\) \? `&_t=\$\{Date\.now\(\)\}` : ''\)/g, '')
     .replace(/path=diag&_t=\$\{Date\.now\(\)\}/g, '')));

// ── 5. A hard reset that actually resets ──
const reset = src.slice(src.indexOf('async function vsHardReset'), src.indexOf('function vsDebugReport'));
ok('a hard reset button exists', /onclick="vsHardReset\(\)"/.test(src));
ok('it unregisters every service worker', /getRegistrations\(\)[\s\S]{0,120}r\.unregister\(\)/.test(reset));
ok('it deletes every cache', /caches\.keys\(\)[\s\S]{0,120}caches\.delete\(k\)/.test(reset));
ok('it changes the url so the document itself cannot come from cache',
  /searchParams\.set\('fresh'/.test(reset));
ok('each step is independently guarded', (reset.match(/catch \(e\) \{\}/g) || []).length >= 2,
  'a browser refusing one step must not skip the reload');
// The reasoning lives in the comment above the declaration, so this reads the
// whole source rather than the sliced body.
ok('it explains why Ctrl+Shift+R is not enough',
  /bypasses the HTTP cache but NOT a service worker/.test(src));

console.log(`\nt80: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
