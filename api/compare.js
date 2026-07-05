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

    // ── Extract item names ────────────────────────────────────────────────
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

    // ── Step 1: Detect category and build targeted searches ───────────────
    let searchContext = '';

    if (tavilyKey && itemA && itemB) {
      const category = detectCategory(itemA, itemB);
      const queries = getSearchQueries(category, itemA, itemB, year);

      // Run all searches in parallel
      const results = await Promise.all(
        queries.map(q => searchFact(tavilyKey, q.query, q.label))
      );

      // Build a clean fact sheet for the AI
      const factLines = results
        .filter(r => r.answer && r.answer !== 'unknown')
        .map(r => `- ${r.label}: ${r.answer}`)
        .join('\n');

      if (factLines) {
        searchContext = `
VERIFIED FACTS FROM WEB (${year}) — USE THESE EXACT FIGURES:
These are sourced from the web right now. Do NOT replace them with your training data estimates.

${factLines}

For all other metrics not listed above, use your training knowledge.
Never say "not specified" for commonly known facts.
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

// ── Category detection ────────────────────────────────────────────────────
function detectCategory(itemA, itemB) {
  const text = `${itemA} ${itemB}`.toLowerCase();

  if (/iphone|samsung galaxy|pixel \d|oneplus|xiaomi|huawei|nothing phone|smartphone/.test(text))
    return 'phone';

  if (/macbook|thinkpad|xps|spectre|envy|inspiron|latitude|surface laptop|chromebook|zenbook|vivobook|gram|matebook/.test(text))
    return 'laptop';

  if (/university|college|institute of technology|school of|harvard|stanford|mit|oxford|cambridge|yale|princeton|caltech/.test(text))
    return 'university';

  if (/toyota|honda|ford|chevrolet|bmw|mercedes|audi|tesla|hyundai|kia|nissan|volkswagen|porsche|ferrari|mazda|subaru|volvo|jeep|ram truck|mustang|camry|civic|corolla|model [s3xy]/.test(text))
    return 'car';

  if (/ipad|galaxy tab|surface pro|tab s\d|kindle|e-reader/.test(text))
    return 'tablet';

  if (/ps5|playstation|xbox|nintendo switch|steam deck|gaming console/.test(text))
    return 'console';

  // Software & apps — SaaS, OS, productivity, creative, streaming, social
  if (/spotify|netflix|disney\+|hulu|apple music|youtube music|tidal|soundcloud|deezer|pandora|amazon prime|hbo max|paramount\+|peacock|apple tv\+|crunchyroll|twitch|discord|slack|teams|zoom|skype|notion|obsidian|evernote|onenote|trello|asana|jira|monday\.com|clickup|linear|figma|sketch|adobe xd|photoshop|illustrator|lightroom|premiere|after effects|davinci resolve|final cut|capcut|canva|word|excel|powerpoint|google docs|google sheets|google slides|vscode|visual studio|intellij|sublime text|atom|vim|neovim|cursor|github|gitlab|bitbucket|chrome|firefox|safari|edge|brave|opera|windows 11|windows 10|macos|ubuntu|linux|android|ios|chatgpt|gemini|copilot|claude|midjourney|stable diffusion|dall-e|software|app\b|application|platform|saas|subscription service/.test(text))
    return 'software';

  // Fictional characters — popular franchises and character names
  if (/batman|superman|spider.?man|iron man|thor|captain america|wonder woman|black panther|deadpool|wolverine|hulk|flash|aquaman|green lantern|cyborg|shazam|doctor strange|scarlet witch|vision|black widow|hawkeye|ant.?man|star.?lord|gamora|groot|rocket raccoon|thanos|loki|hela|joker|lex luthor|darth vader|luke skywalker|yoda|obi.?wan|rey|kylo ren|goku|vegeta|naruto|sasuke|luffy|zoro|ichigo|light yagami|l lawliet|eren yeager|levi ackerman|edward elric|natsu|erza|harry potter|hermione|dumbledore|voldemort|gandalf|frodo|aragorn|legolas|sherlock holmes|james bond|john wick|katniss|harry potter|marvel|dc comics|anime|manga|fictional|character|superhero|villain/.test(text))
    return 'character';

  // City detection — broad list of major cities + generic terms
  if (/new york|london|paris|tokyo|dubai|sydney|toronto|chicago|berlin|amsterdam|singapore|seoul|barcelona|rome|vienna|zurich|copenhagen|oslo|stockholm|madrid|lisbon|cape town|mumbai|delhi|shanghai|beijing|bangkok|istanbul|cairo|mexico city|são paulo|buenos aires|los angeles|san francisco|miami|seattle|boston|city|capital/.test(text))
    return 'city';

  return 'general';
}

// ── Category-specific search queries ─────────────────────────────────────
function getSearchQueries(category, a, b, year) {
  switch (category) {

    case 'phone':
      return [
        { label: `${a} — Starting price (${year})`,       query: `${a} starting retail price USD ${year}` },
        { label: `${b} — Starting price (${year})`,       query: `${b} starting retail price USD ${year}` },
        { label: `${a} — Chipset & AnTuTu score`,         query: `${a} chipset processor AnTuTu benchmark score` },
        { label: `${b} — Chipset & AnTuTu score`,         query: `${b} chipset processor AnTuTu benchmark score` },
        { label: `${a} — Battery & camera specs`,         query: `${a} battery mAh main camera megapixels` },
        { label: `${b} — Battery & camera specs`,         query: `${b} battery mAh main camera megapixels` },
      ];

    case 'laptop':
      return [
        { label: `${a} — Starting price (${year})`,       query: `${a} starting price USD ${year}` },
        { label: `${b} — Starting price (${year})`,       query: `${b} starting price USD ${year}` },
        { label: `${a} — Specs (CPU, RAM, display)`,      query: `${a} processor RAM display size specifications` },
        { label: `${b} — Specs (CPU, RAM, display)`,      query: `${b} processor RAM display size specifications` },
        { label: `${a} — Battery life & weight`,          query: `${a} battery life hours weight kg` },
        { label: `${b} — Battery life & weight`,          query: `${b} battery life hours weight kg` },
      ];

    case 'university':
      return [
        { label: `${a} — QS World Ranking (${year})`,     query: `${a} QS World University Ranking ${year}` },
        { label: `${b} — QS World Ranking (${year})`,     query: `${b} QS World University Ranking ${year}` },
        { label: `${a} — Acceptance rate (${year})`,      query: `${a} acceptance rate ${year}` },
        { label: `${b} — Acceptance rate (${year})`,      query: `${b} acceptance rate ${year}` },
        { label: `${a} — Tuition fees`,                   query: `${a} annual tuition fees international students USD` },
        { label: `${b} — Tuition fees`,                   query: `${b} annual tuition fees international students USD` },
      ];

    case 'car':
      return [
        { label: `${a} — Base price (${year})`,           query: `${a} base MSRP starting price USD ${year}` },
        { label: `${b} — Base price (${year})`,           query: `${b} base MSRP starting price USD ${year}` },
        { label: `${a} — Horsepower & 0-60`,              query: `${a} horsepower 0 to 60 mph specifications` },
        { label: `${b} — Horsepower & 0-60`,              query: `${b} horsepower 0 to 60 mph specifications` },
        { label: `${a} — Fuel economy or range`,          query: `${a} fuel economy MPG or EV range miles` },
        { label: `${b} — Fuel economy or range`,          query: `${b} fuel economy MPG or EV range miles` },
      ];

    case 'tablet':
      return [
        { label: `${a} — Starting price (${year})`,       query: `${a} starting price USD ${year}` },
        { label: `${b} — Starting price (${year})`,       query: `${b} starting price USD ${year}` },
        { label: `${a} — Chipset, display, battery`,      query: `${a} chipset display size battery mAh specifications` },
        { label: `${b} — Chipset, display, battery`,      query: `${b} chipset display size battery mAh specifications` },
      ];

    case 'console':
      return [
        { label: `${a} — Price (${year})`,                query: `${a} retail price USD ${year}` },
        { label: `${b} — Price (${year})`,                query: `${b} retail price USD ${year}` },
        { label: `${a} — Hardware specs`,                 query: `${a} CPU GPU RAM storage specifications` },
        { label: `${b} — Hardware specs`,                 query: `${b} CPU GPU RAM storage specifications` },
      ];

    case 'software':
      return [
        { label: `${a} — Pricing plans (${year})`,        query: `${a} pricing plans subscription cost USD ${year}` },
        { label: `${b} — Pricing plans (${year})`,        query: `${b} pricing plans subscription cost USD ${year}` },
        { label: `${a} — Active users / market share`,    query: `${a} monthly active users market share ${year}` },
        { label: `${b} — Active users / market share`,    query: `${b} monthly active users market share ${year}` },
        { label: `${a} — Platform availability & rating`, query: `${a} platforms supported app store rating ${year}` },
        { label: `${b} — Platform availability & rating`, query: `${b} platforms supported app store rating ${year}` },
      ];

    case 'character':
      return [
        { label: `${a} — Origin & first appearance`,      query: `${a} fictional character first appearance origin comic book film` },
        { label: `${b} — Origin & first appearance`,      query: `${b} fictional character first appearance origin comic book film` },
        { label: `${a} — Powers, abilities & weaknesses`, query: `${a} character powers abilities weaknesses` },
        { label: `${b} — Powers, abilities & weaknesses`, query: `${b} character powers abilities weaknesses` },
        { label: `${a} — Most notable feats`,             query: `${a} most powerful moments greatest feats` },
        { label: `${b} — Most notable feats`,             query: `${b} most powerful moments greatest feats` },
      ];

    case 'city':
      return [
        { label: `${a} — GDP (${year})`,                  query: `${a} GDP total billion dollars ${year}` },
        { label: `${b} — GDP (${year})`,                  query: `${b} GDP total billion dollars ${year}` },
        { label: `${a} — City population (${year})`,      query: `${a} city proper population ${year}` },
        { label: `${b} — City population (${year})`,      query: `${b} city proper population ${year}` },
        { label: `${a} — Numbeo cost of living`,          query: `${a} Numbeo cost of living index ${year}` },
        { label: `${b} — Numbeo cost of living`,          query: `${b} Numbeo cost of living index ${year}` },
      ];

    default:
      return [
        { label: `${a} — Key facts (${year})`,            query: `${a} key specifications features price ${year}` },
        { label: `${b} — Key facts (${year})`,            query: `${b} key specifications features price ${year}` },
      ];
  }
}

// ── Targeted fact search ──────────────────────────────────────────────────
async function searchFact(apiKey, query, label) {
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
    if (!res.ok) return { label, answer: 'unknown' };

    // Prefer Tavily's AI-generated summary answer — it's concise and accurate
    const answer = data.answer
      ? data.answer.slice(0, 220)
      : data.results?.[0]?.content?.slice(0, 220) || 'unknown';

    return { label, answer };
  } catch {
    return { label, answer: 'unknown' };
  }
}
