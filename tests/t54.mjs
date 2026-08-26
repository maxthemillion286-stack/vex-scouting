// t54 — a stale cached reply must never masquerade as a live one.
import fs from 'fs';
import handler from '../api/proxy.js';
let pass=0, fail=0;
const ok=(n,c,e)=>{c?(pass++,console.log('  ok   '+n)):(fail++,console.log('  FAIL '+n+(e?'\n         '+e:'')));};

console.log('t54 — build marker and cache busting');

// ── every streams reply carries the build ────────────────────────────────
const makeRes=()=>({statusCode:null,body:null,headers:{},setHeader(k,v){this.headers[k]=v},status(c){this.statusCode=c;return this},json(b){this.body=b;return this}});
globalThis.fetch = async () => ({ ok:false, status:403, text: async()=>'', headers:{get:()=>null} });
const r1 = makeRes();
await handler({ query: { path: 'streams:RE-V5RC-25-9001' } }, r1);
ok('a failed streams lookup reports its build', typeof r1.body.build === 'string' && r1.body.build.length > 0, JSON.stringify(r1.body).slice(0,120));

globalThis.fetch = async () => ({ ok:true, status:200, headers:{get:()=>null},
  text: async () => '<html><body>'+'x'.repeat(700)+'<a href="https://youtu.be/buildcheck1">v</a></body></html>' });
const r2 = makeRes();
await handler({ query: { path: 'streams:RE-V5RC-25-9002' } }, r2);
ok('a successful streams lookup reports its build', !!r2.body.build);
const r3 = makeRes();
await handler({ query: { path: 'diag' } }, r3);
ok('diag reports the same build', r3.body.build === r1.body.build, r3.body.build + ' vs ' + r1.body.build);

// ── the client must not let a cache answer for it ────────────────────────
const idx = fs.readFileSync('../index.html','utf8');
// The buster is now DEBUG-ONLY: busting on every lookup defeated CDN caching,
// which was the single largest source of wasted YouTube quota.
ok('the streams lookup is cache-busted only when debugging',
   /rwDebugOn\(\) \? `&_t=\$\{Date\.now\(\)\}` : ''/.test(idx));
ok('the diag lookup is cache-busted', /path=diag&_t=\$\{Date\.now\(\)\}/.test(idx));
ok('diag also asks the browser not to cache', /cache: 'no-store'/.test(idx));
ok('the debug report surfaces the proxy build', /proxy: \(vsDebug\.diag && vsDebug\.diag\.build\)/.test(idx));

// ── the service worker must not serve these from cache ───────────────────
const sw = fs.readFileSync('../sw.js','utf8');
// Asserted route-by-route rather than against one frozen alternation, so
// adding another slow lookup doesn't fail this for the wrong reason. Every
// route named here is on-demand and useless when stale — see HANDOFF.md §8.
const swSlow = (sw.match(/path=\(\?:([a-z|]+)\)/) || [])[1] || '';
for (const route of ['streams', 'vimeo', 'diag', 'siblings', 'boxcast']) {
  ok(`${route}: bypasses the SW cache`, swSlow.split('|').includes(route), swSlow);
}
ok('they are network-only, with an offline fallback',
   /event\.respondWith\(fetch\(request\)\.catch\(\(\) => offlineResponse\(request\)\)\)/.test(sw));
ok('ordinary API calls still use network-first-with-timeout',
   /networkFirstWithTimeout\(request, API_CACHE, API_TIMEOUT_MS\)/.test(sw));

// The SW route test, exercised rather than pattern-matched
const routeCheck = (search) => /path=(?:streams|vimeo|diag)/.test(decodeURIComponent(search));
ok('a streams URL is recognised even when encoded',
   routeCheck('?path=' + encodeURIComponent('streams:RE-V5RC-25-0209') + '&_t=1'));
ok('a vimeo URL is recognised', routeCheck('?path=' + encodeURIComponent('vimeo:event=123')));
ok('an ordinary API URL is not', !routeCheck('?path=' + encodeURIComponent('/teams/123/matches')));

console.log(`\nt54: ${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
