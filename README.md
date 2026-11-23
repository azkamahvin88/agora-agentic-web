# Agora — The Open Agentic Market

An open agentic market where independent shops publish agent-readable
storefronts that any agent can discover, call, and order from, right in the
browser. Built for the **Open Agentic Web Challenge 2026** (Cognizant,
Devpost) against **MVP Spec 0.3** (18 Nov 2026).

Live site: https://azkamahvin88.github.io/agora-agentic-web/

## The problem

A customer's AI assistant cannot find small independent shops: there is no
standard way for a bakery, a grocer, or a local courier to publish "this is
what I sell, this is the price, this is how to order from me" in a format
any agent can read. Discovery today belongs to big platforms. Small shops
stay invisible to agents, and customers cannot order through their agents.

Agora gives every small shop an **agent storefront** — `agent-manifest.json`
+ network JSON + a browser runtime — on their own static site, discoverable
through a public registry and callable by any agent. No server, no LLM bill
for the shop (visitors bring their own router/key).

## What is in this repo

Three agentic sites that call each other, plus a registry:

1. **Agora Market** (`index.html`, `app.js`) — the market with front agent
   `Market Concierge`. Local agents: `concierge`, `bakery_specialist`,
   `grocer_specialist`. Grounded site actions on the page itself:
   `website_list_products`, `website_add_to_cart`, `website_get_cart`,
   `website_checkout_order` (demo checkout: user confirms first, then a
   receipt; no real payment). Peer: the `courier` network (see below).
2. **Courier peer site** (`courier/`) — a standalone agentic site with its
   own manifest + network. Its `courier_dispatcher` quotes delivery fees and
   slots from published static data. Proves cross-site interop.
3. **Public registry** (`registry.json` + `registry/index.html`) — a
   NANDA-style discovery list (identifier → manifest URL + capabilities),
   plus "Add your shop" instructions.
4. **Shop template** (`shops/template/`) — copy it to publish your own
   agent storefront.

Plus an **original zero-dependency browser runtime** (`runtime.js`, ES
modules, no build step): manifest/network parse + validation, agent loop
(streaming, tool calls, delegation), MCP-style tool dispatch, site actions
with user confirmation, peer loading + per-origin consent, execution limits
(depth / calls / remote calls / time), fail-closed errors, and a trace panel
showing every agent/tool call, contacted origin, and consent decision.

**Inference is pluggable.** Default: a free anonymous OpenAI-compatible
router (`POST https://text.pollinations.ai/openai`, model `openai-fast`, no
API key). If it is unreachable or rate-limited, the site falls back
automatically to a local deterministic engine that completes the demo
scenario offline. The "AI model settings" panel supports BYOK with any
OpenAI-compatible router (Otari, OpenRouter, OpenAI): the key is stored in
the visitor's browser only and is never sent to any peer site. Peers inherit
the caller's router.

## Demo scenario (under 2 minutes, no key needed)

Visitor opens Agora and writes:

> "I need a birthday cake for 8 people this Saturday, delivered to my home."

1. `concierge` parses the request → delegates to `bakery_specialist`.
2. Bakery checks the catalog and Saturday slots via site actions → finds a
   fitting cake, adds it to the cart (visible in the UI).
3. Bakery needs delivery → concierge asks for **consent** to contact the
   Courier peer site → user approves → the runtime loads the `courier`
   network and the dispatcher quotes the delivery fee + time window.
4. Concierge composes one order (cake + delivery + total) in a confirmation
   card → user presses Confirm **once** → the receipt appears; cart and
   order state update.
5. The trace panel shows the whole flow: agent → tool → peer → consent →
   receipt.

There is also a "Load a peer network by URL" box so judges can load any
external network (e.g. an official example site) — proving the protocol is
open.

## Run it locally

```sh
python3 -m http.server 8000
# open http://localhost:8000/
```

No build step, no npm dependencies, no backend.

## Tests

```sh
node --test test/runtime.test.mjs
```

Covers manifest/network validation, argument validation, local-engine
plans, LLM reply parsing, peer helpers, the single-confirmation checkout
guard, delivery-fee-carrying receipts, and an end-to-end local-engine demo
run with mocked fetch.

## File map

| File | What it is |
|---|---|
| `index.html`, `styles.css` | Market page + styling |
| `app.js` | Page wiring: cart, orders, chat, trace, consent/confirm cards, settings |
| `runtime.js` | Original browser agent runtime (DOM-free) |
| `orderflow.js` | DOM-free checkout helpers: single-confirmation guard + receipt builder |
| `agent-manifest.json` | Published manifest (networks, router, peer policy) |
| `agora.network.json` | Resolved network definition (agents, tools, JSON Schemas) |
| `links.json` | Peer name → site URL map |
| `.well-known/agent-card.json` | A2A agent card |
| `courier/` | Courier peer site (own manifest, network, page, app) |
| `registry.json`, `registry/index.html` | Public discovery registry |
| `shops/template/` | Shop template (manifest + network + page + README) |
| `test/runtime.test.mjs` | Node test suite |

## Honesty notes

- All products, prices, and delivery slots are **static demo data**.
- Checkout is a **demo order**: no payment is taken, nothing is shipped.
- The default router is free and anonymous; if it is unavailable the demo
  still works through the offline local engine.
- The peer in V1 is same-origin (`/courier/`); the peer-URL box keeps the
  protocol open for external peers (MVP §3.4 does not require cross-origin
  for conformance).

## Known issues

None open as of V1 verification (23 Nov 2026):

- All 17 Node tests pass (`node --test test/runtime.test.mjs`), including an
  end-to-end local-engine demo run asserting exactly one order confirmation
  and a receipt total that includes the delivery fee ($24.00 cake + $4.50
  delivery = $28.50).
- All 26 public artifacts return HTTP 200 when served locally.
- The default router was verified live from this machine: a real chat
  completion from `POST https://text.pollinations.ai/openai/chat/completions`
  (model `gpt-oss-20b`, anonymous tier) returned `OK` as requested.

Two defects found during the build were fixed by restructuring (not by
re-editing the runtime): the demo flow used to ask the user to confirm the
same order twice, and the receipt used to drop the delivery fee. Both are
covered by tests now — see `orderflow.js` and `test/runtime.test.mjs`.

## Spec compliance (MVP 0.3)

- Publish network HOCON 2-agent + manifest from a plain HTTPS host. ✓
- Load & run the network in the browser with the default router/model (and
  a BYOK path). ✓
- Call internal agents + at least one grounded capability (site actions). ✓
- After user approval, load a same-named network from a second origin and
  run it locally in the caller browser. ✓ (peer-URL box; courier is the
  built-in second origin)
- Peer site never receives the user key and cannot change the caller router. ✓
- Private context is not sent to peers except explicitly named fields. ✓
  (no private context is shared at all in V1)
- Invalid networks, composition cycles, over-budget requests, and refused
  origins stop with a visible error. ✓

## License

Apache License 2.0 — see `LICENSE`.
