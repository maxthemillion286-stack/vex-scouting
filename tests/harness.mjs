// A real browser for the tests.
//
// Every test before this one reads index.html as TEXT — regexes over source,
// or a function extracted with `new Function` and fed hand-made arguments.
// That catches a lot, and it caught nothing about the bug this harness was
// written for: the Teams tab rendered a cache that the team-number route never
// filled. Both halves were individually correct. Only walking the app from one
// screen to the next shows the join.
//
// So: load the real index.html in jsdom, stub the ONE thing that touches the
// outside world (fetch → /api/proxy), and drive the real handlers.
import fs from 'fs';
import { JSDOM, VirtualConsole } from 'jsdom';

export const FIXTURES = {
  // A two-day, two-division event with both grades present — the shape that
  // has produced most of this project's bugs.
  event: {
    id: 55001, sku: 'RE-V5RC-25-0191', name: 'Bots @ Bristol Signature Event',
    start: '2026-02-28T09:00:00-05:00', end: '2026-03-01T18:00:00-05:00',
    season: { id: 197 },
    location: { region: 'Connecticut' },
    divisions: [{ id: 1, name: 'Alpha' }, { id: 2, name: 'Beta' }]
  },
  // 66449A is High School; 12345B is Middle School. The grade split is the
  // reason the team list can come back empty.
  teams: [
    { id: 9001, number: '66449A', team_name: 'Wired Up', grade: 'High School' },
    { id: 9002, number: '1234X', team_name: 'Gear Grinders', grade: 'High School' },
    { id: 9003, number: '12345B', team_name: 'Middle Bots', grade: 'Middle School' }
  ]
};

// A second event, in a different week and a different grade, so state that
// leaks from one event to the next has somewhere visible to land.
FIXTURES.eventB = {
  id: 55002, sku: 'RE-V5RC-25-0649', name: 'Middle School Spring Classic',
  start: '2026-04-11T09:00:00-04:00', end: '2026-04-11T18:00:00-04:00',
  season: { id: 197 }, location: { region: 'Vermont' }, divisions: [{ id: 1, name: null }]
};

const j = (data, meta) => ({ data, meta: meta || { last_page: 1, current_page: 1 } });

// The proxy, as far as the app can tell. Every route the UI actually calls;
// anything unrecognised is recorded and answered empty, so a test can assert
// on what was NOT handled rather than silently passing.
export function makeRouter(opts = {}) {
  const seen = [];
  const fail = opts.fail || {};          // substring → http status
  const empty = new Set(opts.empty || []); // substring → answer with []
  const router = async (url) => {
    const u = new URL(url, 'https://vexscout.test');
    const raw = u.searchParams.get('path') || u.pathname + u.search;
    const path = decodeURIComponent(raw);
    seen.push(path);
    for (const [frag, status] of Object.entries(fail)) {
      if (path.includes(frag)) return { status, body: { error: 'stubbed failure' } };
    }
    for (const frag of empty) if (path.includes(frag)) return { status: 200, body: j([]) };

    const E = FIXTURES.event;
    if (path.startsWith('/teams?')) {
      const m = path.match(/number\[\]=([^&]+)/);
      const num = m ? decodeURIComponent(m[1]).toUpperCase() : null;
      const v5rc = /program\[\]=1/.test(path);
      const hit = FIXTURES.teams.filter(t => !num || t.number === num);
      return { status: 200, body: j(v5rc ? hit : []) };
    }
    if (/^\/teams\/\d+\/events/.test(path)) return { status: 200, body: j([E]) };
    if (/^\/teams\/\d+\/matches/.test(path)) return { status: 200, body: j(matchesFor(1)) };
    if (/^\/events\/\d+\/teams/.test(path)) return { status: 200, body: j(FIXTURES.teams) };
    if (/^\/events\/\d+\/divisions\/(\d+)\/rankings/.test(path)) {
      const div = +path.match(/divisions\/(\d+)/)[1];
      return { status: 200, body: j(FIXTURES.teams.slice(0, 2).map((t, i) => ({
        rank: i + 1, wins: 5 - i, losses: i, ties: 0,
        team: { id: t.id, name: t.number }, division: { name: div === 1 ? 'Alpha' : 'Beta' }
      }))) };
    }
    if (/^\/events\/(\d+)\/divisions\/(\d+)\/matches/.test(path)) {
      const [, evId, divId] = path.match(/^\/events\/(\d+)\/divisions\/(\d+)\/matches/);
      return { status: 200, body: j(matchesFor(+divId, +evId)) };
    }
    if (/^\/events\/\d+\/skills/.test(path)) {
      return { status: 200, body: j(FIXTURES.teams.map((t, i) => ({
        team: { id: t.id, name: t.number }, type: 'driver', rank: i + 1, score: 100 - i * 10,
        event: { id: E.id }
      }))) };
    }
    if (/^\/events\/\d+\/awards/.test(path)) return { status: 200, body: j([]) };
    if (path.startsWith('/events?')) {
      const wantB = /id\[\]=55002/.test(path) || /sku\[\]=RE-V5RC-25-0649/.test(path);
      return { status: 200, body: j([wantB ? FIXTURES.eventB : E]) };
    }
    if (path.startsWith('legacy:')) return { status: 200, body: { data: [] } };
    if (path.startsWith('/seasons')) return { status: 200, body: j([{ id: 197, name: '2025-2026' }]) };
    if (path.startsWith('streams') || path.includes('path=streams')) {
      return { status: 200, body: { streams: [], reason: 'none' } };
    }
    return { status: 200, body: j([]) };
  };
  router.seen = seen;
  return router;
}

// Two days of qualification matches, both divisions, so day handling is real.
function matchesFor(divId, evId) {
  const eventId = evId || FIXTURES.event.id;
  const B = eventId === FIXTURES.eventB.id;
  const out = [];
  // Event B is a single day in April; event A is two days in February. Nothing
  // about them overlaps, so state carried from one to the other is obvious.
  const days = B ? ['2026-04-11'] : ['2026-02-28', '2026-03-01'];
  let id = divId * 1000 + eventId;
  for (let d = 0; d < days.length; d++) {
    for (let n = 1; n <= 3; n++) {
      const t = `${days[d]}T${String(10 + n).padStart(2, '0')}:00:00-05:00`;
      out.push({
        id: ++id, name: `Qualification ${n + d * 3}`, matchnum: n + d * 3, round: 2,
        started: t, scheduled: t, event: { id: eventId },
        alliances: [
          { color: 'red', score: 100 + n, teams: [{ team: { id: 9001, name: '66449A' } }, { team: { id: 9002, name: '1234X' } }] },
          { color: 'blue', score: 90 + n, teams: [{ team: { id: 9003, name: '12345B' } }, { team: { id: 9004, name: '777Z' } }] }
        ]
      });
    }
  }
  return out;
}

// Boot the real page. Returns the window plus everything that went wrong.
export async function boot(opts = {}) {
  const html = fs.readFileSync('../index.html', 'utf8');
  const router = opts.router || makeRouter(opts);
  const errors = [];

  const vc = new VirtualConsole();
  vc.on('jsdomError', e => errors.push('jsdomError: ' + (e.message || e)));

  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    url: 'https://vexscout.test/',
    pretendToBeVisual: true,
    virtualConsole: vc,
    beforeParse(win) {
      win.fetch = async (url) => {
        const r = await router(String(url));
        const text = typeof r.body === 'string' ? r.body : JSON.stringify(r.body);
        const res = {
          ok: r.status >= 200 && r.status < 300, status: r.status,
          headers: { get: () => null },
          json: async () => JSON.parse(text),
          text: async () => text,
          clone() { return res; }
        };
        return res;
      };
      win.scrollTo = () => {};
      // Some browsers throw on ANY localStorage access when site data is
      // blocked (Safari private browsing, "block all cookies"). opts.noStorage
      // reproduces that exactly.
      if (opts.noStorage) {
        const boom = () => { throw new DOMException('The operation is insecure.', 'SecurityError'); };
        Object.defineProperty(win, 'localStorage', {
          configurable: true,
          get: () => ({ getItem: boom, setItem: boom, removeItem: boom, key: boom, get length() { return boom(); } })
        });
      }
      win.matchMedia = win.matchMedia || (() => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }));
      // Service workers are not what these tests are about. Delete the
      // property rather than setting it undefined, so `'serviceWorker' in
      // navigator` is false — the same shape a browser without support has.
      try { delete win.navigator.serviceWorker; } catch (e) {}
      if ('serviceWorker' in win.navigator) {
        Object.defineProperty(win.navigator, 'serviceWorker', {
          value: { register: async () => ({ update() {}, addEventListener() {} }), addEventListener() {} },
          configurable: true
        });
      }
      win.addEventListener('error', e => errors.push('error: ' + (e.error?.stack || e.message)));
      win.addEventListener('unhandledrejection', e => errors.push('unhandledrejection: ' + (e.reason?.stack || e.reason)));
    }
  });

  const win = dom.window;
  await new Promise(res => {
    if (win.document.readyState === 'complete') return res();
    win.addEventListener('load', res);
  });
  await settle(win);
  return { win, dom, errors, router };
}

// Let pending promises and timers drain. The app fires several fetches per
// screen and renders when they land, so tests have to wait for quiet.
export async function settle(win, rounds = 60) {
  for (let i = 0; i < rounds; i++) await new Promise(r => setTimeout(r, 4));
}

export const text = (win, id) => (win.document.getElementById(id)?.textContent || '').replace(/\s+/g, ' ').trim();
export const html = (win, id) => win.document.getElementById(id)?.innerHTML || '';
