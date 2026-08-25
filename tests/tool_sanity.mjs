import fs from 'fs'; import { JSDOM } from 'jsdom';
const html = fs.readFileSync('../anchor-tool.html','utf8');
let fail=0;
const css=[...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map(m=>m[1]).join('');
const o=(css.match(/{/g)||[]).length,c=(css.match(/}/g)||[]).length;
console.log(`CSS braces ${o}/${c} ${o===c?'OK':'MISMATCH'}`); if(o!==c) fail++;
for(const [i,s] of [...html.matchAll(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/g)].map(m=>m[1]).entries()){
  try{ new Function(s); console.log(`script[${i}] parses OK (${s.length} chars)`);}catch(e){console.log('PARSE ERROR '+e.message); fail++;}
}
const {document}=new JSDOM(html).window;
for(const id of ['sku','loadBtn','link','findBtn','loadVidBtn','player','matchSel','ts','setBtn','json','mergeBtn','copyBtn','dayTable','anchorFs'])
  if(!document.getElementById(id)){console.log('MISSING #'+id); fail++;}
console.log('all referenced element ids present');
process.exit(fail?1:0);
