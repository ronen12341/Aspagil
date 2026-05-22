// Vercel Serverless Function
// Two-step generation pipeline:
//   Step 1: Generate FLAT 170×96 print design (uses user's reference photo if uploaded)
//   Step 2: Take that flat design and render it wrapped around a 3D cup (consistent design)
// This guarantees the customer preview and the print file show the SAME design.
// Requires OPENAI_API_KEY environment variable in Vercel

export const config = {
  api: {
    bodyParser: {
      sizeLimit: '10mb',
    },
  },
};

// Helper: call OpenAI edits endpoint with an image input
async function callEdits(apiKey, prompt, imageBlob, size, filename) {
  const formData = new FormData();
  formData.append('image', imageBlob, filename || 'input.png');
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
    return { ok: true, data: j.data[0], model: 'gpt-image-1 (edits)' };
  }
  const errText = await r.text();
  return { ok: false, error: `edits ${r.status}: ${errText.substring(0, 300)}` };
}

// Helper: call OpenAI generations endpoint (no image input)
async function callGen(apiKey, prompt, size) {
  // Try gpt-image-1 first
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
      return { ok: true, data: j.data[0], model: 'gpt-image-1' };
    }
    const errText = await r.text();
    console.error('gpt-image-1 failed:', r.status, errText.substring(0, 300));
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
      return { ok: true, data: j.data[0], model: 'dall-e-3' };
    }
    const errText = await r.text();
    return { ok: false, error: `dall-e-3 ${r.status}: ${errText.substring(0, 300)}` };
  } catch (e) {
    return { ok: false, error: `dall-e-3 exception: ${e.message}` };
  }
}

// Convert b64_json string to a Blob (for using as input to step 2)
function b64ToBlob(b64) {
  const bin = Buffer.from(b64, 'base64');
  return new Blob([bin], { type: 'image/png' });
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed. Use POST.' });

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'API key not configured', message: 'OPENAI_API_KEY חסר בהגדרות Vercel' });
  }

  try {
    const { prompt, imageBase64 } = req.body || {};
    if (!prompt) return res.status(400).json({ error: 'Missing prompt' });

    // ============================================================
    // STEP 1: Generate the FLAT 170×96 print design
    // ============================================================
    const photoInstruction = imageBase64
      ? `\n\nThe user has provided a personal photograph. CRITICAL: Use that exact photograph in the design. DO NOT redraw, regenerate, recreate, alter, modify, change, retouch, repaint, restyle, or reinterpret the person in the photo. Preserve the photograph pixel-perfect: same face, same eyes, same hair, same skin, same clothing, same background, same colors, same lighting — identical to the input photo. Treat the photograph as an unmodifiable asset that you are placing into the design (like cropping it and pasting it). You may crop it to a shape (oval, circle, heart, rectangle) but the pixels inside that shape must be the original photograph unchanged. The person must look IDENTICAL to the input photo — no AI face regeneration.`
      : '';

    const flatPrompt = `Create a flat 2D print-ready graphic design for a paper coffee cup label. This is a print file, NOT a photo of a cup.

User's design request: ${prompt}${photoInstruction}

Design rules:
- Modern, clean, contemporary aesthetic — 2026 graphic design style
- Wide horizontal landscape rectangle, proportion ~170:96 (roughly 1.77:1)
- Artwork fills the ENTIRE rectangle edge-to-edge — no empty white margins
- ABSOLUTELY NO decorative frames, NO ornate borders, NO Victorian flourishes, NO ribbon banners
- Use ONLY the visual elements the user described — do not invent extra decorations
- Hebrew text must be spelled correctly with authentic Hebrew letter shapes — large, readable, modern typography
- Clean composition, smart whitespace, not cluttered
- This is a flat print file — NO 3D cup, NO mockup, NO product photo`;

    let flatResult;
    if (imageBase64) {
      // User uploaded photo — use edits endpoint
      const base64Data = imageBase64.includes(',') ? imageBase64.split(',')[1] : imageBase64;
      const mimeMatch = imageBase64.match(/^data:(image\/\w+);base64,/);
      const mime = mimeMatch ? mimeMatch[1] : 'image/png';
      const buf = Buffer.from(base64Data, 'base64');
      const userBlob = new Blob([buf], { type: mime });
      flatResult = await callEdits(apiKey, flatPrompt, userBlob, '1536x1024', 'user-photo.png');
      // If edits failed, fall back to text-to-image
      if (!flatResult.ok) {
        console.error('edits step1 failed, falling back:', flatResult.error);
        flatResult = await callGen(apiKey, flatPrompt, '1536x1024');
      }
    } else {
      flatResult = await callGen(apiKey, flatPrompt, '1536x1024');
    }

    if (!flatResult.ok) {
      return res.status(500).json({ error: 'Step 1 (flat design) failed', details: flatResult.error });
    }

    const flatImg = flatResult.data;
    const flatB64 = flatImg.b64_json;
    const flatUrl = flatImg.url;

    // ============================================================
    // STEP 2: Take the flat design and wrap it around a 3D cup mockup
    // This guarantees the mockup shows the EXACT SAME design as the flat file
    // ============================================================
    let flatBlobForStep2;
    if (flatB64) {
      flatBlobForStep2 = b64ToBlob(flatB64);
    } else if (flatUrl) {
      try {
        const r = await fetch(flatUrl);
        const arr = await r.arrayBuffer();
        flatBlobForStep2 = new Blob([Buffer.from(arr)], { type: 'image/png' });
      } catch (e) {
        console.error('Failed to fetch flat URL for step 2:', e.message);
      }
    }

    const mockupPrompt = `Render a photorealistic 3D product photography mockup of a white paper coffee cup with the EXACT artwork from the input image printed on it.

CRITICAL: The artwork in the input image is the print design that goes on the cup. Wrap that EXACT design around the cup surface — same colors, same layout, same Hebrew text (correctly spelled), same photograph (if any) preserved pixel-perfect with no face regeneration, same composition. Do NOT redesign, do NOT change the artwork. Just take the input image and wrap it naturally around a paper cup.

Output requirements:
- Single white paper takeaway cup, centered, shown at slight 3/4 angle
- The cup surface displays the input artwork wrapped around its curve naturally
- Clean light neutral background (soft white/gray)
- Soft natural shadow under the cup
- Professional studio product photography lighting
- Looks like a real photograph of a real product
- If there's a photo of a person in the artwork, the person must look IDENTICAL to the input — no face redrawing`;

    let mockupResult;
    if (flatBlobForStep2) {
      mockupResult = await callEdits(apiKey, mockupPrompt, flatBlobForStep2, '1024x1024', 'flat-design.png');
    } else {
      // Couldn't get flat as blob — fall back to text-to-image mockup
      mockupResult = await callGen(apiKey, `Photorealistic 3D paper cup mockup. ${prompt}. Single white paper cup, slight angle, clean background, studio lighting. Hebrew text spelled correctly. Modern minimal design — no Victorian frames.`, '1024x1024');
    }

    const mockupImg = mockupResult.ok ? mockupResult.data : null;

    return res.status(200).json({
      success: true,
      flat: {
        model: flatResult.model,
        b64_json: flatB64 || null,
        url: flatUrl || null
      },
      mockup: mockupImg ? {
        model: mockupResult.model,
        b64_json: mockupImg.b64_json || null,
        url: mockupImg.url || null
      } : null,
      mockupError: mockupResult.ok ? null : mockupResult.error
    });

  } catch (err) {
    console.error('Function error:', err);
    return res.status(500).json({ error: 'Internal server error', message: err.message });
  }
}
