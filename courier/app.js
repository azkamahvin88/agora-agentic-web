// Agora Courier — peer-site wiring for the Agora runtime (runtime.js).
// A standalone agentic site: it loads its own manifest + network, and its
// dispatcher agent answers delivery quotes from the network's published
// delivery table (static demo data). The same network is what the Agora
// market loads as a peer and runs locally in the caller's browser.
// Copyright 2026 Agora contributors — Apache-2.0.

import { AgoraRuntime, DEMO_COURIER_FALLBACK } from "../runtime.js";

const $ = (id) => document.getElementById(id);

// The delivery table comes from this site's own published network metadata
// (courier.network.json). The fallback is only used if the network has not
// loaded yet.
let deliveryTable = DEMO_COURIER_FALLBACK;

function quoteFor(args) {
  const day = args.day || "Saturday";
  const slots = /saturday/i.test(day) ? deliveryTable.saturdaySlots : deliveryTable.weekdaySlots;
  return {
    fee: deliveryTable.baseFee,
    currency: deliveryTable.currency || "USD",
    day,
    slots,
    address: args.address || "home",
    note: "Demo quote from the Agora Courier peer site (static demo data).",
  };
}

const siteActions = {
  async get_delivery_quote(args) {
    return quoteFor(args || {});
  },
  async get_delivery_slots(args) {
    const day = (args || {}).day || "Saturday";
    return {
      day,
      slots: /saturday/i.test(day) ? deliveryTable.saturdaySlots : deliveryTable.weekdaySlots,
    };
  },
};

function addTrace(event) {
  const panel = $("trace-log");
  const div = document.createElement("div");
  div.className = `trace ${event.kind}`;
  const time = (event.time || "").slice(11, 19);
  div.textContent = `${time} ${event.kind} ${event.detail || ""}`;
  panel.appendChild(div);
  panel.scrollTop = panel.scrollHeight;
}

const runtime = new AgoraRuntime({
  siteActions,
  onTrace: addTrace,
  onReply: (text) => { $("quote-result").textContent = text; },
});

$("quote-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const args = { address: $("quote-address").value.trim() || "home", day: $("quote-day").value };
  try {
    // Each form submission is a fresh run, so the per-run budgets restart.
    runtime.callCount = 0;
    runtime.remoteCallCount = 0;
    const out = await runtime.executeToolCall({ tool: "get_delivery_quote", arguments: args }, "courier_dispatcher", 0);
    const q = out.result;
    $("quote-result").textContent =
      `Delivery quote: $${q.fee.toFixed(2)} (${q.currency}), ${q.day} slots: ${q.slots.join(", ")}.`;
  } catch (err) {
    addTrace({ kind: "error", detail: String(err?.message || err) });
    $("quote-result").textContent = `Could not quote delivery: ${err?.message || err}`;
  }
});

runtime.loadSite()
  .then(() => {
    deliveryTable = runtime.network?.metadata?.delivery || DEMO_COURIER_FALLBACK;
    $("delivery-table").textContent =
      `Flat fee $${deliveryTable.baseFee.toFixed(2)} ${deliveryTable.currency || "USD"}. ` +
      `Saturday slots: ${deliveryTable.saturdaySlots.join(", ")}. ` +
      `Weekday slots: ${deliveryTable.weekdaySlots.join(", ")}.`;
    addTrace({ kind: "site_loaded", detail: "Courier network 'courier' loaded (front agent: courier_dispatcher)." });
  })
  .catch((err) => {
    addTrace({ kind: "error", detail: String(err?.message || err) });
    $("delivery-table").textContent = "The courier network failed to load.";
  });

export { runtime };
