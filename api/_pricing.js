/**
 * Authoritative server-side price catalog for cart items.
 *
 * The cart (assets/js/cart.js) stores `priceNumeric` as a plain field on
 * each item — it's just a snapshot copied from the product page's
 * data-add-to-cart attribute into localStorage. Since it travels as plain
 * JSON in the checkout request body, a client could edit it directly to pay
 * any amount. Anything that touches money (create-payment.js, order.js)
 * must look the price up here instead of trusting the request.
 *
 * Keep this in sync with the prices shown on paper-cups-9oz.html and the
 * quote calculator (PRICE_MAP) in contact.html.
 */
const CATALOG_PRICES = {
  // paper-cups-9oz.html
  "9oz-500": 500,
  "9oz-1000": 800,
  "9oz-2000": 1500,
  "9oz-5000": 2750,
  "9oz-10000": 4500,
  // contact.html quote-calculator cart item (id = "cups-" + qty)
  "cups-500": 500,
  "cups-1000": 800,
  "cups-2000": 1500,
  "cups-3000": 2100,
  "cups-5000": 2750,
  "cups-10000": 4500,
};

export function getCatalogPrice(id) {
  return Object.prototype.hasOwnProperty.call(CATALOG_PRICES, id)
    ? CATALOG_PRICES[id]
    : undefined;
}

/**
 * Server-side mirror of assets/js/cart.js's SHIPPING_TIERS / parseUnits /
 * shippingInfo(). The client sends its own computed shipping.cost /
 * shippingFee, which — like priceNumeric — travels as plain JSON and can be
 * edited directly, so anything that charges money must recompute it here
 * from the actual items instead of trusting the request.
 *
 * Keep the tiers below in sync with assets/js/cart.js.
 */
const SHIPPING_TIERS = [
  { maxUnits: 1000, cost: 60 },
  { maxUnits: 2000, cost: 120 },
  { maxUnits: 3000, cost: 180 },
  { maxUnits: 5000, cost: 250 },
];

function parseUnits(item) {
  const fromNote = String(item?.note || "").replace(/[^\d]/g, "");
  if (fromNote) return parseInt(fromNote, 10);
  const fromId = String(item?.id || "").match(/(\d+)\s*$/);
  return fromId ? parseInt(fromId[1], 10) : 0;
}

/**
 * Returns { units, cost, needsArrangement }. Self-pickup is always
 * shipping-free — that's an intentional fulfillment choice, not something
 * to re-derive from the item count.
 */
export function computeShipping(items, fulfillmentMethod) {
  if (fulfillmentMethod === "pickup") {
    return { units: 0, cost: 0, needsArrangement: false };
  }
  const units = (items || []).reduce((s, i) => s + parseUnits(i) * (Number(i.qty) || 0), 0);
  if (units <= 0) return { units, cost: 0, needsArrangement: false };
  const tier = SHIPPING_TIERS.find((t) => units <= t.maxUnits);
  if (tier) return { units, cost: tier.cost, needsArrangement: false };
  return { units, cost: 0, needsArrangement: true };
}
