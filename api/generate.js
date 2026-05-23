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

// Visual text verifier: send the generated image + the expected text to
// GPT-4o-vision and ask it to OCR-check whether the printed text matches.
// Returns { matches: boolean, foundText: string, issues: string }.
async function verifyImageText(apiKey, imageB64OrUrl, expectedLines) {
  if (!expectedLines || expectedLines.length === 0) return { matches: true, foundText: '', issues: '' };
  try {
    const expected = expectedLines.map((t, i) => `${i + 1}. "${t}"`).join('\n');
    const imageContent = imageB64OrUrl.startsWith('http')
      ? { type: 'image_url', image_url: { url: imageB64OrUrl } }
      : { type: 'image_url', image_url: { url: `data:image/png;base64,${imageB64OrUrl}` } };

    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        messages: [
          {
            role: 'system',
            content: 'You are a strict text-verification OCR. Read Hebrew and English carefully. Output ONLY valid JSON, no markdown.'
          },
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: `Look at this paper-cup design image and identify the text printed on it.

The EXPECTED text strings are:
${expected}

Compare what you see in the image to the expected text, character-by-character. Hebrew letters must match exactly — no substitutions, no missing letters, no extra letters.

Return JSON in this exact shape:
{"foundText": "what you actually see in the image, exact characters", "matches": true_or_false, "issues": "short description of any mismatches, e.g. 'image says חכי but expected חכמה'"}

matches=true ONLY if every expected line appears character-perfect in the image. Otherwise false.`
              },
              imageContent
            ]
          }
        ],
        temperature: 0,
        max_tokens: 500
      })
    });
    if (!r.ok) {
      console.error('verifyImageText failed:', r.status);
      return { matches: true, foundText: '', issues: 'verifier-unavailable' }; // fail-open
    }
    const j = await r.json();
    let content = (j.choices[0].message.content || '').trim();
    content = content.replace(/^```json\s*/i, '').replace(/^```\s*/, '').replace(/\s*```$/, '');
    const parsed = JSON.parse(content);
    return {
      matches: parsed.matches === true,
      foundText: parsed.foundText || '',
      issues: parsed.issues || ''
    };
  } catch (e) {
    console.error('verifyImageText exception:', e.message);
    return { matches: true, foundText: '', issues: 'verifier-error' }; // fail-open so we don't block on infra issues
  }
}

// Pre-processor: use GPT-4o-mini to extract the EXACT Hebrew text + colors
// the user wants on the cup. This lets us inject a letter-by-letter
// spelling guide into the image-gen prompt, which dramatically reduces
// Hebrew spelling errors.
async function extractDesignStructure(apiKey, userPrompt) {
  try {
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: 'You extract structured info from Hebrew/English paper-cup design requests. Output ONLY valid JSON, no markdown, no explanation.'
          },
          {
            role: 'user',
            content: `Extract from this cup design request:
1. "textLines": array of EXACT text strings the user wants printed on the cup. Copy character-by-character in the EXACT script (Hebrew stays Hebrew, English stays English). Each separate phrase/line goes as its own entry. If no text is requested, return [].
2. "colors": array of color names the user mentioned (Hebrew or English). [] if none.
3. "theme": one short sentence describing the visual style/theme.

Request:
"""${userPrompt}"""

Return ONLY JSON in this exact shape:
{"textLines": ["..."], "colors": ["..."], "theme": "..."}`
          }
        ],
        temperature: 0,
        max_tokens: 400
      })
    });
    if (!r.ok) {
      console.error('extractDesignStructure failed:', r.status);
      return null;
    }
    const j = await r.json();
    let content = (j.choices[0].message.content || '').trim();
    // Strip ```json fences if model added them
    content = content.replace(/^```json\s*/i, '').replace(/^```\s*/, '').replace(/\s*```$/, '');
    return JSON.parse(content);
  } catch (e) {
    console.error('extractDesignStructure exception:', e.message);
    return null;
  }
}

// Build a letter-by-letter spelling guide from extracted text lines.
// Renders each Hebrew word as its individual characters separated by hyphens,
// which forces the image model to render each glyph independently.
function buildSpellingGuide(textLines) {
  if (!Array.isArray(textLines) || textLines.length === 0) return '';
  const lines = textLines
    .filter(t => typeof t === 'string' && t.trim().length > 0)
    .map(t => {
      const trimmed = t.trim();
      // Break into characters, mark spaces explicitly
      const chars = Array.from(trimmed).map(c => c === ' ' ? '[רווח/space]' : c).join('  ');
      return `  • "${trimmed}"   (${trimmed.length} characters, including spaces)\n    Letter-by-letter:  ${chars}`;
    });
  if (lines.length === 0) return '';
  return `

═══════════════════════════════════════════════
EXACT TEXT FOR THE CUP — COPY CHARACTER BY CHARACTER
═══════════════════════════════════════════════
The cup MUST contain exactly the following text — every letter must match. NO extra letters. NO missing letters. NO letter substitutions.

${lines.join('\n')}

ENFORCEMENT:
- Render each character above EXACTLY. Count the letters before drawing.
- Hebrew is read RIGHT-TO-LEFT — do not mirror, do not reverse the letter order.
- Do NOT confuse these Hebrew letter pairs (they look similar but are different): ב/כ, ד/ר, ה/ח/ת, מ/ם, נ/ן, ס/ם, ו/ן, צ/ץ, פ/ף.
- A common mistake is dropping the מ in words ending with מה (e.g., the word for "smart" is חכמה — five letters: ח-כ-מ-ה. Do NOT write חכי — that is only three letters and not a real word).
- Do NOT translate the text to English. Hebrew must stay Hebrew.
- Do NOT add decorative letters or symbols inside the text area.
- If you cannot render a character cleanly, render the FULL line in Latin/English transliteration rather than producing garbled Hebrew.
- After drawing, verify each word matches the source character-count above.
`;
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
    // STEP 0: Pre-process the user prompt with GPT-4o-mini to extract
    //   the EXACT text strings + colors. This lets us inject a precise
    //   letter-by-letter spelling guide into the image-gen prompt, which
    //   significantly reduces Hebrew spelling errors.
    // ============================================================
    let structure = null;
    try {
      structure = await extractDesignStructure(apiKey, prompt);
    } catch (e) {
      console.error('Structure extraction failed (non-fatal):', e.message);
    }
    const spellingGuide = structure ? buildSpellingGuide(structure.textLines) : '';
    const extractedColors = (structure && Array.isArray(structure.colors) && structure.colors.length > 0)
      ? `\n\nEXTRACTED COLORS (from user request): ${structure.colors.join(', ')} — these MUST be the dominant palette of the design.`
      : '';

    // ============================================================
    // STEP 1: Generate the FLAT 170×96 print design
    // ============================================================
    const photoInstruction = imageBase64
      ? `\n\nThe user has provided a personal photograph. CRITICAL: Use that exact photograph in the design. DO NOT redraw, regenerate, recreate, alter, modify, change, retouch, repaint, restyle, or reinterpret the person in the photo. Preserve the photograph pixel-perfect: same face, same eyes, same hair, same skin, same clothing, same background, same colors, same lighting — identical to the input photo. Treat the photograph as an unmodifiable asset that you are placing into the design (like cropping it and pasting it). You may crop it to a shape (oval, circle, heart, rectangle) but the pixels inside that shape must be the original photograph unchanged. The person must look IDENTICAL to the input photo — no AI face regeneration.`
      : '';

    const flatPrompt = `Create a flat 2D print-ready graphic design for a paper coffee cup label. This is a print file, NOT a photo of a cup.

User's design request (read carefully, follow exactly): ${prompt}${extractedColors}${photoInstruction}${spellingGuide}

═══════════════════════════════════════════════
CRITICAL RULE #1 — COLORS MUST MATCH USER REQUEST
═══════════════════════════════════════════════
If the user specified colors (in Hebrew or any language), the design MUST use ONLY those colors as the dominant palette. Examples:
- "ירוק ולבן" / "green and white" → green background or large green elements + white. NO black dominance, NO other colors.
- "כחול" / "blue" → blue must be the primary color.
- "אדום וזהב" / "red and gold" → red + gold dominant.
Do not default to white+black when the user specified other colors.

═══════════════════════════════════════════════
CRITICAL RULE #2 — HEBREW TEXT MUST BE SPELLED CORRECTLY
═══════════════════════════════════════════════
Hebrew letters are extremely easy to get wrong. Follow these rules:
- Copy any Hebrew word the user wrote LETTER-BY-LETTER, character-by-character, exactly as it appears.
- Do NOT substitute similar-looking Hebrew letters (ב vs כ, ד vs ר, ה vs ח, ם vs ס, ן vs ו, etc.)
- DROP NO LETTERS. If the source text is "חכמה" (4 letters: ח-כ-מ-ה) — never write "חכי" (3 letters). Count before drawing.
- Common brand names must be spelled EXACTLY:
  • "מכבי חיפה" — letters are: מ-כ-ב-י space ח-י-פ-ה (Maccabi Haifa football club)
  • "מכבי תל אביב" — letters: מ-כ-ב-י space ת-ל space א-ב-י-ב
  • "הפועל" — letters: ה-פ-ו-ע-ל
- If unsure of Hebrew spelling, write the text in Latin/English instead rather than producing garbled Hebrew.
- Hebrew reads RIGHT-TO-LEFT. Do not mirror or reverse it.
- Use clean modern Hebrew typography (sans-serif preferred), large and very readable.

═══════════════════════════════════════════════
DESIGN RULES
═══════════════════════════════════════════════
- Modern, clean, contemporary aesthetic — 2026 graphic design style
- Wide horizontal landscape rectangle, proportion ~170:96 (roughly 1.77:1)
- Artwork fills the ENTIRE rectangle edge-to-edge — no empty white margins
- ABSOLUTELY NO decorative frames, NO ornate borders, NO Victorian flourishes, NO ribbon banners
- Use ONLY the visual elements the user described — do not invent extra decorations
- Clean composition, smart whitespace, not cluttered
- This is a flat print file — NO 3D cup, NO mockup, NO product photo`;

    // Prepare userBlob once (if user uploaded a photo) so we can reuse it across retries
    let userBlob = null;
    if (imageBase64) {
      const base64Data = imageBase64.includes(',') ? imageBase64.split(',')[1] : imageBase64;
      const mimeMatch = imageBase64.match(/^data:(image\/\w+);base64,/);
      const mime = mimeMatch ? mimeMatch[1] : 'image/png';
      const buf = Buffer.from(base64Data, 'base64');
      userBlob = new Blob([buf], { type: mime });
    }

    // Expected text lines for the visual verifier (Step 1.5)
    const expectedLines = (structure && Array.isArray(structure.textLines))
      ? structure.textLines.filter(t => typeof t === 'string' && t.trim().length > 0)
      : [];

    // ============================================================
    // STEP 1 + 1.5: Generate the flat design, then visually verify
    //   that the rendered text matches the expected text. If it
    //   doesn't, regenerate once with an augmented prompt that
    //   tells the model what it got wrong.
    // ============================================================
    let flatResult = null;
    let flatB64 = null;
    let flatUrl = null;
    let verifyInfo = { matches: true, foundText: '', issues: '' };
    let attemptsUsed = 0;
    let augmentedPrompt = flatPrompt;
    const maxAttempts = (expectedLines.length > 0) ? 2 : 1;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      attemptsUsed = attempt;
      if (userBlob) {
        flatResult = await callEdits(apiKey, augmentedPrompt, userBlob, '1536x1024', 'user-photo.png');
        if (!flatResult.ok) {
          console.error('edits step1 failed, falling back:', flatResult.error);
          flatResult = await callGen(apiKey, augmentedPrompt, '1536x1024');
        }
      } else {
        flatResult = await callGen(apiKey, augmentedPrompt, '1536x1024');
      }

      if (!flatResult.ok) {
        return res.status(500).json({ error: 'Step 1 (flat design) failed', details: flatResult.error });
      }

      flatB64 = flatResult.data.b64_json;
      flatUrl = flatResult.data.url;

      // No text to verify? Done.
      if (expectedLines.length === 0) break;

      // Verify the rendered text
      verifyInfo = await verifyImageText(apiKey, flatB64 || flatUrl, expectedLines);
      console.log(`Text verification attempt ${attempt}/${maxAttempts}: matches=${verifyInfo.matches}`, verifyInfo.issues || '');

      if (verifyInfo.matches) break;

      // Mismatch — build a stronger prompt that names what the model got wrong
      if (attempt < maxAttempts) {
        augmentedPrompt = flatPrompt + `

═══════════════════════════════════════════════
URGENT — PREVIOUS RENDER HAD SPELLING ERRORS
═══════════════════════════════════════════════
The previous attempt rendered the WRONG text on the cup.
The image showed: "${verifyInfo.foundText}"
Issue identified by verifier: ${verifyInfo.issues}

THE CORRECT TEXT (REQUIRED — RENDER EXACTLY):
${expectedLines.map((t, i) => `  Line ${i + 1}: "${t}"   (${Array.from(t).length} characters total)`).join('\n')}

This is your final attempt. Render each character above EXACTLY. Count the letters before drawing each word. Do not repeat the previous mistake.`;
      }
    }

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

    const mockupPrompt = `Render a photorealistic 3D product photography mockup of a paper coffee cup with the EXACT artwork from the input image printed on it.

CRITICAL: The artwork in the input image is the print design that goes on the cup. Wrap that EXACT design around the cup surface — preserve ALL of these unchanged:
- Same COLORS (do not shift to white+black if input was green, blue, red, etc.)
- Same LAYOUT and composition
- Same Hebrew text — copy letter-for-letter exactly as in the input (do NOT re-spell, do NOT substitute similar-looking Hebrew letters like ב/כ, ד/ר, ה/ח)
- Same photograph (if any) preserved pixel-perfect — no face regeneration
- Same logos, icons, illustrations

Do NOT redesign. Do NOT change anything. Just take the input image and wrap it naturally around a paper cup so it follows the cup's curve.

Output requirements:
- Single paper takeaway cup, centered, shown at slight 3/4 angle
- The cup's base color should match the design (e.g. if design is green-dominant, the cup may have a green wrap; if the design has a white background, the cup is white)
- Clean light neutral background (soft white/gray), soft natural shadow under the cup
- Professional studio product photography lighting
- Looks like a real photograph of a real product`;

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
      mockupError: mockupResult.ok ? null : mockupResult.error,
      textVerification: expectedLines.length > 0 ? {
        expected: expectedLines,
        matches: verifyInfo.matches,
        foundText: verifyInfo.foundText,
        issues: verifyInfo.issues,
        attempts: attemptsUsed
      } : null
    });

  } catch (err) {
    console.error('Function error:', err);
    return res.status(500).json({ error: 'Internal server error', message: err.message });
  }
}
