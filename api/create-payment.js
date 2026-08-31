/**
 * Vercel Serverless Function — Sumit payment session creator.
 * Calls Sumit's beginredirect API server-side (API key stays secure).
 *
 * Env vars (set in Vercel dashboard):
 *   SUMIT_API_KEY    — Sumit API key
 *   SUMIT_COMPANY_ID — Sumit company ID (numeric)
 *
 * POST /api/create-payment
 * Body: { amount, orderId, customer, successUrl, failureUrl }
 */

import { getCatalogPrice, computeShipping } from "./_pricing.js";

// SUMIT_API_KEY must come ONLY from the environment (this repo is public on
// GitHub) — set it in Vercel project settings. No hardcoded fallback here.
const SUMIT_API_KEY     = process.env.SUMIT_API_KEY;
const SUMIT_COMPANY_ID  = Number(process.env.SUMIT_COMPANY_ID || "1947861983");
const SUMIT_REDIRECT_URL = "https://api.sumit.co.il/billing/payments/beginredirect/";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  if (!SUMIT_API_KEY) {
    return res.status(500).json({ ok: false, error: "sumit_not_configured", message: "SUMIT_API_KEY is not set on the server." });
  }

  try {
    const body = req.body || {};
    const { amount, orderId, customer, successUrl, failureUrl, items } = body;

    if (!amount || !orderId || !customer) {
      return res.status(400).json({ ok: false, error: "missing fields" });
    }

    // Itemize by cart line so the Sumit document — and the eventual
    // Hashavshevet invoice — shows each product instead of one generic line.
    // Every line is re-priced from the server-side catalog — never trust the
    // client-supplied priceNumeric (or the top-level `amount`) for an actual
    // charge. A missing/empty `items` array is refused rather than falling
    // back to a single line billed at the client-supplied `amount`, which
    // let a request with no items bypass catalog pricing entirely and
    // charge whatever amount it sent.
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({
        ok: false,
        error: "missing_items",
        message: "לא נשלחו פריטי הזמנה. רענן/י את העמוד ונסה/י שוב.",
      });
    }
    const unresolved = [];
    const lineItems = items.map((line) => {
      const catalogPrice = getCatalogPrice(line.id);
      if (catalogPrice === undefined) unresolved.push(`${line.name} (${line.id})`);
      return {
        Item: {
          Name: line.name,
          Description: `הזמנה ${orderId}`,
        },
        Quantity: line.qty,
        UnitPrice: catalogPrice ?? 0,
        Description: `הזמנה ${orderId}`,
      };
    });
    if (unresolved.length > 0) {
      console.error("create-payment: unresolved catalog price for line(s):", unresolved);
      return res.status(400).json({
        ok: false,
        error: "price_lookup_failed",
        message: "לא ניתן לאמת את המחיר עבור אחד או יותר מהפריטים בעגלה. רענן/י את העמוד ונסה/י שוב.",
      });
    }

    // Shipping isn't in the catalog-priced product lines above — add it as
    // its own line so the charged total (and the Hashavshevet invoice)
    // actually includes it instead of silently undercharging by the
    // shipping fee. Recomputed from the actual items server-side (like the
    // catalog prices above) rather than trusting body.shippingFee, which is
    // just a client-computed number that travels as plain JSON — otherwise
    // a request could charge ₪0 shipping while claiming a big order's item
    // total.
    const shippingInfo = computeShipping(items, body.fulfillmentMethod);
    const shippingFee = shippingInfo.needsArrangement ? 0 : shippingInfo.cost;
    if (shippingFee > 0) {
      lineItems.push({
        Item: {
          Name: "דמי משלוח",
          Description: `הזמנה ${orderId}`,
        },
        Quantity: 1,
        UnitPrice: shippingFee,
        Description: "דמי משלוח",
      });
    }

    const sumitBody = {
      Credentials: {
        CompanyID: SUMIT_COMPANY_ID,
        APIKey: SUMIT_API_KEY,
      },
      Customer: {
        Name: customer.invoiceName?.trim() || customer.name,
        Phone: customer.phone || null,
        EmailAddress: customer.email || null,
        City: customer.city || null,
        Address: customer.address || null,
        CompanyNumber: customer.taxId || null,
        SearchMode: 0,
      },
      Items: lineItems,
      VATIncluded: true,
      RedirectURL: successUrl,
      CancelRedirectURL: failureUrl,
      ExternalIdentifier: orderId,
      // Finalized (not draft) so the transaction is included in Sumit's
      // "Export to Hashavshevet" feed, which only picks up documents that
      // have been moved to the books. UpdateCustomerOnSuccess stays false so
      // Sumit still doesn't email the customer directly.
      DraftDocument: false,
      UpdateCustomerOnSuccess: false,
    };

    const sumitRes = await fetch(SUMIT_REDIRECT_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(sumitBody),
    });

    const text = await sumitRes.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      console.error("Sumit non-JSON response:", text);
      return res.status(502).json({ ok: false, error: "sumit_invalid_response", raw: text.slice(0, 300) });
    }

    console.log("Sumit beginredirect response:", JSON.stringify(data));

    const isSuccess = data.Status === 0 ||
      (typeof data.Status === "string" && data.Status.toLowerCase().startsWith("success"));

    if (!isSuccess) {
      return res.status(502).json({
        ok: false,
        error: "sumit_error",
        message: data.UserErrorMessage || "Sumit rejected the request",
        fullResponse: data,
      });
    }

    let paymentUrl;
    if (typeof data.Data === "string") {
      paymentUrl = data.Data;
    } else if (data.Data && typeof data.Data === "object") {
      paymentUrl = data.Data.URL || data.Data.Url || data.Data.RedirectURL ||
                   data.Data.PaymentURL || data.Data.PaymentPageURL;
    }

    if (!paymentUrl) {
      return res.status(502).json({ ok: false, error: "no_payment_url", fullResponse: data });
    }

    return res.status(200).json({ ok: true, paymentUrl });
  } catch (err) {
    console.error("create-payment error:", err);
    return res.status(500).json({ ok: false, error: "network_error", message: String(err) });
  }
}
