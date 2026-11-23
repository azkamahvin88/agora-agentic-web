// Agora runtime + orderflow test suite. Run: node --test test/runtime.test.mjs
// Covers: manifest/network validation, arg validation, local-engine plans,
// LLM reply parsing, peer helpers, the single-confirmation checkout guard,
// delivery-fee-carrying receipts, and an end-to-end local-engine demo run
// with mocked fetch (no network, no DOM).
// Copyright 2026 Agora contributors — Apache-2.0.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  AgoraRuntime,
  DEMO_CATALOG,
  DEMO_COURIER_FALLBACK,
  validateManifest,
  validateNetwork,
  validateFrontAgent,
  validateArgs,
  planWithLocalEngine,
  parseLlmToolCalls,
  peerNameFromUrl,
  resolvePeerUrl,
} from "../runtime.js";
import {
  createConfirmationGuard,
  resolveDeliveryFee,
  buildReceipt,
} from "../orderflow.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const THIS_FILE = fileURLToPath(import.meta.url);
const readJson = (rel) => JSON.parse(readFileSync(path.join(ROOT, rel), "utf8"));

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

test("validateManifest accepts the real Agora manifest", () => {
  const m = validateManifest(readJson("agent-manifest.json"));
  assert.deepEqual(m.errors, []);
  assert.equal(m.ok, true);
});

test("validateManifest rejects missing networks and duplicate names", () => {
  assert.equal(validateManifest({}).ok, false);
  assert.equal(validateManifest({ networks: [] }).ok, false);
  const dup = {
    networks: [
      { name: "agora", front_man: "concierge", hocon: "a.json" },
      { name: "agora", front_man: "concierge", hocon: "b.json" },
    ],
  };
  const r = validateManifest(dup);
  assert.equal(r.ok, false);
  assert.match(r.errors.join(" "), /duplicate network name/);
  assert.equal(validateManifest({ networks: [{ name: "x", front_man: "y", hocon: "z.json" }], peer_policy: { default: "maybe" } }).ok, false);
});

test("validateNetwork accepts the real Agora, courier, and template networks", () => {
  for (const rel of ["agora.network.json", "courier/courier.network.json", "shops/template/template.network.json"]) {
    const v = validateNetwork(readJson(rel));
    assert.deepEqual(v.errors, []);
    assert.equal(v.ok, true, rel);
  }
});

test("validateNetwork rejects unknown references and self-references", () => {
  const bad = {
    metadata: { description: "x" },
    tools: [
      { name: "a", function: { description: "d", parameters: { type: "object", properties: {} } }, instructions: "i", tools: ["ghost"] },
    ],
  };
  assert.match(validateNetwork(bad).errors.join(" "), /unknown tool\/agent 'ghost'/);
  const self = {
    metadata: { description: "x" },
    tools: [
      { name: "a", function: { description: "d", parameters: { type: "object", properties: {} } }, instructions: "i", tools: ["a"] },
    ],
  };
  assert.match(validateNetwork(self).errors.join(" "), /references itself/);
});

test("validateFrontAgent matches manifest front agents to network entries", () => {
  const cases = [
    ["agent-manifest.json", "agora.network.json", "agora"],
    ["courier/agent-manifest.json", "courier/courier.network.json", "courier"],
    ["shops/template/agent-manifest.json", "shops/template/template.network.json", "template-shop"],
  ];
  for (const [manifestRel, networkRel, name] of cases) {
    const r = validateFrontAgent(readJson(manifestRel), readJson(networkRel), name);
    assert.deepEqual(r.errors, []);
    assert.equal(r.ok, true, name);
  }
  const bad = validateFrontAgent(readJson("agent-manifest.json"), readJson("agora.network.json"), "nope");
  assert.equal(bad.ok, false);
});

test("validateArgs enforces required, types, minimum, and enum", () => {
  const schema = {
    type: "object",
    required: ["product_id"],
    properties: {
      product_id: { type: "string", minLength: 1 },
      quantity: { type: "integer", minimum: 1 },
      shop: { type: "string", enum: ["bakery", "grocer"] },
    },
  };
  assert.equal(validateArgs(schema, { product_id: "cake-choc-8" }).ok, true);
  assert.equal(validateArgs(schema, {}).ok, false);
  assert.equal(validateArgs(schema, { product_id: "x", quantity: 0 }).ok, false);
  assert.equal(validateArgs(schema, { product_id: "x", shop: "pharmacy" }).ok, false);
  assert.equal(validateArgs(schema, { product_id: "x", quantity: 2, shop: "bakery" }).ok, true);
});

// ---------------------------------------------------------------------------
// Local engine planning
// ---------------------------------------------------------------------------

test("planWithLocalEngine plans the birthday-cake demo end to end", () => {
  const plan = planWithLocalEngine("I need a birthday cake for 8 people this Saturday, delivered to my home.");
  assert.equal(plan.reply, null);
  const tools = plan.steps.map((s) => s.tool);
  assert.deepEqual(tools, ["website_list_products", "website_add_to_cart", "courier_get_delivery_quote"]);
  assert.equal(plan.steps[1].args.product_id, "cake-vanilla-8"); // smallest cake that serves 8
  assert.equal(plan.steps[2].args.day, "Saturday");
});

test("planWithLocalEngine plans checkout and cart-only requests", () => {
  const checkout = planWithLocalEngine("Please checkout my order.");
  assert.deepEqual(checkout.steps.map((s) => s.tool), ["website_get_cart", "website_checkout_order"]);
  assert.equal(checkout.steps[1].confirm, true);
  const cart = planWithLocalEngine("What is in my cart?");
  assert.deepEqual(cart.steps.map((s) => s.tool), ["website_get_cart"]);
  const unknown = planWithLocalEngine("Tell me a joke about the moon.");
  assert.equal(unknown.steps.length, 0);
  assert.match(unknown.reply, /birthday cake/);
});

// ---------------------------------------------------------------------------
// LLM reply parsing
// ---------------------------------------------------------------------------

test("parseLlmToolCalls reads fenced JSON, plain JSON, and reply-only JSON", () => {
  const fenced = parseLlmToolCalls('Here you go:\n```json\n{"calls":[{"tool":"website_get_cart","arguments":{}}]}\n```');
  assert.deepEqual(fenced.calls, [{ tool: "website_get_cart", arguments: {} }]);
  const plain = parseLlmToolCalls('{"reply":"Hello!"}');
  assert.equal(plain.reply, "Hello!");
  assert.deepEqual(plain.calls, []);
  assert.equal(parseLlmToolCalls("not json at all"), null);
  const oa = parseLlmToolCalls(JSON.stringify({
    choices: [{ message: { tool_calls: [{ function: { name: "website_list_products", arguments: '{"shop":"bakery"}' } }] } }],
  }));
  assert.deepEqual(oa.calls, [{ tool: "website_list_products", arguments: { shop: "bakery" } }]);
});

// ---------------------------------------------------------------------------
// Peer helpers
// ---------------------------------------------------------------------------

test("peerNameFromUrl takes the last path component", () => {
  assert.equal(peerNameFromUrl("https://example.com/courier/"), "courier");
  assert.equal(peerNameFromUrl("https://example.com/a/b/courier"), "courier");
  assert.equal(peerNameFromUrl("https://example.com/courier/?x=1"), "courier");
});

test("resolvePeerUrl resolves links.json entries", () => {
  assert.deepEqual(resolvePeerUrl({ courier: "./courier/" }, "courier"), { ok: true, url: "./courier/", error: null });
  assert.equal(resolvePeerUrl({}, "courier").ok, false);
  assert.equal(resolvePeerUrl({ courier: "http://exa mple" }, "courier").ok, false);
});

// ---------------------------------------------------------------------------
// orderflow: single-confirmation guard + delivery-fee receipts
// ---------------------------------------------------------------------------

test("confirmation guard: one approval is usable once, then gone", () => {
  const guard = createConfirmationGuard();
  assert.equal(guard.hasValidConfirmation(), false);
  guard.markConfirmed({ text: "order summary" });
  assert.equal(guard.hasValidConfirmation(), true);
  const token = guard.consumeConfirmation();
  assert.equal(token.summary.text, "order summary");
  assert.equal(guard.hasValidConfirmation(), false);
  assert.equal(guard.consumeConfirmation(), null);
});

test("confirmation guard expires (ttlMs: 0 is immediately invalid)", () => {
  const guard = createConfirmationGuard({ ttlMs: 0 });
  guard.markConfirmed({});
  assert.equal(guard.hasValidConfirmation(), false);
});

test("resolveDeliveryFee prefers the quoted fee, falls back to the published base fee", () => {
  assert.equal(resolveDeliveryFee({ deliveryFee: 7.25 }, 4.5), 7.25);
  assert.equal(resolveDeliveryFee({}, 4.5), 4.5);
  assert.equal(resolveDeliveryFee({ deliveryFee: 0 }, 4.5), 0);
  assert.equal(resolveDeliveryFee({}, undefined), 0);
});

test("buildReceipt total always includes the delivery fee", () => {
  const items = [{ name: "Chocolate Celebration Cake", price: 28, quantity: 1 }];
  const r = buildReceipt({ items, deliveryFee: DEMO_COURIER_FALLBACK.baseFee, day: "Saturday", orderId: "AGORA-0001" });
  assert.equal(r.subtotal, 28);
  assert.equal(r.deliveryFee, 4.5);
  assert.equal(r.total, 32.5);
});

// ---------------------------------------------------------------------------
// End-to-end local-engine demo run with mocked fetch
// ---------------------------------------------------------------------------

function mockFetchFactory() {
  const bySuffix = {
    // More specific suffixes first: the courier manifest URL also ends with
    // "agent-manifest.json", so it must match before the root manifest.
    "courier/agent-manifest.json": "courier/agent-manifest.json",
    "courier/courier.network.json": "courier/courier.network.json",
    "agent-manifest.json": "agent-manifest.json",
    "links.json": "links.json",
    "agora.network.json": "agora.network.json",
  };
  return async (url) => {
    const u = String(url);
    for (const [suffix, rel] of Object.entries(bySuffix)) {
      if (u.endsWith(suffix)) {
        return { ok: true, status: 200, json: async () => readJson(rel) };
      }
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
}

test("end-to-end demo: one confirmation, receipt carries the delivery fee", async () => {
  const guard = createConfirmationGuard();
  let confirmCalls = 0;
  let consentCalls = 0;
  const cart = new Map();
  const snapshot = () => {
    const items = [...cart.values()].map(({ product, quantity }) => ({
      product_id: product.id, name: product.name, price: product.price, quantity,
    }));
    return { items, total: items.reduce((s, i) => s + i.price * i.quantity, 0) };
  };
  const findProduct = (id) => {
    for (const data of Object.values(DEMO_CATALOG)) {
      const p = data.products.find((x) => x.id === id);
      if (p) return p;
    }
    return null;
  };
  let orderCounter = 0;
  const siteActions = {
    async website_list_products(args) {
      const data = DEMO_CATALOG[args.shop || "bakery"];
      return { shop: args.shop, shopName: data.shopName, products: data.products };
    },
    async website_add_to_cart(args) {
      const product = findProduct(args.product_id);
      if (!product) return { ok: false, error: "unknown product" };
      if (!cart.has(args.product_id)) cart.set(args.product_id, { product, quantity: args.quantity || 1 });
      const snap = snapshot();
      return { added: { name: product.name, price: product.price }, cartTotal: snap.total, items: snap.items };
    },
    async website_get_cart() {
      return snapshot();
    },
    // Mirrors the fixed app.js handler: reuse a prior approval (single
    // confirmation) and build the receipt with the delivery fee included.
    async website_checkout_order(args) {
      const snap = snapshot();
      if (!snap.items.length) return { ok: false, error: "Cart is empty." };
      if (!guard.hasValidConfirmation()) return { ok: false, error: "No prior confirmation — checkout refused." };
      guard.consumeConfirmation();
      orderCounter += 1;
      const receipt = buildReceipt({
        items: snap.items,
        deliveryFee: resolveDeliveryFee(args, DEMO_COURIER_FALLBACK.baseFee),
        day: args.day || "Saturday",
        orderId: `AGORA-${String(orderCounter).padStart(4, "0")}`,
      });
      cart.clear();
      return { receipt };
    },
  };

  const runtime = new AgoraRuntime({
    fetchImpl: mockFetchFactory(),
    siteBase: "https://example.invalid/",
    siteActions,
    onTrace: () => {},
    onReply: () => {},
    onConsent: async () => { consentCalls += 1; return true; },
    onConfirm: async (summary) => { confirmCalls += 1; guard.markConfirmed(summary); return true; },
  });
  runtime.engine = "local";
  await runtime.loadSite();
  const result = await runtime.run("I need a birthday cake for 8 people this Saturday, delivered to my home.");

  assert.equal(result.ok, true);
  assert.equal(result.engine, "local");
  // Defect (a): the user confirms the order exactly once.
  assert.equal(confirmCalls, 1, "order confirmation must happen exactly once");
  // Defect (b): the receipt carries the delivery fee in its total.
  assert.ok(result.receipt, "run must return a receipt");
  assert.equal(result.receipt.deliveryFee, 4.5);
  assert.equal(result.receipt.total, 28.5); // Vanilla Berry Cake $24.00 + delivery $4.50
  assert.match(result.receipt.orderId, /^AGORA-0001$/);
  // Peer consent asked once for the courier origin.
  assert.equal(consentCalls, 1);
});

// ---------------------------------------------------------------------------
// Repo hygiene: never touch the upstream reference clone
// ---------------------------------------------------------------------------

test("no project file reads, copies, or imports from upstream/", () => {
  const walk = (dir) => {
    const out = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) out.push(...walk(p));
      else out.push(p);
    }
    return out;
  };
  const files = walk(ROOT).filter((f) => !f.includes(`${path.sep}upstream${path.sep}`) && !f.includes("/.git/") && f !== THIS_FILE);
  for (const f of files) {
    const content = readFileSync(f, "utf8");
    assert.ok(!content.includes("upstream/"), `${path.relative(ROOT, f)} must not reference the reference clone`);
  }
});
