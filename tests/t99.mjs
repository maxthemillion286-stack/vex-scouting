// t99 — the service worker must always ANSWER.
//
// Nothing has ever exercised sw.js's logic: t58 checks its version strings and
// stops there. That matters because every branch in it is a promise chain, and
// a promise chain that rejects inside event.respondWith() does not fall back —
// it hands the browser its own network-error page. At a competition venue that
// is the screen this file exists to prevent.
//
// Four paths could reject, all found by reading the wiring rather than by any
// test:
//
//   1. networkFirstWithTimeout's TIMEOUT branch resolved with
//      `cached().then(hit => hit || network)` and nothing else. Cache misses,
//      network later fails → that inner promise rejects, and Promise.race
//      settles with whichever branch settles FIRST. Venue wifi hangs and then
//      drops, which is exactly that order.
//   2. The font branch's `.catch(() => cached)` returned `cached` — on the
//      only path that can reach it, `cached` is undefined, because a miss is
//      why we were fetching. respondWith(undefined) fails the request.
//   3. The static-asset branch had no failure path at all.
//   4. cache.put() rejects on a partial or opaque response, and an unhandled
//      rejection inside a worker is invisible.
//
// The test loads the real sw.js in a vm with stubbed globals, so it is the
// shipped file being asked the question, not a paraphrase of it.
import fs from 'fs';
import vm from 'vm';
let pass = 0, fail = 0;
const ok = (n, c, e) => { c ? (pass++, console.log('  ok   ' + n)) : (fail++, console.log('  FAIL ' + n + (e ? '\n         ' + e : ''))); };

const SW = fs.readFileSync('../sw.js', 'utf8');

// ── A world the worker can run in ──────────────────────────────────────────
function makeWorld({ net = 'ok', seed = {}, putThrows = false } = {}) {
  const stores = new Map();
  const store = name => {
    if (!stores.has(name)) stores.set(name, new Map());
    return stores.get(name);
  };
  const R = class FakeResponse {
    constructor(body, init = {}) {
      this._body = body;
      this.status = init.status ?? 200;
      this.statusText = init.statusText || '';
      // init.headers may be a FakeHeaders (the worker builds one to add the
      // X-From-Cache tag) or a plain object.
      this.headers = init.headers && init.headers.m instanceof Map
        ? new Map(init.headers.m)
        : new Map(Object.entries(init.headers || {}));
      this.type = init.type || 'basic';
    }
    get ok() { return this.status >= 200 && this.status < 300; }
    clone() { return new R(this._body, { status: this.status, headers: {} }); }
    blob() { return Promise.resolve(this._body); }
    text() { return Promise.resolve(String(this._body)); }
  };
  const H = class FakeHeaders {
    constructor(init) { this.m = new Map(init instanceof Map ? init : (init && init.m) || Object.entries(init || {})); }
    set(k, v) { this.m.set(k, v); }
    get(k) { return this.m.get(k); }
  };
  // Seeded entries must be Responses, not strings — the worker reads .headers
  // and .blob() off whatever the cache hands back. Seeding raw strings made
  // cached() throw, and the new catch turned that into a silent "Offline",
  // which is right for the app and useless for a test.
  for (const [cacheName, entries] of Object.entries(seed)) {
    for (const [url, body] of Object.entries(entries)) {
      store(cacheName).set(url, new R(body, { status: 200 }));
    }
  }

  const hung = [];   // resolvers for requests we deliberately leave in flight
  const fetchImpl = (req) => {
    const url = typeof req === 'string' ? req : req.url;
    if (net === 'ok') return Promise.resolve(new R('live:' + url, { status: 200 }));
    if (net === 'reject') return Promise.reject(new TypeError('Failed to fetch'));
    // 'hang-then-reject' is the venue-wifi case: it answers nothing for a
    // while, then drops. That ORDER is what made the race reject.
    return new Promise((_, rej) => hung.push(() => rej(new TypeError('Failed to fetch'))));
  };

  const caches = {
    open: (name) => Promise.resolve({
      keys: () => Promise.resolve([...store(name).keys()]),
      delete: (k) => { store(name).delete(k); return Promise.resolve(true); },
      put: (req, res) => putThrows
        ? Promise.reject(new TypeError('Failed to execute put: partial response'))
        : (store(name).set(typeof req === 'string' ? req : req.url, res), Promise.resolve())
    }),
    match: (req) => {
      const url = typeof req === 'string' ? req : req.url;
      for (const s of stores.values()) if (s.has(url)) return Promise.resolve(s.get(url));
      return Promise.resolve(undefined);
    },
    keys: () => Promise.resolve([...stores.keys()]),
    delete: (k) => { stores.delete(k); return Promise.resolve(true); }
  };

  const listeners = {};
  const self = {
    addEventListener: (t, fn) => { (listeners[t] = listeners[t] || []).push(fn); },
    skipWaiting: () => {},
    clients: { claim: () => Promise.resolve() }
  };
  const ctx = {
    self, caches, fetch: fetchImpl, Response: R, Headers: H, URL,
    // The worker races a timer against the network. Firing it immediately is
    // how the timeout branch gets tested at all.
    setTimeout: (fn) => { Promise.resolve().then(fn); return 0; },
    console
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(SW, ctx, { filename: 'sw.js' });
  return { listeners, stores, R, hung, ctx };
}

// Fire a fetch event and return whatever respondWith was given.
function ask(world, url, { mode = 'navigate', destination = 'document' } = {}) {
  const handler = world.listeners.fetch && world.listeners.fetch[0];
  if (!handler) throw new Error('sw.js registered no fetch listener');
  let answered = null;
  handler({
    request: { url, method: 'GET', mode, destination },
    respondWith: (p) => { answered = p; }
  });
  return answered;
}

const settle = async (p) => {
  if (p === undefined || p === null) return { kind: 'not-answered' };
  try { return { kind: 'resolved', value: await p }; }
  catch (e) { return { kind: 'rejected', error: String(e && e.message || e) }; }
};

console.log('t99 — the service worker always answers');

// ══ 1. The venue-wifi case: hang past the timeout, then drop ════════════════
console.log('\n· a connection that hangs, then drops');
{
  const w = makeWorld({ net: 'hang-then-reject' });
  const p = ask(w, 'https://vexscout.test/');
  await new Promise(r => setImmediate(r));   // let the instant timer fire
  w.hung.forEach(f => f());                  // now the connection drops
  const r = await settle(p);
  ok('the navigation is answered at all', r.kind !== 'not-answered');
  ok('and it RESOLVES rather than rejecting', r.kind === 'resolved',
    r.kind === 'rejected' ? r.error + ' — respondWith on a rejected promise gives the browser its own error page' : '');
  ok('with a real Response', r.kind === 'resolved' && r.value && typeof r.value.status === 'number',
    JSON.stringify(r.value && r.value.status));
  ok('...saying it is offline', r.kind === 'resolved' && r.value.status === 503, String(r.value && r.value.status));
}
{
  // Same shape, on the API path, where the timeout is longer but the wiring
  // is identical.
  const w = makeWorld({ net: 'hang-then-reject' });
  const p = ask(w, 'https://vexscout.test/api/proxy?path=/teams', { mode: 'cors', destination: '' });
  await new Promise(r => setImmediate(r));
  w.hung.forEach(f => f());
  const r = await settle(p);
  ok('an API call resolves too', r.kind === 'resolved', r.error || '');
  ok('with the JSON the page expects, not a rejection',
    r.kind === 'resolved' && r.value.status === 503, String(r.value && r.value.status));
}

// ══ 2. A cached copy still wins when the network is slow ═══════════════════
console.log('\n· a cached copy is still preferred to nothing');
{
  const build = (SW.match(/const CACHE_NAME = '([^']+)'/) || [])[1];
  const w = makeWorld({ net: 'hang-then-reject',
    seed: { [build]: { 'https://vexscout.test/': 'cached-shell' } } });
  const p = ask(w, 'https://vexscout.test/');
  await new Promise(r => setImmediate(r));
  w.hung.forEach(f => f());
  const r = await settle(p);
  ok('the cached shell is served', r.kind === 'resolved' && r.value !== undefined, r.error || '');
  ok('and tagged so the page knows it is not live',
    r.kind === 'resolved' && r.value.headers && r.value.headers.get('X-From-Cache') === '1');
}

// ══ 3. A legal page must not be answered with the app ══════════════════════
console.log('\n· the /index.html fallback is scoped');
{
  const build = (SW.match(/const CACHE_NAME = '([^']+)'/) || [])[1];
  const w = makeWorld({ net: 'reject',
    seed: { [build]: { '/index.html': 'the-whole-app' } } });
  const r = await settle(ask(w, 'https://vexscout.test/privacy.html'));
  ok('an uncached legal page still answers', r.kind === 'resolved', r.error || '');
  ok('and does NOT answer with the app shell',
    r.kind === 'resolved' && (await r.value.blob()) !== 'the-whole-app',
    'rendering the scouting app under /privacy.html');
  // While the app itself still gets its fallback.
  const r2 = await settle(ask(makeWorld({ net: 'reject',
    seed: { [build]: { '/index.html': 'the-whole-app' } } }), 'https://vexscout.test/'));
  ok('the app itself still falls back to its shell',
    r2.kind === 'resolved' && r2.value && (await r2.value.blob()) === 'the-whole-app',
    JSON.stringify(r2.value && r2.value._body));
}

// ══ 4. Fonts and static assets ═════════════════════════════════════════════
console.log('\n· subresources');
{
  const r = await settle(ask(makeWorld({ net: 'reject' }),
    'https://fonts.gstatic.com/s/rajdhani/v1/x.woff2', { mode: 'no-cors', destination: 'font' }));
  ok('an uncached font offline resolves', r.kind === 'resolved', r.error || '');
  ok('...to a Response rather than undefined', r.kind === 'resolved' && r.value !== undefined,
    'respondWith(undefined) fails the request outright');
}
{
  const r = await settle(ask(makeWorld({ net: 'reject' }),
    'https://vexscout.test/legal.css', { mode: 'no-cors', destination: 'style' }));
  ok('an uncached stylesheet offline resolves', r.kind === 'resolved', r.error || '');
  ok('...to a Response', r.kind === 'resolved' && r.value && typeof r.value.status === 'number');
}

// ══ 5. A cache that refuses the write must not break the answer ════════════
console.log('\n· a cache write that throws');
{
  const w = makeWorld({ net: 'ok', putThrows: true });
  const rejections = [];
  const onRej = (e) => rejections.push(String(e && e.message || e));
  process.on('unhandledRejection', onRej);
  const r = await settle(ask(w, 'https://vexscout.test/'));
  await new Promise(res => setTimeout(res, 60));
  process.off('unhandledRejection', onRej);
  ok('the live response is still returned', r.kind === 'resolved' && r.value && r.value.ok, r.error || '');
  ok('and the failed write raised no unhandled rejection', rejections.length === 0, rejections.join(' | '));
}

// ══ 6. The plumbing the rest of the app depends on ═════════════════════════
console.log('\n· the parts other tests assume');
{
  const w = makeWorld({ net: 'ok' });
  ok('install and activate are registered',
    !!w.listeners.install && !!w.listeners.activate);
  ok('a message listener answers the version question', !!w.listeners.message);
  let told = null;
  w.listeners.message[0]({ data: { type: 'VERSION' }, ports: [{ postMessage: v => { told = v; } }] });
  ok('and names the cache it is running',
    told && told.cache === (SW.match(/const CACHE_NAME = '([^']+)'/) || [])[1], JSON.stringify(told));
  // A non-GET must be left alone entirely, or the worker would swallow posts.
  const handler = w.listeners.fetch[0];
  let touched = false;
  handler({ request: { url: 'https://vexscout.test/x', method: 'POST', mode: 'cors' },
            respondWith: () => { touched = true; } });
  ok('a POST is not intercepted', touched === false);
}

console.log(`\nt99: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
