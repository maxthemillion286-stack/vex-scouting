// Run the whole suite. From the repo root:  node tests/run-all.mjs
//
// Every test is standalone and exits non-zero on failure, so this is just a
// loop with a summary. Run it after ANY change to index.html, api/proxy.js or
// sw.js — several of these encode bugs that were subtle enough to ship twice.
import { readdirSync } from 'fs';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const here = dirname(fileURLToPath(import.meta.url));
const files = readdirSync(here).filter(f => /^t\d+\.mjs$/.test(f))
  .sort((a, b) => parseInt(a.slice(1)) - parseInt(b.slice(1)));

let failed = [];
let totalOk = 0;
for (const f of [...files, 'sanity.mjs', 'tool_sanity.mjs']) {
  const r = spawnSync(process.execPath, [join(here, f)], { cwd: here, encoding: 'utf8' });
  const out = (r.stdout || '') + (r.stderr || '');
  const m = out.match(/(\d+) passed, (\d+) failed/);
  if (m) totalOk += parseInt(m[1]);
  if (r.status !== 0) {
    failed.push(f);
    console.log(`FAIL  ${f}`);
    for (const line of out.split('\n')) if (/FAIL|Error|error:/.test(line)) console.log('      ' + line.trim());
  } else {
    console.log(`ok    ${f}  ${m ? m[0] : ''}`);
  }
}
console.log(`\n${files.length + 2} files, ${totalOk} assertions, ${failed.length} file(s) failing`);
if (failed.length) { console.log('failing: ' + failed.join(', ')); process.exit(1); }
