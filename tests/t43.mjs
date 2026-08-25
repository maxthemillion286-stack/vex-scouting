// t43 — the .input-label overlap fix.
//
// The global rule is `position:absolute; top:-18px`, which lifts a label out of
// its own row and onto whatever sits above it. Every tab panel must override
// that back to static so the label occupies its own height in flow.
//
// LIMITATION, stated plainly: jsdom has no layout engine. getBoundingClientRect
// returns zeroes, so this CANNOT prove two boxes stopped overlapping visually.
// What it does prove is that the cascade resolves to `position: static` for
// labels in every tab — which is the mechanism the fix relies on. A real
// browser check is still required before trusting the visual result.

import fs from 'fs';
import { JSDOM } from 'jsdom';

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '\n         ' + extra : '')); }
};

const html = fs.readFileSync(process.argv[2] || '../index.html', 'utf8');
const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true });
const { document, getComputedStyle } = dom.window;

console.log('t43 — input-label overlap fix');

const TABS = ['tab-scout', 'tab-skills', 'tab-tournament', 'tab-rewatch', 'tab-simulator'];

// ── the baseline the fix is overriding ────────────────────────────────────
{
  const el = document.createElement('span');
  el.className = 'input-label';
  document.body.appendChild(el);           // outside any tab panel
  const cs = getComputedStyle(el);
  ok('unscoped .input-label is still absolute (baseline intact)',
     cs.position === 'absolute', 'got: ' + cs.position);
  el.remove();
}

// ── every tab overrides it ────────────────────────────────────────────────
for (const id of TABS) {
  const panel = document.getElementById(id);
  if (!panel) { ok(`#${id} exists`, false); continue; }

  const label = panel.querySelector('.input-label');
  ok(`#${id} has at least one .input-label to check`, !!label);
  if (!label) continue;

  const cs = getComputedStyle(label);
  ok(`#${id} label is in flow (position:static)`,
     cs.position === 'static', 'got: ' + cs.position);
  ok(`#${id} label is display:block`,
     cs.display === 'block', 'got: ' + cs.display);

  const wrap = label.closest('.input-wrap');
  if (wrap) {
    const ws = getComputedStyle(wrap);
    ok(`#${id} .input-wrap is a column flexbox`,
       ws.display === 'flex' && ws.flexDirection === 'column',
       `got: ${ws.display} / ${ws.flexDirection}`);
  }
}

// ── labels injected later by JS must inherit the same treatment ───────────
// Tournament renders its SORT BY / DIVISION selects into #tournamentResults
// after a fetch; those labels are inside the panel, so they must match.
{
  const panel = document.getElementById('tab-tournament');
  const probe = document.createElement('div');
  probe.className = 'input-wrap select-wrap';
  probe.innerHTML = '<span class="input-label">SORT BY</span><select></select>';
  panel.appendChild(probe);
  const cs = getComputedStyle(probe.querySelector('.input-label'));
  ok('dynamically injected tournament label is also static',
     cs.position === 'static', 'got: ' + cs.position);
  probe.remove();
}

// ── the Jumper divider (bug 2) ────────────────────────────────────────────
{
  const or = document.querySelector('#tab-rewatch .rw-or-row');
  ok('#tab-rewatch has the "or watch a whole event" divider', !!or);
  if (or) {
    const cs = getComputedStyle(or);
    const mt = parseFloat(cs.marginTop) || 0;
    ok('divider has clearance above it (margin-top >= 20px)',
       mt >= 20, 'got: ' + cs.marginTop);

    // The element that used to be overlapped by the label below it
    const nextLabel = or.nextElementSibling &&
                      or.nextElementSibling.querySelector('.input-label');
    ok('the label below the divider exists and is in flow',
       !!nextLabel && getComputedStyle(nextLabel).position === 'static',
       nextLabel ? 'got: ' + getComputedStyle(nextLabel).position : 'no label found');
  }
}

console.log(`\nt43: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
