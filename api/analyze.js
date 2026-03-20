export default async function handler(req, res) {
  // CORS â€” allow your deployed frontend to call this
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'Server misconfigured: API key not set' });

  try {
    const { ticker, currentPrice, companyName, exchange } = req.body;
    if (!ticker) return res.status(400).json({ error: 'Missing ticker' });

    const systemPrompt = `You are a senior equity research analyst. Return ONLY valid JSON â€” no markdown, no preamble, no explanation outside the JSON structure. Be concise but substantive. Use real knowledge about the company.`;

    const userPrompt = `Analyze ${ticker} (${companyName || ticker}) at current price $${currentPrice?.toFixed?.(2) ?? currentPrice}.

Return this exact JSON structure (fill every field with real, accurate data):
{
  "companyName": "Full legal company name",
  "sector": "Sector name",
  "industry": "Sub-industry",
  "exchange": "${exchange || 'NASDAQ'}",
  "marketCap": "e.g. $2.8T",
  "description": "2-sentence company description",

  "dcf": {
    "intrinsicValue": 000.00,
    "currentPrice": ${currentPrice},
    "upside": 0.0,
    "verdict": "undervalued|overvalued|fair",
    "verdictLabel": "e.g. Undervalued by 18%",
    "wacc": "e.g. 9.2%",
    "terminalGrowthRate": "e.g. 3.0%",
    "projectedFCFGrowth": "e.g. 12% over 5yr",
    "explanation": "3-sentence plain-English explanation of how DCF works and what it means for this specific company right now"
  },

  "metrics": {
    "pe": { "value": "00.0x", "good": true, "note": "vs industry avg ~25x" },
    "roic": { "value": "00.0%", "good": true, "note": "benchmark: >15% is excellent" },
    "eps": { "value": "$00.00", "good": true, "note": "TTM EPS" },
    "fcf": { "value": "$00B", "good": true, "note": "trailing 12 months" },
    "evEbitda": { "value": "00.0x", "good": true, "note": "vs sector avg" },
    "debtToEquity": { "value": "0.00", "good": true, "note": "leverage note" }
  },

  "peersComparison": "2-3 sentences comparing these metrics to 2-3 named direct competitors with their actual metric values",

  "news": [
    { "type": "company", "title": "Specific recent news headline", "summary": "1-sentence summary of significance", "date": "recent" },
    { "type": "company", "title": "Specific recent news headline", "summary": "1-sentence summary", "date": "recent" },
    { "type": "macro", "title": "Macro/industry headline affecting this company", "summary": "1-sentence impact explanation", "date": "recent" },
    { "type": "macro", "title": "Another macro/industry headline", "summary": "1-sentence impact", "date": "recent" },
    { "type": "company", "title": "Specific recent news headline", "summary": "1-sentence summary", "date": "recent" }
  ],

  "contracts": [
    { "name": "Partner or Customer name", "type": "Partnership|Contract|Deal|Acquisition", "description": "2-sentence description of the deal scope and its strategic/financial significance" },
    { "name": "Partner or Customer name", "type": "Partnership|Contract|Deal|Acquisition", "description": "2-sentence description" },
    { "name": "Partner or Customer name", "type": "Partnership|Contract|Deal|Acquisition", "description": "2-sentence description" }
  ],

  "moat": {
    "advantages": [
      "Advantage 1 with a brief explanation of why it matters",
      "Advantage 2 with brief explanation",
      "Advantage 3 with brief explanation",
      "Advantage 4 with brief explanation"
    ],
    "summary": "2-sentence overall competitive positioning and moat durability summary",
    "moatType": "e.g. Network Effects + Cost Advantages + Intangibles"
  },

  "projections": {
    "bullTarget": "$000",
    "baseTarget": "$000",
    "bearTarget": "$000",
    "timeframe": "12 months",
    "bullishScore": 72,
    "keyRisks": ["Specific risk 1", "Specific risk 2", "Specific risk 3"],
    "keyTailwinds": ["Specific tailwind 1", "Specific tailwind 2", "Specific tailwind 3"],
    "summary": "3-sentence forward-looking synthesis covering growth catalysts, key risks, and overall conviction"
  }
}`;

    const anthropicResp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 2000,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }]
      })
    });

    if (!anthropicResp.ok) {
      const errData = await anthropicResp.json().catch(() => ({}));
      return res.status(anthropicResp.status).json({ error: errData.error?.message || 'Anthropic API error' });
    }

    const anthropicData = await anthropicResp.json();
    const text = anthropicData.content?.map(b => b.text || '').join('') || '';
    const clean = text.replace(/```json|```/g, '').trim();

    let parsed;
    try {
      parsed = JSON.parse(clean);
    } catch {
      const match = clean.match(/\{[\s\S]*\}/);
      if (match) parsed = JSON.parse(match[0]);
      else return res.status(500).json({ error: 'AI returned unparseable response. Please retry.' });
    }

    return res.status(200).json(parsed);

  } catch (err) {
    console.error('Proxy error:', err);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
}
