// t101 — the INFO tab and its trailer.
//
// The trailer is a standalone page in an iframe, not inline markup: its class
// names (.a, .up, .left, .fade…) are short and generic and would collide with
// the app's stylesheet the moment they shared a document.
//
// The part worth pinning is the loading contract, because all three halves of
// it fail silently:
//
//   · it must NOT load until the tab is first opened — otherwise every visitor
//     pays for a video they never asked for, on venue wifi
//   · leaving the tab must PAUSE it — a trailer playing behind the Tournament
//     tab is a battery drain nobody can see to stop
//   · coming back must RESUME, not reload — a reload restarts it from zero and
//     re-downloads it
//
// Driven in Chromium against a stub obeying the same postMessage contract:
// src null before opening, one request on open, ["pause"] on leaving,
// ["pause","play"] on return, and still one request.
import fs from 'fs';
import { boot, settle, FIXTURES } from './harness.mjs';
let pass = 0, fail = 0;
const ok = (n, c, e) => { c ? (pass++, console.log('  ok   ' + n)) : (fail++, console.log('  FAIL ' + n + (e ? '\n         ' + e : ''))); };

const idx = fs.readFileSync('../index.html', 'utf8');
const src = idx.match(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/)[1];
const css = idx.slice(0, idx.indexOf('</style>'));

console.log('t101 — the INFO tab');

// ══ 1. The tab is wired like every other one ═══════════════════════════════
console.log('\n· wiring');
ok('there is an INFO button', /data-tab="info" onclick="switchTab\('info'\)">INFO</.test(idx));
ok('it comes after SIMULATOR', idx.indexOf('data-tab="simulator"') < idx.indexOf('data-tab="info"'));
ok('there is a panel for it', /<section class="search-section tab-panel" id="tab-info">/.test(idx));
ok('the panel is inside the container, with the others',
  idx.indexOf('id="tab-info"') < idx.indexOf('<footer class="site-foot">'));
ok('the tab has a label for the back/forward stack', /info: 'Info'/.test(src));
ok('and is allowed to be the remembered tab',
  /\['scout','skills','tournament','rewatch','simulator','info'\]/.test(src));

// ══ 2. An iframe, deliberately ═════════════════════════════════════════════
console.log('\n· an iframe, not inline markup');
ok('the trailer is framed', /<iframe id="infoTrailer"/.test(idx));
ok('it names itself for a screen reader', /title="VEX Scout trailer"/.test(idx));
ok('its source is held back in data-src, not src',
  /data-src="\/trailer\.html"/.test(idx) && !/<iframe id="infoTrailer"[^>]*\ssrc=/.test(idx),
  'an src attribute in the markup would load the video for every visitor');
ok('it may go fullscreen', /allowfullscreen/.test(idx));

// ══ 3. The loading contract ════════════════════════════════════════════════
console.log('\n· load once, pause on leaving, resume on return');
ok('switchTab tells the trailer about every tab change', /\n  infoTrailerFor\(tabName\);/.test(src));
ok('the handler exists', /function infoTrailerFor\(tabName\) \{/.test(src));
{
  const fn = src.slice(src.indexOf('function infoTrailerFor(tabName) {'),
                       src.indexOf('function positionTabIndicator()'));
  ok('it survives the trailer not being on the page', /if \(!f\) return;/.test(fn));
  ok('it loads from data-src the first time only',
    /if \(!f\.getAttribute\('src'\)\) f\.setAttribute\('src', f\.dataset\.src\);/.test(fn));
  ok('and otherwise resumes rather than reloading', /vsTrailer: 'play'/.test(fn));
  ok('leaving pauses it', /vsTrailer: 'pause'/.test(fn));
  ok('it says nothing to a frame that never loaded',
    /\} else if \(f\.getAttribute\('src'\)\) \{/.test(fn),
    'posting into an unloaded frame is a no-op at best and an error at worst');
  ok('the message is addressed to this origin, not "*"',
    (fn.match(/location\.origin/g) || []).length === 2, 'both postMessage calls must be scoped');
  ok('a frame that is not ready cannot break the tab switch',
    (fn.match(/try \{/g) || []).length === 2 && (fn.match(/catch \(e\) \{\}/g) || []).length === 2);
}

// ══ 4. The box the iframe sits in ══════════════════════════════════════════
console.log('\n· geometry');
{
  const rule = (css.match(/\.info-trailer \{([^}]*)\}/) || [])[1] || '';
  ok('.info-trailer exists', !!rule);
  ok('it is a ratio box — an iframe cannot size itself to its content',
    /padding-bottom: calc\(56\.25% \+ 64px\)/.test(rule) && /height: 0/.test(rule), rule);
  ok('56.25% is the 16:9 video, 64px the trailer\'s own control bar',
    /max-width: 1100px/.test(rule), rule);
  ok('past the max-width the ratio is pinned rather than growing',
    /@media \(min-width: 1101px\) \{ \.info-trailer \{ padding-bottom: calc\(1100px \* 0\.5625 \+ 64px\)/.test(css));
  ok('the iframe fills the box with no border',
    /\.info-trailer iframe \{[^}]*position: absolute[^}]*inset: 0[^}]*border: 0/.test(css));
  ok('and carries the trailer\'s own backdrop, so there is no white flash',
    /\.info-trailer iframe \{[^}]*background: #050506/.test(css));
  ok('the blurb is prose: body measure and leading',
    /\.info-blurb \{[^}]*max-width: 68ch[^}]*line-height: 1\.5/.test(css));
}

// ══ 5. Driven — the tab opens, and nothing else moved ══════════════════════
console.log('\n· driven');
{
  const { win, errors, stop } = await boot();
  await settle(win, 400);
  const doc = win.document;
  const frame = () => doc.getElementById('infoTrailer');

  ok('the trailer is in the page', !!frame());
  ok('but unloaded until the tab is opened', frame().getAttribute('src') === null,
    String(frame().getAttribute('src')));

  win.switchTab('info'); await settle(win, 300);
  ok('the INFO panel becomes the active one',
    doc.getElementById('tab-info').classList.contains('active'));
  ok('and its button is the active one',
    doc.querySelector('.tab-btn.active').dataset.tab === 'info');
  ok('opening the tab sets the source', frame().getAttribute('src') === '/trailer.html',
    String(frame().getAttribute('src')));
  ok('the blurb is there to read', /Scout any team or compare several side by side/.test(
    doc.getElementById('tab-info').textContent));

  // Leaving and returning must not re-set the src — that would reload it.
  win.switchTab('scout'); await settle(win, 200);
  win.switchTab('info'); await settle(win, 200);
  ok('returning does not reload it', frame().getAttribute('src') === '/trailer.html');
  ok('the other tabs still switch', (win.switchTab('tournament'),
    doc.getElementById('tab-tournament').classList.contains('active')));
  ok('nothing threw', errors.length === 0, errors.join('\n'));
  stop();
}

// ══ 6. The trailer itself ══════════════════════════════════════════════════
// The iframe's src is only as good as the file behind it. This is the check
// that would have caught shipping the tab without the trailer.
console.log('\n· trailer.html');
{
  ok('the file the iframe points at exists', fs.existsSync('../trailer.html'));
  const tr = fs.readFileSync('../trailer.html', 'utf8');
  ok('it is a whole document of its own',
    /^<!doctype html>/i.test(tr) && /<\/html>\s*$/.test(tr));
  ok('it is deployed, not ignored',
    !fs.readFileSync('../.vercelignore', 'utf8').split('\n')
      .map(l => l.trim()).includes('trailer.html'));

  // Both halves of the contract have to exist, or the tab's pause is a no-op
  // that nothing reports.
  ok('it listens for the app\'s messages', /vsTrailer/.test(tr));
  ok('it honours both pause and play',
    /d\.vsTrailer==='pause'/.test(tr) && /d\.vsTrailer==='play'/.test(tr));
  ok('and only from this origin',
    /e\.origin!==location\.origin/.test(tr),
    'a frame that takes messages from anywhere takes them from anyone');

  // The 64px in .info-trailer is the control bar plus the gap above it. If the
  // trailer ever restyles either, the ratio box is wrong and the video is
  // cropped or floating — measured in Chromium at 54 and 10.
  const bar = (tr.match(/\.bar\{height:(\d+)px\}/) || [])[1];
  const gap = (tr.match(/\.player\{[^}]*gap:(\d+)px/) || [])[1];
  ok('its control bar is still 54px', bar === '54', String(bar));
  ok('and still sits 10px below the frame', gap === '10', String(gap));
  ok('...which is the 64px the app reserves for it',
    Number(bar) + Number(gap) === 64, `${bar} + ${gap}`);

  // The app frames it rather than inlining it because these would collide.
  ok('its class names are the generic ones that forced an iframe',
    /\.a\{/.test(tr) && /\.up\{/.test(tr) && /\.left\{/.test(tr));

  // It reaches Google Fonts on its own, so t95's disclosure scan covers it.
  ok('t95 scans the trailer for undisclosed hosts',
    /for \(const page of \[idx, fs\.readFileSync\('\.\.\/trailer\.html', 'utf8'\)\]\)/
      .test(fs.readFileSync('./t95.mjs', 'utf8')));
}

// ══ 7. The three release markers still agree ═══════════════════════════════
// t58 owns this, but a new tab is exactly the kind of change that ships with
// one of the three forgotten.
console.log('\n· release');
{
  const app = (idx.match(/const APP_BUILD = '([^']+)'/) || [])[1];
  const sw = fs.readFileSync('../sw.js', 'utf8');
  const cache = (sw.match(/const CACHE_NAME = 'vex-scout-([^']+)'/) || [])[1];
  const proxy = (fs.readFileSync('../api/proxy.js', 'utf8')
    .match(/const PROXY_BUILD = '([^']+)'/) || [])[1];
  ok('all three markers agree', app === proxy && proxy === cache, `${app} / ${proxy} / ${cache}`);
}

console.log(`\nt101: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
