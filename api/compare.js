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

    // ── Step 1: Run targeted, domain-restricted searches ─────────────────
    let searchContext = '';

    if (tavilyKey && itemA && itemB) {
      const category = detectCategory(itemA, itemB);
      const queries   = getSearchQueries(category, itemA, itemB, year);

      const results = await Promise.all(
        queries.map(q => searchFact(tavilyKey, q.query, q.label, q.domains || []))
      );

      const factLines = results
        .filter(r => r.answer && r.answer !== 'unknown')
        .map(r => `- ${r.label}: ${r.answer}`)
        .join('\n');

      if (factLines) {
        searchContext = `
VERIFIED FACTS FROM REPUTABLE SOURCES (${year}) — USE THESE EXACT FIGURES:
Do NOT replace these with your own training data estimates.

${factLines}

For any metric not listed above, use your training knowledge.
Never write "not specified", "not provided", "unknown", or "N/A".
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

  if (/toyota|honda|ford|chevrolet|bmw|mercedes|audi|tesla|hyundai|kia|nissan|volkswagen|porsche|ferrari|mclaren|lamborghini|bugatti|aston martin|bentley|rolls royce|mazda|subaru|volvo|jeep|ram truck|dodge|chrysler|cadillac|genesis|rivian|lucid|polestar|koenigsegg|pagani|rimac|alfa romeo|jaguar|lotus|maserati|byd|mercedes.?benz|mini cooper|cooper|citroen|citroën|mustang|camry|civic|corolla|model [s3xy]|911|750s|720s|765lt|senna|artura|urus|huracan|aventador|revuelto|temerario|sf90|f8|296|812|roma|purosangue|supra|nsx|gt-r|viper|agera|jesko|regera|zonda|huayra|utopia|nevera|c_two|stelvio|giulia|ghibli|gran turismo|quattroporte|levante|f-type|evora|emira|eletre|dynasty|atto|seal|han/.test(text))
    return 'car';

  if (/ipad|galaxy tab|surface pro|tab s\d|kindle|e-reader/.test(text))
    return 'tablet';

  if (/ps5|playstation|xbox|nintendo switch|steam deck|gaming console/.test(text))
    return 'console';

  if (/spotify|netflix|disney\+|hulu|apple music|youtube music|tidal|soundcloud|deezer|pandora|amazon prime|hbo max|paramount\+|peacock|apple tv\+|crunchyroll|twitch|discord|slack|teams|zoom|skype|notion|obsidian|evernote|onenote|trello|asana|jira|monday\.com|clickup|linear|figma|sketch|adobe xd|photoshop|illustrator|lightroom|premiere|after effects|davinci resolve|final cut|capcut|canva|word|excel|powerpoint|google docs|google sheets|google slides|vscode|visual studio|intellij|sublime text|atom|vim|neovim|cursor|github|gitlab|bitbucket|chrome|firefox|safari|edge|brave|opera|windows 11|windows 10|macos|ubuntu|linux|android|ios|chatgpt|gemini|copilot|claude|midjourney|stable diffusion|dall-e|software|app\b|application|platform|saas|subscription service/.test(text))
    return 'software';

  if (/batman|superman|spider.?man|iron man|thor|captain america|wonder woman|black panther|deadpool|wolverine|hulk|flash|aquaman|green lantern|cyborg|shazam|doctor strange|scarlet witch|vision|black widow|hawkeye|ant.?man|star.?lord|gamora|groot|rocket raccoon|thanos|loki|hela|joker|lex luthor|darth vader|luke skywalker|yoda|obi.?wan|rey|kylo ren|goku|vegeta|naruto|sasuke|luffy|zoro|ichigo|light yagami|l lawliet|eren yeager|levi ackerman|edward elric|natsu|erza|harry potter|hermione|dumbledore|voldemort|gandalf|frodo|aragorn|legolas|sherlock holmes|james bond|john wick|katniss|marvel|dc comics|anime|manga|fictional|character|superhero|villain/.test(text))
    return 'character';

  if (/new york|london|paris|tokyo|dubai|sydney|toronto|chicago|berlin|amsterdam|singapore|seoul|barcelona|rome|vienna|zurich|copenhagen|oslo|stockholm|madrid|lisbon|cape town|mumbai|delhi|shanghai|beijing|bangkok|istanbul|cairo|mexico city|são paulo|buenos aires|los angeles|san francisco|miami|seattle|boston|city|capital/.test(text))
    return 'city';

  return 'general';
}

// ── Search queries with domain restrictions ───────────────────────────────
// Each query targets one reputable source so results are clean and focused.
//
// Source authority by category:
//   Phones     → gsmarena.com          (industry-standard phone specs database)
//   Laptops    → notebookcheck.net     (most detailed independent laptop reviews)
//   Cars       → caranddriver.com      (authoritative US car specs & reviews)
//   Universities→ topuniversities.com  (QS World Rankings authority)
//   Cities (demo/economy) → en.wikipedia.org
//   Cities (cost of living)→ numbeo.com (global cost-of-living database)
//   Software   → en.wikipedia.org      (neutral, well-sourced software articles)
//   Characters → en.wikipedia.org      (well-cited fictional character articles)
//   Consoles   → ign.com               (reputable gaming specs & reviews)
//   Tablets    → gsmarena.com

function getSearchQueries(category, a, b, year) {
  switch (category) {

    case 'phone':
      return [
        { label: `${a} — Full specs`,        query: `${a} full specifications`,       domains: ['www.gsmarena.com'] },
        { label: `${b} — Full specs`,        query: `${b} full specifications`,       domains: ['www.gsmarena.com'] },
        { label: `${a} — Price (${year})`,   query: `${a} price ${year}`,             domains: ['www.gsmarena.com'] },
        { label: `${b} — Price (${year})`,   query: `${b} price ${year}`,             domains: ['www.gsmarena.com'] },
      ];

    case 'laptop':
      return [
        { label: `${a} — Full specs & review`, query: `${a} specifications review`,   domains: ['www.notebookcheck.net'] },
        { label: `${b} — Full specs & review`, query: `${b} specifications review`,   domains: ['www.notebookcheck.net'] },
        { label: `${a} — Price (${year})`,     query: `${a} price ${year}`,           domains: ['www.notebookcheck.net'] },
        { label: `${b} — Price (${year})`,     query: `${b} price ${year}`,           domains: ['www.notebookcheck.net'] },
      ];

    case 'car':
      return [
        { label: `${a} — Full specs & price`, query: `${a} specs horsepower price`,   domains: ['www.caranddriver.com'] },
        { label: `${b} — Full specs & price`, query: `${b} specs horsepower price`,   domains: ['www.caranddriver.com'] },
        { label: `${a} — Engine & performance`, query: `${a} engine torque 0-60 top speed`, domains: ['www.caranddriver.com'] },
        { label: `${b} — Engine & performance`, query: `${b} engine torque 0-60 top speed`, domains: ['www.caranddriver.com'] },
      ];

    case 'university':
      return [
        { label: `${a} — QS Ranking & overview`,  query: `${a} ranking overview`,     domains: ['www.topuniversities.com'] },
        { label: `${b} — QS Ranking & overview`,  query: `${b} ranking overview`,     domains: ['www.topuniversities.com'] },
        { label: `${a} — Acceptance rate & fees`, query: `${a} acceptance rate tuition fees`, domains: ['www.topuniversities.com'] },
        { label: `${b} — Acceptance rate & fees`, query: `${b} acceptance rate tuition fees`, domains: ['www.topuniversities.com'] },
      ];

    case 'city':
      return [
        // Wikipedia for demographics & economy
        { label: `${a} — Population & economy`,  query: `${a} city population GDP economy`,     domains: ['en.wikipedia.org'] },
        { label: `${b} — Population & economy`,  query: `${b} city population GDP economy`,     domains: ['en.wikipedia.org'] },
        // Numbeo for cost of living (most accurate source for this)
        { label: `${a} — Cost of living index`,  query: `${a} cost of living index`,             domains: ['www.numbeo.com'] },
        { label: `${b} — Cost of living index`,  query: `${b} cost of living index`,             domains: ['www.numbeo.com'] },
        // Numbeo for crime & quality of life
        { label: `${a} — Crime & quality of life`, query: `${a} crime index quality of life`,   domains: ['www.numbeo.com'] },
        { label: `${b} — Crime & quality of life`, query: `${b} crime index quality of life`,   domains: ['www.numbeo.com'] },
      ];

    case 'software':
      return [
        { label: `${a} — Overview & user base`,   query: `${a} software overview users`,        domains: ['en.wikipedia.org'] },
        { label: `${b} — Overview & user base`,   query: `${b} software overview users`,        domains: ['en.wikipedia.org'] },
        { label: `${a} — Pricing (${year})`,      query: `${a} pricing plans ${year}`,          domains: ['en.wikipedia.org'] },
        { label: `${b} — Pricing (${year})`,      query: `${b} pricing plans ${year}`,          domains: ['en.wikipedia.org'] },
      ];

    case 'character':
      return [
        { label: `${a} — Origin & abilities`,     query: `${a} fictional character origin powers abilities`, domains: ['en.wikipedia.org'] },
        { label: `${b} — Origin & abilities`,     query: `${b} fictional character origin powers abilities`, domains: ['en.wikipedia.org'] },
        { label: `${a} — Notable feats`,          query: `${a} character notable feats appearances`,         domains: ['en.wikipedia.org'] },
        { label: `${b} — Notable feats`,          query: `${b} character notable feats appearances`,         domains: ['en.wikipedia.org'] },
      ];

    case 'tablet':
      return [
        { label: `${a} — Full specs`,    query: `${a} full specifications`,   domains: ['www.gsmarena.com'] },
        { label: `${b} — Full specs`,    query: `${b} full specifications`,   domains: ['www.gsmarena.com'] },
        { label: `${a} — Price`,         query: `${a} price`,                 domains: ['www.gsmarena.com'] },
        { label: `${b} — Price`,         query: `${b} price`,                 domains: ['www.gsmarena.com'] },
      ];

    case 'console':
      return [
        { label: `${a} — Specs & price`, query: `${a} specifications price`,  domains: ['www.ign.com'] },
        { label: `${b} — Specs & price`, query: `${b} specifications price`,  domains: ['www.ign.com'] },
        { label: `${a} — Game library`,  query: `${a} game library exclusives`, domains: ['www.ign.com'] },
        { label: `${b} — Game library`,  query: `${b} game library exclusives`, domains: ['www.ign.com'] },
      ];

    default:
      return [
        { label: `${a} — Key facts`, query: `${a} overview features`, domains: ['en.wikipedia.org'] },
        { label: `${b} — Key facts`, query: `${b} overview features`, domains: ['en.wikipedia.org'] },
      ];
  }
}

// ── Domain-restricted fact search ─────────────────────────────────────────
async function searchFact(apiKey, query, label, domains = []) {
  try {
    const body = {
      api_key: apiKey,
      query,
      search_depth: 'basic',
      max_results: 2,          // Only 2 results — we're on a single trusted source
      include_answer: true,
      include_raw_content: false
    };

    // Pin the search to the authoritative domain for this category
    if (domains.length > 0) {
      body.include_domains = domains;
    }

    const res = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    const data = await res.json();
    if (!res.ok) return { label, answer: 'unknown' };

    // Prefer Tavily's AI answer summary — concise and pulled from the trusted source
    const answer = data.answer
      ? data.answer.slice(0, 250)
      : data.results?.[0]?.content?.slice(0, 250) || 'unknown';

    return { label, answer };
  } catch {
    return { label, answer: 'unknown' };
  }
}
