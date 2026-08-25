// t56 — YouTube search fallback when the event page lists no stream.
import handler from '../api/proxy.js';
let pass=0, fail=0;
const ok=(n,c,e)=>{c?(pass++,console.log('  ok   '+n)):(fail++,console.log('  FAIL '+n+(e?'\n         '+e:'')));};
const makeRes=()=>({statusCode:null,body:null,headers:{},setHeader(k,v){this.headers[k]=v},status(c){this.statusCode=c;return this},json(b){this.body=b;return this}});
const real=globalThis.fetch;
let n=0;
const NAME = 'Space City Showdown Signature Event';
async function run(routes, q={}) {
  globalThis.fetch = async (url) => {
    for (const [pat, fn] of routes) if (url.includes(pat)) return fn(url);
    throw new Error('unrouted ' + url);
  };
  const res = makeRes();
  await handler({ query: { path: 'streams:RE-V5RC-25-' + (8100+n++),
    start: '2025-11-24', end: '2025-11-25', name: NAME, ...q } }, res);
  return res.body;
}
const emptyPage = () => ({ ok:true, status:200, headers:{get:()=>null},
  text: async () => '<html><body>'+'x'.repeat(700)+'<p>no stream listed</p></body></html>' });
const ytSearch = (items) => () => ({ ok:true, status:200, json: async()=>({ items }) });
// videos.list confirms candidates; without it every result is filtered out.
const ytVideos = (items) => () => ({ ok:true, status:200, json: async()=>({ items:
  items.map(it => ({ id: it.id.videoId,
    snippet: { title: it.snippet.title, description: '', publishedAt: it.snippet.publishedAt },
    liveStreamingDetails: { actualStartTime: it.snippet.publishedAt } })) }) });

console.log('t56 — YouTube search by event name');
process.env.YOUTUBE_API_KEY = 'k';

// ── a good match is accepted ─────────────────────────────────────────────
{
  const out = await run([
    ['events.vex.com', emptyPage], ['robotevents.com', emptyPage], ['r.jina.ai', emptyPage],
    ['allorigins', emptyPage], ['corsproxy', emptyPage],
    ['youtube/v3/search', ytSearch([
      { id:{videoId:'spacecity01'}, snippet:{ title:'Space City Showdown 2025 — Day 1', channelTitle:'Houston VEX', publishedAt:'2025-11-24T15:00:00Z' } }
    ])],
    ['youtube/v3/videos', ytVideos([
      { id:{videoId:'spacecity01'}, snippet:{ title:'Space City Showdown 2025 — Day 1', publishedAt:'2025-11-24T15:00:00Z' } }
    ])]
  ]);
  ok('a well-matched video is found', out.ok === true && out.streams[0].url.includes('spacecity01'), JSON.stringify(out.streams));
  ok('it is tagged as coming from search', out.streams[0].source === 'yt-search', JSON.stringify(out.streams[0]));
  ok('the match strength is reported', !!out.streams[0].match, JSON.stringify(out.streams[0]));
}

// ── a weak match is REJECTED, which is the whole point ───────────────────
{
  const out = await run([
    ['events.vex.com', emptyPage], ['robotevents.com', emptyPage], ['r.jina.ai', emptyPage],
    ['allorigins', emptyPage], ['corsproxy', emptyPage],
    ['youtube/v3/search', ytSearch([
      { id:{videoId:'unrelated01'}, snippet:{ title:'VEX Robotics Competition Highlights', channelTitle:'Random', publishedAt:'2025-11-24T15:00:00Z' } },
      { id:{videoId:'unrelated02'}, snippet:{ title:'How to build a drivetrain', channelTitle:'DIY', publishedAt:'2025-11-24T15:00:00Z' } }
    ])],
    ['youtube/v3/videos', ytVideos([])]
  ]);
  ok('a video sharing only generic words is rejected', out.ok === false, JSON.stringify(out.streams));
  ok('and the reason says so', out.reason === 'no-link-and-no-yt-match', out.reason);
}

// ── search only happens when the page yields nothing ─────────────────────
{
  let searched = false;
  const out = await run([
    ['events.vex.com', () => ({ ok:true, status:200, headers:{get:()=>null},
      text: async () => '<html><body>'+'x'.repeat(700)+'<div id="webcast"><a href="https://www.youtube.com/watch?v=onpage12345">v</a></div></body></html>' })],
    ['youtube/v3/search', () => { searched = true; return ytSearch([])(); }]
  ]);
  ok('a link on the page short-circuits the search', out.streams[0].url.includes('onpage12345') && !searched);
}

// ── no key, and no name ──────────────────────────────────────────────────
{
  delete process.env.YOUTUBE_API_KEY;
  const out = await run([['', emptyPage]]);
  ok('without a key the reason names it', out.reason === 'no-links-and-no-yt-key', out.reason);
  process.env.YOUTUBE_API_KEY = 'k';
}
{
  const out = await run([['', emptyPage]], { name: '' });
  ok('without an event name it falls back to the plain reason', out.reason === 'no-links-on-page', out.reason);
}
{
  // A name made only of stopwords is not distinctive enough to search on
  const out = await run([['', emptyPage], ['youtube/v3/search', ytSearch([])]],
    { name: 'VEX Robotics Competition High School Tournament' });
  ok('a name with no distinctive words is not searched', out.ok === false, JSON.stringify(out).slice(0,150));
}

globalThis.fetch = real;
console.log(`\nt56: ${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
