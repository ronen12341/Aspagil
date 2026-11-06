// Traffic-source classification for orders and leads (see assets/js/attribution.js).
// Underscore prefix = helper module, not an API route.

/** Accepts the client payload; falls back to a bare gclid when that is all we have. */
export function normalizeAttribution(attribution, gclid) {
  if (attribution && typeof attribution === "object" && (attribution.last || attribution.first)) return attribution;
  if (gclid) return { last: { gclid: String(gclid) } };
  return undefined;
}

const SEARCH_ENGINES = ["google.", "bing.com", "yahoo.", "duckduckgo.com", "yandex.", "ecosia.org", "baidu.com"];
const AI_SITES = ["chatgpt.com", "chat.openai.com", "openai.com", "perplexity.ai", "gemini.google.com", "claude.ai", "copilot.microsoft.com", "you.com", "meta.ai"];
const META_SITES = ["facebook.com", "instagram.com", "fb.com", "fb.me", "messenger.com", "l.facebook.com", "lm.facebook.com", "l.instagram.com"];

function hostOf(u) {
  try { return new URL(String(u)).hostname.replace(/^www\./, "").toLowerCase(); } catch (e) { return ""; }
}
function matchHost(h, list) {
  return !!h && list.some((d) => (d.endsWith(".") ? h.startsWith(d) || h.includes("." + d) : h === d || h.endsWith("." + d)));
}

/** Turns one captured visit into a human-readable traffic source (Hebrew). */
export function classifyTouch(t) {
  if (!t || typeof t !== "object") return "ישיר / לא ידוע";
  const src = String(t.utm_source || "").toLowerCase();
  const med = String(t.utm_medium || "").toLowerCase();
  const rh = hostOf(t.referrer);
  const paidMedium = /(^|[^a-z])(cpc|ppc|paid|paidsocial|paid_social|ads?|cpm|display)([^a-z]|$)/.test(med);
  const isMeta = /facebook|instagram|^fb$|^ig$|meta/.test(src) || !!t.fbclid || matchHost(rh, META_SITES);

  if (t.gclid || t.gbraid || t.wbraid || ((src === "google" || src === "adwords") && paidMedium)) return "Google Ads";
  if (isMeta) {
    if (paidMedium || (src && t.fbclid && med)) return "Meta — מודעה ממומנת";
    if (t.fbclid) return "Meta (פייסבוק/אינסטגרם) — ממומן או אורגני";
    return "Meta — אורגני";
  }
  if (t.msclkid) return "Microsoft (Bing) Ads";
  if (t.ttclid || src === "tiktok") return paidMedium || t.ttclid ? "TikTok Ads" : "TikTok";
  if (src) return "קמפיין: " + src + (med ? " / " + med : "");
  if (matchHost(rh, AI_SITES)) return "AI — " + rh;
  if (matchHost(rh, SEARCH_ENGINES)) return "חיפוש אורגני — " + rh;
  if (rh) return "הפניה מאתר — " + rh;
  return "ישיר / לא ידוע";
}

/** Short source label for email subjects, e.g. "Google Ads", "Meta", "אורגני". */
export function shortSource(a) {
  const label = classifyTouch(a && a.last);
  if (label.startsWith("Meta")) return "Meta";
  if (label.startsWith("חיפוש אורגני")) return "אורגני";
  if (label.startsWith("AI")) return "AI";
  if (label.startsWith("הפניה")) return "הפניה";
  if (label.startsWith("ישיר")) return "ישיר";
  return label.replace(/^קמפיין: /, "");
}

/** HTML block for the business notification email. `esc` = the route's escapeHtml. */
export function attributionHtml(a, esc) {
  const last = a && a.last;
  const first = a && a.first;
  const lastLabel = classifyTouch(last);
  const rows = [];
  rows.push("<strong>מקור:</strong> " + esc(lastLabel));
  if (last && last.utm_campaign) rows.push("<strong>קמפיין:</strong> " + esc(last.utm_campaign));
  if (last && last.landing) rows.push("<strong>דף נחיתה:</strong> <span style=\"direction:ltr;display:inline-block;\">" + esc(last.landing) + "</span>");
  if (last && last.ts) rows.push("<strong>תאריך כניסה:</strong> " + esc(new Date(last.ts).toLocaleString("he-IL", { timeZone: "Asia/Jerusalem" })));
  if (first && last && first.ts !== last.ts) {
    rows.push("<strong>כניסה ראשונה:</strong> " + esc(classifyTouch(first)) + (first.ts ? " (" + esc(new Date(first.ts).toLocaleDateString("he-IL", { timeZone: "Asia/Jerusalem" })) + ")" : ""));
  }
  const ids = [];
  if (last) for (const k of ["gclid", "fbclid", "msclkid", "ttclid"]) if (last[k]) ids.push(k);
  if (ids.length) rows.push("<span style=\"color:#999;\">מזהי קליק: " + esc(ids.join(", ")) + "</span>");
  return "<div style=\"background:#fff;border-right:4px solid #2563eb;padding:10px 14px;margin:12px 0;border-radius:6px;font-size:13px;color:#333;line-height:1.7;\">📍 " + rows.join("<br>") + "</div>";
}
