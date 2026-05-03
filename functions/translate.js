const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: corsHeaders(), body: '' };
  }
  if (event.httpMethod !== 'POST') return respond(405, { error: 'Method not allowed' });

  let body;
  try { body = JSON.parse(event.body); } catch(e) { return respond(400, { error: 'Invalid JSON' }); }

  const { career_name, why, imp_t, study, ex } = body;
  if (!career_name) return respond(400, { error: 'Missing career_name' });

  // Check Supabase cache
  try {
    const cached = await supabaseGet(career_name);
    if (cached) return respond(200, { data: cached, source: 'cache' });
  } catch(e) { console.error('Supabase read error:', e.message); }

  // Translate with Claude
  const prompt = `Translate these 4 short career description texts from English to Dutch (Belgian/Flemish tone, clear and direct for teenagers). Return ONLY valid JSON, no markdown.

{
  "why": "${(why||'').replace(/"/g,'\\"')}",
  "imp_t": "${(imp_t||'').replace(/"/g,'\\"')}",
  "study": "${(study||'').replace(/"/g,'\\"')}",
  "ex": "${(ex||'').replace(/"/g,'\\"')}"
}

Return the same JSON structure with Dutch translations. Keep proper nouns (university names, technologies, companies) in English. Keep it concise.`;

  let translated;
  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 400,
        messages: [{ role: 'user', content: prompt }]
      })
    });
    const data = await resp.json();
    let text = data.content[0].text.trim().replace(/^```json?\s*/,'').replace(/\s*```$/,'');
    translated = JSON.parse(text);
  } catch(e) {
    return respond(500, { error: 'Translation failed: ' + e.message });
  }

  // Save to Supabase
  try { await supabaseSave(career_name, translated); } catch(e) { console.error('Save error:', e.message); }

  return respond(200, { data: translated, source: 'generated' });
};

async function supabaseGet(name) {
  const url = `${SUPABASE_URL}/rest/v1/translations?career_name=eq.${encodeURIComponent(name)}&select=data`;
  const resp = await fetch(url, {
    headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
  });
  const rows = await resp.json();
  return rows.length > 0 ? rows[0].data : null;
}

async function supabaseSave(name, data) {
  const url = `${SUPABASE_URL}/rest/v1/translations`;
  await fetch(url, {
    method: 'POST',
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'resolution=merge-duplicates'
    },
    body: JSON.stringify({ career_name: name, data })
  });
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
