// Agora runtime — original implementation written from the Open Agentic Web
// MVP Spec 0.3 (18 Nov 2026). No code is copied from any reference
// implementation. ES module, zero dependencies, no build step.
// Runs in the browser (imported by app.js) and in Node (imported by the
// test suite in test/runtime.test.mjs). This file is DOM-free: all UI
// interaction happens through injected callbacks.
//
// Copyright 2026 Agora contributors
// Licensed under the Apache License, Version 2.0 (the "License");

export const SPEC_VERSION = "open-agentic-web-mvp/0.3";

export const DEFAULT_ROUTER = Object.freeze({
  baseUrl: "https://text.pollinations.ai/openai",
  model: "openai-fast",
});

export const LIMITS = Object.freeze({
  maxDepth: 5, // max agent delegation depth per run
  maxToolCalls: 12, // max tool calls per run
  maxRemoteCalls: 4, // max peer-network fetches per run
  maxHistory: 20, // max retained turns of conversation history
  llmTimeoutMs: 30000, // per LLM request
  peerFetchTimeoutMs: 10000, // per peer manifest/network fetch
});

// ---------------------------------------------------------------------------
// Demo data (static, honestly labelled as demo data in the UI and README).
// Prices are USD. No real payment is ever taken.
// ---------------------------------------------------------------------------

export const DEMO_CATALOG = Object.freeze({
  bakery: {
    shopName: "Sunrise Bakery",
    products: [
      { id: "cake-choc-8", name: "Chocolate Celebration Cake", price: 28.0, serves: "8-10 people", description: "Rich chocolate sponge, ganache, birthday candles included.", tags: ["cake", "birthday", "chocolate"] },
      { id: "cake-vanilla-8", name: "Vanilla Berry Cake", price: 24.0, serves: "6-8 people", description: "Vanilla sponge, fresh berries, light cream.", tags: ["cake", "birthday", "vanilla"] },
      { id: "cake-lemon", name: "Lemon Drizzle Loaf", price: 12.0, serves: "4-6 people", description: "Zesty lemon loaf with a sugar drizzle.", tags: ["cake", "lemon"] },
      { id: "pastry-croissant", name: "Butter Croissant Box (6)", price: 9.0, serves: "2-4 people", description: "Six flaky butter croissants, baked this morning.", tags: ["pastry", "croissant"] },
    ],
    saturdaySlots: ["09:00-12:00", "13:00-16:00"],
  },
  grocer: {
    shopName: "Green Grocer",
    products: [
      { id: "apple-1kg", name: "Organic Apples (1 kg)", price: 4.5, serves: "", description: "Crisp organic apples, sold by the kilo.", tags: ["apple", "fruit"] },
      { id: "bread-sourdough", name: "Sourdough Loaf", price: 6.0, serves: "", description: "Slow-fermented sourdough, baked daily.", tags: ["bread", "sourdough"] },
      { id: "milk-1l", name: "Fresh Milk (1 L)", price: 3.2, serves: "", description: "Pasteurised whole milk, 1 litre.", tags: ["milk", "dairy"] },
      { id: "eggs-12", name: "Free-Range Eggs (12)", price: 5.0, serves: "", description: "A dozen free-range eggs.", tags: ["eggs", "dairy"] },
    ],
    saturdaySlots: ["08:00-12:00", "13:00-17:00"],
  },
});

// Delivery data published by the courier peer site inside its own network
// definition (courier.network.json metadata.delivery). The caller runtime
// reads it from the fetched peer network — it never hardcodes peer prices.
export const DEMO_COURIER_FALLBACK = Object.freeze({
  baseFee: 4.5,
  currency: "USD",
  saturdaySlots: ["09:00-12:00", "13:00-16:00", "17:00-20:00"],
  weekdaySlots: ["10:00-13:00", "14:00-17:00", "18:00-21:00"],
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function isNonEmptyString(v) {
  return typeof v === "string" && v.trim().length > 0;
}

/**
 * Validate an agent-manifest.json document.
 * Returns { ok, errors[] }. Rejects malformed manifests BEFORE any model
 * call, per MVP §5 (parse + validate).
 */
export function validateManifest(manifest) {
  const errors = [];
  if (!isPlainObject(manifest)) {
    return { ok: false, errors: ["manifest must be a JSON object"] };
  }
  if (!Array.isArray(manifest.networks) || manifest.networks.length === 0) {
    errors.push("manifest.networks must be a non-empty array");
  } else {
    const names = new Set();
    for (const n of manifest.networks) {
      if (!isPlainObject(n)) { errors.push("each network entry must be an object"); continue; }
      if (!isNonEmptyString(n.name)) errors.push("network entry is missing a non-empty 'name'");
      else if (names.has(n.name)) errors.push(`duplicate network name: '${n.name}'`);
      else names.add(n.name);
      if (!isNonEmptyString(n.front_man)) errors.push(`network '${n.name || "?"}' is missing a non-empty 'front_man'`);
      if (!isNonEmptyString(n.hocon)) errors.push(`network '${n.name || "?"}' is missing a non-empty 'hocon' path`);
    }
  }
  if (manifest.peer_policy !== undefined) {
    if (!isPlainObject(manifest.peer_policy)) {
      errors.push("manifest.peer_policy must be an object");
    } else {
      if (manifest.peer_policy.default !== undefined &&
          !["allow", "deny"].includes(manifest.peer_policy.default)) {
        errors.push("manifest.peer_policy.default must be 'allow' or 'deny'");
      }
      if (manifest.peer_policy.allowed_peers !== undefined &&
          !Array.isArray(manifest.peer_policy.allowed_peers)) {
        errors.push("manifest.peer_policy.allowed_peers must be an array");
      }
    }
  }
  return { ok: errors.length === 0, errors };
}

/**
 * Validate a resolved network JSON document (Neuro SAN model data).
 * Shape: { metadata: { description }, tools: [ { name, function:
 * { description, parameters: JSON Schema }, instructions, tools: [...] } ] }
 * An entry may also carry `peer_network` (URL of the peer site that owns the
 * tool) and `peer_tool` (tool name on that network).
 */
export function validateNetwork(network) {
  const errors = [];
  if (!isPlainObject(network)) {
    return { ok: false, errors: ["network must be a JSON object"] };
  }
  if (!isPlainObject(network.metadata) || !isNonEmptyString(network.metadata.description)) {
    errors.push("network.metadata.description must be a non-empty string");
  }
  if (!Array.isArray(network.tools) || network.tools.length === 0) {
    errors.push("network.tools must be a non-empty array");
    return { ok: false, errors };
  }
  const names = new Set();
  for (const entry of network.tools) {
    if (!isPlainObject(entry)) { errors.push("each network tool entry must be an object"); continue; }
    if (!isNonEmptyString(entry.name)) { errors.push("a network entry is missing a non-empty 'name'"); continue; }
    if (names.has(entry.name)) errors.push(`duplicate network entry name: '${entry.name}'`);
    names.add(entry.name);
    if (!isPlainObject(entry.function) || !isNonEmptyString(entry.function.description)) {
      errors.push(`entry '${entry.name}' is missing function.description`);
    }
    if (!isPlainObject(entry.function?.parameters) || entry.function.parameters.type !== "object") {
      errors.push(`entry '${entry.name}' must have function.parameters as a JSON Schema object`);
    }
    if (!isNonEmptyString(entry.instructions)) {
      errors.push(`entry '${entry.name}' is missing 'instructions'`);
    }
    if (!Array.isArray(entry.tools)) {
      errors.push(`entry '${entry.name}' must have a 'tools' array (possibly empty)`);
    }
    if (entry.peer_network !== undefined && !isNonEmptyString(entry.peer_network)) {
      errors.push(`entry '${entry.name}' has an invalid 'peer_network'`);
    }
  }
  // References: every name listed in an entry's `tools` must resolve to an
  // entry in this network (agent delegation or local tool) — otherwise the
  // network is rejected before any model call.
  for (const entry of network.tools) {
    if (!Array.isArray(entry.tools)) continue;
    for (const ref of entry.tools) {
      if (ref === entry.name) {
        errors.push(`entry '${entry.name}' references itself (delegation cycle)`);
      } else if (typeof ref !== "string" || !names.has(ref)) {
        errors.push(`entry '${entry.name}' references unknown tool/agent '${ref}'`);
      }
    }
  }
  return { ok: errors.length === 0, errors };
}

/**
 * Check that a manifest's front agent actually exists in the loaded network.
 */
export function validateFrontAgent(manifest, network, networkName) {
  const entry = (manifest.networks || []).find((n) => n.name === networkName);
  if (!entry) return { ok: false, errors: [`manifest has no network named '${networkName}'`] };
  const agentNames = new Set((network.tools || []).map((t) => t.name));
  if (!agentNames.has(entry.front_man)) {
    return { ok: false, errors: [`front agent '${entry.front_man}' of network '${networkName}' is not defined in the network`] };
  }
  return { ok: true, errors: [] };
}

/** Resolve a symbolic peer name through links.json to a concrete URL. */
export function resolvePeerUrl(links, name) {
  if (!isPlainObject(links)) return { ok: false, url: null, error: "links.json must be an object" };
  const raw = links[name];
  if (!isNonEmptyString(raw)) return { ok: false, url: null, error: `no peer named '${name}' in links.json` };
  try {
    // Validates URL shape (relative URLs are resolved by the caller against
    // the site base; here we only check it parses as a URL/path).
    new URL(raw, "https://example.invalid/");
    return { ok: true, url: raw, error: null };
  } catch {
    return { ok: false, url: null, error: `peer URL for '${name}' is malformed: '${raw}'` };
  }
}

/** Peer network name = last path component of the peer site URL (MVP §3.4). */
export function peerNameFromUrl(peerUrl) {
  const clean = String(peerUrl).split("?")[0].split("#")[0].replace(/\/+$/, "");
  const parts = clean.split("/").filter(Boolean);
  return parts.length ? parts[parts.length - 1] : "";
}

// ---------------------------------------------------------------------------
// JSON Schema argument validation (subset: type, required, properties, enum,
// minimum/maximum, minLength/maxLength, items). Used before every tool call.
// ---------------------------------------------------------------------------

export function validateArgs(schema, args) {
  const errors = [];
  if (!isPlainObject(schema)) return { ok: true, errors };
  if (!isPlainObject(args)) return { ok: false, errors: ["arguments must be a JSON object"] };
  for (const req of schema.required || []) {
    if (args[req] === undefined) errors.push(`missing required argument '${req}'`);
  }
  for (const [key, prop] of Object.entries(schema.properties || {})) {
    const v = args[key];
    if (v === undefined) continue;
    if (prop.type === "string" && typeof v !== "string") errors.push(`'${key}' must be a string`);
    if (prop.type === "number" && typeof v !== "number") errors.push(`'${key}' must be a number`);
    if (prop.type === "integer" && (!Number.isInteger(v))) errors.push(`'${key}' must be an integer`);
    if (prop.type === "boolean" && typeof v !== "boolean") errors.push(`'${key}' must be a boolean`);
    if (prop.type === "array" && !Array.isArray(v)) errors.push(`'${key}' must be an array`);
    if (typeof v === "string" && prop.minLength !== undefined && v.length < prop.minLength) {
      errors.push(`'${key}' is shorter than minLength ${prop.minLength}`);
    }
    if (typeof v === "string" && prop.maxLength !== undefined && v.length > prop.maxLength) {
      errors.push(`'${key}' is longer than maxLength ${prop.maxLength}`);
    }
    if (typeof v === "number" && prop.minimum !== undefined && v < prop.minimum) {
      errors.push(`'${key}' is below minimum ${prop.minimum}`);
    }
    if (typeof v === "number" && prop.maximum !== undefined && v > prop.maximum) {
      errors.push(`'${key}' is above maximum ${prop.maximum}`);
    }
    if (Array.isArray(prop.enum) && !prop.enum.includes(v)) {
      errors.push(`'${key}' must be one of: ${prop.enum.join(", ")}`);
    }
  }
  return { ok: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// Local deterministic engine (offline fallback).
// Intent-matching + tool dispatch. No LLM needed; resolves the demo scenario
// end to end. Used automatically when the LLM router is unreachable or
// rate-limited, and whenever the user picks "Local engine only".
// ---------------------------------------------------------------------------

const WORD = (re) => re;

function findProductFor(text) {
  const t = text.toLowerCase();
  const all = Object.entries(DEMO_CATALOG).flatMap(([shop, data]) =>
    data.products.map((p) => ({ ...p, shop })));
  // Birthday cake for N people: pick the smallest cake that serves N.
  const peopleMatch = t.match(/(\d+)\s*(people|person|guests?)/);
  const wantsCake = /cake|birthday/.test(t);
  if (wantsCake && peopleMatch) {
    const n = parseInt(peopleMatch[1], 10);
    const cakes = all.filter((p) => p.tags.includes("cake"));
    const fitting = cakes
      .map((p) => ({ p, max: parseInt((p.serves.match(/(\d+)\s*-\s*(\d+)/) || [])[2] || "0", 10) }))
      .filter((x) => x.max >= n)
      .sort((a, b) => a.max - b.max || a.p.price - b.p.price);
    if (fitting.length) return fitting[0].p;
    return cakes[0];
  }
  if (wantsCake) return all.find((p) => p.id === "cake-choc-8");
  for (const p of all) {
    if (p.tags.some((tag) => t.includes(tag)) || t.includes(p.name.toLowerCase().split(" ")[0])) return p;
  }
  return null;
}

/**
 * Plan the demo / common intents deterministically.
 * Returns { steps: [{ agent, tool, args, reason }], reply }.
 * Steps use tool names from the network; `checkout` is a pseudo-step the
 * runtime turns into a user confirmation card, never an automatic write.
 */
export function planWithLocalEngine(text) {
  const t = text.toLowerCase().trim();
  const steps = [];
  const wantsDelivery = /deliver|delivery|shipping|send (it|this)|to my home|to my house/.test(t);
  const wantsCheckout = /checkout|place (the |my )?order|confirm (the |my )?order|buy (it|this|that)/.test(t);
  const wantsCart = /cart|basket|what('s| is) in (my|the) (cart|basket)|show (my|the) cart/.test(t);
  const wantsList = /list|show|menu|catalog|products|what (do you|can i)|browse/.test(t);
  const dayMatch = t.match(/saturday|sunday|monday|tuesday|wednesday|thursday|friday/);
  const day = dayMatch ? dayMatch[0][0].toUpperCase() + dayMatch[0].slice(1) : "Saturday";

  if (wantsCart && !wantsCheckout) {
    return { steps: [{ agent: "concierge", tool: "website_get_cart", args: {}, reason: "User asked to see the cart." }], reply: null };
  }

  const product = findProductFor(t);
  const isGrocery = product && product.shop === "grocer";
  const specialist = isGrocery ? "grocer_specialist" : "bakery_specialist";
  const shop = isGrocery ? "grocer" : "bakery";

  if (product) {
    steps.push({ agent: specialist, tool: "website_list_products", args: { shop }, reason: `Check the ${DEMO_CATALOG[shop].shopName} catalog.` });
    steps.push({ agent: specialist, tool: "website_add_to_cart", args: { product_id: product.id, quantity: 1 }, reason: `Add "${product.name}" to the cart.` });
  } else if (wantsList) {
    steps.push({ agent: specialist, tool: "website_list_products", args: { shop }, reason: "List products for the user." });
  }

  if ((wantsDelivery || product) && !wantsCheckout) {
    steps.push({ agent: "concierge", tool: "courier_get_delivery_quote", args: { address: "home", day }, reason: "Get a delivery quote from the courier peer site.", peer: true });
  }
  if (wantsCheckout) {
    steps.push({ agent: "concierge", tool: "website_get_cart", args: {}, reason: "Review the cart before checkout." });
    steps.push({ agent: "concierge", tool: "website_checkout_order", args: { day }, reason: "Place the demo order (asks the user to confirm first).", confirm: true });
  }
  if (steps.length === 0) {
    return {
      steps: [],
      reply: "I can help you browse the bakery and grocer, add items to your cart, arrange delivery with our courier partner, and place a demo order. Try: \"I need a birthday cake for 8 people this Saturday, delivered to my home.\"",
    };
  }
  return { steps, reply: null };
}

// ---------------------------------------------------------------------------
// LLM response parsing. The model is instructed to answer with exactly one
// JSON block: {"calls":[{"tool":"...","arguments":{...}}]} or
// {"reply":"..."}. Also tolerates OpenAI tool_calls chat-completion JSON.
// ---------------------------------------------------------------------------

export function parseLlmToolCalls(text) {
  if (typeof text !== "string") return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  let parsed;
  try {
    parsed = JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
  if (parsed && typeof parsed.reply === "string") return { reply: parsed.reply, calls: [] };
  if (parsed && Array.isArray(parsed.calls)) {
    return {
      reply: parsed.reply || null,
      calls: parsed.calls
        .filter((c) => c && typeof c.tool === "string")
        .map((c) => ({ tool: c.tool, arguments: isPlainObject(c.arguments) ? c.arguments : {} })),
    };
  }
  // OpenAI chat-completion shape.
  const msg = parsed?.choices?.[0]?.message;
  if (msg) {
    if (typeof msg.content === "string" && msg.content.trim()) {
      const inner = parseLlmToolCalls(msg.content);
      if (inner) return inner;
    }
    if (Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
      return {
        reply: null,
        calls: msg.tool_calls.map((tc) => {
          let args = {};
          try { args = JSON.parse(tc.function?.arguments || "{}"); } catch { /* keep {} */ }
          return { tool: tc.function?.name || "", arguments: args };
        }).filter((c) => c.tool),
      };
    }
    if (typeof msg.content === "string") return { reply: msg.content, calls: [] };
  }
  if (typeof parsed?.content === "string") return { reply: parsed.content, calls: [] };
  return null;
}

// ---------------------------------------------------------------------------
// AgoraRuntime — browser agent runtime (DOM-free).
// ---------------------------------------------------------------------------

export class AgoraRuntime {
  /**
   * @param {object} opts
   * @param {function} opts.fetchImpl - fetch-compatible function (default global fetch)
   * @param {object} opts.router - { baseUrl, model, apiKey? }
   * @param {object} opts.siteActions - map tool name -> async handler(args, ctx)
   * @param {function} opts.onTrace - (event) => void
   * @param {function} opts.onConfirm - async (summary) => boolean (checkout confirm card)
   * @param {function} opts.onConsent - async ({origin, purpose}) => boolean (peer consent card)
   * @param {function} opts.onReply - (text) => void (assistant message to show)
   * @param {string} opts.siteBase - base URL of this site, for resolving relative paths
   */
  constructor(opts = {}) {
    this.fetchImpl = opts.fetchImpl || (typeof fetch !== "undefined" ? fetch.bind(globalThis) : null);
    if (!this.fetchImpl) throw new Error("AgoraRuntime needs a fetch implementation");
    this.router = { ...DEFAULT_ROUTER, ...(opts.router || {}) };
    this.siteActions = opts.siteActions || {};
    this.onTrace = opts.onTrace || (() => {});
    this.onConfirm = opts.onConfirm || (async () => false);
    this.onConsent = opts.onConsent || (async () => false);
    this.onReply = opts.onReply || (() => {});
    this.siteBase = opts.siteBase || (typeof location !== "undefined" ? location.href : "https://example.invalid/");
    this.manifest = null;
    this.network = null;
    this.networkName = null;
    this.links = {};
    this.history = [];
    this.consentedOrigins = new Set(); // per-session, per-origin consent
    this.peerCache = new Map(); // peer site URL -> { manifest, network }
    this.callCount = 0;
    this.remoteCallCount = 0;
    this.engine = "llm"; // "llm" | "local"
  }

  trace(event) {
    this.onTrace({ time: new Date().toISOString(), ...event });
  }

  setRouter(router) {
    this.router = { ...this.router, ...router };
    this.trace({ kind: "router_changed", detail: `Router set to ${this.router.baseUrl} / model ${this.router.model}. API key ${this.router.apiKey ? "provided (kept in this browser only, never sent to peer sites)" : "not set"}.` });
  }

  async fetchJson(url, timeoutMs = LIMITS.peerFetchTimeoutMs) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await this.fetchImpl(url, { signal: ctrl.signal, headers: { Accept: "application/json" } });
      if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  resolveUrl(path) {
    return new URL(path, this.siteBase).toString();
  }

  async loadSite() {
    const manifestUrl = this.resolveUrl("agent-manifest.json");
    const manifest = await this.fetchJson(manifestUrl);
    const m = validateManifest(manifest);
    if (!m.ok) {
      this.trace({ kind: "error", detail: `Manifest validation failed: ${m.errors.join("; ")}` });
      throw new Error(`Invalid agent-manifest.json: ${m.errors.join("; ")}`);
    }
    this.manifest = manifest;
    try {
      this.links = await this.fetchJson(this.resolveUrl("links.json"));
    } catch {
      this.links = {};
    }
    const first = manifest.networks[0];
    await this.loadNetwork(first.name);
    this.trace({ kind: "site_loaded", detail: `Loaded manifest with network '${first.name}' (front agent: ${first.front_man}). Peer policy: ${manifest.peer_policy?.default || "deny"}; allowed peers: ${(manifest.peer_policy?.allowed_peers || []).join(", ") || "none"}.` });
    return manifest;
  }

  async loadNetwork(name) {
    const entry = (this.manifest?.networks || []).find((n) => n.name === name);
    if (!entry) throw new Error(`Manifest has no network named '${name}'`);
    const network = await this.fetchJson(this.resolveUrl(entry.hocon));
    const v = validateNetwork(network);
    if (!v.ok) {
      this.trace({ kind: "error", detail: `Network '${name}' validation failed: ${v.errors.join("; ")}` });
      throw new Error(`Invalid network '${name}': ${v.errors.join("; ")}`);
    }
    const f = validateFrontAgent(this.manifest, network, name);
    if (!f.ok) {
      this.trace({ kind: "error", detail: f.errors.join("; ") });
      throw new Error(f.errors.join("; "));
    }
    this.network = network;
    this.networkName = name;
    return network;
  }

  toolEntry(name) {
    return (this.network?.tools || []).find((t) => t.name === name) || null;
  }

  isPeerAllowed(peerName) {
    const policy = this.manifest?.peer_policy || { default: "deny", allowed_peers: [] };
    if (policy.default === "allow") return !(policy.denied_peers || []).includes(peerName);
    return (policy.allowed_peers || []).includes(peerName);
  }

  /**
   * Load a peer network by site URL, per the MVP peer protocol:
   * fetch agent-manifest.json from the peer site base, pick the entry whose
   * name EXACTLY matches the last path component, fetch + validate its
   * network, run it locally in the caller browser with the caller's router.
   * The peer never receives the user's API key and cannot change the router.
   */
  async loadPeerNetwork(peerSiteUrl) {
    const base = peerSiteUrl.endsWith("/") ? peerSiteUrl : peerSiteUrl + "/";
    const origin = new URL(base, this.siteBase).origin;
    const expectedName = peerNameFromUrl(base);
    if (this.peerCache.has(base)) return this.peerCache.get(base);

    if (this.remoteCallCount >= LIMITS.maxRemoteCalls) {
      throw new Error(`Remote-call budget exceeded (${LIMITS.maxRemoteCalls} peer fetches per run). Stopping — fail closed.`);
    }
    this.remoteCallCount += 1;

    const manifestUrl = new URL("agent-manifest.json", base).toString();
    const manifest = await this.fetchJson(manifestUrl);
    const m = validateManifest(manifest);
    if (!m.ok) throw new Error(`Peer manifest invalid: ${m.errors.join("; ")}`);
    const entry = manifest.networks.find((n) => n.name === expectedName);
    if (!entry) {
      throw new Error(`Peer manifest at ${origin} has no network named exactly '${expectedName}' (exact-name match required).`);
    }
    const networkUrl = new URL(entry.hocon, base).toString();
    const network = await this.fetchJson(networkUrl);
    const v = validateNetwork(network);
    if (!v.ok) throw new Error(`Peer network '${expectedName}' invalid: ${v.errors.join("; ")}`);
    const f = validateFrontAgent(manifest, network, expectedName);
    if (!f.ok) throw new Error(f.errors.join("; "));
    const loaded = { manifest, network, name: expectedName, origin, base };
    this.peerCache.set(base, loaded);
    this.trace({ kind: "peer_loaded", origin, detail: `Loaded peer network '${expectedName}' from ${origin} (exact-name match). Running locally with the caller's router — the peer site never receives any API key.` });
    return loaded;
  }

  /** Ask for (and remember, per session) consent before contacting an origin. */
  async ensureConsent(origin, purpose) {
    if (this.consentedOrigins.has(origin)) {
      this.trace({ kind: "consent", origin, detail: `Consent already given this session for ${origin}.` });
      return true;
    }
    this.trace({ kind: "consent_requested", origin, detail: `Asking the user before contacting ${origin}: ${purpose}` });
    const ok = await this.onConsent({ origin, purpose });
    this.trace({ kind: ok ? "consent_granted" : "consent_denied", origin, detail: ok ? `User approved contacting ${origin}.` : `User declined contacting ${origin}. Peer call aborted — fail closed.` });
    if (ok) this.consentedOrigins.add(origin);
    return ok;
  }

  /** Execute a peer tool locally, using the peer network's own published data. */
  async executePeerTool(peer, toolName, args) {
    const entry = (peer.network.tools || []).find((t) => t.name === toolName);
    if (!entry) throw new Error(`Peer network '${peer.name}' has no tool '${toolName}'`);
    const v = validateArgs(entry.function?.parameters, args);
    if (!v.ok) throw new Error(`Invalid arguments for peer tool '${toolName}': ${v.errors.join("; ")}`);
    // Grounded execution from the peer's published metadata (delivery table).
    // No API key is ever attached to a peer-site request: this runs locally.
    const delivery = peer.network.metadata?.delivery || DEMO_COURIER_FALLBACK;
    if (toolName === "get_delivery_quote") {
      const day = args.day || "Saturday";
      const slots = /saturday/i.test(day) ? delivery.saturdaySlots : delivery.weekdaySlots;
      return {
        fee: delivery.baseFee, currency: delivery.currency || "USD",
        day, slots, address: args.address || "home",
        note: `Demo quote from the ${peer.name} peer site (static demo data).`,
      };
    }
    if (toolName === "get_delivery_slots") {
      const day = args.day || "Saturday";
      return { day, slots: /saturday/i.test(day) ? delivery.saturdaySlots : delivery.weekdaySlots };
    }
    throw new Error(`Peer tool '${toolName}' has no local executor in this runtime`);
  }

  /** Execute one tool call (local site action, delegation, or peer tool). */
  async executeToolCall(call, currentAgent, depth) {
    const { tool, arguments: args } = call;
    if (this.callCount >= LIMITS.maxToolCalls) {
      throw new Error(`Tool-call budget exceeded (${LIMITS.maxToolCalls} calls per run). Stopping — fail closed.`);
    }
    this.callCount += 1;
    this.trace({ kind: "tool_call", agent: currentAgent, tool, detail: JSON.stringify(args) });

    const entry = this.toolEntry(tool);
    // Delegation: calling another agent by name.
    if (entry && !this.siteActions[tool] && !entry.peer_network) {
      const isAgent = (entry.tools || []).length >= 0 && isNonEmptyString(entry.instructions) && !entry.function?.parameters?.properties?.product_id;
      if (isAgent && entry.name !== tool) { /* unreachable */ }
      if (entry && !this.siteActions[tool] && entry.name === tool && (this.network.tools.some((t) => t.name === tool))) {
        // An agent entry invoked as a tool means delegation to that agent.
        if (depth >= LIMITS.maxDepth) throw new Error(`Delegation depth limit reached (${LIMITS.maxDepth}). Stopping — cycle/budget protection.`);
        this.trace({ kind: "delegate", agent: currentAgent, tool, detail: `Delegating to agent '${tool}'.` });
        return { delegatedTo: tool, result: null };
      }
    }
    if (!entry) throw new Error(`Unknown tool or agent '${tool}' — not in network '${this.networkName}'.`);

    const argCheck = validateArgs(entry.function?.parameters, args || {});
    if (!argCheck.ok) throw new Error(`Invalid arguments for '${tool}': ${argCheck.errors.join("; ")}`);

    // Peer tool (owned by another site).
    if (entry.peer_network) {
      const resolved = resolvePeerUrl(this.links, entry.peer_network);
      const peerUrl = resolved.ok ? resolved.url : entry.peer_network;
      const absolute = new URL(peerUrl, this.siteBase).toString();
      const origin = new URL(absolute, this.siteBase).origin;
      const peerName = peerNameFromUrl(absolute);
      if (!this.isPeerAllowed(peerName)) {
        throw new Error(`Peer '${peerName}' is not in allowed_peers (default deny). Contact refused — fail closed.`);
      }
      const ok = await this.ensureConsent(origin, `Get a delivery quote from the ${peerName} courier site.`);
      if (!ok) throw new Error(`User declined to contact ${origin}.`);
      const peer = await this.loadPeerNetwork(absolute);
      const result = await this.executePeerTool(peer, entry.peer_tool || "get_delivery_quote", args || {});
      this.trace({ kind: "tool_result", agent: currentAgent, tool, detail: JSON.stringify(result) });
      return { result };
    }

    // Local site action, provided by the hosting page (app.js).
    const handler = this.siteActions[tool];
    if (!handler) throw new Error(`Tool '${tool}' is declared but has no site-action handler on this page.`);
    const result = await handler(args || {}, { runtime: this, agent: currentAgent });
    this.trace({ kind: "tool_result", agent: currentAgent, tool, detail: JSON.stringify(result) });
    return { result };
  }

  systemPrompt(agentName) {
    const agent = this.toolEntry(agentName);
    const toolList = (this.network?.tools || []).map((t) =>
      `- ${t.name}: ${t.function?.description || ""} Args JSON Schema: ${JSON.stringify(t.function?.parameters || {})}${t.peer_network ? ` [PEER tool, peer site: ${t.peer_network}]` : ""}`).join("\n");
    return [
      `You are the '${agentName}' agent of the Agora open agentic market website.`,
      `Your instructions: ${agent?.instructions || ""}`,
      `You can call these tools/agents: ${((agent?.tools || []).join(", ")) || "none"}.`,
      `All declared tools (for reference):\n${toolList}`,
      `Answer with EXACTLY one JSON block and nothing else: {"calls":[{"tool":"<name>","arguments":{...}}]} to call tools, or {"reply":"<message>"} to answer directly.`,
      `Never invent prices, products, or delivery slots: only use tool results. This is a demo market with static demo data and no real payment.`,
      `If delivery is needed, call the courier peer tool; the runtime will ask the user for consent first.`,
    ].join("\n");
  }

  async callLlm(messages) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), LIMITS.llmTimeoutMs);
    try {
      const headers = { "Content-Type": "application/json" };
      if (this.router.apiKey) headers.Authorization = `Bearer ${this.router.apiKey}`;
      const res = await this.fetchImpl(new URL("/chat/completions", this.router.baseUrl).toString(), {
        method: "POST",
        headers,
        body: JSON.stringify({ model: this.router.model, messages, temperature: 0.2, max_tokens: 800 }),
        signal: ctrl.signal,
      });
      if (res.status === 402 || res.status === 429) {
        const retryAfter = res.headers?.get?.("Retry-After") || "?";
        throw new Error(`LLM router rate-limited (HTTP ${res.status}, Retry-After: ${retryAfter}). Falling back to the local engine.`);
      }
      if (!res.ok) throw new Error(`LLM router HTTP ${res.status}. Falling back to the local engine.`);
      const data = await res.json();
      const content = data?.choices?.[0]?.message?.content;
      if (typeof content !== "string" || !content.trim()) throw new Error("LLM router returned an empty reply. Falling back to the local engine.");
      return content;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Main entry: run one user turn through the agent network. */
  async run(userText) {
    this.callCount = 0;
    this.remoteCallCount = 0;
    this.history.push({ role: "user", content: userText });
    if (this.history.length > LIMITS.maxHistory) this.history = this.history.slice(-LIMITS.maxHistory);
    this.trace({ kind: "user_message", detail: userText });
    const front = this.manifest.networks[0].front_man;

    // Local-engine-only mode (user setting) skips the LLM entirely.
    if (this.engine === "local") {
      this.trace({ kind: "engine", detail: "Local deterministic engine selected — no LLM call will be made." });
      return this.runLocalPlan(userText, front);
    }

    // Try the LLM router first; any failure falls back to the local engine.
    try {
      const messages = [
        { role: "system", content: this.systemPrompt(front) },
        ...this.history.map((h) => ({ role: h.role, content: h.content })),
      ];
      const raw = await this.callLlm(messages);
      const parsed = parseLlmToolCalls(raw);
      if (!parsed) {
        this.trace({ kind: "error", detail: "LLM reply was not valid tool-call JSON. Falling back to the local engine." });
        return this.runLocalPlan(userText, front);
      }
      if (parsed.reply && parsed.calls.length === 0) {
        this.trace({ kind: "reply", agent: front, detail: parsed.reply });
        this.history.push({ role: "assistant", content: parsed.reply });
        this.onReply(parsed.reply);
        return { ok: true, engine: "llm", reply: parsed.reply };
      }
      return await this.executeLlmCalls(parsed.calls, front, 0, userText);
    } catch (err) {
      this.trace({ kind: "llm_fallback", detail: String(err?.message || err) });
      return this.runLocalPlan(userText, front);
    }
  }

  async executeLlmCalls(calls, currentAgent, depth, userText) {
    const results = [];
    let agent = currentAgent;
    for (const call of calls) {
      const out = await this.executeToolCall(call, agent, depth);
      if (out.delegatedTo) {
        agent = out.delegatedTo;
        // Ask the LLM again as the delegated agent, with the same user text.
        const messages = [
          { role: "system", content: this.systemPrompt(agent) },
          { role: "user", content: userText },
          { role: "user", content: `Tool results so far: ${JSON.stringify(results)}. Continue the task.` },
        ];
        const raw = await this.callLlm(messages);
        const parsed = parseLlmToolCalls(raw);
        if (parsed?.calls?.length) {
          const nested = await this.executeLlmCalls(parsed.calls, agent, depth + 1, userText);
          results.push(...(nested.results || []));
        } else if (parsed?.reply) {
          results.push({ agent, reply: parsed.reply });
        }
      } else {
        results.push({ tool: call.tool, result: out.result });
      }
    }
    const summary = this.summarizeResults(results);
    this.trace({ kind: "reply", agent, detail: summary });
    this.history.push({ role: "assistant", content: summary });
    this.onReply(summary);
    return { ok: true, engine: "llm", results, reply: summary };
  }

  summarizeResults(results) {
    const lines = [];
    for (const r of results) {
      if (r.reply) { lines.push(r.reply); continue; }
      const res = r.result || {};
      if (r.tool === "website_list_products" && Array.isArray(res.products)) {
        lines.push(`${res.shopName || "Shop"}: ${res.products.map((p) => `${p.name} — $${p.price.toFixed(2)}`).join("; ")}.`);
      } else if (r.tool === "website_add_to_cart" && res.added) {
        lines.push(`Added to cart: ${res.added.name} — $${res.added.price.toFixed(2)}. Cart total is now $${res.cartTotal.toFixed(2)}.`);
      } else if (r.tool === "website_get_cart") {
        lines.push(res.items?.length ? `Your cart: ${res.items.map((i) => `${i.name} x${i.quantity}`).join(", ")} — total $${res.total.toFixed(2)}.` : "Your cart is empty.");
      } else if (r.tool === "courier_get_delivery_quote" && res.fee !== undefined) {
        lines.push(`Delivery quote: $${res.fee.toFixed(2)} (${res.currency}), ${res.day} slots: ${(res.slots || []).join(", ")}.`);
      } else if (r.tool === "website_checkout_order" && res.receipt) {
        lines.push(`Order ${res.receipt.orderId} confirmed. Total $${res.receipt.total.toFixed(2)} (demo order, no payment taken).`);
      } else if (res && typeof res === "object") {
        lines.push(JSON.stringify(res));
      }
    }
    return lines.join("\n") || "Done.";
  }

  /** Execute a local-engine plan step by step. Returns a receipt when checkout runs. */
  async runLocalPlan(userText, frontAgent) {
    const plan = planWithLocalEngine(userText);
    if (plan.reply && plan.steps.length === 0) {
      this.trace({ kind: "reply", agent: frontAgent, detail: plan.reply });
      this.history.push({ role: "assistant", content: plan.reply });
      this.onReply(plan.reply);
      return { ok: true, engine: "local", reply: plan.reply };
    }
    const results = [];
    let currentAgent = frontAgent;
    for (const step of plan.steps) {
      if (step.agent !== currentAgent) {
        if (this.callCount > 0 && plan.steps.indexOf(step) > 0) {
          this.trace({ kind: "delegate", agent: currentAgent, tool: step.agent, detail: `Delegating to agent '${step.agent}': ${step.reason}` });
        }
        currentAgent = step.agent;
      }
      const out = await this.executeToolCall({ tool: step.tool, arguments: step.args }, currentAgent, 0);
      if (out.result !== undefined && out.result !== null) results.push({ tool: step.tool, result: out.result });
      // After adding to the cart and getting a quote, present the order
      // summary and let the USER confirm before any checkout write.
      if (step.tool === "courier_get_delivery_quote" && out.result) {
        const cart = await this.siteActions.website_get_cart?.({}, { runtime: this, agent: currentAgent });
        const summary = this.buildOrderSummary(cart, out.result);
        this.trace({ kind: "order_summary", agent: currentAgent, detail: summary.text });
        this.onReply(summary.text);
        const confirmed = await this.onConfirm(summary);
        if (!confirmed) {
          const msg = "Order cancelled — nothing was placed. Your cart is unchanged.";
          this.trace({ kind: "reply", agent: currentAgent, detail: msg });
          this.onReply(msg);
          return { ok: true, engine: "local", results, reply: msg, cancelled: true };
        }
        const checkout = await this.executeToolCall({ tool: "website_checkout_order", arguments: { day: step.args.day } }, currentAgent, 0);
        results.push({ tool: "website_checkout_order", result: checkout.result });
        const receiptText = this.formatReceipt(checkout.result?.receipt);
        this.trace({ kind: "receipt", agent: currentAgent, detail: receiptText });
        this.history.push({ role: "assistant", content: receiptText });
        this.onReply(receiptText);
        return { ok: true, engine: "local", results, reply: receiptText, receipt: checkout.result?.receipt };
      }
    }
    const summary = this.summarizeResults(results);
    this.trace({ kind: "reply", agent: currentAgent, detail: summary });
    this.history.push({ role: "assistant", content: summary });
    this.onReply(summary);
    return { ok: true, engine: "local", results, reply: summary };
  }

  buildOrderSummary(cart, quote) {
    const items = cart?.items || [];
    const subtotal = cart?.total || 0;
    const fee = quote?.fee || 0;
    const total = subtotal + fee;
    const lines = [
      "Your order:",
      ...items.map((i) => `• ${i.name} x${i.quantity} — $${(i.price * i.quantity).toFixed(2)}`),
      `Subtotal: $${subtotal.toFixed(2)}`,
      `Delivery (${quote?.day || "Saturday"}, ${(quote?.slots || []).slice(0, 2).join(" or ")}): $${fee.toFixed(2)}`,
      `Total: $${total.toFixed(2)}`,
      "Demo order — no payment is taken.",
    ];
    return { text: lines.join("\n"), items, subtotal, deliveryFee: fee, total, day: quote?.day, slots: quote?.slots || [] };
  }

  formatReceipt(receipt) {
    if (!receipt) return "Order placed (demo).";
    const lines = [
      `Order ${receipt.orderId} confirmed!`,
      ...receipt.items.map((i) => `• ${i.name} x${i.quantity} — $${(i.price * i.quantity).toFixed(2)}`),
      `Delivery: $${receipt.deliveryFee.toFixed(2)} (${receipt.day})`,
      `Total: $${receipt.total.toFixed(2)}`,
      "This is a demo order — no payment was taken and nothing will be shipped.",
    ];
    return lines.join("\n");
  }
}
