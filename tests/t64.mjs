// t64 — a crash must arrive as a readable message, never a bare 500.
import fs from 'fs';
import handler from '../api/proxy.js';
let pass=0, fail=0;
const ok=(n,c,e)=>{c?(pass++,console.log('  ok   '+n)):(fail++,console.log('  FAIL '+n+(e?'\n         '+e:'')));};
const makeRes=()=>({statusCode:null,body:null,headers:{},setHeader(k,v){this.headers[k]=v},status(c){this.statusCode=c;return this},json(b){this.body=b;return this}});

console.log('t64 — 500s explain themselves');

// Force a crash inside the handler by breaking fetch itself
const real = globalThis.fetch;
globalThis.fetch = () => { throw new TypeError('boom inside the route'); };
process.env.ROBOTEVENTS_TOKEN = 't';
{
  const res = makeRes();
  await handler({ query: { path: '/events?sku[]=RE-V5RC-25-0816' } }, res);
  ok('a crash does not escape the handler', res.statusCode !== null);
  ok('the response carries a message', !!(res.body && (res.body.message || res.body.error)),
     JSON.stringify(res.body).slice(0,200));
}
{
  // A route that throws before any fetch
  const res = makeRes();
  await handler({ query: {} }, res);
  ok('a missing path is a 400, not a crash', res.statusCode === 400, String(res.statusCode));
}
globalThis.fetch = real;

// The wrapper itself
const prx = fs.readFileSync('../api/proxy.js','utf8');
ok('the handler is wrapped in a catch', /try \{\n    return await handleRequest\(req, res\);/.test(prx));
ok('the crash report names the build', /build: PROXY_BUILD,/.test(prx));
ok('it names the path that failed', /path: String\(\(req && req\.query && req\.query\.path\)/.test(prx));
ok('it includes a few stack frames', /at: String\(\(err && err\.stack\)/.test(prx));
ok('the reporter cannot itself throw', /try \{ return res\.status\(500\)\.json\(detail\); \} catch \(e\) \{ return; \}/.test(prx));

// The client must surface it rather than showing "API error 500"
const idx = fs.readFileSync('../index.html','utf8');
const src = idx.match(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/)[1];
ok('the client reads the error body', /await res\.clone\(\)\.json\(\)/.test(src));
ok('the message is attached to the thrown error', /throw new Error\(`API error \$\{res\.status\}\$\{why\}`\)/.test(src));
ok('the stack frames land in the debug report', /vsNote\('api-trace', b\.at\)/.test(src));
ok('no undefined identifiers were left behind', !/MAX_RETRIES/.test(src));

console.log(`\nt64: ${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
