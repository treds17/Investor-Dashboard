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

async function fetchAIAnalysis(ticker, marketData, apiKey) {
  const { companyName, exchange, currentPrice } = marketData;

  const systemPrompt = `You are a senior equity research analyst. Return ONLY valid JSON â€” no markdown, no preamble, no text outside the JSON object. Use real, accurate knowledge about the company.`;

  const userPrompt = `Analyze ${ticker} (${companyName}) at current price $${currentPrice?.toFixed(2)}.

Return exactly this JSON (all fields required):
{
  "companyName": "Full legal company name",
  "sector": "Sector",
  "industry": "Sub-industry",
  "exchange": "${exchange}",
  "marketCap": "e.g. $2.8T",

  "dcf": {
    "intrinsicValue": 000.00,
    "currentPrice": ${currentPrice?.toFixed(2)},
    "verdict": "undervalued|overvalued|fair",
    "verdictLabel": "e.g. Undervalued by 18%",
    "wacc": "e.g. 9.2%",
    "terminalGrowthRate": "e.g. 3.0%",
    "projectedFCFGrowth": "e.g. 12% over 5yr",
    "explanation": "3-sentence plain-English DCF explanation specific to this company"
  },

  "metrics": {
    "pe":           { "value": "00.0x", "good": true,  "note": "context vs peers" },
    "roic":         { "value": "00.0%", "good": true,  "note": "context" },
    "eps":          { "value": "$0.00", "good": true,  "note": "TTM" },
    "fcf":          { "value": "$00B",  "good": true,  "note": "trailing 12 months" },
    "evEbitda":     { "value": "00.0x", "good": true,  "note": "vs sector avg" },
    "debtToEquity": { "value": "0.00",  "good": true,  "note": "leverage note" }
  },

  "peersComparison": "2-3 sentences comparing metrics to 2-3 named competitors with actual values",

  "news": [
    { "type": "company", "title": "Specific headline", "summary": "1-sentence significance" },
    { "type": "company", "title": "Specific headline", "summary": "1-sentence significance" },
    { "type": "macro",   "title": "Industry/macro headline", "summary": "1-sentence impact on company" },
    { "type": "macro",   "title": "Industry/macro headline", "summary": "1-sentence impact" },
    { "type": "company", "title": "Specific headline", "summary": "1-sentence significance" }
  ],

  "contracts": [
    { "name": "Partner name", "type": "Partnership|Contract|Deal", "description": "2-sentence description and strategic significance" },
    { "name": "Partner name", "type": "Partnership|Contract|Deal", "description": "2-sentence description" },
    { "name": "Partner name", "type": "Partnership|Contract|Deal", "description": "2-sentence description" }
  ],

  "moat": {
    "advantages": ["Advantage 1 with explanation", "Advantage 2", "Advantage 3", "Advantage 4"],
    "summary": "2-sentence competitive positioning summary",
    "moatType": "e.g. Network Effects + Cost Advantages"
  },

  "projections": {
    "bullTarget": "$000",
    "baseTarget": "$000",
    "bearTarget": "$000",
    "timeframe": "12 months",
    "bullishScore": 72,
    "keyRisks":     ["Risk 1", "Risk 2", "Risk 3"],
    "keyTailwinds": ["Tailwind 1", "Tailwind 2", "Tailwind 3"],
    "summary": "3-sentence forward-looking synthesis"
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

  const data  = await resp.json();
  const text  = data.content?.map(b => b.text || '').join('') || '';
  const clean = text.replace(/```json|```/g, '').trim();

  try {
    return JSON.parse(clean);
  } catch {
    const match = clean.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
    throw new Error('AI returned unparseable response â€” please retry.');
  }
}
