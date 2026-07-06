/**
 * Vercel Serverless Function — Order handler for Gilcups / Aspagil.
 * Receives cart + customer data, sends notification email via Resend.
 *
 * Env vars required:
 *   RESEND_API_KEY — from resend.com dashboard
 *
 * POST /api/order
 * Body: { customer, items, totalPrice, hasUnpricedItems, paymentMethod }
 */

const BUSINESS_EMAIL = "salesaspagil@gmail.com";
const RESEND_FROM    = "Aspagil <onboarding@resend.dev>";

function toIsraeliE164(raw) {
  const digits = (raw || "").replace(/\D/g, "");
  if (!digits) return "";
  if (digits.startsWith("972")) return digits;
  if (digits.startsWith("0")) return "972" + digits.slice(1);
  return "972" + digits;
}

function escapeHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function generateOrderId() {
  const now = new Date();
  const ymd = now.toISOString().slice(0, 10).replace(/-/g, "");
  const rand = Math.floor(Math.random() * 9000) + 1000;
  return `ORD-${ymd}-${rand}`;
}

function buildEmailHtml(orderId, body) {
  const { customer, items, totalPrice, hasUnpricedItems, paymentMethod, shipping, fulfillmentMethod } = body;
  const waLink = `https://wa.me/${toIsraeliE164(customer.phone)}`;
  const isPickup = fulfillmentMethod === "pickup";

  const paymentBadge = paymentMethod === "online"
    ? `<span style="display:inline-block;background:#16a34a;color:#fff;padding:4px 10px;border-radius:12px;font-size:12px;font-weight:bold;">💳 תשלום אונליין — הלקוח מועבר לסומיט</span>`
    : `<span style="display:inline-block;background:#E85D2F;color:#fff;padding:4px 10px;border-radius:12px;font-size:12px;font-weight:bold;">📞 חיוב טלפוני — צריך להתקשר ללקוח</span>`;

  const fulfillmentBadge = isPickup
    ? `<span style="display:inline-block;background:#7A4E00;color:#fff;padding:4px 10px;border-radius:12px;font-size:12px;font-weight:bold;">🏭 איסוף עצמי מהמפעל</span>`
    : `<span style="display:inline-block;background:#2563eb;color:#fff;padding:4px 10px;border-radius:12px;font-size:12px;font-weight:bold;">🚚 משלוח עד הבית</span>`;

  const itemRows = (items || []).map(i => {
    const lineTotal = i.priceNumeric
      ? `${(i.priceNumeric * i.qty).toLocaleString("he-IL")} ש"ח`
      : "לפי הצעה";
    return `<tr style="border-bottom:1px solid #eee;">
      <td style="padding:10px 8px;color:#1A1A1A;"><strong>${escapeHtml(i.name)}</strong>${i.note ? `<div style="font-size:11px;color:#888">${escapeHtml(i.note)}</div>` : ""}</td>
      <td style="padding:10px 8px;color:#1A1A1A;text-align:center;">${i.qty}</td>
      <td style="padding:10px 8px;color:#1A1A1A;text-align:end;">${escapeHtml(i.price || "—")}</td>
      <td style="padding:10px 8px;color:#1A1A1A;text-align:end;font-weight:bold;">${lineTotal}</td>
    </tr>`;
  }).join("");

  return `
<div dir="rtl" style="font-family:Arial,sans-serif;max-width:700px;margin:0 auto;background:#F4F4F4;padding:24px;border-radius:8px;">
  <h2 style="color:#1A1A1A;border-bottom:2px solid #E85D2F;padding-bottom:8px;margin-top:0;">🛒 הזמנה חדשה מאתר אספגיל</h2>
  <p style="color:#666;margin:4px 0;">מספר הזמנה: <strong style="color:#1A1A1A;">${orderId}</strong></p>
  <p style="color:#666;margin:4px 0;">${new Date().toLocaleString("he-IL", { timeZone: "Asia/Jerusalem" })}</p>
  <p style="margin:12px 0;">${paymentBadge} ${fulfillmentBadge}</p>

  ${isPickup ? `<div style="background:#7A4E00;color:#fff;padding:14px 16px;border-radius:8px;margin:12px 0;font-size:15px;font-weight:bold;">
    ⚠️ איסוף עצמי — יש ליצור קשר עם הלקוח ולתאם מראש מועד איסוף מהמפעל. אין לאפשר הגעה ללא תיאום.
  </div>` : ""}

  <h3 style="color:#C44A24;margin-top:24px;">פרטי לקוח</h3>
  <table style="width:100%;border-collapse:collapse;background:#fff;border-radius:8px;overflow:hidden;">
    <tr><td style="padding:10px;color:#C44A24;font-weight:bold;width:140px;">שם</td><td style="padding:10px;">${escapeHtml(customer.name)}</td></tr>
    ${customer.business ? `<tr style="background:#FAFAF7;"><td style="padding:10px;color:#C44A24;font-weight:bold;">עסק</td><td style="padding:10px;">${escapeHtml(customer.business)}</td></tr>` : ""}
    <tr style="background:#FAFAF7;"><td style="padding:10px;color:#C44A24;font-weight:bold;">טלפון</td><td style="padding:10px;direction:ltr;"><a href="tel:${escapeHtml(customer.phone)}" style="color:#E85D2F;">${escapeHtml(customer.phone)}</a> · <a href="${waLink}" style="color:#25D366;">וואטסאפ ↗</a></td></tr>
    ${customer.email ? `<tr><td style="padding:10px;color:#C44A24;font-weight:bold;">אימייל</td><td style="padding:10px;direction:ltr;">${escapeHtml(customer.email)}</td></tr>` : ""}
    ${customer.taxId ? `<tr style="background:#FAFAF7;"><td style="padding:10px;color:#C44A24;font-weight:bold;">ח.פ / ת.ז</td><td style="padding:10px;direction:ltr;">${escapeHtml(customer.taxId)}</td></tr>` : ""}
    ${customer.invoiceName ? `<tr><td style="padding:10px;color:#C44A24;font-weight:bold;">שם לחשבונית</td><td style="padding:10px;">${escapeHtml(customer.invoiceName)}</td></tr>` : ""}
    ${customer.address || customer.city ? `<tr style="background:#FAFAF7;"><td style="padding:10px;color:#C44A24;font-weight:bold;">כתובת</td><td style="padding:10px;">${escapeHtml([customer.address, customer.city].filter(Boolean).join(", "))}</td></tr>` : ""}
    ${customer.notes ? `<tr><td style="padding:10px;color:#C44A24;font-weight:bold;vertical-align:top;">הערות</td><td style="padding:10px;white-space:pre-wrap;">${escapeHtml(customer.notes)}</td></tr>` : ""}
  </table>

  <h3 style="color:#C44A24;margin-top:24px;">פריטי הזמנה</h3>
  <table style="width:100%;border-collapse:collapse;background:#fff;border-radius:8px;overflow:hidden;">
    <thead>
      <tr style="background:#E85D2F;color:#fff;">
        <th style="padding:10px 8px;text-align:start;">מוצר</th>
        <th style="padding:10px 8px;text-align:center;">כמות</th>
        <th style="padding:10px 8px;text-align:end;">מחיר ליח׳</th>
        <th style="padding:10px 8px;text-align:end;">סה"כ</th>
      </tr>
    </thead>
    <tbody>${itemRows}
      ${shipping && shipping.units > 0 ? `<tr style="border-bottom:1px solid #eee;">
        <td style="padding:10px 8px;color:#1A1A1A;"><strong>${isPickup ? "איסוף עצמי" : "משלוח"}</strong><div style="font-size:11px;color:#888">${shipping.units.toLocaleString("he-IL")} יח' בהזמנה</div></td>
        <td style="padding:10px 8px;color:#1A1A1A;text-align:center;">—</td>
        <td style="padding:10px 8px;color:#1A1A1A;text-align:end;">—</td>
        <td style="padding:10px 8px;color:#1A1A1A;text-align:end;font-weight:bold;">${isPickup ? "ללא עלות" : (shipping.needsArrangement ? "לפי תיאום" : Number(shipping.cost).toLocaleString("he-IL") + ' ש"ח')}</td>
      </tr>` : ""}
    </tbody>
    ${totalPrice > 0 ? `
    <tfoot>
      <tr style="background:#E85D2F;color:#fff;">
        <td colspan="3" style="padding:12px 8px;text-align:end;font-weight:bold;">סה"כ:</td>
        <td style="padding:12px 8px;text-align:end;font-weight:bold;font-size:16px;">${Number(totalPrice).toLocaleString("he-IL")} ש"ח</td>
      </tr>
    </tfoot>` : ""}
  </table>

  ${hasUnpricedItems ? `<p style="background:#FFF4D6;border-right:4px solid #E85D2F;padding:12px;margin-top:16px;color:#7A4E00;">⚠️ יש פריטים ללא מחיר — צריך לקבוע מחיר בשיחה עם הלקוח.</p>` : ""}
  ${shipping && shipping.needsArrangement ? `<p style="background:#FFF4D6;border-right:4px solid #E85D2F;padding:12px;margin-top:16px;color:#7A4E00;">🚚 הזמנה מעל 5,000 יח' — צריך לתאם עלות משלוח מול הלקוח בנפרד.</p>` : ""}

  <div style="margin-top:24px;padding:16px;background:#fff;border-radius:8px;text-align:center;">
    <p style="margin:0 0 8px;color:#C44A24;font-weight:bold;">פעולות מהירות:</p>
    <a href="tel:${escapeHtml(customer.phone)}" style="display:inline-block;background:#C44A24;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none;margin:4px;">📞 התקשר ללקוח</a>
    <a href="${waLink}" style="display:inline-block;background:#25D366;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none;margin:4px;">💬 וואטסאפ</a>
  </div>

  <p style="margin-top:24px;font-size:12px;color:#999;text-align:center;">נשלח מאתר אספגיל · gilcups.com</p>
</div>`;
}

async function sendViaResend(apiKey, payload) {
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!r.ok) {
    const t = await r.text();
    return { ok: false, error: t.slice(0, 500) };
  }
  const j = await r.json();
  return { ok: true, id: j.id };
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "RESEND_API_KEY missing" });

  try {
    const body = req.body || {};
    const { customer, items, totalPrice, hasUnpricedItems, paymentMethod } = body;

    if (!customer?.name || !customer?.phone) {
      return res.status(400).json({ error: "missing fields" });
    }
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "empty cart" });
    }

    const orderId = generateOrderId();
    const html = buildEmailHtml(orderId, body);
    const subject = `🛒 הזמנה חדשה ${orderId} — ${customer.name}`;

    const result = await sendViaResend(apiKey, {
      from: RESEND_FROM,
      to: [BUSINESS_EMAIL],
      reply_to: customer.email || undefined,
      subject,
      html,
    });

    if (!result.ok) {
      console.error("Email send failed:", result.error);
      return res.status(500).json({ error: "email failed", detail: result.error });
    }

    // Auto-reply to customer
    if (customer.email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customer.email)) {
      const replyHtml = `<!DOCTYPE html><html dir="rtl" lang="he"><head><meta charset="utf-8"></head><body style="font-family:Arial,sans-serif;direction:rtl;padding:24px;background:#f5f5f5;">
<div style="max-width:560px;margin:0 auto;background:#fff;border-radius:8px;padding:24px;">
<h2 style="color:#E85D2F;margin-top:0;">תודה על הזמנתכם — אספגיל</h2>
<p>שלום ${escapeHtml(customer.name)},</p>
<p>קיבלנו את ההזמנה שלכם בהצלחה (מספר הזמנה: <strong>${orderId}</strong>).</p>
<p>נחזור אליכם תוך יום עסקים עם אישור סופי ופרטי משלוח.</p>
<p>לשאלות: <a href="tel:039600550" style="color:#E85D2F;">03-9600550</a></p>
<p style="margin-top:24px;">בברכה,<br><strong>צוות אספגיל</strong></p>
</div></body></html>`;
      sendViaResend(apiKey, {
        from: RESEND_FROM,
        to: [customer.email],
        subject: `תודה על הזמנתכם — אספגיל (${orderId})`,
        html: replyHtml,
      }).catch(err => console.error("auto-reply failed:", err));
    }

    return res.status(200).json({ ok: true, orderId });
  } catch (err) {
    console.error("order handler error:", err);
    return res.status(500).json({ error: "internal server error", message: err.message });
  }
}
