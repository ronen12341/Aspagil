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
const RESEND_FROM    = 'Aspagil <onboarding@resend.dev>'; // safe default; switch to a verified domain later for better deliverability
const SITE_URL       = 'https://aspagil.vercel.app';

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

function buildEmailHtml(type, fields, attachmentNames) {
  const title = type === 'design'
    ? '🎨 בקשת עיצוב AI חדשה מהאתר'
    : '📧 בקשת הצעת מחיר חדשה מהאתר';

  // Build rows in a stable order
  const ORDER = ['name','phone','email','business','invoice_name','tax_id','address','quantity','usage','user_description','notes'];
  const rows = [];
  for (const key of ORDER) {
    if (fields[key] != null && String(fields[key]).trim() !== '') {
      rows.push(`
        <tr>
          <td style="font-weight:700;padding:10px 12px;border-bottom:1px solid #eee;width:35%;background:#FAFAFA;color:#444;">${FIELD_LABELS[key] || key}</td>
          <td style="padding:10px 12px;border-bottom:1px solid #eee;color:#1a1a1a;">${escapeHtml(fields[key])}</td>
        </tr>`);
    }
  }
  // Any other fields not in ORDER
  for (const key of Object.keys(fields)) {
    if (ORDER.includes(key)) continue;
    if (key === 'subject' || key === 'from_name' || key === 'access_key' || key === 'redirect' || key === 'botcheck') continue;
    if (fields[key] != null && String(fields[key]).trim() !== '') {
      rows.push(`
        <tr>
          <td style="font-weight:700;padding:10px 12px;border-bottom:1px solid #eee;width:35%;background:#FAFAFA;color:#444;">${escapeHtml(FIELD_LABELS[key] || key)}</td>
          <td style="padding:10px 12px;border-bottom:1px solid #eee;color:#1a1a1a;">${escapeHtml(fields[key])}</td>
        </tr>`);
    }
  }

  let attachmentSection = '';
  if (attachmentNames && attachmentNames.length) {
    attachmentSection = `
      <p style="margin-top:18px;padding:12px;background:#FFF4E5;border-right:4px solid #E0A23A;color:#7A4E00;border-radius:6px;">
        📎 <strong>קבצים מצורפים (${attachmentNames.length}):</strong><br>
        ${attachmentNames.map(n => escapeHtml(n)).join('<br>')}
      </p>`;
  }

  return `<!DOCTYPE html>
<html dir="rtl" lang="he"><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#F5F5F5;font-family:Arial,'Segoe UI',Tahoma,sans-serif;">
  <div style="max-width:640px;margin:24px auto;background:#FFF;border-radius:12px;overflow:hidden;box-shadow:0 4px 14px rgba(0,0,0,0.08);">
    <div style="background:linear-gradient(135deg,#B85A00,#E0A23A);color:#FFF;padding:20px 24px;">
      <h1 style="margin:0;font-size:1.3rem;">${title}</h1>
      <p style="margin:6px 0 0;opacity:0.92;font-size:0.9rem;">נשלח מ-${SITE_URL}</p>
    </div>
    <div style="padding:8px 24px 24px;">
      <table style="width:100%;border-collapse:collapse;margin-top:12px;font-size:0.95rem;">
        ${rows.join('')}
      </table>
      ${attachmentSection}
      <p style="margin-top:24px;color:#999;font-size:0.78rem;border-top:1px solid #eee;padding-top:12px;">
        מייל זה נוצר אוטומטית. ענה ישירות ללקוח דרך כתובת המייל / מספר הטלפון שמופיעים למעלה.
      </p>
    </div>
  </div>
</body></html>`;
}

function buildAutoReplyHtml(customerName) {
  const greet = customerName ? `שלום ${escapeHtml(customerName)},` : 'שלום,';
  return `<!DOCTYPE html>
<html dir="rtl" lang="he"><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#F5F5F5;font-family:Arial,'Segoe UI',Tahoma,sans-serif;">
  <div style="max-width:560px;margin:24px auto;background:#FFF;border-radius:12px;overflow:hidden;box-shadow:0 4px 14px rgba(0,0,0,0.08);">
    <div style="background:linear-gradient(135deg,#B85A00,#E0A23A);color:#FFF;padding:24px;text-align:center;">
      <h1 style="margin:0;font-size:1.5rem;">חברת אספגיל</h1>
      <p style="margin:6px 0 0;opacity:0.92;">מפעל ישראלי להדפסה על כוסות נייר וקרטון</p>
    </div>
    <div style="padding:24px;color:#1a1a1a;line-height:1.7;font-size:1rem;">
      <p style="margin:0 0 12px;">${greet}</p>
      <p style="margin:0 0 12px;"><strong>תודה ששלחתם לנו הזמנה</strong> — קיבלנו את הפנייה שלכם בהצלחה.</p>
      <p style="margin:0 0 12px;">אנו נחזור אליכם בהקדם עם הצעת מחיר מפורטת והדמיה.</p>
      <p style="margin:24px 0 0;font-weight:700;">בברכה,<br>חברת אספגיל</p>
      <div style="margin-top:24px;padding-top:14px;border-top:1px solid #eee;color:#666;font-size:0.85rem;">
        <p style="margin:0;">📞 03-9600550</p>
        <p style="margin:4px 0 0;">🌐 ${SITE_URL}</p>
      </div>
    </div>
  </div>
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

    // Honeypot — silently drop bot submissions
    if (fields.botcheck) {
      return res.status(200).json({ success: true, skipped: 'honeypot' });
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

    // 1. Send notification to the business
    const businessHtml = buildEmailHtml(type, fields, attachmentNames);
    const subject = fields.subject || (type === 'design'
      ? '🎨 בקשת עיצוב AI חדשה מהאתר'
      : '📧 בקשת הצעת מחיר חדשה מהאתר');

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
      const replyHtml = buildAutoReplyHtml(fields.name);
      autoReplyResult = await sendViaResend(apiKey, {
        from: 'חברת אספגיל <onboarding@resend.dev>',
        to: [replyTo],
        subject: 'תודה על פנייתכם - חברת אספגיל',
        html: replyHtml
      });
      if (!autoReplyResult.ok) {
        console.error('Auto-reply failed (non-fatal):', autoReplyResult.error);
      }
    }

    return res.status(200).json({
      success: true,
      businessEmailId: businessResult.id,
      autoReplySent: !!(autoReplyResult && autoReplyResult.ok),
      attachmentCount: attachmentNames.length
    });

  } catch (err) {
    console.error('submit-form error:', err);
    return res.status(500).json({ error: 'Internal server error', message: err.message });
  }
}
