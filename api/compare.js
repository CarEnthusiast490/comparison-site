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
    // Try quoted format first: Compare "X" vs "Y"
    let itemA = '';
    let itemB = '';
    const quotedMatch = userMessage.match(/Compare "(.+?)" vs "(.+?)"/i);
    if (quotedMatch) {
      itemA = quotedMatch[1];
      itemB = quotedMatch[2];
    } else {
      // Fallback: grab anything between Compare and vs, and vs and in detail
      const fallback = userMessage.match(/Compare (.+?) vs (.+?) in detail/i);
      if (fallback) {
        itemA = fallback[1].replace(/"/g, '').trim();
        itemB = fallback[2].replace(/"/g, '').trim();
      }
    }

    // ── Step 1: Web search for current data ───────────────────────────────
    let searchContext = '';

    if (tavilyKey && itemA && itemB) {
      // Run multiple targeted searches per item for richer data
      const searches = await Promise.all([
        searchWeb(tavilyKey, `${itemA} latest statistics data ${year}`),
        searchWeb(tavilyKey, `${itemB} latest statistics data ${year}`),
        searchWeb(tavilyKey, `${itemA} vs ${itemB} comparison ${year}`),
      ]);

      const [dataA, dataB, combined] = searches;

      searchContext = `
=== LIVE WEB DATA (fetched ${year}) — YOU MUST USE THIS ===

The following is real, current data retrieved from the web RIGHT NOW.
You are STRICTLY REQUIRED to use these figures in your comparison rows.
Do NOT use your training data if it contradicts these search results.
If the search results contain a statistic, use that exact figure.

--- Current data for: ${itemA} ---
${dataA}

--- Current data for: ${itemB} ---
${dataB}

--- Direct comparison sources ---
${combined}

=== END OF LIVE WEB DATA ===

REMINDER: Use the figures above. Do not substitute with older data from your training.
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
        max_tokens: 4000,
        temperature: 0.1  // Lower = more faithful to the provided data
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
        search_depth: 'advanced',  // deeper search than basic
        max_results: 7,
        include_answer: true,       // Tavily's own AI summary of results
        include_raw_content: false
      })
    });

    const data = await res.json();
    if (!res.ok || !data.results?.length) return 'No results found.';

    const answer = data.answer ? `Key summary: ${data.answer}\n` : '';
    const results = data.results
      .map(r => `[${r.title}] ${r.content}`)
      .join('\n\n');

    return answer + results;
  } catch {
    return 'Search unavailable.';
  }
}
