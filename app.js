// Agora Market — page wiring for the Agora runtime (runtime.js).
// Owns all page state (cart, orders) and all DOM. The runtime stays DOM-free.
// Copyright 2026 Agora contributors — Apache-2.0.

import { AgoraRuntime, DEMO_CATALOG, DEFAULT_ROUTER, DEMO_COURIER_FALLBACK, LIMITS } from "./runtime.js";
import { createConfirmationGuard, resolveDeliveryFee, buildReceipt } from "./orderflow.js";

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------------------
// Page state (demo data only — nothing here is a real order or payment).
// ---------------------------------------------------------------------------
const cart = new Map(); // productId -> { product, quantity, shop }
let orders = [];
let orderCounter = 0;

// Single-confirmation guard: one approval of the order-summary card covers
// the checkout write that follows it, so the user is never asked twice.
// (See orderflow.js.)
const confirmGuard = createConfirmationGuard();

// Delivery fee for receipts. Defaults to the courier's published base fee
// and is refreshed from the courier peer site's own published network data
// (the same data the runtime reads when it quotes delivery), so the
// receipt fee always matches the quoted fee.
let courierFee = DEMO_COURIER_FALLBACK.baseFee;
fetch("./courier/courier.network.json")
  .then((res) => (res.ok ? res.json() : null))
  .then((net) => {
    const fee = net?.metadata?.delivery?.baseFee;
    if (typeof fee === "number" && Number.isFinite(fee)) courierFee = fee;
  })
  .catch(() => { /* keep the fallback fee */ });

function findProduct(productId) {
  for (const [shop, data] of Object.entries(DEMO_CATALOG)) {
    const p = data.products.find((x) => x.id === productId);
    if (p) return { ...p, shop };
  }
  return null;
}

function cartSnapshot() {
  const items = [...cart.values()].map(({ product, quantity }) => ({
    product_id: product.id, name: product.name, price: product.price, quantity,
  }));
  const total = items.reduce((s, i) => s + i.price * i.quantity, 0);
  return { items, total };
}

function renderProducts() {
  for (const [shop, data] of Object.entries(DEMO_CATALOG)) {
    const grid = $(`products-${shop}`);
    if (!grid) continue;
    grid.innerHTML = "";
    for (const p of data.products) {
      const card = document.createElement("article");
      card.className = "product";
      card.innerHTML = `<h3></h3><p class="desc"></p><p class="meta"></p><p class="price"></p>`;
      card.querySelector("h3").textContent = p.name;
      card.querySelector(".desc").textContent = p.description;
      card.querySelector(".meta").textContent = p.serves ? `Serves ${p.serves}` : data.shopName;
      card.querySelector(".price").textContent = `$${p.price.toFixed(2)}`;
      const btn = document.createElement("button");
      btn.textContent = "Add to cart";
      btn.addEventListener("click", () => {
        addToCart(p.id, 1);
        addChat("assistant", `Added ${p.name} to your cart.`);
      });
      card.appendChild(btn);
      grid.appendChild(card);
    }
  }
}

function addToCart(productId, quantity) {
  const product = findProduct(productId);
  if (!product) return { ok: false, error: `Unknown product '${productId}'` };
  // Idempotent for the demo: re-adding the same product keeps one of it,
  // so a fallback re-run after a partial LLM run cannot duplicate the cart.
  if (cart.has(productId)) {
    return { ok: true, already: true, product, cart: cartSnapshot() };
  }
  cart.set(productId, { product, quantity });
  renderCart();
  return { ok: true, product, cart: cartSnapshot() };
}

function renderCart() {
  const snap = cartSnapshot();
  const el = $("cart-items");
  el.innerHTML = "";
  if (!snap.items.length) {
    el.innerHTML = "<li>Your cart is empty.</li>";
  } else {
    for (const i of snap.items) {
      const li = document.createElement("li");
      li.textContent = `${i.name} x${i.quantity} — $${(i.price * i.quantity).toFixed(2)} `;
      const rm = document.createElement("button");
      rm.className = "mini";
      rm.textContent = "Remove";
      rm.addEventListener("click", () => { cart.delete(i.product_id); renderCart(); });
      li.appendChild(rm);
      el.appendChild(li);
    }
  }
  $("cart-total").textContent = `$${snap.total.toFixed(2)}`;
  $("cart-count").textContent = String(snap.items.length);
}

// ---------------------------------------------------------------------------
// Chat + trace rendering
// ---------------------------------------------------------------------------
function addChat(role, text) {
  const log = $("chat-log");
  const div = document.createElement("div");
  div.className = `msg ${role}`;
  div.textContent = text;
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
}

function addTrace(event) {
  const panel = $("trace-log");
  const div = document.createElement("div");
  div.className = `trace ${event.kind}`;
  const time = (event.time || "").slice(11, 19);
  const label = event.agent ? `[${event.agent}] ` : event.origin ? `[${event.origin}] ` : "";
  div.textContent = `${time} ${event.kind} ${label}${event.detail || ""}`;
  panel.appendChild(div);
  panel.scrollTop = panel.scrollHeight;
}

// ---------------------------------------------------------------------------
// Consent + confirmation cards (user approval before peer contact / writes)
// ---------------------------------------------------------------------------
function askConsent({ origin, purpose }) {
  return new Promise((resolve) => {
    const box = $("consent-box");
    box.innerHTML = "";
    const card = document.createElement("div");
    card.className = "card consent";
    card.innerHTML = `<h3>Contact another site?</h3><p></p><p class="small">Consent is remembered for this origin for this browser session only. Your API key is never sent to the peer site.</p>`;
    card.querySelector("p").textContent = `Agora wants to contact ${origin} to: ${purpose}`;
    const yes = document.createElement("button");
    yes.textContent = "Allow";
    yes.addEventListener("click", () => { box.innerHTML = ""; resolve(true); });
    const no = document.createElement("button");
    no.textContent = "Deny";
    no.className = "secondary";
    no.addEventListener("click", () => { box.innerHTML = ""; resolve(false); });
    card.append(yes, no);
    box.appendChild(card);
  });
}

function askConfirmOrder(summary) {
  return new Promise((resolve) => {
    const box = $("confirm-box");
    box.innerHTML = "";
    const card = document.createElement("div");
    card.className = "card order";
    card.innerHTML = `<h3>Confirm your order</h3><pre></pre><p class="small">Demo order — no payment is taken and nothing will be shipped.</p>`;
    card.querySelector("pre").textContent = summary.text;
    const yes = document.createElement("button");
    yes.textContent = "Confirm order";
    yes.addEventListener("click", () => {
      // Record the approval: the checkout write that follows this card
      // reuses it instead of asking the user a second time (orderflow.js).
      confirmGuard.markConfirmed(summary);
      box.innerHTML = "";
      resolve(true);
    });
    const no = document.createElement("button");
    no.textContent = "Cancel";
    no.className = "secondary";
    no.addEventListener("click", () => { box.innerHTML = ""; resolve(false); });
    card.append(yes, no);
    box.appendChild(card);
  });
}

// ---------------------------------------------------------------------------
// Site actions (grounded tools the runtime can call on this page)
// ---------------------------------------------------------------------------
const siteActions = {
  async website_list_products(args) {
    const shop = args.shop || "bakery";
    const data = DEMO_CATALOG[shop];
    if (!data) return { ok: false, error: `Unknown shop '${shop}'` };
    return { shop, shopName: data.shopName, products: data.products, saturdaySlots: data.saturdaySlots };
  },
  async website_add_to_cart(args) {
    const res = addToCart(args.product_id, args.quantity || 1);
    if (!res.ok) return res;
    const snap = cartSnapshot();
    return { added: { name: res.product.name, price: res.product.price }, already: !!res.already, cartTotal: snap.total, items: snap.items };
  },
  async website_get_cart() {
    return cartSnapshot();
  },
  async website_checkout_order(args) {
    const snap = cartSnapshot();
    if (!snap.items.length) return { ok: false, error: "Cart is empty — nothing to check out." };
    // Checkout is the irreversible write: it always needs one user
    // confirmation. The runtime already showed the order-summary card in
    // the demo flow, and that approval is reused here (single confirmation);
    // a checkout that arrives without a prior approval shows exactly one
    // card of its own.
    if (!confirmGuard.hasValidConfirmation()) {
      const confirmed = await askConfirmOrder({
        text: [
          "Your order:",
          ...snap.items.map((i) => `• ${i.name} x${i.quantity} — $${(i.price * i.quantity).toFixed(2)}`),
          `Total: $${snap.total.toFixed(2)}`,
          "Demo order — no payment is taken.",
        ].join("\n"),
      });
      if (!confirmed) return { ok: false, cancelled: true, error: "User cancelled checkout." };
    }
    // Consume the approval so it can never silently cover a later checkout.
    confirmGuard.consumeConfirmation();
    orderCounter += 1;
    // The receipt total always includes the delivery fee: the fee carried
    // in the checkout call wins, otherwise the courier's published base fee.
    const receipt = buildReceipt({
      items: snap.items,
      deliveryFee: resolveDeliveryFee(args, courierFee),
      day: args.day || "Saturday",
      orderId: `AGORA-${String(orderCounter).padStart(4, "0")}`,
    });
    orders.push(receipt);
    cart.clear();
    renderCart();
    renderOrders();
    return { receipt };
  },
};

function renderOrders() {
  const el = $("orders-list");
  el.innerHTML = "";
  if (!orders.length) {
    el.innerHTML = "<li>No orders yet.</li>";
    return;
  }
  for (const o of orders) {
    const li = document.createElement("li");
    li.textContent = `${o.orderId} — ${o.items.map((i) => i.name).join(", ")} — $${o.total.toFixed(2)} (${o.day})`;
    el.appendChild(li);
  }
}

// ---------------------------------------------------------------------------
// Runtime setup
// ---------------------------------------------------------------------------
const SETTINGS_KEY = "agora.router.v1";

function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* ignore */ }
  return { baseUrl: DEFAULT_ROUTER.baseUrl, model: DEFAULT_ROUTER.model, apiKey: "", engine: "llm" };
}

const settings = loadSettings();
const runtime = new AgoraRuntime({
  router: { baseUrl: settings.baseUrl, model: settings.model, apiKey: settings.apiKey || undefined },
  siteActions,
  onTrace: addTrace,
  onConsent: askConsent,
  onConfirm: askConfirmOrder,
  onReply: (text) => addChat("assistant", text),
});
runtime.engine = settings.engine === "local" ? "local" : "llm";

function renderSettings() {
  $("setting-base-url").value = settings.baseUrl;
  $("setting-model").value = settings.model;
  $("setting-api-key").value = settings.apiKey || "";
  $("setting-engine").value = runtime.engine;
  $("engine-status").textContent =
    runtime.engine === "local"
      ? "Engine: local deterministic engine (offline, no LLM call)."
      : `Engine: LLM router ${settings.baseUrl} / ${settings.model}${settings.apiKey ? " (BYOK key set)" : " (no key — free anonymous router)"}. Falls back to the local engine automatically if the router fails or rate-limits.`;
}

$("settings-form").addEventListener("submit", (e) => {
  e.preventDefault();
  settings.baseUrl = $("setting-base-url").value.trim() || DEFAULT_ROUTER.baseUrl;
  settings.model = $("setting-model").value.trim() || DEFAULT_ROUTER.model;
  settings.apiKey = $("setting-api-key").value.trim();
  settings.engine = $("setting-engine").value;
  try {
    // Stored in localStorage, bound to this site's origin. Never sent to any
    // peer site: peer calls are local executions that only read the peer's
    // published network data; the key is only ever attached to requests to
    // the router base URL above.
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch { /* storage unavailable — settings live for this session only */ }
  runtime.setRouter({ baseUrl: settings.baseUrl, model: settings.model, apiKey: settings.apiKey || undefined });
  runtime.engine = settings.engine === "local" ? "local" : "llm";
  renderSettings();
  addChat("assistant", "Model settings saved.");
});

$("settings-reset").addEventListener("click", () => {
  Object.assign(settings, { baseUrl: DEFAULT_ROUTER.baseUrl, model: DEFAULT_ROUTER.model, apiKey: "", engine: "llm" });
  try { localStorage.removeItem(SETTINGS_KEY); } catch { /* ignore */ }
  runtime.setRouter({ baseUrl: settings.baseUrl, model: settings.model, apiKey: undefined });
  runtime.engine = "llm";
  renderSettings();
  addChat("assistant", "Model settings reset to the free default router (no key).");
});

// ---------------------------------------------------------------------------
// Chat + demo + peer loader
// ---------------------------------------------------------------------------
let busy = false;

async function sendUserText(text) {
  if (busy) return;
  busy = true;
  $("send-btn").disabled = true;
  try {
    addChat("user", text);
    const result = await runtime.run(text);
    if (!result.ok) addChat("assistant", `Something went wrong: ${result.error || "unknown error"}`);
  } catch (err) {
    addTrace({ kind: "error", detail: String(err?.message || err) });
    addChat("assistant", `I could not complete that: ${err?.message || err}. Nothing was charged and your cart is unchanged.`);
  } finally {
    busy = false;
    $("send-btn").disabled = false;
  }
}

$("chat-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const input = $("chat-input");
  const text = input.value.trim();
  if (!text) return;
  input.value = "";
  sendUserText(text);
});

$("demo-btn").addEventListener("click", () => {
  sendUserText("I need a birthday cake for 8 people this Saturday, delivered to my home.");
});

$("peer-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const url = $("peer-url").value.trim();
  if (!url) return;
  addTrace({ kind: "peer_load_requested", detail: `User asked to load peer network from ${url}` });
  try {
    const absolute = new URL(url, location.href).toString();
    const peer = await runtime.loadPeerNetwork(absolute);
    addChat("assistant", `Loaded peer network '${peer.name}' from ${peer.origin}. Its agents: ${(peer.network.tools || []).map((t) => t.name).join(", ")}. You can now ask me about delivery.`);
  } catch (err) {
    addTrace({ kind: "error", detail: String(err?.message || err) });
    addChat("assistant", `Could not load that peer network: ${err?.message || err}`);
  }
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
renderProducts();
renderCart();
renderOrders();
renderSettings();

runtime.loadSite()
  .then(() => {
    addChat("assistant", "Welcome to Agora — the open agentic market. I am the Market Concierge. Ask me for a cake, groceries, or delivery, or press \"Run the demo order\". Everything here is demo data; checkout never takes payment.");
    $("demo-btn").disabled = false;
  })
  .catch((err) => {
    addTrace({ kind: "error", detail: String(err?.message || err) });
    addChat("assistant", `The agent network failed to load: ${err?.message || err}. The shop list below still works, but the concierge is unavailable.`);
  });

export { runtime };
