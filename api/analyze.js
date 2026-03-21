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

  let marketData;
  try {
    marketData = await fetchYahooData(clean);
  } catch (err) {
    return res.status(502).json({ error: `Market data failed: ${err.message}` });
  }

  try {
    const aiData = await fetchAIAnalysis(clean, marketData, apiKey);
    return res.status(200).json({ marketData, aiData });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'AI analysis failed' });
  }
}

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
// AI ANALYSIS
// ─────────────────────────────────────────────────────────
async function fetchAIAnalysis(ticker, marketData, apiKey) {
  const companyName  = marketData.companyName || ticker;
  const exchange     = marketData.exchange || 'NASDAQ';
  const currentPrice = typeof marketData.currentPrice === 'number'
    ? marketData.currentPrice.toFixed(2) : 'unknown';

  // Plain-English schema description — no JSON template to corrupt
  const systemPrompt = `You are a senior equity research analyst. You must respond with ONLY a valid JSON object and absolutely nothing else — no markdown, no code fences, no explanation, no text before or after the JSON. Produce clean, properly escaped JSON with all strings quoted and all arrays/objects properly closed.`;

  const userPrompt = `Analyze this stock and return a JSON object with the exact keys described below.

STOCK INFO:
- Ticker: ${ticker}
- Company: ${companyName}
- Exchange: ${exchange}
- Current price: $${currentPrice}

REQUIRED JSON KEYS AND TYPES — produce ALL of them:

companyName: string
sector: string
industry: string
exchange: string
marketCap: string (e.g. "$2.8T")

dcf: object with keys:
  intrinsicValue: number (no $ sign, e.g. 213.45)
  currentPrice: number (use ${currentPrice})
  upside: number (percentage, e.g. 18.5)
  verdict: string, one of: "undervalued" "overvalued" "fair"
  verdictLabel: string (e.g. "Undervalued by 18%")
  wacc: string (e.g. "9.2%")
  terminalGrowthRate: string (e.g. "3.0%")
  projectedFCFGrowth: string (e.g. "12% over 5yr")
  explanation: string (3 sentences about DCF for this specific company)

metrics: object with keys pe, roic, eps, fcf, evEbitda, debtToEquity.
  Each has: value (string), good (boolean), note (string)

peersComparison: string (2-3 sentences comparing metrics to named competitors with actual values)

news: array of exactly 5 objects, each with:
  type: string, either "company" or "macro"
  title: string (specific real headline)
  summary: string (1 sentence)
  source: string (publication name e.g. "Bloomberg")
  sourceUrl: string (homepage URL of that publication e.g. "https://bloomberg.com")

contracts: array of 5 objects, each with:
  name: string (partner/customer name)
  type: string (e.g. "Partnership" "Contract" "Deal")
  description: string (2 sentences on scope and strategic significance)

competitors: array of 4 objects, each with:
  name: string (full company name)
  ticker: string (stock ticker)
  description: string (2 sentences on what they do and why they compete)
  threatLevel: integer 0-100 (competitive threat score)

moat: object with keys:
  advantages: array of 4 strings (each is one advantage with brief explanation)
  summary: string (2 sentences on competitive positioning)
  moatType: string (e.g. "Network Effects + Cost Advantages")
  vsCompetitors: array of 4 objects, each with:
    dimension: string (competitive dimension e.g. "Cloud Infrastructure")
    advantage: string, one of: "ahead" "behind" "parity"
    detail: string (2 sentences comparing this company vs competitors on this dimension)

projections: object with keys:
  bullTarget: string (e.g. "$245")
  baseTarget: string (e.g. "$210")
  bearTarget: string (e.g. "$165")
  timeframe: string ("12 months")
  bullishScore: integer 0-100
  keyRisks: array of 3 strings
  keyTailwinds: array of 3 strings
  summary: string (3 sentences forward-looking synthesis)

Respond with ONLY the JSON object. No other text.`;

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2800,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    }),
    signal: AbortSignal.timeout(55000),
  });

  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(err.error?.message || `Anthropic API error ${resp.status}`);
  }

  const data = await resp.json();
  const text = data.content?.map(b => b.text || '').join('') || '';

  // Strip any accidental markdown fences
  const cleaned = text
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();

  try {
    return JSON.parse(cleaned);
  } catch {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return JSON.parse(match[0]);
      } catch (e2) {
        throw new Error(`AI returned malformed JSON: ${e2.message}. Please retry.`);
      }
    }
    throw new Error('AI returned unparseable response. Please retry.');
  }
}
