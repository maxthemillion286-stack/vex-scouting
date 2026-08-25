// t52 — the debug panel must be inert without the flag.
import fs from 'fs';
let pass=0, fail=0;
const ok=(n,c,e)=>{c?(pass++,console.log('  ok   '+n)):(fail++,console.log('  FAIL '+n+(e?'\n         '+e:'')));};
const html = fs.readFileSync('../index.html','utf8');
const src = html.match(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/)[1];
const mk = (loc) => new Function('location', src.match(/const rwDebugOn = [^;]+;/)[0] + 'return rwDebugOn;')(loc);
const on = (loc) => mk(loc)();

console.log('t52 — debug panel gating');
ok('off with no query string', on({ search: '' }) === false);
ok('off on a normal event link', on({ search: '?sku=RE-V5RC-25-1926' }) === false);
ok('on with ?debug=1', on({ search: '?debug=1' }) === true);
ok('on with &debug=1', on({ search: '?sku=X&debug=1' }) === true);
ok('off with debug=0', on({ search: '?debug=0' }) === false);
ok('the panel is gated on the flag', /if \(rwDebugOn\(\)\) \{/.test(src));
ok('debug state resets per event load', /vsDebug\.jumper = null;/.test(src));
ok('no console logging remains', !/console\.log\('\[jumper\]/.test(src));
ok('debug output is escaped before injection', /replace\(\/<\/g, '&lt;'\)/.test(src));
ok('the "copy this" label is gone', !/copy this/i.test(src));

// The report must cover more than the Jumper, so future issues land here too.
const rep = src.match(/function vsDebugReport\(\)[\s\S]*?\n\}/)[0];
for (const k of ['page','server','jumper','apiCalls','recentErrors'])
  ok(`report includes ${k}`, new RegExp('\\b' + k + ':').test(rep));
ok('report captures the service worker version', /serviceWorker:/.test(rep));
ok('API failures are recorded', /vsNote\('api'/.test(src));
ok('server diag is only fetched under the flag',
   /debug=1\/\.test\(location\.search\)\) \{ vsLoadDiag\(\); vsLoadSwVersion\(\); \}/.test(src));
ok('the live service worker version is also only asked for under the flag',
   /vsLoadSwVersion\(\); \}/.test(src) && (src.match(/vsLoadSwVersion\(\)/g)||[]).length === 2);
console.log(`\nt52: ${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
