const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: corsHeaders(), body: '' };
  }

  // GET - retrieve video for a career
  if (event.httpMethod === 'GET') {
    const careerName = event.queryStringParameters?.career;
    if (!careerName) return respond(400, { error: 'Missing career parameter' });

    try {
      const url = `${SUPABASE_URL}/rest/v1/videos?career_name=eq.${encodeURIComponent(careerName)}&select=youtube_url,submitted_at`;
      const response = await fetch(url, {
        headers: {
          'apikey': SUPABASE_KEY,
          'Authorization': `Bearer ${SUPABASE_KEY}`
        }
      });
      const rows = await response.json();
      return respond(200, rows.length > 0 ? { video: rows[0] } : { video: null });
    } catch (e) {
      return respond(500, { error: e.message });
    }
  }

  // POST - submit a video for a career
  if (event.httpMethod === 'POST') {
    let body;
    try { body = JSON.parse(event.body); } catch (e) { return respond(400, { error: 'Invalid JSON' }); }

    const { career_name, youtube_url } = body;
    if (!career_name || !youtube_url) return respond(400, { error: 'Missing career_name or youtube_url' });

    // Validate YouTube URL
    const ytRegex = /^https?:\/\/(www\.)?(youtube\.com\/watch\?v=|youtu\.be\/)[\w-]+/;
    if (!ytRegex.test(youtube_url)) return respond(400, { error: 'Invalid YouTube URL' });

    // Extract video ID for thumbnail
    const videoId = extractVideoId(youtube_url);
    if (!videoId) return respond(400, { error: 'Could not extract video ID' });

    try {
      const url = `${SUPABASE_URL}/rest/v1/videos`;
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'apikey': SUPABASE_KEY,
          'Authorization': `Bearer ${SUPABASE_KEY}`,
          'Content-Type': 'application/json',
          'Prefer': 'resolution=merge-duplicates'
        },
        body: JSON.stringify({
          career_name,
          youtube_url,
          video_id: videoId,
          submitted_at: new Date().toISOString()
        })
      });

      if (!response.ok) {
        const err = await response.text();
        return respond(500, { error: `Supabase error: ${err}` });
      }

      return respond(200, { success: true, video_id: videoId });
    } catch (e) {
      return respond(500, { error: e.message });
    }
  }

  return respond(405, { error: 'Method not allowed' });
};

function extractVideoId(url) {
  const patterns = [
    /youtube\.com\/watch\?v=([\w-]+)/,
    /youtu\.be\/([\w-]+)/,
    /youtube\.com\/embed\/([\w-]+)/
  ];
  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) return match[1];
  }
  return null;
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
