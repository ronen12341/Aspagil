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
