// t45 — Skills controls row must fit on one line at desktop width.
//
// .container is max-width 1100 with 24px padding => 1052px of content.
// With all five selects visible (Region + State + VEX Region + Grade + Season)
// the sum of their min-widths, the flex gaps, and the LOAD RANKINGS button has
// to stay under that or the button wraps to its own line.
//
// jsdom does no layout, so this is arithmetic on the declared min-widths, not a
// measurement. It catches the row being over-subscribed; it cannot catch a
// button that renders wider than the estimate below.
import fs from 'fs'; import { JSDOM } from 'jsdom';
let pass=0, fail=0;
const ok=(n,c,e)=>{c?(pass++,console.log('  ok   '+n)):(fail++,console.log('  FAIL '+n+(e?'\n         '+e:'')));};

const { document } = new JSDOM(fs.readFileSync(process.argv[2]||'../index.html','utf8')).window;
console.log('t45 — skills row fits on one line');

const row = document.querySelector('#tab-skills .controls-row');
const wraps = [...row.querySelectorAll('.input-wrap')];
ok('all five selects are present', wraps.length === 5, 'got ' + wraps.length);

const mins = wraps.map(w => parseInt((w.getAttribute('style')||'').match(/min-width:\s*(\d+)px/)?.[1] || '200', 10));
const GAP = 10, CONTENT = 1100 - 48;
// "LOAD RANKINGS": 13 chars, 14px display font + 3px letter-spacing, 24px side padding.
const BUTTON = 13 * 11 + 13 * 3 + 48;
const total = mins.reduce((a,b)=>a+b,0) + GAP * wraps.length + BUTTON;

console.log(`         min-widths: ${mins.join(' + ')} = ${mins.reduce((a,b)=>a+b,0)}`);
console.log(`         + gaps ${GAP*wraps.length} + button ~${BUTTON} = ${total} / ${CONTENT}px`);
ok('row fits within the container content box', total <= CONTENT, `over by ${total-CONTENT}px`);
ok('at least 40px of slack for font variance', CONTENT - total >= 40, `slack ${CONTENT-total}px`);

// The button must stay the last child so it sits at the end of the row
ok('LOAD RANKINGS is the last item in the row',
   row.lastElementChild.tagName === 'BUTTON' && /LOAD RANKINGS/.test(row.lastElementChild.textContent));

// Ellipsis is what makes the narrower widths acceptable
const css = [...fs.readFileSync(process.argv[2]||'../index.html','utf8').matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map(m=>m[1]).join('');
ok('.cs-value truncates with an ellipsis', /\.cs-value\s*{[^}]*text-overflow:\s*ellipsis/.test(css));

console.log(`\nt45: ${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
