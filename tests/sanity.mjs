import fs from 'fs';
import { JSDOM } from 'jsdom';
const html = fs.readFileSync('../index.html','utf8');
let fail = 0;
// 1. CSS braces balance
const css = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map(m=>m[1]).join('\n');
const open = (css.match(/{/g)||[]).length, close = (css.match(/}/g)||[]).length;
console.log(`CSS braces: ${open} open / ${close} close ${open===close?'OK':'MISMATCH'}`);
if (open!==close) fail++;
// 2. inline JS parses
const scripts = [...html.matchAll(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/g)].map(m=>m[1]);
for (const [i,s] of scripts.entries()) {
  if (!s.trim()) continue;
  try { new Function(s); console.log(`script[${i}] (${s.length} chars): parses OK`); }
  catch(e){ console.log(`script[${i}]: PARSE ERROR ${e.message}`); fail++; }
}
// 3. DOM builds, all tabs present
const { document } = new JSDOM(html).window;
const tabs = ['tab-scout','tab-skills','tab-tournament','tab-rewatch','tab-simulator'];
for (const t of tabs) if(!document.getElementById(t)){console.log('MISSING '+t); fail++;}
console.log(`tab panels present: ${tabs.length}`);
console.log(`labels total: ${document.querySelectorAll('.input-label').length}`);
process.exit(fail?1:0);
