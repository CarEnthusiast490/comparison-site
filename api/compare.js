export default async function handler(req, res) {
  // Only accept POST requests
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Read the API key from Vercel environment variables (never exposed to users)
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({
      error: {
        message: 'ANTHROPIC_API_KEY environment variable is not set. Add it in your Vercel project settings.'
      }
    });
  }

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(req.body),
    });

    const data = await response.json();

    // Forward the exact status code and body from Anthropic back to the browser
    return res.status(response.status).json(data);

  } catch (err) {
    return res.status(500).json({ error: { message: err.message || 'Unexpected server error' } });
  }
}
