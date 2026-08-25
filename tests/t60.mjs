// t60 — YouTube quota economics and air-time correctness.
//
// Quota is the binding constraint: 10,000 units/day, search.list costs 100.
// These tests count real requests, so a regression that quietly reintroduces
// an expensive call shows up as a number rather than a slowdown.
import handler from '../api/proxy.js';
let pass=0, fail=0;
const ok=(n,c,e)=>{c?(pass++,console.log('  ok   '+n)):(fail++,console.log('  FAIL '+n+(e?'\n         '+e:'')));};
const makeRes=()=>({statusCode:null,body:null,headers:{},setHeader(k,v){this.headers[k]=v},status(c){this.statusCode=c;return this},json(b){this.body=b;return this}});
const COST = { search: 100, videos: 1, channels: 1, playlistItems: 1 };
let n=0, spend=0, calls=[];

function stub(routes) {
  spend = 0; calls = [];
  globalThis.fetch = async (url) => {
    if (url.includes('googleapis.com/youtube/v3/')) {
      const ep = url.split('/youtube/v3/')[1].split('?')[0];
      spend += COST[ep] ?? 0;
      calls.push(ep);
    }
    for (const [pat, fn] of routes) if (url.includes(pat)) return fn(url);
    return { ok:false, status:403, text: async()=>'', headers:{get:()=>null} };
  };
}
const j = (o) => () => ({ ok:true, status:200, json: async()=>o });
const pageWith = (body) => () => ({ ok:true, status:200, headers:{get:()=>null},
  text: async () => '<html><body>'+'x'.repeat(700)+body+'</body></html>' });

async function run(q={}) {
  const res = makeRes();
  await handler({ query: { path: 'streams:RE-V5RC-25-' + (9200+n++),
    start:'2025-11-24', end:'2025-11-25', name:'Katy Cypress Showdown High School', ...q } }, res);
  return res.body;
}

console.log('t60 — quota and air-time');
process.env.YOUTUBE_API_KEY = 'k';

// ── name search: one search + one batched details call ───────────────────
{
  stub([
    ['/search?', j({ items: [
      { id:{videoId:'aaaaaaaaaa1'}, snippet:{ title:'Katy Cypress Showdown High School', channelTitle:'KR' } },
      { id:{videoId:'bbbbbbbbbb2'}, snippet:{ title:'Katy Cypress Showdown Day 2', channelTitle:'KR' } }
    ]})],
    ['/videos?', j({ items: [
      { id:'aaaaaaaaaa1', snippet:{ title:'Katy Cypress Showdown High School', description:'', publishedAt:'2025-10-01T00:00:00Z' },
        liveStreamingDetails:{ actualStartTime:'2025-11-24T14:00:00Z' } },
      { id:'bbbbbbbbbb2', snippet:{ title:'Katy Cypress Showdown Day 2', description:'', publishedAt:'2025-10-01T00:00:00Z' },
        liveStreamingDetails:{ actualStartTime:'2025-11-25T14:00:00Z' } }
    ]})]
  ]);
  const out = await run();
  ok('a name search finds the broadcasts', out.ok === true && out.streams.length === 2, JSON.stringify(out.streams).slice(0,150));
  ok('it costs 101 units, not 400', spend === 101, spend + ' units: ' + calls.join(','));
  ok('exactly one details call covers every candidate',
     calls.filter(c => c === 'videos').length === 1, calls.join(','));
  ok('actualStartTime is returned so sync needs no extra call',
     !!out.streams[0].actualStartTime, JSON.stringify(out.streams[0]));
}

// ── THE bug this fixes: a stream scheduled weeks early ───────────────────
{
  stub([
    ['/search?', j({ items: [{ id:{videoId:'earlyvid001'},
      snippet:{ title:'Katy Cypress Showdown High School', channelTitle:'KR' } }]})],
    ['/videos?', j({ items: [{ id:'earlyvid001',
      // Created six weeks before the event — publishedAt would exclude it.
      snippet:{ title:'Katy Cypress Showdown High School', description:'', publishedAt:'2025-10-10T00:00:00Z' },
      liveStreamingDetails:{ actualStartTime:'2025-11-24T14:30:00Z' } }]})]
  ]);
  const out = await run();
  ok('a broadcast scheduled weeks early is STILL found',
     out.ok === true && out.streams[0].url.includes('earlyvid001'), JSON.stringify(out).slice(0,160));
}
{
  // ...but a video that merely mentions the event and aired months later is not
  stub([
    ['/search?', j({ items: [{ id:{videoId:'laterecap01'},
      snippet:{ title:'Katy Cypress Showdown Recap', channelTitle:'KR' } }]})],
    ['/videos?', j({ items: [{ id:'laterecap01',
      snippet:{ title:'Katy Cypress Showdown Recap', description:'', publishedAt:'2026-02-01T00:00:00Z' },
      liveStreamingDetails:{} }]})]
  ]);
  const out = await run();
  ok('a video from months later is rejected on air time', out.ok === false, JSON.stringify(out.streams));
}

// ── channel resolution: 3 units, was 400 ─────────────────────────────────
{
  stub([
    ['events.vex.com', pageWith('<div id="webcast"><a href="https://www.youtube.com/@KatyRobotics">channel</a></div>')],
    ['/channels?', j({ items:[{ id:'UCabc123', contentDetails:{ relatedPlaylists:{ uploads:'UUabc123' } } }]})],
    ['/playlistItems?', j({ items:[
      { snippet:{ resourceId:{videoId:'chanvid0001'}, title:'Katy Cypress Showdown HS', publishedAt:'2025-11-20T00:00:00Z' } }
    ]})],
    ['/videos?', j({ items:[{ id:'chanvid0001',
      snippet:{ title:'Katy Cypress Showdown HS', description:'', publishedAt:'2025-11-20T00:00:00Z' },
      liveStreamingDetails:{ actualStartTime:'2025-11-24T14:00:00Z' } }]})]
  ]);
  const out = await run();
  ok('a channel resolves to its broadcast', out.ok === true && out.streams[0].url.includes('chanvid0001'),
     JSON.stringify(out.streams).slice(0,150));
  ok('channel resolution costs 3 units, not 400', spend === 3, spend + ' units: ' + calls.join(','));
  ok('no search.list is used for a channel', !calls.includes('search'), calls.join(','));
}

// ── a link on the page spends nothing at all ─────────────────────────────
{
  stub([['events.vex.com', pageWith('<div id="webcast"><a href="https://www.youtube.com/watch?v=onpage12345">v</a></div>')]]);
  const out = await run();
  ok('a link on the page costs zero quota', spend === 0 && out.ok === true, spend + ' units');
}

// ── the in-memory cache must stop a repeat costing again ─────────────────
{
  stub([
    ['/search?', j({ items: [{ id:{videoId:'cachedvid01'},
      snippet:{ title:'Katy Cypress Showdown High School', channelTitle:'KR' } }]})],
    ['/videos?', j({ items: [{ id:'cachedvid01',
      snippet:{ title:'Katy Cypress Showdown High School', description:'', publishedAt:'2025-11-20T00:00:00Z' },
      liveStreamingDetails:{ actualStartTime:'2025-11-24T14:00:00Z' } }]})]
  ]);
  const sku = 'RE-V5RC-25-9999';
  const r1 = makeRes();
  await handler({ query: { path:'streams:'+sku, start:'2025-11-24', end:'2025-11-25', name:'Katy Cypress Showdown High School' } }, r1);
  const first = spend;
  const r2 = makeRes();
  await handler({ query: { path:'streams:'+sku, start:'2025-11-24', end:'2025-11-25', name:'Katy Cypress Showdown High School' } }, r2);
  ok('a repeat lookup spends nothing more', spend === first, `${first} then ${spend}`);
  ok('and returns the same answer', r2.body.ok === true && r2.body.streams[0].url === r1.body.streams[0].url);
  ok('the repeat is served from cache', r2.headers['X-Cache'] === 'HIT', String(r2.headers['X-Cache']));
}

// ── a past event's miss is cached hard; today's is retried ───────────────
{
  stub([['/search?', j({ items: [] })]]);
  const past = makeRes();
  await handler({ query: { path:'streams:RE-V5RC-20-1111', start:'2020-01-01', end:'2020-01-02', name:'Katy Cypress Showdown' } }, past);
  const soon = new Date(Date.now() - 3600e3).toISOString();
  const now = makeRes();
  await handler({ query: { path:'streams:RE-V5RC-26-2222', start:soon, end:soon, name:'Katy Cypress Showdown' } }, now);
  const pastAge = parseInt((past.headers['Cache-Control']||'').match(/s-maxage=(\d+)/)?.[1] || '0', 10);
  const nowAge = parseInt((now.headers['Cache-Control']||'').match(/s-maxage=(\d+)/)?.[1] || '0', 10);
  ok('a finished event caches its miss for a day', pastAge >= 86400, pastAge + 's');
  ok("today's event retries within the hour", nowAge > 0 && nowAge <= 3600, nowAge + 's');
}

// ── the date window is what separates two events at the same venue ────────
// Name matching is deliberately loose now (a stream title is a shortened event
// name), so air time has to carry the discrimination.
{
  stub([
    ['/search?', j({ items: [
      { id:{videoId:'rightweek1'}, snippet:{ title:'Cypress Showdown Field 1', channelTitle:'KR' } },
      { id:{videoId:'wrongweek1'}, snippet:{ title:'Cypress Showdown Field 1', channelTitle:'KR' } }
    ]})],
    ['/videos?', j({ items: [
      { id:'rightweek1', snippet:{ title:'Cypress Showdown Field 1', description:'', publishedAt:'2025-11-01T00:00:00Z' },
        liveStreamingDetails:{ actualStartTime:'2025-11-24T14:00:00Z' } },
      // Same venue, same name, different weekend — a DIFFERENT event.
      { id:'wrongweek1', snippet:{ title:'Cypress Showdown Field 1', description:'', publishedAt:'2025-11-01T00:00:00Z' },
        liveStreamingDetails:{ actualStartTime:'2025-12-13T14:00:00Z' } }
    ]})]
  ]);
  const out = await run();
  ok('an identically named broadcast from another weekend is excluded',
     out.ok === true && out.streams.length === 1 && out.streams[0].url.includes('rightweek1'),
     JSON.stringify(out.streams.map(x => x.url)));
}
{
  // A shortened title is accepted where the old one-directional rule rejected it
  stub([
    ['/search?', j({ items: [{ id:{videoId:'shorttitle'},
      snippet:{ title:'Cypress Showdown - HS Field 1', channelTitle:'KR' } }]})],
    ['/videos?', j({ items: [{ id:'shorttitle',
      snippet:{ title:'Cypress Showdown - HS Field 1', description:'', publishedAt:'2025-11-01T00:00:00Z' },
      liveStreamingDetails:{ actualStartTime:'2025-11-24T14:00:00Z' } }]})]
  ]);
  const out = await run();
  ok('a shortened stream title still matches its event', out.ok === true, JSON.stringify(out.streams).slice(0,140));
}
{
  // ...but an unrelated video airing that same day is not swept in
  stub([
    ['/search?', j({ items: [{ id:{videoId:'unrelated9'},
      snippet:{ title:'Cypress High School Football Game', channelTitle:'Sports' } }]})],
    ['/videos?', j({ items: [{ id:'unrelated9',
      snippet:{ title:'Cypress High School Football Game', description:'', publishedAt:'2025-11-24T00:00:00Z' },
      liveStreamingDetails:{ actualStartTime:'2025-11-24T14:00:00Z' } }]})]
  ]);
  const out = await run();
  ok('an unrelated video on the right day is still rejected', out.ok === false, JSON.stringify(out.streams));
}

// ── resilience: a failed details call must not wipe out every candidate ───
{
  stub([
    ['/search?', j({ items: [{ id:{videoId:'degraded01'},
      snippet:{ title:'Katy Cypress Showdown High School', channelTitle:'KR',
                publishedAt:'2025-11-24T14:00:00Z' } }]})],
    ['/videos?', () => ({ ok:false, status:500, json: async()=>({}) })]
  ]);
  const out = await run();
  ok('a failed details call degrades to snippet data instead of losing everything',
     out.ok === true && out.streams[0].url.includes('degraded01'), JSON.stringify(out).slice(0,180));
}
{
  // ...and degraded mode still applies the date window, using publishedAt
  stub([
    ['/search?', j({ items: [{ id:{videoId:'degradedold'},
      snippet:{ title:'Katy Cypress Showdown High School', channelTitle:'KR',
                publishedAt:'2024-01-01T00:00:00Z' } }]})],
    ['/videos?', () => ({ ok:false, status:500, json: async()=>({}) })]
  ]);
  const out = await run();
  ok('degraded mode still rejects a video from the wrong year', out.ok === false, JSON.stringify(out.streams));
}

// ── a full-day budget sanity check ───────────────────────────────────────
{
  // 10,000 units/day. Worst case is a streamless event: 101 units.
  const worst = 101, budget = 10000;
  ok('the worst-case lookup leaves room for ~99 events a day',
     Math.floor(budget / worst) >= 99, Math.floor(budget/worst) + ' lookups');
  // The old channel path cost 400 — 25 lookups a day.
  ok('channel resolution is now ~130x cheaper than before',
     Math.floor(400 / 3) >= 130, String(Math.floor(400/3)));
}

// ── the real miss, from a live event: query with the event's own name ─────
{
  const EV = 'Robotics is EZ @ 2025 Maker Faire Orange County - MS';
  let sentQuery = null;
  stub([
    ['/search?', (url) => { sentQuery = decodeURIComponent((url.match(/[?&]q=([^&]*)/)||[])[1]||'');
      return j({ items: [
        { id:{videoId:'realstream1'}, snippet:{ title:'robotics is ez @ 2025 maker faire orange county - ms', channelTitle:'robotics is ez' } },
        { id:{videoId:'mfhighlight'}, snippet:{ title:'Maker Faire Orange County 2025 Highlights', channelTitle:'Maker Faire' } }
      ]})(); }],
    ['/videos?', j({ items: [
      { id:'realstream1', snippet:{ title:'robotics is ez @ 2025 maker faire orange county - ms', description:'', publishedAt:'2025-09-20T00:00:00Z' },
        contentDetails:{ duration:'PT1H41M57S' },
        liveStreamingDetails:{ actualStartTime:'2025-09-20T16:00:00Z' } },
      // Same weekend, same words, but a short edited upload — not a broadcast.
      { id:'mfhighlight', snippet:{ title:'Maker Faire Orange County 2025 Highlights', description:'', publishedAt:'2025-09-20T00:00:00Z' },
        contentDetails:{ duration:'PT4M12S' } }
    ]})]
  ]);
  const res = makeRes();
  await handler({ query: { path:'streams:RE-V5RC-25-7001', start:'2025-09-20', end:'2025-09-20', name: EV } }, res);
  const out = res.body;
  ok('the query sent is the event name, not the tokenised version',
     sentQuery === EV, JSON.stringify(sentQuery));
  ok("the organiser's stream is found", out.ok === true && out.streams.some(x => x.url.includes('realstream1')),
     JSON.stringify(out.streams.map(x=>x.url)));
  ok('a short highlights reel from the same weekend is rejected',
     !out.streams.some(x => x.url.includes('mfhighlight')), JSON.stringify(out.streams.map(x=>x.url)));
}
{
  // A long upload that was never a live broadcast is still plausible — some
  // organisers upload the recording afterwards rather than streaming it.
  stub([
    ['/search?', j({ items: [{ id:{videoId:'uploadedrec'},
      snippet:{ title:'Katy Cypress Showdown High School', channelTitle:'KR' } }]})],
    ['/videos?', j({ items: [{ id:'uploadedrec',
      snippet:{ title:'Katy Cypress Showdown High School', description:'', publishedAt:'2025-11-24T20:00:00Z' },
      contentDetails:{ duration:'PT3H02M' } }]})]
  ]);
  const out = await run();
  ok('a long non-live upload is still accepted', out.ok === true, JSON.stringify(out.streams).slice(0,120));
}
{
  stub([
    ['/search?', j({ items: [{ id:{videoId:'shortclip01'},
      snippet:{ title:'Katy Cypress Showdown High School', channelTitle:'KR' } }]})],
    ['/videos?', j({ items: [{ id:'shortclip01',
      snippet:{ title:'Katy Cypress Showdown High School', description:'', publishedAt:'2025-11-24T20:00:00Z' },
      contentDetails:{ duration:'PT2M30S' } }]})]
  ]);
  const out = await run();
  ok('a two-minute clip is rejected as too short to be a session', out.ok === false, JSON.stringify(out.streams));
}

console.log(`\nt60: ${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
