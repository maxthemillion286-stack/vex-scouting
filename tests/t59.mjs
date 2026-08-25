// t59 — auto-find must not block the first render, and a blocked page must
// still fall through to the YouTube search.
import fs from 'fs';
import handler from '../api/proxy.js';
let pass=0, fail=0;
const ok=(n,c,e)=>{c?(pass++,console.log('  ok   '+n)):(fail++,console.log('  FAIL '+n+(e?'\n         '+e:'')));};
const idx = fs.readFileSync('../index.html','utf8');
const src = idx.match(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/)[1];

console.log('t59 — non-blocking auto-find');

// ── the client renders first ─────────────────────────────────────────────
ok('auto-find is a standalone function', /async function rwAutoFindStream\(eventId\)/.test(src));
ok('it is started WITHOUT await',
   /const autoFind = daysNeeded\.length \? rwAutoFindStream\(eventId\) : Promise\.resolve\(null\);/.test(src));
ok('it is skipped entirely when every day is already anchored',
   /daysNeeded\.length \? rwAutoFindStream/.test(src) && /\.filter\(d => !preCal\[d\]\)/.test(src));
const kick = src.indexOf('const autoFind = daysNeeded.length ? rwAutoFindStream(eventId)');
const firstRender = src.indexOf('rewatchRender();', kick);
const awaited = src.indexOf('const af = await autoFind;', kick);
ok('a render happens before the promise is awaited',
   kick > 0 && firstRender > kick && awaited > firstRender,
   `kick=${kick} render=${firstRender} await=${awaited}`);
ok('a pending flag exists so the panel says it is still looking',
   /let rwAutoFindPending = false;/.test(src) && /Looking for this event's stream/.test(src));
ok('the flag is cleared once the promise settles', /rwAutoFindPending = false;/.test(src));
ok('a final render runs whether or not a stream was found',
   /the "looking…" note has to be replaced by the reason/.test(src));

// ── the proxy no longer gives up when the page is blocked ────────────────
const makeRes=()=>({statusCode:null,body:null,headers:{},setHeader(k,v){this.headers[k]=v},status(c){this.statusCode=c;return this},json(b){this.body=b;return this}});
process.env.YOUTUBE_API_KEY='k';
let n=0;
async function run(ytItems, name='Mount Vernon Showdown High School') {
  const details = ytItems.map(it => ({ id: it.id.videoId,
    snippet: { title: it.snippet.title, description:'', publishedAt: it.snippet.publishedAt },
    liveStreamingDetails: { actualStartTime: it.snippet.publishedAt } }));
  globalThis.fetch = async (u) =>
    u.includes('youtube/v3/search') ? { ok:true, status:200, json: async()=>({ items: ytItems }) } :
    u.includes('youtube/v3/videos') ? { ok:true, status:200, json: async()=>({ items: details }) } :
    { ok:false, status:403, text: async()=>'', headers:{get:()=>null} };
  const res = makeRes();
  await handler({ query: { path: 'streams:RE-V5RC-25-' + (8900+n++),
    start:'2025-09-13', end:'2025-09-13', name } }, res);
  return res.body;
}
{
  const out = await run([{ id:{videoId:'blockedok01'},
    snippet:{ title:'Mount Vernon Showdown — High School', channelTitle:'MV', publishedAt:'2025-09-13T14:00:00Z' } }]);
  ok('an entirely blocked page STILL reaches the YouTube search',
     out.ok === true && out.streams[0].source === 'yt-search', JSON.stringify(out).slice(0,180));
  ok('pageUrl is null when nothing could be read', out.pageUrl === null);
  ok('the blocked attempts are still reported', Array.isArray(out.tried) && out.tried.length > 0);
}
{
  const out = await run([]);
  ok('blocked page plus no YouTube match has its own reason',
     out.reason === 'page-blocked-and-no-yt-match', out.reason);
}
{
  // The dead relay was pure latency — every lookup waited on it to time out.
  const prx = fs.readFileSync('../api/proxy.js','utf8');
  ok('the relay that always timed out is gone', !/allorigins/.test(prx));
  ok('direct timeout is tightened', /BROWSER_HEADERS, 5000, 'direct'/.test(prx));
  ok('relay timeout is tightened', /\}, 7000, src, u\)/.test(prx));
}

console.log(`\nt59: ${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
