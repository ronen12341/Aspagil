// Vercel Serverless Function
// Calls OpenAI DALL-E / GPT-Image to generate cup designs
// Requires OPENAI_API_KEY environment variable in Vercel

export default async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed. Use POST.' });
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({
      error: 'API key not configured',
      message: 'מנהל האתר צריך להוסיף את OPENAI_API_KEY בהגדרות Vercel'
    });
  }

  try {
    const { hebrewText, style, backgroundDescription, hasLogo, logoBase64 } = req.body || {};

    if (!hebrewText) {
      return res.status(400).json({ error: 'Missing hebrewText parameter' });
    }

    const styleMap = {
      watercolor: 'soft watercolor painting style with delicate pastel colors and gentle brush strokes',
      minimal: 'minimalist clean modern design with simple geometric shapes and lots of white space',
      bold: 'bold vibrant colors with strong contrast, pop art inspired',
      kids: 'cute playful kids style with bright fun colors and cartoon elements',
      elegant: 'elegant luxury design with ornamental gold accents and sophisticated decorations',
      floral: 'beautiful floral botanical pattern with flowers and leaves',
      vintage: 'vintage retro classic style with distressed texture and classic ornaments',
      modern: 'modern contemporary sleek design with geometric patterns'
    };

    const styleDesc = styleMap[style] || styleMap.watercolor;
    const bgDesc = backgroundDescription || 'decorative ornaments and patterns';

    // Build a sophisticated prompt for high-quality cup label
    const prompt = `Design a beautiful flat 2D paper cup label artwork in wide horizontal banner format (170x96mm proportion, 16:9 aspect ratio).

Style: ${styleDesc}.

Decorative theme: ${bgDesc}.

CENTER OF DESIGN: Display this Hebrew text prominently in elegant decorative Hebrew typography:
"${hebrewText}"

The Hebrew text must be clearly readable, well-centered, and styled to match the overall design theme.

Composition: Flat 2D artwork like a luxury wedding invitation or premium product label. Decorative borders and ornamental frames around the edges. The Hebrew text is the central focus with beautiful surrounding decorations.

IMPORTANT: This is FLAT 2D artwork only - not a 3D cup, not a product photo, not a mockup. Just the design itself ready to be printed onto a paper cup. White or light background with the decorative artwork. Professional, beautiful, suitable for printing.`;

    // Try gpt-image-1 first (best quality, supports text), fall back to dall-e-3
    let imageData = null;
    let modelUsed = '';
    let errorDetails = '';

    // Attempt 1: gpt-image-1 (best for text rendering)
    try {
      const r1 = await fetch('https://api.openai.com/v1/images/generations', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: 'gpt-image-1',
          prompt: prompt,
          size: '1536x1024',
          quality: 'high',
          n: 1
        })
      });

      if (r1.ok) {
        const data = await r1.json();
        if (data.data && data.data[0]) {
          imageData = data.data[0];
          modelUsed = 'gpt-image-1';
        }
      } else {
        const errText = await r1.text();
        errorDetails = `gpt-image-1: ${r1.status} - ${errText}`;
        console.error(errorDetails);
      }
    } catch (e1) {
      errorDetails = `gpt-image-1 exception: ${e1.message}`;
    }

    // Attempt 2: Fall back to dall-e-3 if gpt-image-1 failed
    if (!imageData) {
      try {
        const r2 = await fetch('https://api.openai.com/v1/images/generations', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            model: 'dall-e-3',
            prompt: prompt,
            size: '1792x1024',
            quality: 'hd',
            n: 1,
            response_format: 'b64_json'
          })
        });

        if (r2.ok) {
          const data = await r2.json();
          if (data.data && data.data[0]) {
            imageData = data.data[0];
            modelUsed = 'dall-e-3';
          }
        } else {
          const errText = await r2.text();
          errorDetails += ` | dall-e-3: ${r2.status} - ${errText}`;
          console.error(errorDetails);
        }
      } catch (e2) {
        errorDetails += ` | dall-e-3 exception: ${e2.message}`;
      }
    }

    if (!imageData) {
      return res.status(500).json({
        error: 'Failed to generate image',
        details: errorDetails
      });
    }

    return res.status(200).json({
      success: true,
      model: modelUsed,
      b64_json: imageData.b64_json || null,
      url: imageData.url || null,
      revised_prompt: imageData.revised_prompt || null
    });

  } catch (err) {
    console.error('Function error:', err);
    return res.status(500).json({
      error: 'Internal server error',
      message: err.message
    });
  }
}
