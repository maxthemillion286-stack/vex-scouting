// Vercel Serverless Function — proxies requests to RobotEvents API
// The token is read from Vercel environment variables, never exposed to the browser

export default async function handler(req, res) {
  const path = req.query.path;
  if (!path) {
    return res.status(400).json({ error: 'Missing path parameter' });
  }

  const token = process.env.ROBOTEVENTS_TOKEN;
  if (!token) {
    return res.status(500).json({ error: 'API token not configured' });
  }

  // Determine which API base to use
  // Paths starting with "legacy:" use the older /api/ V1 endpoint (public, no auth)
  // Otherwise default to /api/v2 (requires bearer token)
  let url;
  let useAuth = true;
  if (path.startsWith('legacy:')) {
    url = `https://www.robotevents.com/api${path.slice(7)}`;
    useAuth = false; // V1 public endpoint doesn't require bearer
  } else {
    url = `https://www.robotevents.com/api/v2${path}`;
  }

  try {
    const headers = {
      'Accept': 'application/json',
      'User-Agent': 'Mozilla/5.0 VexScout'
    };
    if (useAuth) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    const response = await fetch(url, { headers });
    const text = await response.text();

    // Try to parse as JSON; if it's HTML, return an error
    try {
      const data = JSON.parse(text);
      res.status(response.status).json(data);
    } catch (e) {
      res.status(response.status).json({
        error: 'Non-JSON response',
        status: response.status,
        preview: text.slice(0, 200)
      });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
