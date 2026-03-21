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

  // 1. Fetch market data server-side (no CORS proxy needed)
  let marketData;
  try {
    marketData = await fetchYahooData(clean);
  } catch (err) {
    return res.status(502).json({ error: `Market data failed: ${err.message}` });
  }

  // 2. Fetch AI analysis
  try {
    const aiData = await fetchAIAnalysis(clean, marketData, apiKey);
    return res.status(200).json({ marketData, aiData });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'AI analysis failed' });
  }
}

// ─────────────────────────────────────────────────────────
// YAHOO FINANCE (server-side — no CORS issues)
// ─────────────────────────────────────────────────────────
async function fetchYahooData(ticker) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?range=1y&interval=1d&includePrePost=false`;

  let resp = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; InvestorIQ/1.0)',
      'Accept': 'application/json',
    },
    signal: AbortSignal.timeout(10000),
  });

  // Fallback to query2
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
  const timestamps = result.timestamp                     || [];
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
  const companyName  = marketData.companyName  || ticker;
  const exchange     = marketData.exchange     || 'NASDAQ';
  const currentPrice = typeof marketData.currentPrice === 'number'
    ? marketData.currentPrice.toFixed(2)
    : 'unknown';

  const systemPrompt = `You are a senior equity research analyst. Return ONLY a valid JSON object. No markdown fences, no explanation, no text before or after the JSON. Every string value must be properly quoted. Numbers must be plain numbers with no extra characters.`;

  // NOTE: No dynamic values are injected inside the JSON template below.
  // All context is given in plain English ABOVE the template to avoid
  // accidentally producing malformed JSON (e.g. undefined, NaN, null).
  const userPrompt = `Analyze the following stock:
- Ticker: ${ticker}
- Company: ${companyName}
- Exchange: ${exchange}
- Current market price: $${currentPrice}

Using the current price above, fill in ALL fields in the JSON template below with real, accurate data.
For the dcf.currentPrice and dcf.intrinsicValue fields use plain numbers (e.g. 213.45), no dollar signs.
For dcf.upside use a plain number representing percentage (e.g. 18.5 means 18.5% upside).
For projections.bullishScore use an integer between 0 and 100.

Return exactly this JSON structure and nothing else:
{
  "companyName": "Full legal company name",
  "sector": "Sector name",
  "industry": "Sub-industry name",
  "exchange": "Exchange name",
  "marketCap": "Human readable e.g. $2.8T or $450B",

  "dcf": {
    "intrinsicValue": 0,
    "currentPrice": 0,
    "upside": 0,
    "verdict": "undervalued",
    "verdictLabel": "Undervalued by X%",
    "wacc": "9.2%",
    "terminalGrowthRate": "3.0%",
    "projectedFCFGrowth": "12% over 5yr",
    "explanation": "Three sentence plain-English explanation of DCF specific to this company."
  },

  "metrics": {
    "pe":           { "value": "28.5x", "good": true,  "note": "vs industry avg ~25x" },
    "roic":         { "value": "32.1%", "good": true,  "note": "well above 15% benchmark" },
    "eps":          { "value": "$6.42", "good": true,  "note": "TTM earnings per share" },
    "fcf":          { "value": "$95B",  "good": true,  "note": "trailing 12 months" },
    "evEbitda":     { "value": "22.3x", "good": true,  "note": "vs sector avg 18x" },
    "debtToEquity": { "value": "1.73",  "good": false, "note": "elevated but manageable" }
  },

  "peersComparison": "Two to three sentences comparing these metrics to two or three named competitors with their actual metric values.",

  "news": [
    { "type": "company", "title": "Specific recent headline", "summary": "One sentence significance.", "source": "e.g. Bloomberg", "sourceUrl": "https://..." },
    { "type": "company", "title": "Specific recent headline", "summary": "One sentence summary.", "source": "e.g. Reuters", "sourceUrl": "https://..." },
    { "type": "macro",   "title": "Macro or industry headline", "summary": "One sentence impact.", "source": "e.g. WSJ", "sourceUrl": "https://..." },
    { "type": "macro",   "title": "Another macro headline", "summary": "One sentence impact.", "source": "e.g. FT", "sourceUrl": "https://..." },
    { "type": "company", "title": "Third company headline", "summary": "One sentence summary.", "source": "e.g. CNBC", "sourceUrl": "https://..." }
  ],

  "contracts": [
    { "name": "Partner or customer name", "type": "Partnership", "description": "Two sentences on the deal scope and strategic significance." },
    { "name": "Partner or customer name", "type": "Contract",    "description": "Two sentences on the deal scope and significance." },
    { "name": "Partner or customer name", "type": "Deal",        "description": "Two sentences on the deal scope and significance." }
  ],

  "moat": {
    "advantages": [
      "First advantage with a brief explanation of why it matters",
      "Second advantage with brief explanation",
      "Third advantage with brief explanation",
      "Fourth advantage with brief explanation"
    ],
    "summary": "Two sentence competitive positioning and moat durability summary.",
    "moatType": "e.g. Network Effects + Cost Advantages + Intangibles"
  },

  "projections": {
    "bullTarget": "$000",
    "baseTarget": "$000",
    "bearTarget": "$000",
    "timeframe": "12 months",
    "bullishScore": 70,
    "keyRisks":     ["Specific risk one", "Specific risk two", "Specific risk three"],
    "keyTailwinds": ["Specific tailwind one", "Specific tailwind two", "Specific tailwind three"],
    "summary": "Three sentence forward-looking synthesis covering growth catalysts, key risks, and overall conviction."
  }
}`;

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1800,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    }),
    signal: AbortSignal.timeout(50000),
  });

  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(err.error?.message || `Anthropic API error ${resp.status}`);
  }

  const data = await resp.json();
  const text = data.content?.map(b => b.text || '').join('') || '';

  // Strip any accidental markdown fences
  const clean = text.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();

  // Attempt parse
  try {
    return JSON.parse(clean);
  } catch {
    // Try extracting the outermost JSON object
    const match = clean.match(/\{[\s\S]*\}/);
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
