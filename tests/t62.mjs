// t62 — the same data must not be fetched twice per event load.
import fs from 'fs';
let pass=0, fail=0;
const ok=(n,c,e)=>{c?(pass++,console.log('  ok   '+n)):(fail++,console.log('  FAIL '+n+(e?'\n         '+e:'')));};
const idx = fs.readFileSync('../index.html','utf8');
const src = idx.match(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/)[1];

console.log('t62 — request de-duplication');

// Exercise the real memo helpers
const env = new Function('apiGet','sim_pool','sim_poolSize',
  src.match(/let rwMemoKey = null;[\s\S]*?const rwAllDivisionMatches = eventId => rwMemoed\('divm', async \(\) => \{[\s\S]*?\n\}\);/)[0] +
  '\nreturn { rwMemoReset, rwEventDetail, rwAllDivisionMatches, calls: () => log };');

let log = [];
const apiGet = async (path) => { log.push(path); 
  if (path === '/events') return [{ id: 1, divisions: [{id:1},{id:2}] }];
  return [{ id: path }]; };
const mk = () => { log = []; return new Function('apiGet','sim_pool','sim_poolSize','log',
  src.match(/let rwMemoKey = null;[\s\S]*?const rwAllDivisionMatches = eventId => rwMemoed\('divm', async \(\) => \{[\s\S]*?\n\}\);/)[0] +
  '\nreturn { rwMemoReset, rwEventDetail, rwAllDivisionMatches };')(
    apiGet, async (arr, fn) => { for (const a of arr) await fn(a); }, () => 2, log); };

{
  const m = mk();
  m.rwMemoReset(99);
  await m.rwEventDetail(99); await m.rwEventDetail(99); await m.rwEventDetail(99);
  ok('three event lookups make ONE request',
     log.filter(p => p === '/events').length === 1, log.join(','));
}
{
  const m = mk();
  m.rwMemoReset(99);
  await Promise.all([m.rwAllDivisionMatches(99), m.rwAllDivisionMatches(99)]);
  const divCalls = log.filter(p => /divisions\/\d+\/matches/.test(p));
  ok('two callers share ONE set of division fetches', divCalls.length === 2, log.join(','));
  ok('the event itself is fetched once', log.filter(p => p === '/events').length === 1, log.join(','));
}
{
  const m = mk();
  m.rwMemoReset(99);
  await m.rwEventDetail(99);
  m.rwMemoReset(100);
  await m.rwEventDetail(100);
  ok('switching events clears the memo', log.filter(p => p === '/events').length === 2, log.join(','));
}
{
  // A failure must not be cached, or one blip breaks the event until reload
  log = [];
  let n = 0;
  const flaky = async (path) => { log.push(path); if (n++ === 0) throw new Error('blip'); return [{ id: 1, divisions: [] }]; };
  const m = new Function('apiGet','sim_pool','sim_poolSize',
    src.match(/let rwMemoKey = null;[\s\S]*?const rwAllDivisionMatches = eventId => rwMemoed\('divm', async \(\) => \{[\s\S]*?\n\}\);/)[0] +
    '\nreturn { rwMemoReset, rwEventDetail };')(flaky, async()=>{}, ()=>2);
  m.rwMemoReset(99);
  try { await m.rwEventDetail(99); } catch (e) {}
  const second = await m.rwEventDetail(99);
  ok('a failed fetch is not cached, so a retry works', Array.isArray(second) && log.length === 2, log.join(','));
}

// Source-level: the duplicate call sites are gone
ok('the whole-event loader uses the shared fetch',
   /for \(const m of await rwAllDivisionMatches\(eventId\)\)/.test(src));
ok('the anchor finder reuses the same result',
   /const allEv = await rwAllDivisionMatches\(eventId\);/.test(src));
ok('auto-find reuses the memoised event detail',
   /const ev = await rwEventDetail\(eventId\);/.test(src));

console.log(`\nt62: ${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
