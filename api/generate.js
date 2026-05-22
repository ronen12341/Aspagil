// Vercel Serverless Function
// Calls OpenAI DALL-E / GPT-Image to generate cup designs
// Requires OPENAI_API_KEY environment variable in Vercel

export const config = {
  api: {
    bodyParser: {
      sizeLimit: '10mb',
    },
  },
};

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
      message: 'OPENAI_API_KEY חסר בהגדרות Vercel'
    });
  }

  try {
    const { prompt, imageBase64 } = req.body || {};

    if (!prompt) {
      return res.status(400).json({ error: 'Missing prompt' });
    }

    // Build a richer prompt for cup design - in Hebrew + English combined
    const fullPrompt = `Design a beautiful flat 2D paper cup label artwork in wide horizontal format (170x96mm proportion, 16:9 ratio). The user's request: ${prompt}

Important guidelines:
- This is FLAT 2D artwork, not a 3D cup photo - just the design that will be printed on a cup
- Wide horizontal banner format
- Beautiful, professional, suitable for printing
- Include any Hebrew text mentioned by the user, rendered clearly in elegant typography
- Match the style and elements requested
- Decorative, attractive composition`;

    let openaiResponse;
    let modelUsed = '';
    let errorDetails = '';

    // CASE 1: User uploaded a reference image - use image edits endpoint
    if (imageBase64) {
      try {
        // Extract base64 data
        const base64Data = imageBase64.includes(',') ? imageBase64.split(',')[1] : imageBase64;
        const mimeMatch = imageBase64.match(/^data:(image\/\w+);base64,/);
        const mime = mimeMatch ? mimeMatch[1] : 'image/png';

        const imageBuffer = Buffer.from(base64Data, 'base64');
        const blob = new Blob([imageBuffer], { type: mime });

        const formData = new FormData();
        formData.append('image', blob, 'reference.png');
        formData.append('prompt', fullPrompt);
        formData.append('model', 'gpt-image-1');
        formData.append('size', '1536x1024');
        formData.append('quality', 'high');
        formData.append('n', '1');

        const r1 = await fetch('https://api.openai.com/v1/images/edits', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${apiKey}` },
          body: formData
        });

        if (r1.ok) {
          openaiResponse = await r1.json();
          modelUsed = 'gpt-image-1 (edits)';
        } else {
          const errText = await r1.text();
          errorDetails = `gpt-image-1 edits: ${r1.status} - ${errText.substring(0, 500)}`;
          console.error(errorDetails);
        }
      } catch (e) {
        errorDetails = `Edits exception: ${e.message}`;
        console.error(errorDetails);
      }
    }

    // CASE 2: No image OR edits failed - use text-to-image
    if (!openaiResponse || !openaiResponse.data) {
      // Try gpt-image-1 first
      try {
        const r2 = await fetch('https://api.openai.com/v1/images/generations', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            model: 'gpt-image-1',
            prompt: fullPrompt,
            size: '1536x1024',
            quality: 'high',
            n: 1
          })
        });

        if (r2.ok) {
          openaiResponse = await r2.json();
          modelUsed = 'gpt-image-1';
        } else {
          const errText = await r2.text();
          errorDetails += ` | gpt-image-1: ${r2.status} - ${errText.substring(0, 500)}`;
          console.error(errorDetails);
        }
      } catch (e) {
        errorDetails += ` | gpt-image-1 exception: ${e.message}`;
      }

      // Fall back to DALL-E 3
      if (!openaiResponse || !openaiResponse.data) {
        try {
          const r3 = await fetch('https://api.openai.com/v1/images/generations', {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${apiKey}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              model: 'dall-e-3',
              prompt: fullPrompt,
              size: '1792x1024',
              quality: 'hd',
              n: 1,
              response_format: 'b64_json'
            })
          });

          if (r3.ok) {
            openaiResponse = await r3.json();
            modelUsed = 'dall-e-3';
          } else {
            const errText = await r3.text();
            errorDetails += ` | dall-e-3: ${r3.status} - ${errText.substring(0, 500)}`;
            console.error(errorDetails);
          }
        } catch (e) {
          errorDetails += ` | dall-e-3 exception: ${e.message}`;
        }
      }
    }

    if (!openaiResponse || !openaiResponse.data || !openaiResponse.data[0]) {
      return res.status(500).json({
        error: 'Failed to generate image',
        details: errorDetails || 'Unknown error'
      });
    }

    const imageData = openaiResponse.data[0];
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
