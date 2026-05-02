// Vercel Serverless Function — proxies requests to RobotEvents API
// The token is read from Vercel environment variables, never exposed to the browser

export default async function handler(req, res) {
  // Get the path the user wants (e.g. "/teams?number[]=7700S")
  const path = req.query.path;
  if (!path) {
    return res.status(400).json({ error: 'Missing path parameter' });
  }

  // Get token from environment variable
  const token = process.env.ROBOTEVENTS_TOKEN;
  if (!token) {
    return res.status(500).json({ error: 'API token not configured' });
  }

  // Build the full RobotEvents URL
  const url = `https://www.robotevents.com/api/v2${path}`;

  try {
    const response = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/json'
      }
    });

    const data = await response.json();
    res.status(response.status).json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
