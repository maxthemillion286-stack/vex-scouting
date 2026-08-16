// Vercel Serverless Function — proxies requests to the VEX RobotEvents API
//
// UPDATED: As of 2026, the API moved from robotevents.com to events.vex.com
// due to the VEX/RECF split. Tokens transferred over and remain valid.
//
// Supports MULTIPLE TOKENS for higher rate limits:
//   - Set ROBOTEVENTS_TOKEN, ROBOTEVENTS_TOKEN_2, ROBOTEVENTS_TOKEN_3, etc.
//   - Tokens are rotated round-robin per request
//   - On 429 (rate limit), automatically falls over to the next token
//   - The response carries X-Token-Count so the frontend can scale its
//     request concurrency to match the available rate-limit headroom.

const cache = new Map(); // path -> { data, status, expires }
const DEFAULT_TTL_MS = 60 * 1000;       // 1 min for general data
const LONG_TTL_MS = 5 * 60 * 1000;      // 5 min for stable data
const SHORT_TTL_MS = 15 * 1000;         // 15s for live match data

// Round-robin counter persists across requests in the same Vercel instance
let tokenCursor = 0;

function getTokens() {
  const tokens = [];
  for (let i = 1; i <= 10; i++) {
    const key = i === 1 ? 'ROBOTEVENTS_TOKEN' : `ROBOTEVENTS_TOKEN_${i}`;
    const val = process.env[key];
    if (val) tokens.push(val);
  }
  return tokens;
}

// Determine cache TTL based on what's being requested
function ttlFor(path) {
  // A TEAM's season match history changes only when they play — cache long.
  // (Previously this fell through to the generic '/matches' 15s rule, which
  // forced constant refetching of hundreds of near-static team histories.)
  if (/^\/teams\/\d+\/matches/.test(path)) return LONG_TTL_MS;
  // Event rosters are near-static once registration settles
  if (/^\/events\/\d+\/teams/.test(path)) return LONG_TTL_MS;
  // Skills rankings (legacy) and team details rarely change — cache longer
  if (path.startsWith('legacy:/seasons/') && path.includes('/skills')) return LONG_TTL_MS;
  if (path.match(/^\/teams\/\d+$/)) return LONG_TTL_MS;
  if (path.startsWith('/teams?')) return LONG_TTL_MS;
  if (path.startsWith('/seasons')) return LONG_TTL_MS;
  // LIVE data at a running event changes fast — keep these short
  if (path.includes('/matches')) return SHORT_TTL_MS;   // event/division matches
  if (path.includes('/rankings')) return SHORT_TTL_MS;
  return DEFAULT_TTL_MS;
}


// ── Payload slimming ───────────────────────────────────────────────────────
// The season skills standings return every team worldwide with fully nested
// team/event/season objects — several megabytes of JSON, most of which the app
// never reads. On a competition's wifi that download is the single slowest
// thing the app does. Strip it to the fields the client actually uses before it
// ever crosses the network. Everything is still computed from real data; we're
// only dropping fields nobody reads.
function slimSeasonSkills(data) {
  const items = Array.isArray(data) ? data : (data && data.data) || null;
  if (!items || !Array.isArray(items)) return data;
  const out = items.map(it => {
    const t = it.team || {};
    return {
      rank: it.rank,
      scoreDriver: it.scoreDriver ?? it.scores?.driver ?? 0,
      scoreProg: it.scoreProg ?? it.scores?.programming ?? 0,
      score: it.score ?? it.scores?.score ?? 0,
      team: {
        id: t.id,
        team: t.team,
        program: t.program,
        gradeLevel: t.gradeLevel,
        region: t.region,
        eventRegion: t.eventRegion,
        country: t.country
      }
    };
  });
  return Array.isArray(data) ? out : { ...data, data: out };
}

function slimForPath(path, data) {
  if (path.startsWith('legacy:/seasons/') && path.includes('/skills')) return slimSeasonSkills(data);
  return data;
}

export default async function handler(req, res) {
  const path = req.query.path;
  if (!path) {
    return res.status(400).json({ error: 'Missing path parameter' });
  }

  let url;
  let useAuth = true;
  if (path.startsWith('legacy:')) {
    // Legacy endpoints (used for season skills standings) — public, no auth needed
    url = `https://events.vex.com/api${path.slice(7)}`;
    useAuth = false;
  } else if (path.startsWith('streams:')) {
    // ── Finding an event's stream link ───────────────────────────────────
    // The RobotEvents API does NOT expose an event's description or its
    // webcast section, so there is nothing in the API to read. The links are
    // only on the event's public web page, which the browser can't fetch
    // itself (no CORS). So we fetch the page here and pull the links out.
    //
    // Deliberately regex rather than a DOM parser: it needs no dependency and
    // the page's markup changes more often than URL formats do.
    const sku = path.slice(8).toUpperCase();
    if (!/^RE-[A-Z0-9-]{3,40}$/.test(sku)) {
      return res.status(400).json({ ok: false, reason: 'bad-sku' });
    }
    const cacheKey = 'streams:' + sku;
    const hit = cache.get(cacheKey);
    if (hit && hit.expires > Date.now()) {
      res.setHeader('X-Cache', 'HIT');
      return res.status(200).json(hit.data);
    }
    try {
      const pageUrl = `https://www.robotevents.com/robot-competitions/vex-robotics-competition/${sku}.html`;
      const r = await fetch(pageUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml',
          'Accept-Language': 'en-US,en;q=0.9'
        }
      });
      if (!r.ok) {
        const out = { ok: false, reason: 'page-' + r.status, streams: [] };
        return res.status(200).json(out);
      }
      const rawHtml = await r.text();

      // ── Decode BEFORE matching, not after ────────────────────────────────
      // Two ways a perfectly good URL used to get lost here:
      //
      //   1. `&amp;` — in markup, `?v=ABC&amp;t=90` is a single URL, but the
      //      regex sees `&`, `a`, `m`, `p`, `;` and stops dead at the `;`,
      //      because `;` is not in the character class. Decoding afterwards
      //      was too late: the match had already been truncated to `?v=ABC&`.
      //
      //   2. `https:\/\/...` — inside the inline JSON blobs the page embeds,
      //      slashes are backslash-escaped. `\/` never matches `\/` in the
      //      pattern's literal `//`, so those URLs were skipped entirely —
      //      and on many event pages the JSON blob is the ONLY place the
      //      webcast link appears.
      //
      // Normalising the whole document up front means the matcher only ever
      // sees plain URLs, and one code path handles every source on the page.
      const html = rawHtml
        .replace(/\\\//g, '/')        // escaped slashes in inline JSON
        .replace(/\\u0026/gi, '&')    // JSON-escaped ampersand
        .replace(/&amp;/gi, '&')      // HTML-entity ampersand
        .replace(/&#0*38;/g, '&')     // numeric-entity ampersand
        .replace(/&#x0*26;/gi, '&');  // hex-entity ampersand

      const STREAM_URL_RE = /https?:\/\/(?:www\.)?(?:youtube\.com\/(?:watch\?v=|live\/|embed\/)|youtu\.be\/|player\.vimeo\.com\/video\/|vimeo\.com\/(?:event\/)?)[\w?=&\/-]+/gi;

      const found = [];
      const seen = new Set();
      const add = (url, source) => {
        // Entities are already gone; this only trims punctuation the URL
        // picked up from the markup around it (quotes, a closing paren, a
        // sentence-ending period).
        let u = url.replace(/[\\"'<>).,;]+$/, '');
        if (seen.has(u)) return;
        seen.add(u);
        found.push({ url: u, source });
      };

      // Anything inside a webcast-ish block gets priority
      const webcastBlock = html.match(/(?:id|class)="[^"]*webcast[^"]*"[\s\S]{0,4000}/i);
      if (webcastBlock) {
        const m = webcastBlock[0].match(STREAM_URL_RE) || [];
        for (const u of m) add(u, 'webcast-section');
      }
      // Then anywhere on the page
      const anywhere = html.match(STREAM_URL_RE) || [];
      for (const u of anywhere) add(u, 'page');

      const out = { ok: found.length > 0, streams: found.slice(0, 12) };
      cache.set(cacheKey, { data: out, status: 200, expires: Date.now() + LONG_TTL_MS });
      res.setHeader('Cache-Control', 'public, s-maxage=3600, stale-while-revalidate=3600');
      return res.status(200).json(out);
    } catch (err) {
      return res.status(200).json({ ok: false, reason: 'fetch-failed', streams: [] });
    }
  } else if (path.startsWith('youtube:')) {
    // ── Stream start lookup ──────────────────────────────────────────────
    // A livestream's `actualStartTime` is the wall-clock moment the broadcast
    // began. With it, a match's position in the video is pure arithmetic:
    //     videoSeconds = (match.started - actualStartTime) / 1000
    // ...which removes the need for a manual anchor entirely.
    //
    // The key stays server-side deliberately. A YouTube key shipped to the
    // browser is readable by anyone and can be scraped and abused against your
    // quota; proxying keeps it private and lets us cache the result.
    const ytKey = process.env.YOUTUBE_API_KEY;
    const videoId = path.slice(8);
    if (!ytKey) return res.status(200).json({ ok: false, reason: 'no-key' });
    if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) {
      return res.status(400).json({ ok: false, reason: 'bad-id' });
    }
    try {
      const r = await fetch(
        'https://www.googleapis.com/youtube/v3/videos' +
        '?part=liveStreamingDetails&id=' + encodeURIComponent(videoId) +
        '&key=' + encodeURIComponent(ytKey)
      );
      const j = await r.json();
      const item = (j.items || [])[0];
      const d = item && item.liveStreamingDetails;
      if (!d) return res.status(200).json({ ok: false, reason: 'not-a-livestream' });

      if (d.actualStartTime) {
        // Lookups are immutable once a broadcast has ended — cache hard.
        res.setHeader('Cache-Control', 'public, s-maxage=86400, stale-while-revalidate=86400');
        return res.status(200).json({ ok: true, status: 'started', actualStartTime: d.actualStartTime });
      }
      if (d.scheduledStartTime) {
        // Scheduled but not yet live — no offset exists yet.
        return res.status(200).json({ ok: false, reason: 'not-started', scheduledStartTime: d.scheduledStartTime });
      }
      return res.status(200).json({ ok: false, reason: 'not-a-livestream' });
    } catch (err) {
      return res.status(200).json({ ok: false, reason: 'lookup-failed' });
    }
  } else {
    // Main authenticated v2 API
    url = `https://events.vex.com/api/v2${path}`;
  }

  const tokens = useAuth ? getTokens() : [];
  if (useAuth && tokens.length === 0) {
    return res.status(500).json({ error: 'No API tokens configured' });
  }
  // Tell the frontend how much parallel headroom exists
  res.setHeader('X-Token-Count', String(Math.max(1, tokens.length)));

  // Check cache
  const cached = cache.get(path);
  if (cached && cached.expires > Date.now()) {
    res.setHeader('X-Cache', 'HIT');
    if (ttlFor(path) === LONG_TTL_MS) {
      res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=300');
    }
    return res.status(cached.status).json(cached.data);
  }

  const baseHeaders = {
    'Accept': 'application/json',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
    'Accept-Language': 'en-US,en;q=0.9',
    'Referer': 'https://events.vex.com/'
  };

  // Try each token until one succeeds (or we run out)
  const attempts = useAuth ? tokens.length : 1;
  let lastResponse = null;
  let lastText = '';

  for (let i = 0; i < attempts; i++) {
    const headers = { ...baseHeaders };
    if (useAuth) {
      const tokenIndex = (tokenCursor + i) % tokens.length;
      headers['Authorization'] = `Bearer ${tokens[tokenIndex]}`;
    }

    try {
      const response = await fetch(url, { headers });
      const text = await response.text();
      lastResponse = response;
      lastText = text;

      // If rate-limited or server error, try next token
      if (useAuth && (response.status === 429 || response.status >= 500) && i < attempts - 1) {
        continue;
      }

      if (useAuth) {
        tokenCursor = (tokenCursor + 1) % tokens.length;
      }

      const retryAfter = response.headers.get('Retry-After');
      if (retryAfter) res.setHeader('Retry-After', retryAfter);

      let data;
      try {
        data = slimForPath(path, JSON.parse(text));
      } catch (e) {
        data = {
          error: 'Non-JSON response from events.vex.com',
          status: response.status,
          preview: text.slice(0, 300)
        };
      }

      // Cache successful responses with smart TTL
      if (response.status >= 200 && response.status < 300) {
        cache.set(path, {
          data,
          status: response.status,
          expires: Date.now() + ttlFor(path)
        });
        if (cache.size > 1500) {
          const firstKey = cache.keys().next().value;
          cache.delete(firstKey);
        }
        // EDGE CACHING — STABLE DATA ONLY. Team histories, rosters, and skills
        // standings (5-min TTL) are served by Vercel's CDN without invoking this
        // function. Live data (event matches/rankings) deliberately gets NO edge
        // caching, so a Match Day refresh is always function-fresh.
        if (ttlFor(path) === LONG_TTL_MS) {
          res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=300');
        }
      }

      res.setHeader('X-Cache', 'MISS');
      return res.status(response.status).json(data);
    } catch (err) {
      lastResponse = null;
      lastText = err.message;
      if (i === attempts - 1) {
        return res.status(500).json({ error: err.message });
      }
    }
  }

  if (lastResponse) {
    let data;
    try {
      data = JSON.parse(lastText);
    } catch (e) {
      data = { error: 'All tokens rate-limited', status: lastResponse.status };
    }
    const retryAfter = lastResponse.headers.get('Retry-After');
    if (retryAfter) res.setHeader('Retry-After', retryAfter);
    return res.status(lastResponse.status).json(data);
  }

  return res.status(500).json({ error: 'Request failed' });
}
