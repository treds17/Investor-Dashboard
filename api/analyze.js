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

  // 2. Two parallel Haiku calls with individual retry + partial fallback
  const [quantResult, qualResult] = await Promise.all([
    withRetry(() => fetchQuantAnalysis(clean, marketData, apiKey)),
    withRetry(() => fetchQualAnalysis(clean, marketData, apiKey)),
  ]);

  // If BOTH failed, return an error
  if (!quantResult.ok && !qualResult.ok) {
    return res.status(500).json({
      error: `Analysis failed: ${quantResult.error}. Please retry.`,
    });
  }

  // Merge — use empty fallbacks for whichever half failed
  const aiData = {
    ...(quantResult.ok  ? quantResult.data  : QUANT_FALLBACK),
    ...(qualResult.ok   ? qualResult.data   : QUAL_FALLBACK),
    _partialFailure: (!quantResult.ok || !qualResult.ok)
      ? `Some sections unavailable (${!quantResult.ok ? 'financial data' : 'news/moat'}). Retry to reload.`
      : null,
  };

  return res.status(200).json({ marketData, aiData });
}

// ─────────────────────────────────────────────────────────
// RETRY WRAPPER — attempts fn up to 2 times, returns {ok, data, error}
// ─────────────────────────────────────────────────────────
async function withRetry(fn, attempts = 2) {
  for (let i = 0; i < attempts; i++) {
    try {
      const data = await fn();
      return { ok: true, data };
    } catch (err) {
      if (i === attempts - 1) return { ok: false, error: err.message };
      // Small pause before retry
      await new Promise(r => setTimeout(r, 800));
    }
  }
}

// ─────────────────────────────────────────────────────────
// FALLBACKS — shown when one call fails but the other succeeds
// ─────────────────────────────────────────────────────────
const QUANT_FALLBACK = {
  companyName: '', sector: '—', industry: '—', exchange: '—', marketCap: '—',
  dcf: null,
  metrics: null,
  peersComparison: '',
  competitors: [],
  projections: null,
};

const QUAL_FALLBACK = {
  news: [],
  contracts: [],
  moat: null,
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
// HAIKU HELPER
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
  const cleaned = text.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();

  try {
    return JSON.parse(cleaned);
  } catch {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
    throw new Error('AI returned unparseable JSON. Please retry.');
  }
}

const SYS = `You are a senior equity research analyst. Respond with ONLY a valid JSON object. No markdown, no code fences, no explanation — just the raw JSON.`;

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

projections: object with bullTarget (string e.g. "$245"), baseTarget (string), bearTarget (string), timeframe ("12 months"), bullishScore (integer 0-100), keyRisks (array of 3 strings), keyTailwinds (array of 3 strings), summary (string, 2 sentences)`;

  return callHaiku(apiKey, SYS, prompt, 1400);
}

// ─────────────────────────────────────────────────────────
// CALL 2 — QUAL: News, Contracts, Moat + vsCompetitors
// ─────────────────────────────────────────────────────────
async function fetchQualAnalysis(ticker, marketData, apiKey) {
  const company = marketData.companyName || ticker;

  const prompt = `Stock: ${ticker} (${company}).

Return a JSON object with these exact keys:

news: array of 5 objects each with type (string: "company" or "macro"), title (string, specific headline), summary (string, 1 sentence), source (string, publication name), sourceUrl (string, publication homepage URL)

contracts: array of 5 objects each with name (string, partner name), type (string e.g. "Partnership"), description (string, 2 sentences on scope and significance)

moat: object with advantages (array of 4 strings, each one advantage with brief reason), summary (string, 2 sentences), moatType (string e.g. "Network Effects + Cost Advantages"), vsCompetitors (array of 4 objects each with dimension (string, competitive area), advantage (string: "ahead" or "behind" or "parity"), detail (string, 1-2 sentences comparing this company vs rivals))`;

  return callHaiku(apiKey, SYS, prompt, 1400);
}
