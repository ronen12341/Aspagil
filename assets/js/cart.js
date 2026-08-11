/**
 * Gilcups — Cart Library
 * Vanilla JS cart with localStorage persistence.
 * Automatically injects a cart icon into the site header.
 *
 * Usage (add to any page):
 *   <script src="assets/js/cart.js"></script>
 *
 * To add an item:
 *   Cart.addItem({ id, name, priceNumeric, price, note })
 */

(function () {
  "use strict";

  const STORAGE_KEY = "gilcups-cart-v1";

  /* ─── Shipping tiers (by total unit count in cart) ───
   * 500–1,000 יח' → 50 ש"ח | 2,000 → 100 ש"ח | 3,000 → 150 ש"ח | 5,000 → 200 ש"ח
   * מעל 5,000 יח' — עלות המשלוח מתואמת בנפרד מול הלקוח.
   */
  const SHIPPING_TIERS = [
    { maxUnits: 1000, cost: 50 },
    { maxUnits: 2000, cost: 100 },
    { maxUnits: 3000, cost: 150 },
    { maxUnits: 5000, cost: 200 },
  ];

  function parseUnits(item) {
    // Units are embedded in the item's note (e.g. "1,000 יח׳") or id (e.g. "9oz-1000").
    const fromNote = (item.note || "").replace(/[^\d]/g, "");
    if (fromNote) return parseInt(fromNote, 10);
    const fromId = (item.id || "").match(/(\d+)\s*$/);
    return fromId ? parseInt(fromId[1], 10) : 0;
  }

  /* ─── State ─── */
  let items = [];

  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) items = parsed;
      }
    } catch (e) { /* ignore */ }
  }

  function save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
    } catch (e) { /* ignore */ }
  }

  function emit() {
    document.dispatchEvent(new CustomEvent("cart:updated", { detail: { items } }));
    updateBadge();
  }

  /* ─── Public API ─── */
  const Cart = {
    getItems: () => items.slice(),

    totalQty: () => items.reduce((s, i) => s + i.qty, 0),

    totalPrice: () => items.reduce((s, i) => s + (i.priceNumeric ? i.priceNumeric * i.qty : 0), 0),

    hasUnpricedItems: () => items.some(i => !i.priceNumeric),

    totalUnits: () => items.reduce((s, i) => s + parseUnits(i) * i.qty, 0),

    // Returns { units, cost, label, needsArrangement }
    shippingInfo() {
      const units = Cart.totalUnits();
      if (units <= 0) return { units, cost: 0, label: "", needsArrangement: false };
      const tier = SHIPPING_TIERS.find(t => units <= t.maxUnits);
      if (tier) {
        return { units, cost: tier.cost, label: tier.cost.toLocaleString("he-IL") + ' ש"ח', needsArrangement: false };
      }
      return { units, cost: 0, label: "לפי תיאום מול נציג", needsArrangement: true };
    },

    addItem(item, qty = 1) {
      const existing = items.find(p => p.id === item.id);
      if (existing) {
        existing.qty += qty;
      } else {
        items.push({ ...item, qty });
      }
      save();
      emit();
    },

    removeItem(id) {
      items = items.filter(i => i.id !== id);
      save();
      emit();
    },

    updateQty(id, qty) {
      if (qty <= 0) { Cart.removeItem(id); return; }
      const item = items.find(i => i.id === id);
      if (item) { item.qty = qty; save(); emit(); }
    },

    clear() {
      items = [];
      save();
      emit();
    }
  };

  /* ─── Badge ─── */
  function updateBadge() {
    const qty = Cart.totalQty();
    document.querySelectorAll(".cart-badge").forEach(el => {
      el.textContent = qty;
      el.style.display = qty > 0 ? "flex" : "none";
    });
  }

  /* ─── Inject cart icon into header ─── */
  function injectCartIcon() {
    // Don't inject on the checkout/order-success pages
    const path = window.location.pathname;
    if (path.endsWith("checkout.html") || path.endsWith("order-success.html")) {
      updateBadge();
      return;
    }

    const cta = document.querySelector(".header-cta");
    if (!cta || cta.querySelector(".cart-icon-link")) return;

    const qty = Cart.totalQty();
    const link = document.createElement("a");
    link.href = "checkout.html";
    link.className = "cart-icon-link";
    link.setAttribute("aria-label", "עגלת קניות");
    link.title = "עגלת קניות";
    link.innerHTML = `
      <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
        <path stroke-linecap="round" stroke-linejoin="round" d="M2.25 3h1.386c.51 0 .955.343 1.087.835l.383 1.437M7.5 14.25a3 3 0 0 0-3 3h15.75m-12.75-3h11.218c1.121-2.3 2.1-4.684 2.924-7.138a60.114 60.114 0 0 0-16.536-1.84M7.5 14.25 5.106 5.272M6 20.25a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0Zm12.75 0a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0Z" />
      </svg>
      <span class="cart-badge" style="display:${qty > 0 ? "flex" : "none"}">${qty}</span>
    `;

    // Insert before the first button/link in .header-cta
    const firstBtn = cta.querySelector(".btn");
    if (firstBtn) {
      cta.insertBefore(link, firstBtn);
    } else {
      cta.appendChild(link);
    }
  }

  /* ─── "Add to cart" button feedback ─── */
  document.addEventListener("click", function (e) {
    const btn = e.target.closest("[data-add-to-cart]");
    if (!btn) return;

    try {
      const item = JSON.parse(btn.getAttribute("data-add-to-cart"));
      Cart.addItem(item);

      const orig = btn.innerHTML;
      btn.innerHTML = "✓ נוסף לסל";
      btn.disabled = true;
      btn.classList.add("cart-btn-added");
      setTimeout(() => {
        btn.innerHTML = orig;
        btn.disabled = false;
        btn.classList.remove("cart-btn-added");
      }, 1800);
    } catch (ex) {
      console.error("cart: invalid data-add-to-cart", ex);
    }
  });

  /* ─── Init ─── */
  load();

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", injectCartIcon);
  } else {
    injectCartIcon();
  }

  /* Expose globally */
  window.Cart = Cart;
})();
