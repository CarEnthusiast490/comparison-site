module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const groqKey = process.env.GROQ_API_KEY;
  const tavilyKey = process.env.TAVILY_API_KEY;

  if (!groqKey) {
    return res.status(500).json({
      error: { message: 'GROQ_API_KEY is not set in Vercel environment variables.' }
    });
  }

  try {
    const { system, messages } = req.body;
    const userMessage = messages?.[0]?.content || '';
    const year = new Date().getFullYear();

    // ── Extract item names ─────────────────────────────────────────────────
    let itemA = '';
    let itemB = '';
    const quotedMatch = userMessage.match(/Compare "(.+?)" vs "(.+?)"/i);
    if (quotedMatch) {
      itemA = quotedMatch[1];
      itemB = quotedMatch[2];
    } else {
      const fallback = userMessage.match(/Compare (.+?) vs (.+?) in detail/i);
      if (fallback) {
        itemA = fallback[1].replace(/"/g, '').trim();
        itemB = fallback[2].replace(/"/g, '').trim();
      }
    }

    // ── Step 1: Web search — two focused searches, trimmed results ─────────
    let searchContext = '';

    if (tavilyKey && itemA && itemB) {
      const [dataA, dataB] = await Promise.all([
        searchWeb(tavilyKey, `${itemA} statistics facts ${year}`),
        searchWeb(tavilyKey, `${itemB} statistics facts ${year}`),
      ]);

      searchContext = `
=== LIVE WEB DATA (${year}) — USE THESE FIGURES ===
You MUST use the statistics below. Do not use older data from your training.

--- ${itemA} ---
${dataA}

--- ${itemB} ---
${dataB}
=== END LIVE DATA ===
`;
    }

    // ── Step 2: Build the final system prompt ─────────────────────────────
    const finalSystem = searchContext
      ? `${system}\n\n${searchContext}`
      : system;

    // ── Step 3: Call Groq ─────────────────────────────────────────────────
    const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${groqKey}`
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [
          { role: 'system', content: finalSystem },
          ...(messages || [])
        ],
        max_tokens: 3000,
        temperature: 0.1
      })
    });

    const groqData = await groqRes.json();

    if (!groqRes.ok) {
      return res.status(groqRes.status).json({
        error: { message: groqData.error?.message || 'Groq API error' }
      });
    }

    const text = groqData.choices?.[0]?.message?.content || '';
    return res.status(200).json({
      content: [{ type: 'text', text }]
    });

  } catch (err) {
    return res.status(500).json({
      error: { message: err.message || 'Unexpected server error' }
    });
  }
};

// ── Tavily search helper — trimmed to stay within token limits ─────────────
async function searchWeb(apiKey, query) {
  try {
    const res = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: apiKey,
        query,
        search_depth: 'basic',
        max_results: 3,
        include_answer: true,
        include_raw_content: false
      })
    });

    const data = await res.json();
    if (!res.ok || !data.results?.length) return 'No results found.';

    const answer = data.answer ? `Summary: ${data.answer}\n` : '';

    // Trim each result to 300 chars to keep total tokens manageable
    const results = data.results
      .map(r => `• ${r.title}: ${r.content.slice(0, 300)}`)
      .join('\n');

    return (answer + results).slice(0, 1500);
  } catch {
    return 'Search unavailable.';
  }
}
