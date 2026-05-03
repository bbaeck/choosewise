const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

exports.handler = async (event) => {
  // Handle CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: corsHeaders(), body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return respond(405, { error: 'Method not allowed' });
  }

  let career;
  try {
    career = JSON.parse(event.body);
  } catch (e) {
    return respond(400, { error: 'Invalid JSON body' });
  }

  if (!career || !career.n) {
    return respond(400, { error: 'Missing career name' });
  }

  // 1. Check Supabase cache first
  try {
    const cached = await supabaseGet(career.n);
    if (cached) {
      console.log(`Cache hit: ${career.n}`);
      return respond(200, { data: cached, source: 'cache' });
    }
  } catch (e) {
    console.error('Supabase read error:', e.message);
    // Continue to generate even if cache read fails
  }

  // 2. Generate with Claude
  console.log(`Generating enrichment for: ${career.n}`);
  let enriched;
  try {
    enriched = await generateWithClaude(career);
  } catch (e) {
    console.error('Claude error:', e.message);
    return respond(500, { error: 'Failed to generate enrichment: ' + e.message });
  }

  // 3. Save to Supabase
  try {
    await supabaseSave(career.n, enriched);
    console.log(`Saved to Supabase: ${career.n}`);
  } catch (e) {
    console.error('Supabase write error:', e.message);
    // Return enrichment even if save fails
  }

  return respond(200, { data: enriched, source: 'generated' });
};

async function generateWithClaude(c) {
  const prompt = `You are a career strategist for young people aged 15-25. Be honest, practical, and direct. Return ONLY valid JSON, no markdown, no backticks, no explanation.

Career: ${c.n} (Sector: ${c.s})
Scores — AI-proof: ${c.ai}/100, Wealth: ${c.w}/100, Meaning: ${c.m}/100, Impact: ${c.imp}/100
Why it matters: ${c.why || ''}
How to get there: ${c.study || ''}

Return this exact JSON structure (salary ranges in EUR, be specific and honest):
{
  "fit": {
    "traits": ["specific trait 1", "specific trait 2", "specific trait 3"],
    "style": "one honest sentence about who thrives in this career",
    "risk": "low or medium or high",
    "horizon": "short-term payoff or medium-term payoff or long-term payoff"
  },
  "reality": {
    "downsides": ["honest downside 1", "honest downside 2", "honest downside 3"],
    "failure": "most common reason people fail or quit in 1 sentence",
    "barrier": "single hardest barrier to entry",
    "market": "honest 1-sentence market reality"
  },
  "timeline": {
    "y0_3": "what the first 3 years actually look like day-to-day",
    "y3_7": "what years 3-7 look like as you advance",
    "y7plus": "what 7+ years looks like at senior level",
    "sal_early": "e.g. €25k-€40k",
    "sal_mid": "e.g. €55k-€85k",
    "sal_top": "e.g. €120k-€250k+"
  },
  "wealth": {
    "early": "e.g. €25k-€40k",
    "mid": "e.g. €55k-€85k",
    "top": "e.g. €120k-€300k+",
    "variance": "high or medium or low",
    "variance_note": "one sentence explaining the income spread within this field"
  },
  "paths": {
    "academic": "specific degree names and 2-3 top programs or universities",
    "alternative": "concrete non-traditional route with specific steps",
    "required": ["specific must-have qualification"],
    "optional": ["helpful extra 1", "helpful extra 2"],
    "subjects": ["Subject1", "Subject2", "Subject3"]
  },
  "adjacent": ["Specific Role 1", "Specific Role 2", "Specific Role 3", "Specific Role 4"],
  "where": {
    "companies": ["Real Company 1", "Real Company 2", "Real Company 3"],
    "industries": ["Industry 1", "Industry 2"],
    "type": "startup or corporate or mixed or public sector or self-employed"
  },
  "ai_detail": {
    "cant_do": "specific concrete thing AI cannot do in this role today",
    "near_future": "what AI will likely automate in this role within 5 years",
    "augment": "the single most powerful way AI will make this professional more effective"
  },
  "steps": [
    "Concrete action to take this year (age 15-17)",
    "Concrete action for year 2 (age 17-19)",
    "Concrete action for year 3 (age 19-21)",
    "Concrete action for year 4-5 (age 21-23)",
    "Concrete action for year 5+ (age 23-25)"
  ],
  "choose_if": ["specific personality or situation match 1", "specific match 2", "specific match 3"],
  "avoid_if": ["specific honest reason to avoid 1", "specific reason 2", "specific reason 3"]
}`;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1000,
      messages: [{ role: 'user', content: prompt }]
    })
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Anthropic API error ${response.status}: ${err}`);
  }

  const data = await response.json();
  let text = data.content[0].text.trim();
  text = text.replace(/^```json\s*/g, '').replace(/^```\s*/g, '').replace(/\s*```$/g, '').trim();
  return JSON.parse(text);
}

async function supabaseGet(careerName) {
  const url = `${SUPABASE_URL}/rest/v1/enrichments?career_name=eq.${encodeURIComponent(careerName)}&select=data`;
  const response = await fetch(url, {
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json'
    }
  });
  if (!response.ok) throw new Error(`Supabase GET error: ${response.status}`);
  const rows = await response.json();
  return rows.length > 0 ? rows[0].data : null;
}

async function supabaseSave(careerName, data) {
  const url = `${SUPABASE_URL}/rest/v1/enrichments`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'resolution=merge-duplicates'
    },
    body: JSON.stringify({ career_name: careerName, data: data })
  });
  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Supabase POST error: ${response.status}: ${err}`);
  }
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
  };
}

function respond(statusCode, body) {
  return {
    statusCode,
    headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  };
}
