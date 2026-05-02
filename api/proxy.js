// Vercel Serverless Function — proxies requests to RobotEvents API
// The token is read from Vercel environment variables, never exposed to the browser

export default async function handler(req, res) {
  const path = req.query.path;
  if (!path) {
    return res.status(400).json({ error: 'Missing path parameter' });
  }

  const token = process.env.ROBOTEVENTS_TOKEN;

  // Determine which API to use
  // Paths starting with "legacy:" use V1 API (public, no auth — same as official site)
  // Otherwise use V2 API (requires bearer token)
  let url;
  let useAuth = true;
  if (path.startsWith('legacy:')) {
    url = `https://www.robotevents.com/api${path.slice(7)}`;
    useAuth = false;
  } else {
    url = `https://www.robotevents.com/api/v2${path}`;
  }

  if (useAuth && !token) {
    return res.status(500).json({ error: 'API token not configured' });
  }

  try {
    const headers = {
      'Accept': 'application/json',
      // Browser-like User-Agent so RobotEvents doesn't block us as a bot
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
      'Accept-Language': 'en-US,en;q=0.9',
      'Referer': 'https://www.robotevents.com/'
    };
    if (useAuth) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    const response = await fetch(url, { headers });
    const text = await response.text();

    // Try to parse as JSON
    try {
      const data = JSON.parse(text);
      res.status(response.status).json(data);
    } catch (e) {
      // Return error info if response wasn't JSON
      res.status(response.status).json({
        error: 'Non-JSON response from RobotEvents',
        status: response.status,
        preview: text.slice(0, 300)
      });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
