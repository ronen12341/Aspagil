// Vercel Serverless Function — Form submission handler.
//
// Receives JSON from the client containing form fields and (optionally)
// one or more files encoded as base64. Sends two emails via Resend:
//   1. Notification to the business (salesaspagil@gmail.com) with file
//      attachments
//   2. Auto-reply "thank you" to the customer
//
// Requires environment variable RESEND_API_KEY (set in Vercel dashboard).
//
// Expected JSON body shape:
//   {
//     "type": "quote" | "design",          // contact form vs designer
//     "fields": { name, phone, email, ... },// plain string form fields
//     "files": [                           // optional, can be empty
//       { "field": "artwork_file", "name": "design.pdf",
//         "type": "application/pdf", "contentBase64": "..." },
//       ...
//     ]
//   }

export const config = {
  api: {
    bodyParser: {
      sizeLimit: '25mb',
    },
  },
};

const BUSINESS_EMAIL = 'salesaspagil@gmail.com';
// gilcups.com is the only domain verified in this Resend account — a "from"
// on any other domain (including the shared onboarding@resend.dev sender)
// gets rejected with 403. This route (the contact/quote form) was sending
// from onboarding@resend.dev and had its business notifications silently
// dropped as a result.
const RESEND_FROM    = 'Aspagil <noreply@gilcups.com>';
const RESEND_FROM_CUSTOMER = 'אספגיל <orders@gilcups.com>';
const SITE_URL       = 'https://www.gilcups.com';

const FIELD_LABELS = {
  name:          'שם',
  phone:         'טלפון',
  email:         'דוא"ל',
  business:      'שם העסק',
  invoice_name:  'שם לחשבונית',
  tax_id:        'מספר ח.פ / ת.ז',
  address:       'כתובת מלאה',
  quantity:      'כמות יחידות',
  usage:         'סוג שימוש',
  notes:         'הערות / פרטים נוספים',
  user_description: 'תיאור העיצוב (למעצב AI)'
};

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function buildEmailHtml(type, fields, attachmentNames, orderId) {
  const title = type === 'design'
    ? 'בקשת עיצוב AI חדשה מהאתר'
    : 'בקשת הצעת מחיר חדשה מהאתר';

  // Build rows in a stable order
  const ORDER = ['name','phone','email','business','invoice_name','tax_id','address','quantity','usage','user_description','notes'];
  const rows = [];
  for (const key of ORDER) {
    if (fields[key] != null && String(fields[key]).trim() !== '') {
      // Preserve line breaks in multi-line text (user_description, notes)
      const value = escapeHtml(fields[key]).replace(/\n/g, '<br>');
      rows.push(`<tr><td align="right" valign="top" style="font-weight:bold;padding:8px 12px;border-bottom:1px solid #dddddd;background:#f5f5f5;width:30%;color:#333333;">${FIELD_LABELS[key] || key}</td><td align="right" valign="top" style="padding:8px 12px;border-bottom:1px solid #dddddd;color:#1a1a1a;">${value}</td></tr>`);
    }
  }
  // Any other fields not in ORDER
  for (const key of Object.keys(fields)) {
    if (ORDER.includes(key)) continue;
    if (key === 'subject' || key === 'from_name' || key === 'access_key' || key === 'redirect' || key === 'botcheck') continue;
    if (key === 'artwork_url' || key === 'artwork_name') continue; // rendered as a download button below
    if (fields[key] != null && String(fields[key]).trim() !== '') {
      const value = escapeHtml(fields[key]).replace(/\n/g, '<br>');
      rows.push(`<tr><td align="right" valign="top" style="font-weight:bold;padding:8px 12px;border-bottom:1px solid #dddddd;background:#f5f5f5;width:30%;color:#333333;">${escapeHtml(FIELD_LABELS[key] || key)}</td><td align="right" valign="top" style="padding:8px 12px;border-bottom:1px solid #dddddd;color:#1a1a1a;">${value}</td></tr>`);
    }
  }

  // If we have no rows at all, show a clear message instead of empty body
  if (rows.length === 0) {
    rows.push(`<tr><td colspan="2" align="right" style="padding:16px;color:#a04040;background:#fff4f4;">⚠ לא התקבלו פרטי לקוח. כנראה תקלה בטופס. אנא בדוק את הקבצים המצורפים.</td></tr>`);
  }

  let attachmentSection = '';
  if (attachmentNames && attachmentNames.length) {
    attachmentSection = `<p align="right" style="margin:18px 0 0;padding:12px;background:#fff4e5;border-right:4px solid #e0a23a;color:#7a4e00;direction:rtl;"><strong>קבצים מצורפים (${attachmentNames.length}):</strong><br>${attachmentNames.map(n => escapeHtml(n)).join('<br>')}</p>`;
  }

  // Artwork uploaded to cloud storage — show a prominent download button
  let artworkSection = '';
  if (fields.artwork_url) {
    const safeUrl  = escapeHtml(fields.artwork_url);
    const safeName = escapeHtml(fields.artwork_name || 'קובץ גרפיקה');
    artworkSection = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:18px 0 0;direction:rtl;"><tr><td align="right" style="padding:16px;background:#E6F4EA;border-right:4px solid #1F6638;color:#14532d;">
<strong style="font-size:15px;">📎 הלקוח צירף קובץ גרפיקה להזמנה:</strong><br>
<span style="color:#333;">${safeName}</span><br>
<a href="${safeUrl}" target="_blank" style="display:inline-block;margin-top:12px;background:#1F6638;color:#ffffff;padding:11px 22px;border-radius:6px;text-decoration:none;font-weight:bold;">⬇ הורד את הקובץ</a>
<br><span style="font-size:11px;color:#5a7a64;word-break:break-all;">${safeUrl}</span>
</td></tr></table>`;
  }

  return `<!DOCTYPE html>
<html dir="rtl" lang="he"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:Arial,sans-serif;direction:rtl;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f5f5f5;">
<tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="640" cellpadding="0" cellspacing="0" border="0" style="max-width:640px;background:#ffffff;border:1px solid #e0e0e0;">
<tr><td align="right" style="background:#b85a00;color:#ffffff;padding:20px 24px;direction:rtl;">
<div style="font-size:20px;font-weight:bold;margin:0;">${escapeHtml(title)}</div>
<div style="font-size:13px;margin-top:6px;color:#ffe8d0;">מספר הזמנה: ${escapeHtml(orderId)} · נשלח מ-${SITE_URL}</div>
</td></tr>
<tr><td style="padding:20px 24px;" align="right">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;direction:rtl;">
${rows.join('')}
</table>
${attachmentSection}
${artworkSection}
<p align="right" style="margin:24px 0 0;color:#999999;font-size:12px;border-top:1px solid #eeeeee;padding-top:12px;direction:rtl;">
מייל זה נוצר אוטומטית. ענה ישירות ללקוח דרך כתובת המייל / מספר הטלפון שמופיעים למעלה.
</p>
</td></tr>
</table>
</td></tr>
</table>
</body></html>`;
}

function buildAutoReplyHtml(customerName, orderId) {
  const greet = customerName ? `שלום ${escapeHtml(customerName)},` : 'שלום,';
  return `<!DOCTYPE html>
<html dir="rtl" lang="he"><head><meta charset="utf-8"><title>תודה על פנייתכם - חברת אספגיל</title></head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:Arial,sans-serif;direction:rtl;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f5f5f5;">
<tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;background:#ffffff;border:1px solid #e0e0e0;">
<tr><td align="center" style="background:#b85a00;color:#ffffff;padding:24px;direction:rtl;">
<div style="font-size:22px;font-weight:bold;">חברת אספגיל</div>
<div style="font-size:14px;margin-top:6px;color:#ffe8d0;">מפעל ישראלי להדפסה על כוסות נייר וקרטון</div>
</td></tr>
<tr><td align="right" style="padding:24px;color:#1a1a1a;line-height:1.7;font-size:15px;direction:rtl;">
<p style="margin:0 0 12px;">${greet}</p>
<p style="margin:0 0 12px;"><strong>תודה ששלחתם לנו הזמנה</strong> — קיבלנו את הפנייה שלכם בהצלחה (מספר הזמנה: <strong>${escapeHtml(orderId)}</strong>).</p>
<p style="margin:0 0 12px;">אנו נחזור אליכם בהקדם עם הצעת מחיר מפורטת והדמיה.</p>
<p style="margin:24px 0 0;font-weight:bold;">בברכה,<br>חברת אספגיל</p>
<div style="margin-top:24px;padding-top:14px;border-top:1px solid #eeeeee;color:#666666;font-size:13px;">
<div>טלפון: 03-9600550</div>
<div style="margin-top:4px;">אתר: ${SITE_URL}</div>
</div>
</td></tr>
</table>
</td></tr>
</table>
</body></html>`;
}

async function sendViaResend(apiKey, payload) {
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });
  if (!r.ok) {
    const errText = await r.text();
    return { ok: false, status: r.status, error: errText.substring(0, 500) };
  }
  const j = await r.json();
  return { ok: true, id: j.id };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    return res.status(500).json({
      error: 'RESEND_API_KEY missing',
      message: 'RESEND_API_KEY לא הוגדר ב-Vercel Environment Variables'
    });
  }

  try {
    const body = req.body || {};
    const type = body.type === 'design' ? 'design' : 'quote';
    const fields = body.fields || {};
    const files = Array.isArray(body.files) ? body.files : [];

    // Diagnostic logging — visible in Vercel function logs
    console.log('submit-form received:', {
      type: type,
      fieldsCount: Object.keys(fields).length,
      fieldsKeys: Object.keys(fields),
      filesCount: files.length,
      hasName: !!fields.name,
      hasEmail: !!fields.email,
      hasPhone: !!fields.phone
    });

    // Honeypot — silently drop bot submissions
    if (fields.botcheck) {
      return res.status(200).json({ success: true, skipped: 'honeypot' });
    }

    // Fail loudly if the submission is essentially empty — better than sending an empty email
    if (Object.keys(fields).length === 0 && files.length === 0) {
      return res.status(400).json({
        error: 'Empty submission',
        message: 'הטופס לא הגיע עם תוכן. אנא מלאו את הפרטים ונסו שוב.'
      });
    }

    // Build attachments array for Resend
    const attachments = [];
    const attachmentNames = [];
    for (const f of files) {
      if (!f || !f.contentBase64 || !f.name) continue;
      attachments.push({
        filename: f.name,
        content: f.contentBase64
      });
      attachmentNames.push(f.name);
    }

    // Generated once, up front, so the business email, the customer
    // auto-reply, and the JSON response all reference the same order number
    // (previously this was generated after both emails were sent, so neither
    // email actually contained the order id returned to the client).
    const orderId = 'ORD-' + new Date().toISOString().slice(0,10).replace(/-/g,'') + '-' + (Math.floor(Math.random()*9000)+1000);

    // 1. Send notification to the business
    const businessHtml = buildEmailHtml(type, fields, attachmentNames, orderId);
    const subject = fields.subject || (type === 'design'
      ? `🎨 בקשת עיצוב AI חדשה מהאתר ${orderId}`
      : `📧 בקשת הצעת מחיר חדשה מהאתר ${orderId}`);

    const replyTo = (fields.email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(fields.email)) ? fields.email : undefined;

    const businessResult = await sendViaResend(apiKey, {
      from: RESEND_FROM,
      to: [BUSINESS_EMAIL],
      reply_to: replyTo,
      subject: subject,
      html: businessHtml,
      attachments: attachments.length ? attachments : undefined
    });

    if (!businessResult.ok) {
      console.error('Business email failed:', businessResult.error);
      return res.status(500).json({
        error: 'Failed to send notification email',
        details: businessResult.error
      });
    }

    // 2. Send auto-reply to customer (best-effort — don't fail the request if this fails)
    let autoReplyResult = null;
    if (replyTo) {
      const replyHtml = buildAutoReplyHtml(fields.name, orderId);
      autoReplyResult = await sendViaResend(apiKey, {
        from: RESEND_FROM_CUSTOMER,
        to: [replyTo],
        subject: `תודה על פנייתכם - חברת אספגיל (${orderId})`,
        html: replyHtml
      });
      if (!autoReplyResult.ok) {
        console.error('Auto-reply failed (non-fatal):', autoReplyResult.error);
      }
    }

    return res.status(200).json({
      success: true,
      orderId: orderId,
      businessEmailId: businessResult.id,
      autoReplySent: !!(autoReplyResult && autoReplyResult.ok),
      attachmentCount: attachmentNames.length
    });

  } catch (err) {
    console.error('submit-form error:', err);
    return res.status(500).json({ error: 'Internal server error', message: err.message });
  }
}
