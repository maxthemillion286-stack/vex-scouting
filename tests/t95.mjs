// t95 — the legal pages, and the link that has to reach them.
//
// The privacy policy is not decoration. The YouTube API terms require a client
// to publish one and link to it, and VEX Scout uses both the YouTube Data API
// (api/proxy.js) and the embedded player (index.html). A policy at a URL
// nobody links to does not satisfy that, so the link is as much of the
// deliverable as the page is.
//
// What this file guards:
//   · both pages exist, are well-formed, and are actually deployed
//   · the app links to them, from a foot that stays out of the way
//   · the disclosures still match what the code really does — if a future
//     change adds analytics, a cookie or a new third-party host, the policy
//     stops being true and these assertions go red
import fs from 'fs';
import { boot, settle } from './harness.mjs';
let pass = 0, fail = 0;
const ok = (n, c, e) => { c ? (pass++, console.log('  ok   ' + n)) : (fail++, console.log('  FAIL ' + n + (e ? '\n         ' + e : ''))); };

const idx = fs.readFileSync('../index.html', 'utf8');
const sw = fs.readFileSync('../sw.js', 'utf8');
const priv = fs.readFileSync('../privacy.html', 'utf8');
const terms = fs.readFileSync('../terms.html', 'utf8');
const legalCss = fs.readFileSync('../legal.css', 'utf8');
const idxCss = idx.slice(0, idx.indexOf('</style>'));

console.log('t95 — privacy policy, terms, and the link to them');

// ══ 1. The pages exist and are whole ════════════════════════════════════════
console.log('\n· the pages');
for (const [name, doc] of [['privacy.html', priv], ['terms.html', terms]]) {
  ok(`${name} is a document`, /^<!DOCTYPE html>/i.test(doc));
  ok(`${name} closes its html`, /<\/html>\s*$/.test(doc));
  ok(`${name} has a title`, /<title>[^<]+<\/title>/.test(doc));
  ok(`${name} is responsive`, /name="viewport"/.test(doc));
  // Tag balance — these are hand-written, and an unclosed div is invisible
  // until someone opens the page.
  for (const tag of ['div', 'p', 'ul', 'li']) {
    const open = (doc.match(new RegExp(`<${tag}[ >]`, 'g')) || []).length;
    const close = (doc.match(new RegExp(`</${tag}>`, 'g')) || []).length;
    ok(`${name} balances <${tag}>`, open === close, `${open} open, ${close} close`);
  }
}

// ══ 2. They ship ════════════════════════════════════════════════════════════
console.log('\n· deployed, not ignored');
{
  const ignore = fs.readFileSync('../.vercelignore', 'utf8')
    .split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
  for (const f of ['privacy.html', 'terms.html', 'legal.css']) {
    ok(`${f} is not in .vercelignore`, !ignore.includes(f), ignore.join(' '));
  }
}

// ══ 3. The app links to them ════════════════════════════════════════════════
console.log('\n· the link out of the app');
ok('index.html has a site foot', /<footer class="site-foot">/.test(idx));
ok('the foot links to the policy', /href="\/privacy\.html"/.test(idx));
ok('the foot links to the terms', /href="\/terms\.html"/.test(idx));
{
  // "Nowhere in the way": smallest type on the page, muted, no frame. If a
  // later change gives the foot a border or a fill it stops being a footnote
  // and starts being chrome.
  const rule = (idxCss.match(/\.site-foot \{([^}]*)\}/) || [])[1] || '';
  ok('the foot exists in CSS', !!rule);
  const size = parseInt((rule.match(/font-size: (\d+)px/) || [])[1] || '99', 10);
  ok('the foot is 10px or smaller', size <= 10, `${size}px`);
  ok('the foot is muted', /color: var\(--text-muted\)/.test(rule), rule);
  ok('the foot has no frame', !/border:/.test(rule) && !/background:/.test(rule), rule);
  ok('the foot sits clear of the content', /margin: \d\dpx/.test(rule), rule);
  // As low as it can go. On a short page — Scout before you have searched
  // anything — normal flow leaves the foot halfway up an empty screen, right
  // under the controls, where it reads as part of the form. Sticky at a full
  // viewport height pins it to the bottom, and does nothing on a long page.
  ok('the foot is pinned to the bottom of the viewport',
    /position: sticky/.test(rule) && /top: 100vh/.test(rule), rule);
  // The pin only reaches the bottom if body gives it a box to sink into.
  ok('body is at least a viewport tall', /^\s*body \{[^}]*min-height: 100vh/m.test(idxCss));
  // Sticky makes it a positioned element; the fixed background gradient sits
  // at z-index 0 and the container at 2, so the foot needs to be up there too.
  ok('the foot is above the background wash', /z-index: 2/.test(rule), rule);
}
// And it renders, in a real DOM, at the bottom of the body.
{
  const { win, stop } = await boot();
  await settle(win);
  const doc = win.document;
  const foot = doc.querySelector('footer.site-foot');
  ok('the foot is in the rendered page', !!foot);
  const links = foot ? [...foot.querySelectorAll('a')].map(a => a.getAttribute('href')) : [];
  ok('both links render', links.includes('/privacy.html') && links.includes('/terms.html'), links.join(' '));
  // Out of the way means AFTER everything. Nothing but the script tags may
  // follow it, or it has landed in the middle of the app.
  ok('the foot is the last thing in the body',
    !!foot && !doc.body.querySelector('footer.site-foot ~ *:not(script)'));
  // One line of two words. A foot that grows a menu is no longer out of the way.
  ok('the foot is one short line', !!foot && foot.textContent.replace(/\s+/g, ' ').trim().length < 30,
    foot && JSON.stringify(foot.textContent.trim()));
  // The panels above it must not have moved.
  ok('the tab panels are untouched',
    !!doc.getElementById('tab-scout') && !!doc.getElementById('tab-simulator'));
  ok('the foot did not land inside a panel', !!foot && !foot.closest('.tab-panel'));
  stop();
}

// ══ 4. One stylesheet, not two copies ═══════════════════════════════════════
console.log('\n· shared look');
for (const [name, doc] of [['privacy.html', priv], ['terms.html', terms]]) {
  ok(`${name} uses legal.css`, /href="\/legal\.css"/.test(doc));
  ok(`${name} has no inline <style>`, !/<style>/.test(doc));
}
ok('legal.css keeps prose on the body face at 1.5',
  /font-family: var\(--body\)/.test(legalCss) && /line-height: 1\.5/.test(legalCss));
ok('legal.css keeps headings on the display face',
  /h1 \{[^}]*font-family: var\(--display\)/.test(legalCss));
ok('a notice is still a left rule, not a box',
  /\.lede \{[^}]*border-left: 2px solid/.test(legalCss)
  && !/\.lede \{[^}]*background:/.test(legalCss));
// Two palettes, not sixteen: the pages follow the app's dark/light choice only.
ok('legal.css carries a light mode', /body\.light \{/.test(legalCss));
for (const [name, doc] of [['privacy.html', priv], ['terms.html', terms]]) {
  ok(`${name} reads the app's theme`, /localStorage\.getItem\('vex_theme'\)/.test(doc));
  ok(`${name} survives blocked storage`, /catch \(e\) \{\}/.test(doc));
  ok(`${name} only switches on light-`, /indexOf\('light-'\) === 0/.test(doc));
}

// ══ 5. The pages link back, and to each other ═══════════════════════════════
console.log('\n· navigation');
ok('privacy links home', /href="\/"/.test(priv));
ok('terms links home', /href="\/"/.test(terms));
ok('privacy links to terms', /href="\/terms\.html"/.test(priv));
ok('terms links to privacy', /href="\/privacy\.html"/.test(terms));

// ══ 6. The policy is still TRUE ═════════════════════════════════════════════
// This is the part that matters. A privacy policy is a claim about the code,
// and the code is what drifts.
console.log('\n· the disclosures match the code');
{
  const appSrc = idx.match(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/)[1];
  const proxy = fs.readFileSync('../api/proxy.js', 'utf8');

  // Claim: no analytics, no tracking.
  // Match the products, not the English words — "plausible" is a perfectly
  // ordinary adjective and proxy.js uses it in a comment about video matching.
  const trackers = /gtag\(|googletagmanager|google-analytics|plausible\.(io|js)|posthog|mixpanel|segment\.com|fbq\(|@vercel\/analytics|hotjar|clarity\.ms/i;
  ok('no analytics anywhere in the app', !trackers.test(idx), 'the "no tracking" section is now false');
  ok('no analytics in the proxy', !trackers.test(proxy));
  ok('privacy.html claims no tracking', /No Google Analytics/.test(priv));

  // Claim: the app sets no cookies of its own.
  ok('the app never touches document.cookie', !/document\.cookie/.test(idx),
    'the "sets no cookies" claim is now false');
  ok('privacy.html claims no cookies', /document\.cookie/.test(priv));

  // Claim: the third-party hosts listed are the third-party hosts used. Any
  // NEW external host the app contacts has to be added to the policy.
  const disclosed = ['fonts.googleapis.com', 'fonts.gstatic.com', 'youtube.com',
                     'vimeo.com', 'boxcast.tv', 'robotevents.com', 'vercel.com',
                     'events.vex.com', 'vexworlds.tv'];
  const seen = new Set();
  for (const m of idx.matchAll(/https:\/\/([a-z0-9.-]+)/g)) seen.add(m[1]);
  const undisclosed = [...seen].filter(h =>
    !disclosed.some(d => h === d || h.endsWith('.' + d) || h.includes(d.split('.')[0])));
  ok('every external host the page contacts is disclosed', undisclosed.length === 0,
    'add to privacy.html: ' + undisclosed.join(', '));

  // Claim: tokens stay on the server.
  ok('privacy.html covers the outbound links',
    /events\.vex\.com/.test(priv) && /vexworlds\.tv/.test(priv));
  ok('no API token is inlined in the page', !/AIza[0-9A-Za-z_-]{20,}/.test(idx));
  ok('privacy.html says keys stay server-side', /never reach your browser/.test(priv));

  // Claim: the listed browser storage is the browser storage used. These are
  // the keys index.html actually writes.
  for (const key of ['vex_theme', 'vex_active_tab', 'vex_offline_events', 'vex_rw_seen']) {
    ok(`${key} is real`, appSrc.includes(key));
  }
  ok('privacy.html covers offline saves', /saved for offline use/.test(priv));
  ok('privacy.html covers the Jumper', /Jumper/.test(priv));

  // The YouTube API terms want these named specifically.
  ok('privacy.html links the YouTube ToS', /youtube\.com\/t\/terms/.test(priv));
  ok('privacy.html links Google\'s privacy policy', /policies\.google\.com\/privacy/.test(priv));
  ok('privacy.html points at Google\'s permissions page',
    /myaccount\.google\.com\/permissions/.test(priv));

  // Terms: the two sentences the page exists for.
  ok('terms disclaims affiliation with VEX', /not (made by, )?affiliated with/i.test(terms)
    && /REC Foundation/.test(terms));
  ok('terms warns the predictions can be wrong', /confidently wrong/.test(terms));
  ok('terms disclaims warranty', /as is, with no warranty/.test(terms));
  ok('terms credits RobotEvents for the data', /RobotEvents API/.test(terms));
}

// ══ 7. The service worker does not serve the app under a legal URL ══════════
console.log('\n· offline behaviour');
ok('the index fallback is scoped to the app', /isApp \? '\/index\.html' : null/.test(sw),
  'an uncached offline hit on /privacy.html would render the whole app');
ok('the scope test is the root and index only',
  /const isApp = url\.pathname === '\/' \|\| url\.pathname === '\/index\.html'/.test(sw));

console.log(`\nt95: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
