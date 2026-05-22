// Vercel Serverless Function
// Generates TWO images per request:
//   1. A 3D photorealistic cup mockup (shown to customer on the page)
//   2. A flat 170×96mm print-ready design (sent to factory via email)
// Requires OPENAI_API_KEY environment variable in Vercel

export const config = {
  api: {
    bodyParser: {
      sizeLimit: '10mb',
    },
  },
};

async function callOpenAI(apiKey, prompt, imageBase64, size) {
  // If user uploaded a reference image, use edits endpoint
  if (imageBase64) {
    try {
      const base64Data = imageBase64.includes(',') ? imageBase64.split(',')[1] : imageBase64;
      const mimeMatch = imageBase64.match(/^data:(image\/\w+);base64,/);
      const mime = mimeMatch ? mimeMatch[1] : 'image/png';

      const imageBuffer = Buffer.from(base64Data, 'base64');
      const blob = new Blob([imageBuffer], { type: mime });

      const formData = new FormData();
      formData.append('image', blob, 'reference.png');
      formData.append('prompt', prompt);
      formData.append('model', 'gpt-image-1');
      formData.append('size', size);
      formData.append('quality', 'high');
      formData.append('n', '1');

      const r = await fetch('https://api.openai.com/v1/images/edits', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${apiKey}` },
        body: formData
      });

      if (r.ok) {
        const j = await r.json();
        return { ok: true, data: j, model: 'gpt-image-1 (edits)' };
      } else {
        const errText = await r.text();
        console.error('edits failed:', r.status, errText.substring(0, 300));
      }
    } catch (e) {
      console.error('edits exception:', e.message);
    }
  }

  // Text-to-image: try gpt-image-1
  try {
    const r = await fetch('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'gpt-image-1',
        prompt: prompt,
        size: size,
        quality: 'high',
        n: 1
      })
    });
    if (r.ok) {
      const j = await r.json();
      return { ok: true, data: j, model: 'gpt-image-1' };
    } else {
      const errText = await r.text();
      console.error('gpt-image-1 failed:', r.status, errText.substring(0, 300));
    }
  } catch (e) {
    console.error('gpt-image-1 exception:', e.message);
  }

  // Fall back to DALL-E 3
  const dalleSize = size === '1536x1024' ? '1792x1024' : (size === '1024x1536' ? '1024x1792' : '1024x1024');
  try {
    const r = await fetch('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'dall-e-3',
        prompt: prompt,
        size: dalleSize,
        quality: 'hd',
        n: 1,
        response_format: 'b64_json'
      })
    });
    if (r.ok) {
      const j = await r.json();
      return { ok: true, data: j, model: 'dall-e-3' };
    } else {
      const errText = await r.text();
      console.error('dall-e-3 failed:', r.status, errText.substring(0, 300));
      return { ok: false, error: `dall-e-3 ${r.status}: ${errText.substring(0, 200)}` };
    }
  } catch (e) {
    return { ok: false, error: `dall-e-3 exception: ${e.message}` };
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed. Use POST.' });

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({
      error: 'API key not configured',
      message: 'OPENAI_API_KEY חסר בהגדרות Vercel'
    });
  }

  try {
    const { prompt, imageBase64 } = req.body || {};
    if (!prompt) return res.status(400).json({ error: 'Missing prompt' });

    // ============================================================
    // PROMPT 1: FLAT 170×96 PRINT FILE (for factory email)
    // Clean, modern, edge-to-edge. NO decorative frames or borders.
    // ============================================================
    const flatPrompt = `Create a modern, clean, professional flat 2D graphic design for printing on a paper coffee cup. This is a print-ready artwork file, NOT a photo of a cup.

User's request: ${prompt}

Design specifications:
- Modern minimalist graphic design — clean, contemporary, fresh aesthetic
- Horizontal landscape rectangle, wide banner proportion (approximately 170:96 ratio)
- The artwork must fill the ENTIRE rectangle edge-to-edge with NO empty white margins anywhere
- ABSOLUTELY NO decorative frames, NO ornate borders, NO ribbon banners, NO Victorian/vintage flourishes
- DO NOT add unnecessary background patterns the user did not ask for
- Use ONLY the visual elements the user actually described — nothing extra
- If the user mentioned Hebrew text, render it perfectly: correctly spelled real Hebrew letters, clean modern typography, large and readable
- Hebrew typography must be authentic — letter shapes must be accurate
- Smart use of whitespace and clean composition — not cluttered, not busy
- Contemporary color palette appropriate to the user's described mood
- Output: a clean, minimal, modern print artwork that looks like it was designed by a professional graphic designer in 2026
- NO 3D cup, NO mockup, NO product photo — this is a flat print file only`;

    // ============================================================
    // PROMPT 2: 3D CUP MOCKUP (for customer preview on page)
    // ============================================================
    const mockupPrompt = `Create a photorealistic product photography mockup of a single white paper coffee cup (disposable takeaway cup) with a custom design printed on it. Studio product shot.

The design printed on the cup is based on this request: ${prompt}

Requirements:
- One single white paper cup, centered in frame, shown at a slight 3/4 angle so the printed design is clearly visible
- Photorealistic 3D rendering — looks like a real product photograph
- The design wraps naturally around the cup's curved surface
- Clean light neutral background (soft white or light gray), subtle natural shadow under the cup
- Soft professional studio lighting
- The design must match the style, mood, colors and any Hebrew text the user described
- Hebrew text on the cup must be spelled correctly with authentic Hebrew letter shapes
- Modern contemporary aesthetic — NO ornate Victorian borders, NO vintage flourishes unless the user explicitly asked for that style
- Use ONLY the elements the user described — do not invent extra decorations
- High-end commercial product photography quality`;

    // Run both image generations in parallel for speed
    const [flatResult, mockupResult] = await Promise.all([
      callOpenAI(apiKey, flatPrompt, imageBase64, '1536x1024'),
      callOpenAI(apiKey, mockupPrompt, imageBase64, '1024x1024')
    ]);

    if (!flatResult.ok && !mockupResult.ok) {
      return res.status(500).json({
        error: 'Failed to generate both images',
        flatError: flatResult.error,
        mockupError: mockupResult.error
      });
    }

    const flatImg = flatResult.ok ? flatResult.data.data[0] : null;
    const mockupImg = mockupResult.ok ? mockupResult.data.data[0] : null;

    return res.status(200).json({
      success: true,
      flat: flatImg ? {
        model: flatResult.model,
        b64_json: flatImg.b64_json || null,
        url: flatImg.url || null
      } : null,
      mockup: mockupImg ? {
        model: mockupResult.model,
        b64_json: mockupImg.b64_json || null,
        url: mockupImg.url || null
      } : null
    });

  } catch (err) {
    console.error('Function error:', err);
    return res.status(500).json({
      error: 'Internal server error',
      message: err.message
    });
  }
}
