module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({
      error: { message: 'GEMINI_API_KEY is not set in Vercel environment variables.' }
    });
  }

  try {
    const { system, messages } = req.body;
    const userMessage = messages?.[0]?.content || '';
    const combinedPrompt = `${system}\n\nUser request: ${userMessage}`;

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: combinedPrompt }] }],
          generationConfig: { temperature: 0.2, maxOutputTokens: 4000 }
        })
      }
    );

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({
        error: { message: data.error?.message || 'Gemini API error' }
      });
    }

    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    return res.status(200).json({
      content: [{ type: 'text', text }]
    });

  } catch (err) {
    return res.status(500).json({ error: { message: err.message || 'Unexpected server error' } });
  }
};
