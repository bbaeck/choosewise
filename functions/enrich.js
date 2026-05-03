const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: corsHeaders(), body: '' };
  }
  if (event.httpMethod !== 'POST') return respond(405, { error: 'Method not allowed' });

  let career;
  try { career = JSON.parse(event.body); } catch(e) { return respond(400, { error: 'Invalid JSON body' }); }
  if (!career || !career.n) return respond(400, { error: 'Missing career name' });

  // 1. Check Supabase cache
  try {
    const cached = await supabaseGet(career.n);
    if (cached) {
      console.log('Cache hit:', career.n);
      return respond(200, { data: cached, source: 'cache' });
    }
  } catch(e) { console.error('Supabase read error:', e.message); }

  // 2. Generate with Claude
  console.log('Generating:', career.n);
  let enriched;
  try {
    enriched = await generateWithClaude(career);
  } catch(e) {
    console.error('Claude error:', e.message);
    return respond(500, { error: 'Failed to generate enrichment: ' + e.message });
  }

  // 3. Save to Supabase
  try {
    await supabaseSave(career.n, enriched);
  } catch(e) {
    console.error('Supabase write error:', e.message);
  }

  return respond(200, { data: enriched, source: 'generated' });
};

async function generateWithClaude(c) {
  // Shorter prompt to avoid truncation
  const prompt = `Career strategist for teens. Return ONLY valid JSON, no markdown, no backticks.

Career: ${c.n} (${c.s}) — AI-proof:${c.ai}/100 Wealth:${c.w}/100 Meaning:${c.m}/100 Impact:${c.imp}/100

JSON (keep each string under 100 chars):
{"fit":{"traits":["t1","t2","t3"],"style":"one sentence","risk":"low/medium/high","horizon":"short/medium/long payoff"},"reality":{"downsides":["d1","d2","d3"],"failure":"one sentence","barrier":"one sentence","market":"one sentence"},"timeline":{"y0_3":"one sentence","y3_7":"one sentence","y7plus":"one sentence","sal_early":"e.g. 25k-40k","sal_mid":"e.g. 55k-85k","sal_top":"e.g. 100k-200k+"},"wealth":{"early":"25k-40k","mid":"55k-85k","top":"100k-250k+","variance":"high/medium/low","variance_note":"one sentence"},"paths":{"academic":"degree and 2 programs","alternative":"one sentence","required":["qual1"],"optional":["opt1"],"subjects":["S1","S2","S3"]},"adjacent":["R1","R2","R3","R4"],"where":{"companies":["C1","C2","C3"],"industries":["I1","I2"],"type":"startup/corporate/mixed/public"},"ai_detail":{"cant_do":"one sentence","near_future":"one sentence","augment":"one sentence"},"steps":["step1","step2","step3","step4","step5"],"choose_if":["r1","r2","r3"],"avoid_if":["r1","r2","r3"]}`;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1200,
      messages: [{ role: 'user', content: prompt }]
    })
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Anthropic API ${response.status}: ${err}`);
  }

  const data = await response.json();
  if (data.error) throw new Error(data.error.message);

  let text = data.content[0].text.trim();
  // Strip markdown fences if present
  text = text.replace(/^```json\s*/i, '').replace(/^```\s*/, '').replace(/\s*```$/, '').trim();

  // Try parsing as-is
  try {
    return JSON.parse(text);
  } catch(e) {
    // Response was truncated - try to recover by closing the JSON
    console.log('JSON truncated, attempting recovery. Length:', text.length);
    const recovered = recoverJSON(text);
    if (recovered) return recovered;
    throw new Error('Unterminated string in JSON at position ' + e.message);
  }
}

function recoverJSON(text) {
  // Strategy: truncate at last complete top-level key-value pair
  // Find the last } that closes a top-level section
  const topLevelKeys = ['fit','reality','timeline','wealth','paths','adjacent','where','ai_detail','steps','choose_if','avoid_if'];
  
  // Try progressively shorter versions
  for (let i = topLevelKeys.length - 1; i >= 3; i--) {
    const key = topLevelKeys[i];
    const keyIdx = text.lastIndexOf('"' + key + '"');
    if (keyIdx === -1) continue;
    
    // Find the end of the previous section
    const beforeKey = text.slice(0, keyIdx).trimEnd();
    if (beforeKey.endsWith(',')) {
      const truncated = beforeKey.slice(0, -1) + '}';
      try {
        const parsed = JSON.parse(truncated);
        // Fill in missing keys with defaults
        topLevelKeys.forEach(function(k) {
          if (!parsed[k]) {
            if (k === 'adjacent' || k === 'steps' || k === 'choose_if' || k === 'avoid_if') parsed[k] = [];
            else parsed[k] = {};
          }
        });
        return parsed;
      } catch(e2) { continue; }
    }
  }
  return null;
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
  if (!response.ok) throw new Error(`Supabase GET ${response.status}`);
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
    throw new Error(`Supabase POST ${response.status}: ${err}`);
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
