// t57 — grade level must veto a wrong-day match, and the bar must be 80%.
import handler from '../api/proxy.js';
let pass=0, fail=0;
const ok=(n,c,e)=>{c?(pass++,console.log('  ok   '+n)):(fail++,console.log('  FAIL '+n+(e?'\n         '+e:'')));};
const makeRes=()=>({statusCode:null,body:null,headers:{},setHeader(k,v){this.headers[k]=v},status(c){this.statusCode=c;return this},json(b){this.body=b;return this}});
const real=globalThis.fetch;
let n=0;
const emptyPage = () => ({ ok:true, status:200, headers:{get:()=>null},
  text: async () => '<html><body>'+'x'.repeat(700)+'<p>no stream</p></body></html>' });
async function search(name, items) {
  // The lookup now confirms candidates with a batched videos.list call, which
  // is where air time and the full description come from.
  const details = items.map(it => ({
    id: it.id.videoId,
    snippet: { title: it.snippet.title, description: it.snippet.description || '',
               publishedAt: it.snippet.publishedAt },
    liveStreamingDetails: { actualStartTime: '2025-11-24T15:00:00Z' }
  }));
  globalThis.fetch = async (url) =>
    url.includes('youtube/v3/search') ? { ok:true, status:200, json: async()=>({ items }) } :
    url.includes('youtube/v3/videos') ? { ok:true, status:200, json: async()=>({ items: details }) } :
    emptyPage();
  const res = makeRes();
  await handler({ query: { path: 'streams:RE-V5RC-25-' + (8500+n++),
    start:'2025-11-24', end:'2025-11-25', name } }, res);
  return res.body;
}
const vid = (id, title, desc='') => ({ id:{videoId:id},
  snippet:{ title, description: desc, channelTitle:'Katy Robotics', publishedAt:'2025-11-24T15:00:00Z' } });

console.log('t57 — grade veto and the 80% bar');
process.env.YOUTUBE_API_KEY = 'k';

const HS = 'Katy Cypress Showdown High School';
const MS = 'Katy Cypress Showdown Middle School';

// ── the veto ─────────────────────────────────────────────────────────────
{
  const out = await search(HS, [vid('msvideo0001', 'Katy Cypress Showdown — Middle School Day')]);
  ok('an HS event REJECTS the MS broadcast', out.ok === false, JSON.stringify(out.streams));
}
{
  const out = await search(MS, [vid('hsvideo0001', 'Katy Cypress Showdown — High School Day')]);
  ok('an MS event REJECTS the HS broadcast', out.ok === false, JSON.stringify(out.streams));
}
{
  const out = await search(HS, [
    vid('msvideo0002', 'Katy Cypress Showdown Middle School'),
    vid('hsvideo0002', 'Katy Cypress Showdown High School')
  ]);
  ok('with both on offer, the right grade is picked',
     out.ok === true && out.streams.length === 1 && out.streams[0].url.includes('hsvideo0002'),
     JSON.stringify(out.streams));
}
{
  // Abbreviations are common in stream titles
  const out = await search(HS, [vid('msabbrev001', 'Katy Cypress Showdown MS Div A')]);
  ok('the abbreviation "MS" also vetoes', out.ok === false, JSON.stringify(out.streams));
}
{
  // A video that states no grade is ambiguous, not wrong — allow it
  const out = await search(HS, [vid('nograde0001', 'Katy Cypress Showdown Livestream')]);
  ok('a video with no stated grade is still accepted',
     out.ok === true && out.streams[0].url.includes('nograde0001'), JSON.stringify(out.streams));
}
{
  // The grade appearing only in the description must still veto
  const out = await search(HS, [vid('descgrade01', 'Katy Cypress Showdown', 'Middle School division matches')]);
  ok('a grade stated only in the description vetoes too', out.ok === false, JSON.stringify(out.streams));
}

// ── the 80% bar ──────────────────────────────────────────────────────────
{
  // A shortened title is the normal case — "Katy Cypress Showdown High School"
  // is streamed as "Cypress Showdown". Every distinctive word in the title is
  // explained by the event, so it is accepted; the DATE is what separates this
  // from a different event at the same venue (covered in t60).
  const out = await search(HS, [vid('partial0001', 'Cypress Showdown Field 1')]);
  ok('a shortened title is accepted', out.ok === true, JSON.stringify(out.streams));
}
{
  // Sharing one word is still a coincidence, not a match.
  const out = await search(HS, [vid('oneword0002', 'Katy Fall Classic')]);
  ok('a single shared word is still rejected', out.ok === false, JSON.stringify(out.streams));
}
{
  const out = await search(HS, [vid('full0000001', 'Katy Cypress Showdown 2025')]);
  ok('a 3-of-3 match is accepted', out.ok === true, JSON.stringify(out.streams));
  ok('the match ratio is reported', out.streams[0].match === '3/3', out.streams[0].match);
}
{
  const out = await search(HS, [vid('weak0000001', 'Katy Robotics Fall Meet')]);
  ok('a weak match is rejected outright', out.ok === false, JSON.stringify(out.streams));
}
{
  // Even a perfect ratio needs two real words behind it
  const out = await search('Katy Regional Event', [vid('oneword0001', 'Katy Regional')]);
  ok('a single distinctive word never qualifies', out.ok === false, JSON.stringify(out.streams));
}

globalThis.fetch = real;
console.log(`\nt57: ${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
