export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'Server misconfigured: API key not set' });

  const { ticker } = req.body;
  if (!ticker) return res.status(400).json({ error: 'Missing ticker' });

  const clean = ticker.toUpperCase().replace(/[^A-Z0-9.\-]/g, '');

  // 1. Market data
  let marketData;
  try {
    marketData = await fetchYahooData(clean);
  } catch (err) {
    return res.status(502).json({ error: `Market data failed: ${err.message}` });
  }

  // 2. Two parallel calls, each with up to 3 attempts
  const [quantResult, qualResult] = await Promise.all([
    withRetry(() => fetchQuantAnalysis(clean, marketData, apiKey), 3),
    withRetry(() => fetchQualAnalysis(clean, marketData, apiKey), 3),
  ]);

  // Both failed → hard error
  if (!quantResult.ok && !qualResult.ok) {
    return res.status(500).json({
      error: `Analysis failed on both calls: ${quantResult.error}. Please retry.`,
    });
  }

  const quantData = quantResult.ok ? quantResult.data : QUANT_FALLBACK;
  const qualData  = qualResult.ok  ? qualResult.data  : QUAL_FALLBACK;

  // Validate that critical arrays/objects actually exist in the response.
  // If a required key is missing, mark it as a partial failure so the
  // frontend knows to show a warning — but still return what we have.
  const missing = [];
  if (!quantData.competitors?.length)  missing.push('competitors');
  if (!quantData.metrics)              missing.push('metrics');
  if (!quantData.dcf)                  missing.push('DCF');
  if (!qualData.news?.length)          missing.push('news');
  if (!qualData.contracts?.length)     missing.push('contracts');
  if (!qualData.moat)                  missing.push('moat');

  const aiData = {
    ...quantData,
    ...qualData,
    _partialFailure: missing.length
      ? `Some sections could not load: ${missing.join(', ')}. Try searching again.`
      : null,
  };

  return res.status(200).json({ marketData, aiData });
}

// ─────────────────────────────────────────────────────────
// RETRY — up to `attempts` tries with exponential backoff
// Returns { ok: true, data } or { ok: false, error }
// ─────────────────────────────────────────────────────────
async function withRetry(fn, attempts = 3) {
  let lastError;
  for (let i = 0; i < attempts; i++) {
    try {
      const data = await fn();
      // Sanity check — if we got back an empty object, treat as failure
      if (!data || typeof data !== 'object' || Object.keys(data).length === 0) {
        throw new Error('Empty response from AI');
      }
      return { ok: true, data };
    } catch (err) {
      lastError = err;
      if (i < attempts - 1) {
        // Exponential backoff: 600ms, 1200ms
        await new Promise(r => setTimeout(r, 600 * (i + 1)));
      }
    }
  }
  return { ok: false, error: lastError?.message || 'Unknown error' };
}

// ─────────────────────────────────────────────────────────
// FALLBACKS — used when a call fails all retries
// ─────────────────────────────────────────────────────────
const QUANT_FALLBACK = {
  companyName: '', sector: '—', industry: '—', exchange: '—', marketCap: '—',
  dcf: null, metrics: null, peersComparison: '', competitors: [], projections: null,
};
const QUAL_FALLBACK = {
  news: [], contracts: [], moat: null,
};

// ─────────────────────────────────────────────────────────
// YAHOO FINANCE
// ─────────────────────────────────────────────────────────
async function fetchYahooData(ticker) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?range=1y&interval=1d&includePrePost=false`;
  let resp = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; InvestorIQ/1.0)', 'Accept': 'application/json' },
    signal: AbortSignal.timeout(10000),
  });
  if (!resp.ok) {
    resp = await fetch(url.replace('query1', 'query2'), {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; InvestorIQ/1.0)', 'Accept': 'application/json' },
      signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok) throw new Error(`Yahoo Finance returned ${resp.status}`);
  }
  return parseYahooResponse(await resp.json(), ticker);
}

function parseYahooResponse(raw, ticker) {
  if (raw.chart?.error || !raw.chart?.result?.[0]) {
    throw new Error(`Ticker "${ticker}" not found. Check the symbol.`);
  }
  const result     = raw.chart.result[0];
  const meta       = result.meta;
  const timestamps = result.timestamp || [];
  const closes     = result.indicators?.quote?.[0]?.close || [];

  function getClosestPrice(daysAgo) {
    const targetTs = Date.now() / 1000 - daysAgo * 86400;
    let closest = null, minDiff = Infinity;
    for (let i = 0; i < timestamps.length; i++) {
      if (closes[i] == null) continue;
      const diff = Math.abs(timestamps[i] - targetTs);
      if (diff < minDiff) { minDiff = diff; closest = closes[i]; }
    }
    return closest;
  }

  return {
    ticker,
    companyName:      meta.longName || meta.shortName || ticker,
    exchange:         meta.exchangeName || '',
    currency:         meta.currency || 'USD',
    currentPrice:     meta.regularMarketPrice,
    previousClose:    meta.chartPreviousClose || getClosestPrice(2),
    price1d:          getClosestPrice(2),
    price1m:          getClosestPrice(30),
    price1y:          getClosestPrice(365),
    fiftyTwoWeekHigh: meta.fiftyTwoWeekHigh,
    fiftyTwoWeekLow:  meta.fiftyTwoWeekLow,
  };
}

// ─────────────────────────────────────────────────────────
// HAIKU HELPER — parses and validates JSON response
// ─────────────────────────────────────────────────────────
async function callHaiku(apiKey, systemPrompt, userPrompt, maxTokens) {
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    }),
    signal: AbortSignal.timeout(45000),
  });

  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(err.error?.message || `Anthropic API error ${resp.status}`);
  }

  const data    = await resp.json();
  const text    = data.content?.map(b => b.text || '').join('') || '';
  const cleaned = text
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();

  // Try direct parse first
  try {
    const parsed = JSON.parse(cleaned);
    return parsed;
  } catch {
    // Try to salvage by extracting the outermost { ... }
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return JSON.parse(match[0]);
      } catch {
        // Last resort: try to fix common truncation issues
        // (unclosed array/object at end of token limit)
        const salvaged = attemptSalvage(match[0]);
        if (salvaged) return salvaged;
      }
    }
    throw new Error('Could not parse AI response as JSON');
  }
}

// Attempts to close any unclosed brackets/braces caused by token cutoff
function attemptSalvage(text) {
  try {
    let fixed = text.trimEnd();
    // Remove trailing incomplete string/value
    fixed = fixed.replace(/,\s*$/, '');
    fixed = fixed.replace(/"[^"]*$/, '"—"');
    // Count unclosed braces and brackets
    let braces = 0, brackets = 0;
    let inString = false;
    for (let i = 0; i < fixed.length; i++) {
      const c = fixed[i];
      if (c === '"' && fixed[i - 1] !== '\\') inString = !inString;
      if (inString) continue;
      if (c === '{') braces++;
      if (c === '}') braces--;
      if (c === '[') brackets++;
      if (c === ']') brackets--;
    }
    // Close any open brackets then braces
    fixed += ']'.repeat(Math.max(0, brackets));
    fixed += '}'.repeat(Math.max(0, braces));
    return JSON.parse(fixed);
  } catch {
    return null;
  }
}

const SYS = `You are a senior equity research analyst. Respond with ONLY a valid JSON object. No markdown, no code fences, no explanation — just the raw JSON. Ensure all strings are properly quoted and all arrays and objects are fully closed.`;

// ─────────────────────────────────────────────────────────
// CALL 1 — QUANT: DCF, Metrics, Competitors, Projections
// ─────────────────────────────────────────────────────────
async function fetchQuantAnalysis(ticker, marketData, apiKey) {
  const price   = typeof marketData.currentPrice === 'number'
    ? marketData.currentPrice.toFixed(2) : 'unknown';
  const company = marketData.companyName || ticker;

  const prompt = `Stock: ${ticker} (${company}), current price $${price}.

Return a JSON object with these exact keys:

companyName: full legal name (string)
sector: sector name (string)
industry: sub-industry (string)
exchange: exchange name (string)
marketCap: e.g. "$2.8T" (string)

dcf: object with: intrinsicValue (number), currentPrice (number, use ${price}), upside (number, percentage), verdict (string: "undervalued" or "overvalued" or "fair"), verdictLabel (string e.g. "Undervalued by 18%"), wacc (string e.g. "9.2%"), terminalGrowthRate (string), projectedFCFGrowth (string), explanation (string, 2 sentences)

metrics: object with keys pe, roic, eps, fcf, evEbitda, debtToEquity — each has value (string), good (boolean), note (string)

peersComparison: string, 2 sentences comparing metrics to named competitors

competitors: array of 4 objects each with name (string), ticker (string), description (string, 1 sentence), threatLevel (integer 0-100)

projections: object with bullTarget (string e.g. "$245"), baseTarget (string), bearTarget (string), timeframe ("12 months"), bullishScore (integer 0-100), keyRisks (array of 3 strings), keyTailwinds (array of 3 strings), summary (string, 1 sentence)`;

  return callHaiku(apiKey, SYS, prompt, 1300);
}

// ─────────────────────────────────────────────────────────
// CALL 2 — QUAL: News, Contracts, Moat + vsCompetitors
// ─────────────────────────────────────────────────────────
async function fetchQualAnalysis(ticker, marketData, apiKey) {
  const company = marketData.companyName || ticker;

  const prompt = `Stock: ${ticker} (${company}).

Return a JSON object with these exact keys:

news: array of 5 objects each with type (string: "company" or "macro"), title (string, specific headline), summary (string, brief — under 15 words), source (string, publication name), sourceUrl (string, publication homepage URL)

contracts: array of 5 objects each with name (string, partner name), type (string e.g. "Partnership"), description (string, 1 concise sentence on scope and significance)

moat: object with advantages (array of 4 strings, each under 12 words), summary (string, 1 sentence), moatType (string e.g. "Network Effects + Cost Advantages"), vsCompetitors (array of 4 objects each with dimension (string, competitive area), advantage (string: "ahead" or "behind" or "parity"), detail (string, 1 sentence comparing this company vs rivals))`;

  return callHaiku(apiKey, SYS, prompt, 1300);
}
