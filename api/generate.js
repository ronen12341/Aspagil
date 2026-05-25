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

// Vercel function timeout — image generation + verification can take 30-50s.
// Default is 10s on Hobby which causes "Failed to fetch" on the client.
export const maxDuration = 60;

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

// Pre-processor: use GPT-4o-mini to extract the EXACT Hebrew text + colors.
// CRITICAL: Only extract text the user EXPLICITLY marked as text-to-print
// (inside quotes "..." or '...' or after explicit cues like "כתוב:" / "טקסט:").
// Free-form description words are NOT extracted as text — they describe how
// the cup looks, not what to write on it.
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
            content: 'You extract structured info from Hebrew/English paper-cup design requests. You are EXTREMELY CONSERVATIVE: you only extract text the user EXPLICITLY asked to PRINT on the cup. You do NOT treat description words as text to print. Output ONLY valid JSON.'
          },
          {
            role: 'user',
            content: `Analyze this cup design request and extract structured info.

Request:
"""${userPrompt}"""

EXTRACTION RULES — read carefully:

For "textLines":
- ONLY extract text the user EXPLICITLY asked to print on the cup.
- A user wants text printed on the cup ONLY when one of these is true:
  a) The text appears inside quotes: "..." or '...' or "..." or "..."
  b) The text follows an explicit cue word like: "כתוב", "טקסט:", "כיתוב:", "הכיתוב הוא", "write:", "text:", "says:", "with the words"
- DO NOT extract words from a free-form description of the cup's appearance.
- DO NOT extract words like "כוס", "לבנה", "עם", "לוגו", "פעמיים", "מקדימה", "מאחורה", "צבע", "סגנון", "פרחים", "עיצוב" — these are description words.
- DO NOT extract a description sentence as text. "כוס לבנה עם לוגו פעמיים" is a DESCRIPTION — extract textLines: [].
- DO NOT extract a brand mentioned in the description unless it's clearly meant as text on the cup.
- If unsure → return empty array.

EXAMPLES:
- "כוס לבנה עם לוגו פעמיים" → textLines: []   (just a description, no text to print)
- "כוס עם הטקסט 'מכבי חיפה'" → textLines: ["מכבי חיפה"]
- "כוס שכתוב עליה קפה גינץ" → textLines: ["קפה גינץ"]
- "כוס בסגנון חתונה עם 'דנה ויוסי 12.6.2026'" → textLines: ["דנה ויוסי 12.6.2026"]
- "white cup with green flowers" → textLines: []
- "cup that says 'Best Mom'" → textLines: ["Best Mom"]

For "colors": only color names the user mentioned (in any language).
For "theme": one short sentence describing the visual style.

Return ONLY JSON in this exact shape (no markdown):
{"textLines": [], "colors": [], "theme": "..."}`
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
    const { prompt, imageBase64, designDescription, cupText } = req.body || {};
    if (!prompt && !designDescription && (typeof cupText !== 'string' || cupText.length === 0)) {
      return res.status(400).json({ error: 'Missing prompt or design description' });
    }

    // ============================================================
    // STEP 0: Pre-process the user prompt to extract the EXACT text
    //   strings + colors.
    //
    //   NEW FLOW (designer.html v2+): the frontend sends `designDescription`
    //   and `cupText` as SEPARATE fields. When `cupText` is provided
    //   explicitly we treat it as ground truth and SKIP the extractor —
    //   this prevents the model from "extracting" stray words from the
    //   design description (which is what caused the prompt-on-cup bug).
    //
    //   LEGACY FLOW: when only `prompt` is sent, we still run the
    //   GPT-4o-mini extractor as before.
    // ============================================================
    const hasExplicitCupText = (typeof cupText === 'string');
    const explicitNoText = hasExplicitCupText && cupText.trim().length === 0;

    // The AI generates the flat print file (170×96) including the customer's
    // Hebrew text. Hebrew rendering may have spelling issues — the graphic
    // designer corrects them when preparing the actual print plate. The
    // customer preview (mockup) also gets a client-side text overlay using
    // Canvas (real Hebrew font) so the customer sees the text correctly.
    let structure = null;
    if (hasExplicitCupText) {
      const trimmed = cupText.trim();
      structure = {
        textLines: trimmed.length > 0 ? [trimmed] : [],
        colors: [],
        theme: ''
      };
    } else {
      try {
        structure = await extractDesignStructure(apiKey, prompt);
      } catch (e) {
        console.error('Structure extraction failed (non-fatal):', e.message);
      }
    }

    // The client will overlay text on the MOCKUP preview only (for display).
    // The FLAT print file remains the AI's raw output for the graphic designer.
    const willOverlayClientText = hasExplicitCupText && cupText.trim().length > 0;

    const spellingGuide = structure ? buildSpellingGuide(structure.textLines) : '';
    const extractedColors = (structure && Array.isArray(structure.colors) && structure.colors.length > 0)
      ? `\n\nEXTRACTED COLORS (from user request): ${structure.colors.join(', ')} — these MUST be the dominant palette of the design.`
      : '';

    // ============================================================
    // STRICT RULES — these prevent the two bugs we saw in production:
    //   (1) AI added a human/model that the user never asked for
    //   (2) AI printed words from the prompt itself onto the cup
    //
    //   We only allow people in the design if the user EXPLICITLY
    //   mentioned a person (face, mom, child, portrait, etc.) in their
    //   description. Otherwise NO PEOPLE, regardless of whether they
    //   uploaded a logo or other asset.
    // ============================================================
    function detectPersonMention(text) {
      if (!text) return false;
      const personWords = [
        // Hebrew
        'פנים', 'פרצוף', 'אדם', 'איש ', 'אישה', 'אנשים', 'ילד', 'ילדה', 'ילדים',
        'אמא', 'אבא', 'סבא', 'סבתא', 'תינוק', 'משפחה', 'דמות',
        'חתן', 'כלה', 'זוג', 'בן זוג', 'בת זוג',
        'פורטרט', 'תמונה שלי', 'התמונה שלי', 'תמונה של',
        // English
        'face', 'person', 'people', 'man ', 'woman', 'women', 'men ',
        'child', 'children', 'kid', 'kids', 'baby', 'family',
        'portrait', 'mother', 'father', 'mom', 'dad',
        'wife', 'husband', 'son', 'daughter', 'bride', 'groom'
      ];
      const lower = String(text).toLowerCase();
      return personWords.some(w => lower.includes(w.toLowerCase()));
    }

    const userMentionedPerson =
      detectPersonMention(designDescription) ||
      detectPersonMention(prompt) ||
      detectPersonMention(cupText);

    const noPeopleRule = userMentionedPerson ? '' : `

═══════════════════════════════════════════════
CRITICAL RULE — NO PEOPLE, NO FACES, NO BODIES
═══════════════════════════════════════════════
Do NOT add any people, models, faces, hands, body parts, or human figures to the design.
Even if the description mentions a name, an occasion (mother's day, birthday, wedding), a gift recipient, or a person — the cup design is graphic/illustrative ONLY. No photos of people. No illustrations of people. No silhouettes. No body parts. The cup is a product shot — only the cup with the graphic design on it. ZERO humans anywhere in the image.
If a reference image was uploaded, treat it as a LOGO or GRAPHIC ASSET only — never as a person to feature. Do not invent a person to accompany the logo.
`;

    // NO TEXT rule only applies when the user EXPLICITLY left the text field empty.
    // When the user provided text, the AI renders it as part of the flat design
    // (Hebrew spelling may have errors — fixed by the graphic designer later).
    const noTextRule = explicitNoText ? `

═══════════════════════════════════════════════
CRITICAL RULE — NO TEXT ON CUP
═══════════════════════════════════════════════
The cup must be COMPLETELY FREE of any text, letters, words, numbers, or written characters in any language (Hebrew, English, or any other).
- Do NOT add slogans, captions, taglines, or labels
- Do NOT write any words from the design description on the cup
- If a logo was uploaded with text inside it, keep that logo as-is — but do not add OTHER text outside the logo
The cup is a pure visual/graphic design with NO typography.
` : '';

    // The "designed typography" rule is no longer needed because the
    // client now handles text rendering. We deliberately don't ask the
    // AI to design typography.
    const typographyRule = '';

    // Detect whether the user explicitly asked for the logo to appear
    // multiple times (front and back, both sides, twice, etc.)
    function detectMultiLogoMention(text) {
      if (!text) return false;
      const t = String(text).toLowerCase();
      const keywords = [
        'פעמיים', 'שני צידי', 'שתי פעמים', 'שני צדדים', 'משני הצדדים',
        'מקדימה ומאחורה', 'מקדימה וגם מאחורה', 'גם מקדימה וגם מאחורה',
        'מקדימה ואחורה', 'קדימה ואחורה', 'בשני הצדדים', 'משני הצדדים',
        'front and back', 'both sides', 'twice', 'two logos', 'two copies'
      ];
      return keywords.some(k => t.includes(k.toLowerCase()));
    }

    const userWantsMultipleLogos =
      detectMultiLogoMention(designDescription) ||
      detectMultiLogoMention(prompt);

    // Logo usage rule — once OR twice depending on user's request.
    const logoOnceRule = imageBase64 ? (userWantsMultipleLogos ? `

═══════════════════════════════════════════════
CRITICAL RULE — USE THE UPLOADED LOGO EXACTLY TWICE
═══════════════════════════════════════════════
The customer asked for the logo on both sides of the cup. On the FLAT rectangle:
- Place the uploaded logo at ~25% from the left edge (becomes the FRONT of the cup)
- Place the SAME uploaded logo at ~75% from the left edge (becomes the BACK of the cup)
- Both logos are IDENTICAL — same image, same size, same orientation
- Use the uploaded logo EXACTLY as it is — do not redraw, modify, or change it
- Do NOT create three or more logos. EXACTLY TWO instances of the same logo.
` : `

═══════════════════════════════════════════════
CRITICAL RULE — USE THE UPLOADED LOGO EXACTLY ONCE
═══════════════════════════════════════════════
The uploaded image is the customer's LOGO. Place it on the design EXACTLY ONE TIME — centered horizontally on the flat rectangle.

ABSOLUTE PROHIBITIONS:
- Do NOT duplicate, repeat, mirror, or tile the logo
- Do NOT show the same logo in two corners
- Do NOT add small copies of the logo as decorative repeats
- The logo appears ONCE. One logo. Single placement.
`) : '';

    // ============================================================
    // STEP 1: Generate the FLAT 170×96 print design
    // ============================================================
    // The user may upload either (a) a personal photograph of a person,
    // or (b) a logo / graphic asset. We branch based on whether the
    // description actually mentions a person.
    let photoInstruction = '';
    if (imageBase64) {
      if (userMentionedPerson) {
        photoInstruction = `\n\nThe user has provided a personal photograph. CRITICAL: Use that exact photograph in the design. DO NOT redraw, regenerate, recreate, alter, modify, change, retouch, repaint, restyle, or reinterpret the person in the photo. Preserve the photograph pixel-perfect: same face, same eyes, same hair, same skin, same clothing, same background, same colors, same lighting — identical to the input photo. Treat the photograph as an unmodifiable asset that you are placing into the design (like cropping it and pasting it). You may crop it to a shape (oval, circle, heart, rectangle) but the pixels inside that shape must be the original photograph unchanged. The person must look IDENTICAL to the input photo — no AI face regeneration.`;
      } else {
        photoInstruction = `\n\nThe user has provided a LOGO or GRAPHIC ASSET (not a personal photo of a person). CRITICAL: Use that exact image as a graphic element in the design — place it as-is without redrawing, regenerating, or modifying it. Preserve it pixel-perfect: same colors, same typography (if it contains text), same proportions. You may resize and position it but you must NOT alter the image itself. Do NOT add any people, faces, or human figures alongside this logo. This is a graphic asset only.`;
      }
    }

    // Build the user request block. When the user provides cupText, we tell
    // the AI to render it on the FLAT print file (Hebrew may not be perfect —
    // graphic designer cleans up afterwards). The Canvas overlay on the mockup
    // gives the customer a clean preview.
    let userRequestBlock;
    if (designDescription || hasExplicitCupText) {
      const descLine = designDescription
        ? `Design description (style, colors, mood — read carefully, follow exactly): ${designDescription}`
        : `Design description: minimal — no specific style requested.`;
      let textLine = '';
      if (hasExplicitCupText) {
        if (cupText.trim().length > 0) {
          textLine = `\n\nText to render on the cup (the ONLY text — render once, in elegant balanced typography, MEDIUM size that fits naturally next to the logo without overwhelming it): "${cupText.trim()}"

TEXT PLACEMENT: Render the text ONLY ONCE on the design. Do NOT repeat the text. Keep the text size proportional — it should complement the logo, not dominate the cup. Use clean modern Hebrew typography in a color that harmonizes with the design (the brand color or a neutral dark tone). Place the text below or beside the logo in a balanced composition.`;
        } else {
          textLine = `\n\nText on cup: NONE — the cup must contain NO text whatsoever.`;
        }
      }
      userRequestBlock = descLine + textLine;
    } else {
      userRequestBlock = `User's design request (read carefully, follow exactly): ${prompt}`;
    }

    const flatPrompt = `Create a FLAT 2D PRINT TEMPLATE for a paper coffee cup wrap. The output is a flat horizontal rectangle (the unrolled cup surface), NOT an illustration of a cup.

═══════════════════════════════════════════════
ABSOLUTE RULE — FLAT RECTANGLE OUTPUT ONLY
═══════════════════════════════════════════════
You are designing the printable surface that gets wrapped AROUND a paper cup. The output MUST be:
- A FLAT horizontal rectangle filling the entire image edge-to-edge
- NO drawing of a cup shape anywhere in the output
- NO cup outline, NO cup silhouette, NO 3D rendering
- NO product photography
- NO realistic cup illustration
The viewer should see a flat printable design — like a label peeled off a can — not a picture of a cup.

═══════════════════════════════════════════════
ABSOLUTE RULE — DESCRIPTION IS NOT TEXT
═══════════════════════════════════════════════
The user's description tells you HOW the cup looks (style, colors, what elements to include). It is NOT text to print on the cup.
- Words like "כוס", "לבנה", "עם", "לוגו", "פעמיים", "מקדימה", "מאחורה", "סגנון", "צבע" describe the cup — they do NOT appear as text on the cup.
- ONLY render text on the cup if it was explicitly given in quotes ("...") or after an explicit cue word like "כתוב", "טקסט:", "text:", "says:".
- If the description does NOT contain any explicitly quoted text, the cup must contain NO TEXT AT ALL — only the logo and visual elements.
- Do NOT render the description sentence as text on the cup. Do NOT translate description words into Hebrew letters on the cup.

═══════════════════════════════════════════════
LOGO PLACEMENT FOR "FRONT AND BACK" REQUESTS
═══════════════════════════════════════════════
When the user asks for the logo to appear "on both sides", "front and back", "פעמיים", "מקדימה ומאחורה", or similar:
- Place the SAME logo TWO TIMES on the flat rectangle
- One logo at ~25% from the left edge (this wraps to the "front" of the cup)
- Second identical logo at ~75% from the left edge (this wraps to the "back" of the cup)
- Both logos are identical in size and orientation
- The space between them (at ~50% — which is the "side" of the cup) can be empty background or have subtle decorative elements
When the user asks for just ONE logo: place it ONCE, centered horizontally.

${userRequestBlock}${extractedColors}${photoInstruction}${spellingGuide}${noPeopleRule}${noTextRule}${typographyRule}${logoOnceRule}

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
    const maxAttempts = (expectedLines.length > 0) ? 3 : 1;

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

      // Mismatch — build a stronger prompt that names what the model got wrong.
      // On the LAST attempt, we instruct the model to render the text in
      // English/Latin transliteration rather than produce more garbled Hebrew.
      if (attempt < maxAttempts) {
        const isFinalAttempt = (attempt === maxAttempts - 1);

        const detailedExpected = expectedLines.map((t, i) => {
          const chars = Array.from(t).map(c => c === ' ' ? '[space]' : c).join(' · ');
          return `  Line ${i + 1}: "${t}"   (${Array.from(t).length} characters)\n     Character-by-character: ${chars}`;
        }).join('\n\n');

        const fallbackInstruction = isFinalAttempt ? `

LAST-RESORT FALLBACK:
If you genuinely cannot render this Hebrew text without errors, render it in clean Latin/English transliteration of the meaning rather than garbled Hebrew. A correct English version is better than wrong Hebrew. But strongly prefer Hebrew if you can render it correctly.` : '';

        augmentedPrompt = flatPrompt + `

═══════════════════════════════════════════════
URGENT — PREVIOUS RENDER HAD SPELLING ERRORS  (attempt ${attempt + 1}/${maxAttempts})
═══════════════════════════════════════════════
The previous attempt rendered the WRONG text on the cup.
The image showed: "${verifyInfo.foundText}"
Verifier's diagnosis: ${verifyInfo.issues}

THE CORRECT TEXT — RENDER THIS EXACTLY, EVERY CHARACTER:
${detailedExpected}

STRATEGY FOR THIS RETRY:
1. Render the text MUCH LARGER than before — make it the dominant element on the cup so the letterforms are clear.
2. Use a BOLD, simple Hebrew typeface (Heebo Black / Assistant Bold / Rubik Black style) — no fancy decorative fonts that risk garbling letters.
3. Render each word as a separate, clean unit with generous spacing.
4. After drawing each word, mentally compare letter-by-letter against the source above. If anything doesn't match, redraw that word.${fallbackInstruction}

Do not repeat the previous mistakes.`;
      }
    }

    // ============================================================
    // STEP 2 — SKIPPED (final decision).
    // gpt-image-1 cannot reliably wrap a 2D design onto a 3D cup without
    // reinterpreting colors and elements. The only way to guarantee the
    // customer preview matches the print file is to use the same image.
    // The customer sees the flat. The designer receives the same flat.
    // Identical, no ambiguity, no surprises.
    // ============================================================
    const mockupImg = {
      b64_json: flatB64 || null,
      url: flatUrl || null
    };
    const mockupResult = { ok: true, model: 'flat-as-preview', error: null };

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
      // Tell the client to overlay this text on the rendered images using Canvas
      clientTextOverlay: willOverlayClientText ? {
        text: cupText.trim(),
        // Suggested vertical position (0=top, 1=bottom) and font size hint
        position: { yRatio: 0.62 },
        // Brand orange — matches the site theme
        color: '#E85D2F'
      } : null,
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
