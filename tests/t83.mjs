// t83 — storage that cannot take the page down, and a boot that cannot be
// cancelled by its first bad step.
//
// t82 drives these end to end; this one pins the shape, because the failure
// mode is silent and the temptation to write `localStorage.getItem(...)`
// inline is permanent.
//
// The bug: window.onload was one unguarded sequence, and its second step read
// localStorage for the saved theme. Safari private browsing, "block all
// cookies", and managed school devices throw a SecurityError on ANY access to
// it — read included. So on those browsers onload died at line two and
// everything after it never ran: no tab restore, no service worker, and no
// enhanceAllSelects(), which is why all twelve dropdowns rendered as raw
// native controls. The page looked broken and said nothing.
//
// Two rules come out of it:
//   1. No bare localStorage outside the guards.
//   2. No step of the boot may cancel another. They do not depend on each
//      other, so nothing that throws in one should reach the next.
import fs from 'fs';
let pass = 0, fail = 0;
const ok = (n, c, e) => { c ? (pass++, console.log('  ok   ' + n)) : (fail++, console.log('  FAIL ' + n + (e ? '\n         ' + e : ''))); };
const idx = fs.readFileSync('../index.html', 'utf8');
const src = idx.match(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/)[1];

console.log('t83 — guarded storage, uncancellable boot');

// ── 1. The guards exist and do the right thing ──
ok('lsGet returns null rather than throwing', /const lsGet = \(k\) => \{ try \{ return localStorage\.getItem\(k\); \} catch \(e\) \{ return null; \} \};/.test(src));
ok('lsSet reports whether it worked', /const lsSet = \(k, v\) => \{ try \{ localStorage\.setItem\(k, v\); return true; \} catch \(e\) \{ return false; \} \};/.test(src),
  'the match cache needs to know a write failed so it can purge and move on');
ok('lsRemove is guarded too', /const lsRemove = \(k\) => \{ try \{ localStorage\.removeItem\(k\); \} catch \(e\) \{\} \};/.test(src));
ok('a prefix purge exists for the quota case', /const lsPurgePrefix = \(prefix\) =>/.test(src));
ok('the purge is itself guarded — .length throws in the same browsers',
  /lsPurgePrefix[\s\S]{0,320}catch \(e\) \{\}/.test(src));
ok('the reason is written down where the next person will read it',
  /throw a SecurityError on ANY access/.test(src));

const lsGet = new Function('localStorage', 'return (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } };')();
const lsSet = new Function('localStorage', 'return (k, v) => { try { localStorage.setItem(k, v); return true; } catch (e) { return false; } };')();
const boom = { getItem() { throw new Error('SecurityError'); }, setItem() { throw new Error('SecurityError'); } };
const fine = { _v: {}, getItem(k) { return this._v[k] ?? null; }, setItem(k, v) { this._v[k] = v; } };
ok('a refusing store reads as null, not an exception', lsGet.call(null, 'x') !== undefined);
ok('a working store still reads through', new Function('s', "return (function(k){try{return s.getItem(k)}catch(e){return null}})")(fine)('nope') === null);
ok('a refused write reports false', (function () { try { boom.setItem('a', 'b'); return true; } catch (e) { return false; } })() === false);

// ── 2. Nothing bare is left ──
const bare = src.split('\n')
  .map((l, i) => [i + 1, l])
  .filter(([, l]) => /localStorage\.(getItem|setItem|removeItem)/.test(l))
  .filter(([, l]) => !/const ls(Get|Set|Remove) =/.test(l) && !/lsPurgePrefix/.test(l));
// The three helpers and the purge loop are the only places allowed to touch it.
const allowed = src.slice(src.indexOf('const lsGet ='), src.indexOf('const lsPurgePrefix') + 400);
const outside = bare.filter(([, l]) => !allowed.includes(l.trim()));
ok('no bare localStorage access outside the guards', outside.length === 0,
  outside.map(([n, l]) => n + ': ' + l.trim()).join('\n         '));

// ── 3. The boot cannot be cancelled by one bad step ──
ok('a step runner exists', /function bootStep\(what, fn\)/.test(src));
ok('it catches and carries on', /bootStep[\s\S]{0,200}try \{ fn\(\); \} catch \(e\) \{/.test(src));
ok('a failed step is recorded, not swallowed silently',
  /vsNote\('boot', what \+ ': '/.test(src),
  'it must reach the debug panel — DevTools are blocked on this site');

const onload = src.slice(src.indexOf('window.onload = () => {'), src.indexOf('// ── THEME ──'));
for (const step of ['badge', 'seasons', 'enter-key handlers', 'theme', 'restore tab',
                    'tab indicator', 'styled dropdowns', 'service worker']) {
  ok(`the ${step} step is guarded`, new RegExp("bootStep\\('" + step.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&') + "'").test(onload));
}
ok('nothing in onload runs outside a guarded step',
  !/^\s{2}(?!bootStep|if \('serviceWorker'|\/\/|\}|$)\S/m.test(onload.replace(/window\.onload = \(\) => \{\n/, '')),
  onload.split('\n').filter(l => /^  [a-z]/.test(l) && !/^  bootStep|^  if \(/.test(l)).join(' | '));

// The behaviour itself: one throwing step must not stop the rest.
const ran = [];
const bootStep = (what, fn) => { try { fn(); } catch (e) { ran.push('!' + what); } };
bootStep('a', () => ran.push('a'));
bootStep('b', () => { throw new Error('nope'); });
bootStep('c', () => ran.push('c'));
ok('a step that throws does not stop the ones after it',
  ran.join(',') === 'a,!b,c', ran.join(','));

// ── 4. Every tournament sub-view keeps the nav ──
// The bracket was the one that did not, so opening it meant searching the
// event again to get anywhere else.
for (const v of ['teams', 'matches', 'skills', 'awards', 'bracket', 'picklist', 'team']) {
  ok(`the ${v} view renders the nav`, new RegExp("tournamentNav\\('" + v + "'\\)").test(src));
}
// The no-elims path used to say "Elimination bracket not available" and stop.
// v66 projects the bracket from the seeds instead, so the marker moved — the
// thing being checked is still that this path keeps the nav.
ok('the bracket renders it on the empty path too — the case most likely to be hit',
  /if \(totalElims === 0\) \{[\s\S]{0,1600}tournamentNav\('bracket'\)/.test(src));
ok('...and that path projects a bracket rather than dead-ending',
  /Eliminations have not started — projected from the seeds/.test(src));
ok('the bracket marks itself as the current view like its siblings',
  /async function renderBracketView\(\) \{\s*\n\s*tournamentView = 'bracket';/.test(src));

console.log(`\nt83: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
