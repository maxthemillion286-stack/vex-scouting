// t42 — proxy.js `streams:<SKU>` route: URL extraction correctness.
//
// Covers the two bugs found while testing auto-find:
//   (a) `&amp;` was decoded AFTER matching, so URLs truncated at the `;`
//   (b) escaped-slash URLs (https:\/\/) inside inline JSON were never matched
//
// Runs the real exported handler with fetch stubbed, so the assertions cover
// the shipped code path rather than a copy of the regex.

import handler from '../api/proxy.js';

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '\n         ' + extra : '')); }
};

// Minimal Vercel req/res doubles
function makeRes() {
  const res = {
    statusCode: null, body: null, headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; }
  };
  return res;
}

const realFetch = globalThis.fetch;
// The scraper rejects anything under 500 chars as a Cloudflare stub, so
// fixtures are padded to look like a real page.
const PAD = '<div class="pad">' + 'x'.repeat(700) + '</div>';
function stubPage(html) {
  globalThis.fetch = async () => ({
    ok: true, status: 200,
    text: async () => '<html><body>' + PAD + html + '</body></html>',
    headers: { get: () => null }
  });
}

// Each call needs a distinct SKU — the route caches per SKU for 5 minutes and
// a reused SKU would silently serve the previous fixture's result.
let n = 0;
async function scrape(html) {
  stubPage(html);
  const sku = `RE-V5RC-24-${1000 + (n++)}`;
  const res = makeRes();
  await handler({ query: { path: 'streams:' + sku } }, res);
  return res.body;
}

console.log('t42 — stream link extraction');

// ── (a) ampersand entities ────────────────────────────────────────────────
{
  const out = await scrape(
    `<div id="webcast"><a href="https://www.youtube.com/watch?v=dQw4w9WgXcQ&amp;t=90">Watch</a></div>`
  );
  const u = (out.streams[0] || {}).url;
  ok('&amp; does not truncate the URL',
     u === 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=90',
     'got: ' + u);
}

{
  // Numeric and hex entity forms both appear in the wild
  const out = await scrape(
    `<a href="https://www.youtube.com/watch?v=abcdefghijk&#38;t=42">a</a>`
  );
  ok('numeric &#38; decodes to &',
     (out.streams[0] || {}).url === 'https://www.youtube.com/watch?v=abcdefghijk&t=42',
     'got: ' + (out.streams[0] || {}).url);
}

// ── (b) escaped slashes in inline JSON ────────────────────────────────────
{
  const out = await scrape(
    `<script>window.__DATA__ = {"webcast":"https:\\/\\/www.youtube.com\\/watch?v=JSONvid1234"};</script>`
  );
  ok('escaped-slash URL inside inline JSON is found',
     out.ok === true &&
     out.streams.some(s => s.url === 'https://www.youtube.com/watch?v=JSONvid1234'),
     'got: ' + JSON.stringify(out.streams));
}

{
  // Both bugs at once: escaped slashes AND a JSON-escaped ampersand
  const out = await scrape(
    `<script>var x = "https:\\/\\/youtu.be\\/SHORTid1234\\u0026feature=share";</script>`
  );
  ok('escaped slashes + \\u0026 together',
     out.streams.some(s => s.url === 'https://youtu.be/SHORTid1234&feature=share'),
     'got: ' + JSON.stringify(out.streams));
}

// ── ordering, dedup, and the untouched behaviour ──────────────────────────
{
  const out = await scrape(`
    <p>Random link https://www.youtube.com/watch?v=elsewhere12</p>
    <div class="panel webcast-panel">
      <a href="https://www.youtube.com/watch?v=inwebcast99&amp;t=5">Division A</a>
    </div>
  `);
  const wc = out.streams.find(s => s.source === 'webcast-section');
  ok('webcast-section link is found and labelled',
     !!wc && wc.url === 'https://www.youtube.com/watch?v=inwebcast99&t=5',
     'got: ' + JSON.stringify(out.streams));
  ok('webcast-section link is ranked first',
     out.streams[0] && out.streams[0].source === 'webcast-section',
     'got: ' + JSON.stringify(out.streams.map(s => s.source)));
}

{
  const dup = 'https://www.youtube.com/watch?v=dupdupdup12';
  const out = await scrape(`<a href="${dup}">1</a><a href="${dup}&amp;t=0">2</a><a href="${dup}">3</a>`);
  const exact = out.streams.filter(s => s.url === dup);
  ok('identical URLs are de-duplicated', exact.length === 1,
     'got: ' + JSON.stringify(out.streams.map(s => s.url)));
}

{
  const out = await scrape(`<a href="https://vimeo.com/event/1234567">Stream</a>`);
  ok('vimeo event links are recognised',
     out.ok === true && out.streams[0].url === 'https://vimeo.com/event/1234567',
     'got: ' + JSON.stringify(out.streams));
}

{
  const out = await scrape(`<p>No stream here, sorry.</p>`);
  ok('a page with no links reports ok:false', out.ok === false && out.streams.length === 0,
     'got: ' + JSON.stringify(out));
}

{
  // Trailing punctuation from surrounding prose must not end up in the URL
  const out = await scrape(`<p>Watch at https://youtu.be/trailingdot1.</p>`);
  ok('trailing sentence punctuation is trimmed',
     out.streams[0].url === 'https://youtu.be/trailingdot1',
     'got: ' + (out.streams[0] || {}).url);
}

// ── guard rails ───────────────────────────────────────────────────────────
{
  const res = makeRes();
  await handler({ query: { path: 'streams:NOT-A-SKU' } }, res);
  ok('malformed SKU is rejected', res.statusCode === 400 && res.body.reason === 'bad-sku',
     'got: ' + res.statusCode + ' ' + JSON.stringify(res.body));
}

{
  globalThis.fetch = async () => ({ ok: false, status: 404, text: async () => '', headers: { get: () => null } });
  const res = makeRes();
  await handler({ query: { path: 'streams:RE-V5RC-24-9999' } }, res);
  ok('a 404 event page degrades to ok:false, not a throw',
     res.statusCode === 200 && res.body.ok === false && res.body.reason === 'page-unreachable',
     'got: ' + JSON.stringify(res.body));
}

globalThis.fetch = realFetch;

console.log(`\nt42: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
