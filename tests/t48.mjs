// t48 — Vimeo resolution: clip id, pinning hash, and the scheduled start.
import handler from '../api/proxy.js';
let pass=0, fail=0;
const ok=(n,c,e)=>{c?(pass++,console.log('  ok   '+n)):(fail++,console.log('  FAIL '+n+(e?'\n         '+e:'')));};
const makeRes=()=>({statusCode:null,body:null,headers:{},setHeader(k,v){this.headers[k]=v},status(c){this.statusCode=c;return this},json(b){this.body=b;return this}});
const real=globalThis.fetch;
let n=0;
async function run(arg, routes) {
  globalThis.fetch = async (url) => {
    for (const [pat, fn] of routes) if (url.includes(pat)) return fn(url);
    throw new Error('unrouted: ' + url);
  };
  const res = makeRes();
  await handler({ query: { path: 'vimeo:' + arg } }, res);
  return res.body;
}
const html = (s) => () => ({ ok:true, status:200, text: async()=>s, headers:{get:()=>null} });
const json = (o) => () => ({ ok:true, status:200, json: async()=>o, headers:{get:()=>null} });

console.log('t48 — Vimeo resolution');

const EMBED = (clip) => html(
  `<div data-config-url="https://player.vimeo.com/video/${clip}/config?s=sig&amp;t=1">` +
  `<iframe src="https://player.vimeo.com/video/${clip}/"></iframe></div>`);

// ── the full happy path ───────────────────────────────────────────────────
{
  const id = 900000001 + (n++);
  const out = await run('event=' + id, [
    ['/embed', EMBED('987654321')],
    ['/config', json({ video: {
      title: 'Day 1 — Division A',
      duration: 28800,
      embed_code: '<iframe src="https://player.vimeo.com/video/987654321?h=abc123def4"></iframe>',
      live_event: { status: 'ended', ingest: { scheduled_start_time: '2026-03-07T13:00:00Z' } }
    }})]
  ]);
  ok('an event resolves to its current clip', out.ok === true && out.videoId === '987654321', JSON.stringify(out));
  ok('the pinning hash is extracted', out.hash === 'abc123def4', JSON.stringify(out));
  ok('the scheduled start comes through', out.scheduledStart === '2026-03-07T13:00:00Z', JSON.stringify(out));
  ok('live status and duration come through', out.liveStatus === 'ended' && out.duration === 28800, JSON.stringify(out));
}

// ── hash fallback when the config has none ────────────────────────────────
{
  const id = 900000001 + (n++);
  const out = await run('event=' + id, [
    ['/embed', EMBED('555000111')],
    ['/config', json({ video: { title: 'x', live_event: null } })],
    ['vimeo.com/555000111', html(
      // The page also lists a related clip — the wrong hash must not be taken.
      '<a href="/video/999888777?h=WRONGHASH1">next up</a>' +
      '<meta content="https://player.vimeo.com/video/555000111?h=goodhash99">')]
  ]);
  ok('hash falls back to the clip page', out.hash === 'goodhash99', JSON.stringify(out));
  ok("a related clip's hash is NOT used", out.hash !== 'WRONGHASH1');
}

// ── failure modes stay legible ────────────────────────────────────────────
{
  const id = 900000001 + (n++);
  const out = await run('event=' + id, [['/embed', html('<html>nothing attached</html>')]]);
  ok('an event with no clip attached says so', out.ok === false && out.reason === 'no-clip-attached', JSON.stringify(out));
}
{
  const res = makeRes();
  await handler({ query: { path: 'vimeo:event=notanumber' } }, res);
  ok('a non-numeric id is rejected', res.statusCode === 400 && res.body.reason === 'bad-id');
}
{
  const out = await run('clip=' + (900000001 + (n++)), [
    ['vimeo.com/', html('<p>no hash here</p>')]
  ]);
  ok('a clip with no findable hash still returns the id', out.ok === true && out.hash === null, JSON.stringify(out));
}

// ── auto-find must recognise Vimeo links on the event page ────────────────
{
  globalThis.fetch = async () => ({ ok:true, status:200, headers:{get:()=>null},
    text: async () => '<html><body>' + 'x'.repeat(700) +
      '<div id="webcast"><a href="https://vimeo.com/event/12345678">Watch live</a></div></body></html>' });
  const res = makeRes();
  await handler({ query: { path: 'streams:RE-V5RC-24-7777' } }, res);
  ok('a Vimeo event link IS auto-found on the event page',
     res.body.ok === true && res.body.streams[0].url === 'https://vimeo.com/event/12345678',
     JSON.stringify(res.body));
}

globalThis.fetch = real;
console.log(`\nt48: ${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
