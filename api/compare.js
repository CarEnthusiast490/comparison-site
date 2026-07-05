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

    // ── Step 1: Web search — supplement only, not primary source ──────────
    let searchContext = '';

    if (tavilyKey && itemA && itemB) {
      const [dataA, dataB] = await Promise.all([
        searchWeb(tavilyKey, `${itemA} population cost of living index crime rate ${year}`),
        searchWeb(tavilyKey, `${itemB} population cost of living index crime rate ${year}`),
      ]);

      // Only add search context if we actually got useful results
      if (dataA !== 'No results found.' || dataB !== 'No results found.') {
        searchContext = `
SUPPLEMENTARY WEB DATA (${year}):
Use the figures below to update any metrics where you have recent data.
Your own training knowledge is the PRIMARY source — use it for everything.
Only replace a figure with one from below if it is clearly more recent.
Do NOT say "not specified" for any metric you can answer from your training.

--- Recent data for ${itemA} ---
${dataA}

--- Recent data for ${itemB} ---
${dataB}
`;
      }
    }

    // ── Step 2: Build final system prompt ─────────────────────────────────
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
        max_tokens: 4000,
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

// ── Tavily search helper ───────────────────────────────────────────────────
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

    // Filter out irrelevant results (events, conferences, etc.)
    const filtered = data.results.filter(r =>
      !/(conference|meeting|event|summit|workshop|seminar)/i.test(r.title)
    );

    const results = (filtered.length ? filtered : data.results)
      .map(r => `• ${r.title}: ${r.content.slice(0, 350)}`)
      .join('\n');

    return (answer + results).slice(0, 1800);
  } catch {
    return 'Search unavailable.';
  }
}
