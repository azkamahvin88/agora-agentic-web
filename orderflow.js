// orderflow.js — DOM-free checkout helpers for Agora.
// Shared by app.js (browser) and test/runtime.test.mjs (Node).
//
// Owns two behaviours that used to live as inline logic in the page wiring:
//  (1) Single-confirmation checkout. One user approval covers both the
//      order-summary card AND the checkout write that follows it, so the
//      user is never asked to confirm the same order twice. The runtime
//      shows the order card (via onConfirm); the checkout handler then
//      reuses that approval instead of showing a second card. A checkout
//      that arrives WITHOUT a prior approval still shows exactly one card.
//  (2) Delivery-fee-carrying receipts. The receipt total always includes
//      the delivery fee: the fee passed with the checkout call wins when
//      present, otherwise the courier's published base fee is used (never
//      silently zero).
//
// Copyright 2026 Agora contributors — Apache-2.0.

/**
 * A short-lived approval token. `markConfirmed` is called when the user
 * approves an order-summary card; `hasValidConfirmation` is checked by the
 * checkout handler; `consumeConfirmation` clears the token once used, so
 * one approval can never silently cover two separate checkouts.
 */
export function createConfirmationGuard({ ttlMs = 120000 } = {}) {
  let token = null;
  return {
    markConfirmed(summary) {
      token = { summary: summary || null, at: Date.now() };
    },
    hasValidConfirmation() {
      return !!token && Date.now() - token.at < ttlMs;
    },
    consumeConfirmation() {
      const current = token;
      token = null;
      return current;
    },
  };
}

/**
 * Delivery fee for a checkout: prefer the fee carried in the tool call
 * arguments (from the most recent courier quote); fall back to the
 * courier's published base fee; never default to a hidden zero when a
 * published fee is known.
 */
export function resolveDeliveryFee(args, courierFee) {
  if (args && typeof args.deliveryFee === "number" && Number.isFinite(args.deliveryFee) && args.deliveryFee >= 0) {
    return args.deliveryFee;
  }
  if (typeof courierFee === "number" && Number.isFinite(courierFee) && courierFee >= 0) {
    return courierFee;
  }
  return 0;
}

/**
 * Build an order receipt. `total` is always subtotal + deliveryFee, so a
 * receipt never silently drops the delivery charge.
 */
export function buildReceipt({ items, deliveryFee, day, orderId }) {
  const safeItems = Array.isArray(items) ? items : [];
  const subtotal = safeItems.reduce((sum, item) => sum + item.price * item.quantity, 0);
  const fee = typeof deliveryFee === "number" && Number.isFinite(deliveryFee) ? deliveryFee : 0;
  return {
    orderId,
    items: safeItems,
    deliveryFee: fee,
    day: day || "Saturday",
    subtotal,
    total: subtotal + fee,
  };
}
