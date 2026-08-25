// t44 — hidden shim selects must not render a visible custom dropdown.
//
// enhanceSelect wraps every select in a .cs div and moves the select inside it.
// The wrapper does not inherit `hidden`, so enhancing a hidden shim produced a
// fully visible dropdown bar at the top of <body>, outside every tab.
import fs from 'fs'; import { JSDOM } from 'jsdom';
let pass=0, fail=0;
const ok=(n,c,e)=>{c?(pass++,console.log('  ok   '+n)):(fail++,console.log('  FAIL '+n+(e?'\n         '+e:'')));};

const html = fs.readFileSync(process.argv[2] || '../index.html','utf8');
const dom = new JSDOM(html, { runScripts:'outside-only' });
const { document } = dom.window;

// Pull the real enhanceSelect out of the page source rather than reimplementing it
const src = html.match(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/)[1];
const body = src.match(/function enhanceSelect\(select\)[\s\S]*?\n\}/)[0];
const enhanceSelect = new Function('document','csBuildList','csClose','csCloseAll','csSyncLabel','MutationObserver','Event',
  body + '; return enhanceSelect;')(document, ()=>{}, ()=>{}, ()=>{}, ()=>{},
  function(){ return { observe(){}, disconnect(){} }; }, dom.window.Event);

console.log('t44 — hidden shim selects');

document.querySelectorAll('select').forEach(enhanceSelect);

for (const id of ['seasonSelect','scoutGradeSelect']) {
  const s = document.getElementById(id);
  ok(`#${id} is still hidden`, s && s.hidden);
  ok(`#${id} got NO visible .cs wrapper`, s && !s.closest('.cs'),
     s && s.closest('.cs') ? 'wrapper was created' : '');
}

ok('no .cs wrapper is a direct child of <body>',
   ![...document.body.children].some(el => el.classList.contains('cs')),
   [...document.body.children].filter(el=>el.classList.contains('cs')).length + ' found');

// Skills reveals these later — they must still be enhanced
for (const id of ['stateSelect','subregionSelect']) {
  const s = document.getElementById(id);
  ok(`#${id} (inside a hidden WRAPPER) is still enhanced`, s && !!s.closest('.cs'),
     s ? 'no .cs wrapper' : 'element missing');
}

// Normal visible selects unaffected
for (const id of ['detailSeasonSelect','rwSeasonSelect','detailGradeSelect']) {
  const s = document.getElementById(id);
  ok(`#${id} is enhanced as before`, s && !!s.closest('.cs'));
}

console.log(`\nt44: ${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
