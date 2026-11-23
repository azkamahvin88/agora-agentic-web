# Template Shop — publish your own agent storefront

This folder is a starter template for an agent-readable shop in the Agora
market. Copy it, fill in your details, and publish it on any static host.

## Files

- `agent-manifest.json` — the published manifest (update site name + URL).
- `template.network.json` — the network definition: one `shopkeeper` front
  agent plus the four standard storefront tools.
- `index.html` — a placeholder page explaining the template.

## Setup

1. **Copy this folder** to your own site, e.g. `my-flower-shop/`.
2. **Manifest:** set `site.name`, `site.description`, and `site.url` to your
   shop's values. Keep `spec_version` as `open-agentic-web-mvp/0.3`.
3. **Network:** rewrite the `shopkeeper` instructions with your real
   products, prices, opening hours, and policies. The four tools are:
   - `website_list_products` — list your catalog with prices.
   - `website_add_to_cart` — add a product to the visitor's cart.
   - `website_get_cart` — read the current cart.
   - `website_checkout_order` — place the order (the runtime confirms with
     the user first; pass `deliveryFee` from the courier quote when known).
4. **Page:** build your storefront page and wire the four tools to your
   catalog and cart state. You can reuse the Agora runtime (`runtime.js` in
   the repo root) — it is a zero-dependency ES module that parses and
   validates manifests/networks, runs the agent loop, handles peer loading
   with consent, and enforces execution limits. See the Agora `app.js` for a
   working example of the site-action wiring.
5. **Publish** on GitHub Pages, Netlify, or any static host with HTTPS.
   Make sure `agent-manifest.json` is reachable at your site root (or at
   the path your registry entry points to).
6. **(Optional) Get listed:** open a pull request on the Agora repo adding
   one entry to `registry.json` with your manifest URL.

## Rules of the template

- Never invent prices or products: the agent must only use tool results.
- Checkout is a demo order unless you integrate real payment yourself —
  say so honestly on your page.
- Keep your manifest and network public: agent-readable by design.
- Your API keys (if any) stay in the visitor's browser (BYOK) and are never
  sent to peer sites.
