// Vercel Serverless Function — proxies requests to RobotEvents API
//
// Supports MULTIPLE TOKENS for higher rate limits:
//   - Set ROBOTEVENTS_TOKEN, ROBOTEVENTS_TOKEN_2, ROBOTEVENTS_TOKEN_3, etc.
//   - Tokens are rotated round-robin per request
//   - On 429 (rate limit), automatically falls over to the next token
//
// Add new tokens later by setting ROBOTEVENTS_TOKEN_4, _5, etc. in Vercel.

const cache = new Map(); // path -> { data, status, expires }
const CACHE_TTL_MS = 30 * 1000;

// Round-robin counter persists across requests in the same Vercel instance
let tokenCursor = 0;

function getTokens() {
  const tokens = [];
  // Read up to 10 token slots from environment
  for (let i = 1; i <= 10; i++) {
    const key = i === 1 ? 'ROBOTEVENTS_TOKEN' : `ROBOTEVENTS_TOKEN_${i}`;
    const val = process.env[key];
    if (val) tokens.push(val);
  }
  return tokens;
}

export default async function handler(req, res) {
  const path = req.query.path;
  if (!path) {
    return res.status(400).json({ error: 'Missing path parameter' });
  }

  // Determine which API to use
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
    return res.status(cached.status).json(cached.data);
  }

  const baseHeaders = {
    'Accept': 'application/json',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
    'Accept-Language': 'en-US,en;q=0.9',
    'Referer': 'https://www.robotevents.com/'
  };

  // Try each token until one succeeds (or we run out)
  // For non-auth (legacy) endpoints we just try once
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

      // Success or non-retryable error — advance the round-robin and return
      if (useAuth) {
        tokenCursor = (tokenCursor + 1) % tokens.length;
      }

      // Forward Retry-After if present
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

      // Cache successful responses
      if (response.status >= 200 && response.status < 300) {
        cache.set(path, {
          data,
          status: response.status,
          expires: Date.now() + CACHE_TTL_MS
        });
        if (cache.size > 200) {
          const firstKey = cache.keys().next().value;
          cache.delete(firstKey);
        }
      }

      return res.status(response.status).json(data);
    } catch (err) {
      lastResponse = null;
      lastText = err.message;
      if (i === attempts - 1) {
        return res.status(500).json({ error: err.message });
      }
    }
  }

  // All tokens exhausted with rate limits — return last response
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
