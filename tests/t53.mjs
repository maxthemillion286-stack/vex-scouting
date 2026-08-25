// t53 — the diag route must report config without leaking values.
import handler from '../api/proxy.js';
let pass=0, fail=0;
const ok=(n,c,e)=>{c?(pass++,console.log('  ok   '+n)):(fail++,console.log('  FAIL '+n+(e?'\n         '+e:'')));};
const makeRes=()=>({statusCode:null,body:null,headers:{},setHeader(k,v){this.headers[k]=v},status(c){this.statusCode=c;return this},json(b){this.body=b;return this}});

console.log('t53 — diag route');
process.env.ROBOTEVENTS_TOKEN = 'SECRET-TOKEN-AAA';
process.env.ROBOTEVENTS_TOKEN_2 = 'SECRET-TOKEN-BBB';
process.env.YOUTUBE_API_KEY = 'SECRET-YT-KEY';
const res = makeRes();
await handler({ query: { path: 'diag' } }, res);
const b = res.body;

ok('returns 200', res.statusCode === 200);
ok('counts the RobotEvents tokens', b.robotEventsTokens === 2, JSON.stringify(b));
ok('reports the YouTube key as a boolean', b.youtubeKey === true);
const dump = JSON.stringify(b);
ok('no token value appears anywhere', !/SECRET-TOKEN/.test(dump), dump);
ok('no YouTube key value appears anywhere', !/SECRET-YT-KEY/.test(dump), dump);
ok('includes a timestamp', typeof b.time === 'string');

delete process.env.YOUTUBE_API_KEY;
const res2 = makeRes();
await handler({ query: { path: 'diag' } }, res2);
ok('a missing YouTube key reads false', res2.body.youtubeKey === false);

console.log(`\nt53: ${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
