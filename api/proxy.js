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
        data = JSON.parse(text);
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
