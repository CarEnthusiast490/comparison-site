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

    // ── Step 1: Targeted web searches for current data ────────────────────
    let searchContext = '';

    if (tavilyKey && itemA && itemB) {
      // Use specific, targeted queries instead of generic ones
      const [dataA, dataB] = await Promise.all([
        searchWeb(tavilyKey, `${itemA} population cost of living GDP crime rate ${year}`),
        searchWeb(tavilyKey, `${itemB} population cost of living GDP crime rate ${year}`),
      ]);

      searchContext = `
=== RECENT WEB DATA (${year}) ===
Use any relevant figures from below to update your knowledge.
IMPORTANT: If a specific figure is NOT in the search results below, 
use your own training knowledge instead — never write "not specified" 
for something that is commonly known. Only write "not specified" if 
the data is genuinely obscure or unknown.

--- Recent data: ${itemA} ---
${dataA}

--- Recent data: ${itemB} ---
${dataB}
=== END WEB DATA ===
`;
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
        max_results: 4,
        include_answer: true,
        include_raw_content: false
      })
    });

    const data = await res.json();
    if (!res.ok || !data.results?.length) return 'No results found.';

    const answer = data.answer ? `Summary: ${data.answer}\n` : '';

    // Filter out results that don't seem relevant (e.g. conference listings)
    const filtered = data.results.filter(r =>
      !r.title.toLowerCase().includes('conference') &&
      !r.title.toLowerCase().includes('meeting') &&
      !r.title.toLowerCase().includes('event')
    );

    const results = (filtered.length ? filtered : data.results)
      .map(r => `• ${r.title}: ${r.content.slice(0, 400)}`)
      .join('\n');

    return (answer + results).slice(0, 2000);
  } catch {
    return 'Search unavailable.';
  }
}
