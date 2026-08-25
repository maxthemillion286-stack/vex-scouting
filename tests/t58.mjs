// t58 — all three files must report one matching release number.
import fs from 'fs';
let pass=0, fail=0;
const ok=(n,c,e)=>{c?(pass++,console.log('  ok   '+n)):(fail++,console.log('  FAIL '+n+(e?'\n         '+e:'')));};
const idx = fs.readFileSync('../index.html','utf8');
const prx = fs.readFileSync('../api/proxy.js','utf8');
const sw  = fs.readFileSync('../sw.js','utf8');

console.log('t58 — release numbers agree');
const app = (idx.match(/const APP_BUILD = '([^']+)'/)||[])[1];
const proxy = (prx.match(/const PROXY_BUILD = '([^']+)'/)||[])[1];
const cache = (sw.match(/const CACHE_NAME = 'vex-scout-([^']+)'/)||[])[1];
const api = (sw.match(/const API_CACHE = 'vex-scout-([^']+)-api'/)||[])[1];
const hdr = (sw.match(/Service Worker — (v\d+)/)||[])[1];

console.log(`         app=${app} proxy=${proxy} cache=${cache} api=${api} header=${hdr}`);
ok('index.html declares a build', !!app);
ok('proxy.js declares a build', !!proxy);
ok('sw.js declares a cache version', !!cache);
ok('app and proxy agree', app === proxy, `${app} vs ${proxy}`);
ok('sw cache matches the app build', cache === app, `${cache} vs ${app}`);
ok('sw api cache matches too', api === cache, `${api} vs ${cache}`);
ok('the sw header comment matches', hdr === cache, `${hdr} vs ${cache}`);

// The debug page must expose all three so a mismatch is visible
ok('the debug report exposes the app build', /app: APP_BUILD/.test(idx));
ok('the debug report exposes the proxy build', /proxy: \(vsDebug\.diag && vsDebug\.diag\.build\)/.test(idx));
ok('the debug report asks the live SW for its cache name', /vsLoadSwVersion/.test(idx));
ok('the SW answers a VERSION request', /d\.type === 'VERSION'/.test(sw));
ok('the SW replies with its own CACHE_NAME', /postMessage\(\{ cache: CACHE_NAME \}\)/.test(sw));
ok('SKIP_WAITING still works', /SKIP_WAITING/.test(sw));

console.log(`\nt58: ${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
