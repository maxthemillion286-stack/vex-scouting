// t55 — a Vimeo CHANNEL link must never be mistaken for a broadcast.
import fs from 'fs';
import handler from '../api/proxy.js';
let pass=0, fail=0;
const ok=(n,c,e)=>{c?(pass++,console.log('  ok   '+n)):(fail++,console.log('  FAIL '+n+(e?'\n         '+e:'')));};
const idx = fs.readFileSync('../index.html','utf8');
const src = idx.match(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/)[1];
const parse = new Function(src.match(/function rwParseSource\(url\)[\s\S]*?\n\}/)[0] + 'return rwParseSource;')();

console.log('t55 — Vimeo channel vs broadcast');

// ── client-side classification ───────────────────────────────────────────
{
  const c = parse('https://vimeo.com/ccisdrobotics');
  ok('a channel slug is flagged as a channel', c && c.kind === 'channel', JSON.stringify(c));
  ok('a channel yields no video id', c && !c.id && !c.eventId);
}
for (const [url, id] of [
  ['https://vimeo.com/987654321', '987654321'],
  ['https://player.vimeo.com/video/987654321?h=abc123', '987654321']
]) {
  const v = parse(url);
  ok(`a numeric clip URL is still a clip (${url.slice(0,34)}…)`, v && v.id === id && !v.kind, JSON.stringify(v));
}
{
  const e = parse('https://vimeo.com/event/1234567');
  ok('an event URL is still an event', e && e.eventId === '1234567' && !e.kind, JSON.stringify(e));
}
{
  const h = parse('https://vimeo.com/987654321/abc123def');
  ok('a hashed clip URL keeps its hash', h && h.id === '987654321' && h.hash === 'abc123def', JSON.stringify(h));
}

// ── the proxy must not report a channel as a stream ──────────────────────
const makeRes=()=>({statusCode:null,body:null,headers:{},setHeader(k,v){this.headers[k]=v},status(c){this.statusCode=c;return this},json(b){this.body=b;return this}});
const real = globalThis.fetch;
let n=0;
async function run(routes) {
  globalThis.fetch = async (url) => {
    for (const [pat, fn] of routes) if (url.includes(pat)) return fn(url);
    throw new Error('unrouted ' + url);
  };
  const res = makeRes();
  await handler({ query: { path: 'streams:RE-V5RC-25-' + (7100 + n++), start: '2025-11-24', end: '2025-11-25' } }, res);
  return res.body;
}
const pageOf = (body) => () => ({ ok:true, status:200, headers:{get:()=>null},
  text: async () => '<html><body>' + 'x'.repeat(700) + body + '</body></html>' });

{
  const out = await run([
    ['events.vex.com', pageOf('<div id="webcast"><a href="https://vimeo.com/ccisdrobotics">Watch</a></div>')],
    ['vimeo.com', pageOf('<a href="/video/555000111">clip</a><script>{"clip_id":555000111}</script>')],
    ['r.jina.ai', pageOf('<a href="/video/555000111">clip</a>')],
    ['', pageOf('')]
  ]);
  ok('the channel is reported separately, not as a stream',
     (out.channels || []).some(c => /ccisdrobotics/.test(c)), JSON.stringify(out.channels));
  ok('no bare channel URL appears in streams',
     !(out.streams || []).some(s => /vimeo\.com\/[a-z]/i.test(s.url)), JSON.stringify(out.streams));
  ok('the channel resolves to a numeric clip',
     (out.streams || []).some(s => /vimeo\.com\/555000111/.test(s.url)), JSON.stringify(out.streams));
}
{
  // A real clip link on the page must still win without any channel lookup
  const out = await run([['events.vex.com',
    pageOf('<div id="webcast"><a href="https://vimeo.com/event/9876543">Live</a></div>')]]);
  ok('a vimeo event link is used directly',
     out.streams[0].url === 'https://vimeo.com/event/9876543', JSON.stringify(out.streams));
}

// ── the client filters unresolved channels out of the pool ───────────────
ok('auto-find drops anything still classed as a channel',
   /!\(rwParseSource\(x\.url\) \|\| \{\}\)\.kind/.test(src));
ok('sync explains a channel link rather than failing blankly',
   /is a channel, not a broadcast/.test(src));

globalThis.fetch = real;
console.log(`\nt55: ${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
