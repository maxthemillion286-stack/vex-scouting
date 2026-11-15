// t117 — v112: stream finding reads YouTube's own search page before paying.
//
// Asked: "why is it so hard for it to find the stream automatically even
// though the stream names are almost identical to the competition name".
// One search through the API costs 100 of 10,000 daily units; the tracker
// visiting a season of events spends the day's worth in minutes and every
// event after that fails. The page search costs none.
import fs from 'fs';
import os from 'os';
import path from 'path';
let pass = 0, fail = 0;
const ok = (n, c, e) => { c ? (pass++, console.log('  ok   ' + n)) : (fail++, console.log('  FAIL ' + n + (e ? '\n         ' + e : ''))); };
const px = fs.readFileSync('../api/proxy.js', 'utf8');
console.log('t117 — v112: the free search first');

// The real module, with the one function under test let out.
const tmp = path.join(os.tmpdir(), 'proxy-t117-' + process.pid + '.mjs');
fs.writeFileSync(tmp, px + '\nexport { searchYouTubeByName };\n');
const mod = await import(tmp);
fs.unlinkSync(tmp);

// ── reading the page ──
const renderer = (id, title) => `{"videoRenderer":{"videoId":"${id}","thumbnail":{"thumbnails":[{"url":"https://i.ytimg.com/vi/${id}/hq720.jpg","width":360,"height":202}]},"title":{"runs":[{"text":${JSON.stringify(title)}}],"accessibility":{"accessibilityData":{"label":"x"}}},"longBylineText":{"runs":[{"text":"Some Channel"}]}}}`;
const pageOf = list => '<html><script>var ytInitialData = {"contents":[' + list.map(([i, t]) => renderer(i, t)).join(',') + ']};</script></html>';
{
  const got = mod.parseYtResults(pageOf([['aaaaaaaaaaa', 'Cypress Showdown - HS Field 1'], ['bbbbbbbbbbb', 'He said "go" \\ and it went'], ['aaaaaaaaaaa', 'Cypress Showdown - HS Field 1']]));
  ok('videos and titles are read off the page', got.length === 2 && got[0].id.videoId === 'aaaaaaaaaaa' && got[0].snippet.title === 'Cypress Showdown - HS Field 1', JSON.stringify(got));
  ok('quotes and backslashes in a title survive', got[1].snippet.title === 'He said "go" \\ and it went', got[1].snippet.title);
  ok('a consent page, an error page or nothing reads as no results', mod.parseYtResults('<html>Before you continue</html>').length === 0 && mod.parseYtResults('').length === 0 && mod.parseYtResults(null).length === 0);
  ok('a huge page cannot produce an endless list', mod.parseYtResults(pageOf(Array.from({ length: 90 }, (_, i) => [String(i).padStart(11, 'x'), 'T' + i]))).length === 40);
}

// ── the path ──
const NAME = 'Excalibur Robotics Challenge 2026: VEX V5 Robotics Competition';
const START = '2026-11-07T08:00:00-06:00', END = '2026-11-07T18:00:00-06:00';
const details = ids => ({ items: ids.map(id => ({ id, snippet: { title: 'Excalibur Robotics Challenge 2026', description: '', publishedAt: '2026-11-01T00:00:00Z', channelId: 'UCx' },
  contentDetails: { duration: 'PT7H5M' }, liveStreamingDetails: { actualStartTime: '2026-11-07T14:10:00Z', actualEndTime: '2026-11-07T21:15:00Z' } })) });
const run = async (pageHtml, apiItems, pageStatus = 200) => {
  const calls = { page: 0, search: 0, videos: 0 };
  const real = globalThis.fetch;
  globalThis.fetch = async url => {
    url = String(url);
    if (url.startsWith('https://www.youtube.com/results')) { calls.page++; if (pageHtml === 'throw') throw new Error('blocked'); return { ok: pageStatus === 200, status: pageStatus, text: async () => pageHtml }; }
    if (url.includes('/youtube/v3/search')) { calls.search++; return { ok: true, json: async () => ({ items: apiItems }) }; }
    if (url.includes('/youtube/v3/videos')) { calls.videos++; const ids = decodeURIComponent((url.match(/[?&]id=([^&]+)/) || [])[1] || '').split(','); return { ok: true, json: async () => details(ids) }; }
    return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
  };
  try { return { out: await mod.searchYouTubeByName(NAME, START, END, 'key'), calls }; } finally { globalThis.fetch = real; }
};
const apiHit = [{ id: { videoId: 'ccccccccccc' }, snippet: { title: 'Excalibur Robotics Challenge 2026', description: '', publishedAt: '2026-11-01T00:00:00Z' } }];
{
  const a = await run(pageOf([['aaaaaaaaaaa', 'Excalibur Robotics Challenge 2026'], ['zzzzzzzzzzz', 'Minecraft speedrun']]), apiHit);
  ok('a stream on the search page is found', a.out.length === 1 && /aaaaaaaaaaa/.test(a.out[0].url), JSON.stringify(a.out));
  ok('and the paid search is never made', a.calls.search === 0 && a.calls.page === 1 && a.calls.videos === 1, JSON.stringify(a.calls));
  ok('it says how it was found', a.out.how === 'page');
  const b = await run(pageOf([['zzzzzzzzzzz', 'Minecraft speedrun']]), apiHit);
  ok('nothing on the page: the paid search still runs, as before', b.out.length === 1 && /ccccccccccc/.test(b.out[0].url) && b.calls.search === 1 && b.out.how === 'api', JSON.stringify(b.calls));
  const c = await run('<html>Before you continue to YouTube</html>', apiHit);
  ok('a consent page falls back to the paid search', c.out.length === 1 && c.calls.search === 1);
  const d = await run('', apiHit, 429);
  ok('being refused falls back to the paid search', d.out.length === 1 && d.calls.search === 1);
  const e = await run('throw', apiHit);
  ok('being unreachable falls back to the paid search', e.out.length === 1 && e.calls.search === 1);
  const f = await run(pageOf([['zzzzzzzzzzz', 'Minecraft speedrun']]), []);
  ok('nothing anywhere is still nothing', f.out.length === 0);
}
ok('the page is asked with a time limit', /youtube\.com\/results\?search_query=[\s\S]{0,400}AbortSignal\.timeout\(6000\)/.test(px));
ok('old cached misses are asked again', /const RW_STREAM_LOGIC = 'L6';/.test(fs.readFileSync('../index.html', 'utf8')));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
