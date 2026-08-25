// t51 — the publishing path must not exist in the shipped bundle, and the
// offline tool must not be deployed.
import fs from 'fs';
import { JSDOM } from 'jsdom';
let pass=0, fail=0;
const ok=(n,c,e)=>{c?(pass++,console.log('  ok   '+n)):(fail++,console.log('  FAIL '+n+(e?'\n         '+e:'')));};

const idx = fs.readFileSync(process.argv[2]||'../index.html','utf8');
console.log('t51 — publishing stays out of the public app');

// ── nothing in the shipped page offers to publish ────────────────────────
ok('no export function in the bundle', !/rwExportAnchors/.test(idx));
ok('no export markup or styles', !/rw-export|EXPORT FOR EVERYONE/.test(idx));
ok('no export box element', !/rwExportBox/.test(idx));

const { document } = new JSDOM(idx).window;
const buttons = [...document.querySelectorAll('button')].map(b => b.textContent.trim().toUpperCase());
ok('no visible button mentions exporting or publishing',
   !buttons.some(t => /EXPORT|PUBLISH/.test(t)),
   buttons.filter(t => /EXPORT|PUBLISH/.test(t)).join(','));

// ── but reading published anchors still works ────────────────────────────
ok('the app still fetches anchors.json', /anchors\.json/.test(idx));
ok('merge precedence is still present', /rwMergePublished/.test(idx));
ok('published anchors are still marked in the UI', /published anchor/.test(idx));

// ── the manual fallback survives, since it only affects that one browser ──
ok('manual calibration is still available to users', /rewatchCalibrate\(/.test(idx));
ok('anchors still save to localStorage only', /localStorage\.setItem\(rwCalKey/.test(idx));

// ── the tool itself ──────────────────────────────────────────────────────
const tool = fs.readFileSync('../anchor-tool.html','utf8');
ok('the tool is marked noindex', /noindex/.test(tool));
ok('the tool documents that it must not be deployed', /vercelignore/i.test(tool));
ok('the tool carries no secrets or tokens',
   !/(ROBOTEVENTS_TOKEN|YOUTUBE_API_KEY|Bearer\s+\w)/.test(tool));
ok('the tool talks only to the proxy, never the API directly',
   !/events\.vex\.com/.test(tool));
ok('the tool preserves the Vimeo hash when anchoring', /meta\.hash/.test(tool));
ok('the tool merges rather than overwrites other events',
   /\.\.\.\(doc\.events\[String\(EVENT\.id\)\] \|\| \{\}\)/.test(tool));

// The export shape the tool writes must be exactly what the app reads back.
{
  const { JSDOM: J } = await import('jsdom');
  const w = new J(tool, { runScripts: 'outside-only' }).window;
  const src = tool.match(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/)[1];
  const merge = src.match(/\$\('mergeBtn'\)\.onclick = \(\) => \{[\s\S]*?\n\};/)[0];
  ok('the tool writes under an "events" key, matching the reader',
     /doc\.events\[String\(EVENT\.id\)\]/.test(merge) && /doc\.events = \{\}/.test(merge));
  ok('the tool keys days the same way the app does',
     /getFullYear\(\)/.test(src) && /padStart\(2, ?'0'\)/.test(src));
}

// ── the deploy guard ─────────────────────────────────────────────────────
const ignore = fs.existsSync('../.vercelignore') ? fs.readFileSync('../.vercelignore','utf8') : '';
ok('.vercelignore excludes the tool', /anchor-tool\.html/.test(ignore), ignore || '(missing)');

console.log(`\nt51: ${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
