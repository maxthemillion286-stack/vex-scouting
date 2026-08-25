// t46 — auto-find of an event's stream: the paths that made it return nothing.
import handler from '../api/proxy.js';
let pass=0, fail=0;
const ok=(n,c,e)=>{c?(pass++,console.log('  ok   '+n)):(fail++,console.log('  FAIL '+n+(e?'\n         '+e:'')));};
const makeRes=()=>({statusCode:null,body:null,headers:{},setHeader(k,v){this.headers[k]=v},status(c){this.statusCode=c;return this},json(b){this.body=b;return this}});
const real=globalThis.fetch;
let n=0;
const SKU=(p='V5RC')=>`RE-${p}-24-${2000+(n++)}`;

async function run(sku, routes, q={}) {
  globalThis.fetch = async (url, opts) => {
    for (const [pat, fn] of routes) {
      if (url.includes(pat)) return fn(url, opts);
    }
    throw new Error('unrouted: ' + url);
  };
  const res = makeRes();
  await handler({ query: { path: 'streams:' + sku, ...q } }, res);
  return res.body;
}
const page = (html, status=200) => () => ({ ok: status<400, status, text: async()=>html, headers:{get:()=>null} });
const cfChallenge = page('<html><head><title>Just a moment...</title></head><body><div id="challenge-running"></div>' + 'x'.repeat(900) + '</body></html>');
const realPage = (extra) => page('<html><body>' + 'p'.repeat(600) + extra + '</body></html>');

console.log('t46 — stream auto-find');

// ── Cloudflare: the failure that looked like "event has no stream" ────────
{
  // Every strategy challenged => must report unreachable, not "no links"
  const out = await run(SKU(), [['', cfChallenge]]);
  ok('all-Cloudflare is reported as page-unreachable, not empty',
     out.ok === false && out.reason === 'page-unreachable', JSON.stringify(out));
}
{
  // The site blocks datacenter IPs (403) but a relay fetches from its own
  // address and succeeds. This is the real-world case for events.vex.com.
  const out = await run(SKU(), [
    ['r.jina.ai', realPage('<div id="webcast"><a href="https://www.youtube.com/watch?v=viaRelay12">Live</a></div>')],
    ['', page('', 403)]
  ]);
  ok('a relay recovers the page when the direct fetch is 403',
     out.ok === true && out.streams[0].url === 'https://www.youtube.com/watch?v=viaRelay12',
     JSON.stringify(out).slice(0, 200));
  ok('the relay used is reported', out.pageVia === 'jina', String(out.pageVia));
  ok('the reported page is the real URL, not the relay wrapper',
     /^https:\/\/events\.vex\.com\//.test(out.pageUrl || ''), out.pageUrl);
}
{
  // No Googlebot impersonation: it fails WAF reverse-DNS from a datacenter IP
  // and gets blocked harder than an honest browser string.
  const uas = [];
  await run(SKU(), [['', (url, opts) => { uas.push((opts.headers||{})['User-Agent']||''); return page('', 403)(); }]]);
  ok('no request claims to be Googlebot', !uas.some(u => /Googlebot/i.test(u)),
     uas.find(u => /Googlebot/i.test(u)) || '');
  ok('direct requests send full browser client hints',
     uas.some(u => /Chrome\/127/.test(u)), uas[0]);
}
{
  // If one relay is down the next must still be tried.
  const out = await run(SKU(), [
    ['corsproxy.io', realPage('<a href="https://www.youtube.com/watch?v=secondRel1">v</a>')],
    ['r.jina.ai', page('', 502)],
    ['', page('', 403)]
  ]);
  ok('a failing relay falls through to the next',
     out.ok === true && out.pageVia === 'corsproxy', JSON.stringify(out).slice(0, 160));
}

// ── program path derivation ───────────────────────────────────────────────
{
  const seen = [];
  for (const [sku, expect] of [
    ['RE-VIQRC-24-3001','vex-iq-competition'],
    ['RE-VURC-24-3002','vex-u-robotics-competition'],
    ['RE-V5RC-24-3003','vex-robotics-competition']
  ]) {
    const urls = [];
    await run(sku, [['', (url) => { urls.push(decodeURIComponent(url)); return realPage('')(); }]]);
    ok(`${sku} tries the ${expect} path first`,
       urls[0] === `https://events.vex.com/robot-competitions/${expect}/${sku}.html`,
       urls[0]);
  }
}

// ── channel resolution ────────────────────────────────────────────────────
{
  process.env.YOUTUBE_API_KEY = 'testkey';
  const out = await run(SKU(), [
    ['robotevents.com', realPage('<div id="webcast"><a href="https://www.youtube.com/@TexasVEX">Our channel</a></div>')],
    // Channel resolution is now channels.list + playlistItems.list +
    // videos.list — 3 units instead of the 400 the old search-based path cost.
    ['youtube/v3/channels', () => ({ ok:true, json: async()=>({ items:[
      { id:'UCtest123', contentDetails:{ relatedPlaylists:{ uploads:'UUtest123' } } }]}) })],
    ['youtube/v3/playlistItems', () => ({ ok:true, json: async()=>({ items:[
      { snippet:{ resourceId:{videoId:'day1vid1234'}, title:'Day 1', publishedAt:'2026-03-07T14:00:00Z' } },
      { snippet:{ resourceId:{videoId:'day2vid1234'}, title:'Day 2', publishedAt:'2026-03-08T14:00:00Z' } }
    ]}) })],
    ['youtube/v3/videos', () => ({ ok:true, json: async()=>({ items:[
      { id:'day1vid1234', snippet:{ title:'Day 1', description:'', publishedAt:'2026-03-07T14:00:00Z' },
        liveStreamingDetails:{ actualStartTime:'2026-03-07T14:00:00Z' } },
      { id:'day2vid1234', snippet:{ title:'Day 2', description:'', publishedAt:'2026-03-08T14:00:00Z' },
        liveStreamingDetails:{ actualStartTime:'2026-03-08T14:00:00Z' } }
    ]}) })]
  ], { start: '2026-03-07', end: '2026-03-08' });
  ok('a channel-only page resolves into real videos',
     out.ok === true && out.streams.length === 2, JSON.stringify(out));
  ok('resolved videos are oldest-first (day 1 before day 2)',
     out.streams[0].url.includes('day1vid1234') && out.streams[1].url.includes('day2vid1234'),
     JSON.stringify(out.streams.map(s=>s.url)));
  ok('publishedAt is passed through for per-day matching',
     out.streams[0].publishedAt === '2026-03-07T14:00:00Z', JSON.stringify(out.streams[0]));
}

// ── the reasons the UI needs to explain itself ────────────────────────────
{
  delete process.env.YOUTUBE_API_KEY;
  const out = await run(SKU(), [['robotevents.com',
    realPage('<a href="https://www.youtube.com/@SomeOrg">channel</a>')]],
    { start:'2026-03-07', end:'2026-03-07' });
  ok('channel found but no API key => channel-needs-yt-key',
     out.reason === 'channel-needs-yt-key', JSON.stringify(out));
  ok('the channel URL is reported back', (out.channels||[]).length === 1, JSON.stringify(out.channels));
}
{
  const out = await run(SKU(), [['robotevents.com', realPage('<p>nothing here</p>')]]);
  ok('a page with no links => no-links-on-page', out.reason === 'no-links-on-page', JSON.stringify(out));
}
{
  // VEX's own channel links are in the site chrome on every page
  const out = await run(SKU(), [['robotevents.com',
    realPage('<footer><a href="https://www.youtube.com/@VEXRobotics">VEX</a></footer>')]]);
  ok("the site's own channel links are ignored",
     (out.channels||[]).length === 0 && out.reason === 'no-links-on-page', JSON.stringify(out));
}

// ── direct video still wins over a channel, and costs no quota ────────────
{
  process.env.YOUTUBE_API_KEY = 'testkey';
  let searched = false;
  const out = await run(SKU(), [
    ['robotevents.com', realPage('<a href="https://www.youtube.com/watch?v=directvid12">v</a><a href="https://www.youtube.com/@Org">c</a>')],
    ['youtube/v3/', () => { searched = true; return { ok:true, json: async()=>({items:[]}) }; }]
  ], { start:'2026-03-07' });
  ok('a direct video is used as-is', out.streams[0].url === 'https://www.youtube.com/watch?v=directvid12');
  ok('no YouTube quota is spent when a direct video exists', searched === false);
}

// ── URL candidates ────────────────────────────────────────────────────────
{
  // The confirmed events.vex.com URL is the primary; robotevents.com is kept
  // for older events that still redirect.
  const out = await run(SKU(), [['robotevents.com',
    realPage('<a href="https://www.youtube.com/watch?v=fallback1234">v</a>')], ['', page('', 404)]]);
  ok('a 404 on the primary path falls through to the fallback host',
     out.ok === true && out.streams[0].url === 'https://www.youtube.com/watch?v=fallback1234',
     JSON.stringify(out).slice(0, 200));
  ok('the URL that worked is reported', /robotevents\.com/.test(out.pageUrl || ''), out.pageUrl);
  ok('the winning strategy is reported', !!out.pageVia, String(out.pageVia));
}
{
  const out = await run(SKU(), [['', page('', 404)]]);
  ok('when every candidate 404s, the attempts are reported',
     out.reason === 'page-unreachable' && Array.isArray(out.tried) && out.tried.length >= 4,
     JSON.stringify(out).slice(0, 200));
  ok('each attempt names its URL and status',
     /events\.vex\.com|robotevents\.com/.test(out.tried[0]) && /:\d{3}$/.test(out.tried[0]),
     out.tried[0]);
  ok('events.vex.com is tried first', /^events\.vex\.com/.test(out.tried[0] || ''), out.tried[0]);
  ok('robotevents.com is kept as a fallback',
     out.tried.some(t => t.includes('robotevents.com')));
  ok('the confirmed URL shape is the very first thing tried',
     (out.tried[0] || '').startsWith('events.vex.com/robot-competitions/vex-robotics-competition/'),
     out.tried[0]);
}

// ── the real page shape: links inside a #webcast section ──────────────────
{
  // Mirrors the live page: a #webcast section holding the stream link.
  const out = await run(SKU(), [['events.vex.com', realPage(
    '<div class="tab-pane" id="webcast"><h3>Webcast</h3>' +
    '<a href="https://www.youtube.com/watch?v=spacecity12&amp;t=0" target="_blank">Space City Stream</a>' +
    '</div>')]]);
  ok('a link in the #webcast section is found and prioritised',
     out.ok === true && out.streams[0].source === 'webcast-section' &&
     out.streams[0].url === 'https://www.youtube.com/watch?v=spacecity12&t=0',
     JSON.stringify(out.streams));
  ok('the page it came from is reported',
     /events\.vex\.com/.test(out.pageUrl || ''), out.pageUrl);
}
{
  // The page loads but carries no link — distinct from an unreachable page,
  // and the distinction is what tells us whether the links are JS-rendered.
  const out = await run(SKU(), [['events.vex.com', realPage('<div id="webcast">Webcast info coming soon</div>')]]);
  ok('a reachable page with no links reports no-links-on-page WITH a pageUrl',
     out.reason === 'no-links-on-page' && !!out.pageUrl, JSON.stringify(out).slice(0,200));
}

globalThis.fetch = real;
console.log(`\nt46: ${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
