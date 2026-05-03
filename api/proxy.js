// Vercel Serverless Function — proxies requests to RobotEvents API
//
// Supports MULTIPLE TOKENS for higher rate limits:
//   - Set ROBOTEVENTS_TOKEN, ROBOTEVENTS_TOKEN_2, ROBOTEVENTS_TOKEN_3, etc.
//   - Tokens are rotated round-robin per request
//   - On 429 (rate limit), automatically falls over to the next token

const cache = new Map(); // path -> { data, status, expires }
const DEFAULT_TTL_MS = 60 * 1000;       // 1 min for general data
const LONG_TTL_MS = 5 * 60 * 1000;      // 5 min for stable data (skills rankings, team details)
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
  // Skills rankings (legacy) and team details rarely change — cache longer
  if (path.startsWith('legacy:/seasons/') && path.includes('/skills')) return LONG_TTL_MS;
  if (path.match(/^\/teams\/\d+$/)) return LONG_TTL_MS;
  if (path.startsWith('/teams?')) return LONG_TTL_MS;
  if (path.startsWith('/seasons')) return LONG_TTL_MS;
  // Match scores during live events change often
  if (path.includes('/matches')) return SHORT_TTL_MS;
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
    url = `https://www.robotevents.com/api${path.slice(7)}`;
    useAuth = false;
  } else {
    url = `https://www.robotevents.com/api/v2${path}`;
  }

  const tokens = useAuth ? getTokens() : [];
  if (useAuth && tokens.length === 0) {
    return res.status(500).json({ error: 'No API tokens configured' });
  }

  // Check cache
  const cached = cache.get(path);
  if (cached && cached.expires > Date.now()) {
    res.setHeader('X-Cache', 'HIT');
    return res.status(cached.status).json(cached.data);
  }

  const baseHeaders = {
    'Accept': 'application/json',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
    'Accept-Language': 'en-US,en;q=0.9',
    'Referer': 'https://www.robotevents.com/'
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
          error: 'Non-JSON response from RobotEvents',
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
        // Cap cache at 500 entries
        if (cache.size > 500) {
          const firstKey = cache.keys().next().value;
          cache.delete(firstKey);
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
