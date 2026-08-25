// t61 — the anchoring form must stay closed until asked for.
import fs from 'fs';
let pass=0, fail=0;
const ok=(n,c,e)=>{c?(pass++,console.log('  ok   '+n)):(fail++,console.log('  FAIL '+n+(e?'\n         '+e:'')));};
const idx = fs.readFileSync('../index.html','utf8');
const src = idx.match(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/)[1];

console.log('t61 — collapsed anchor form');
const line = src.match(/const formOpen = [^;]+;/)[0];
console.log('         ' + line);

ok('the form opens only for the day the user picked', line === "const formOpen = ctx.calDay === day;", line);
ok('it no longer auto-opens on single-day events', !/days\.length === 1/.test(line));
ok('it no longer auto-opens when there is no stream yet', !/!cal &&/.test(line));

// Exercise the condition rather than only reading it
const isOpen = new Function('ctx','day', 'const formOpen = ctx.calDay === day; return formOpen;');
ok('closed when nothing is selected', isOpen({ calDay: null }, '2026-03-07') === false);
ok('closed for a day other than the selected one', isOpen({ calDay: '2026-03-08' }, '2026-03-07') === false);
ok('open for the selected day', isOpen({ calDay: '2026-03-07' }, '2026-03-07') === true);

ok('the + button is what opens it', /rewatchCalibrateDay\('\$\{day\}'\)/.test(src) && /\+ ADD STREAM/.test(src));
ok('the same button closes it again', /formOpen \? 'CANCEL' : '\+ ADD STREAM'/.test(src));
ok('a calibrated day shows RESET instead', /rewatchClearCal\('\$\{day\}'\)/.test(src));

console.log(`\nt61: ${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
