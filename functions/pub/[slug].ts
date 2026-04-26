/**
 * Cloudflare Pages Function — handles every /pub/<slug>/ URL.
 *
 * Single per-pub JSON fetch from R2, no index parsing. The pipeline writes
 * /data/pub/{slug}.json containing the full pub data plus a pre-computed
 * `nearby` array of the 10 closest pubs, so this Function does:
 *
 *   1. Fetch one ~5 KB JSON file from R2 (single network hop, ~50 ms cold)
 *   2. Render HTML
 *
 * vs the previous architecture, which fetched and parsed a 15.78 MB index
 * on every cold start, blowing the Pages-Function CPU ceiling and 503-ing
 * for unique URLs hit by Applebot / Googlebot.
 *
 * Production URL → Function:  /pub/coach-and-horses/  → renders the pub
 * Production URL → 404:        /pub/no-such-pub/      → returns 404
 */

import { type Pub, renderPubPage } from "../_lib/render";

interface Env {
  ASSETS: Fetcher;
  // Cloudflare Pages auto-injects this at build AND runtime — used as a
  // cache buster so a new deploy invalidates both the module-scope template
  // cache and the edge Cache API entries from the previous deploy.
  CF_PAGES_COMMIT_SHA?: string;
}

// ── Module-scope cache ───────────────────────────────────────────────────
//
// Only the HTML template needs to live across requests on a warm isolate
// (it's the same for every pub). Per-pub data is small enough that a fresh
// fetch per request is fine.

let cachedSha: string | null = null;
let cachedTemplate: string | null = null;

const R2_DATA_URL = "https://data.sunny-pint.co.uk/data";

async function loadTemplate(env: Env, origin: string): Promise<string> {
  const sha = env.CF_PAGES_COMMIT_SHA ?? "dev";
  if (cachedSha === sha && cachedTemplate) return cachedTemplate;
  const res = await env.ASSETS.fetch(`${origin}/index.html`);
  if (!res.ok) throw new Error(`Failed to load template: ${res.status}`);
  const template = await res.text();
  cachedSha = sha;
  cachedTemplate = template;
  return template;
}

async function loadPub(slug: string): Promise<Pub | null> {
  const res = await fetch(`${R2_DATA_URL}/pub/${slug}.json`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Failed to load pub/${slug}.json: ${res.status}`);
  return (await res.json()) as Pub;
}

// ── Route handler ────────────────────────────────────────────────────────

// Handle GET and HEAD — some crawlers (and link checkers) probe with HEAD
// first, and if we only export onRequestGet those fall through to the static
// 404.html which tells Google the URL doesn't exist.
export const onRequest: PagesFunction<Env> = async (ctx) => {
  if (ctx.request.method !== "GET" && ctx.request.method !== "HEAD") {
    return new Response("Method not allowed", { status: 405 });
  }
  const url = new URL(ctx.request.url);

  // Edge-cache lookup. Include deploy SHA so a new deploy invalidates the
  // entire cache namespace; force GET so HEAD probes reuse GET entries and
  // vice-versa.
  const sha = ctx.env.CF_PAGES_COMMIT_SHA ?? "dev";
  const cacheKey = new Request(`${url.origin}${url.pathname}?_v=${sha}`, { method: "GET" });
  // `caches.default` is a Cloudflare Workers extension not present in the
  // standard DOM CacheStorage type. The cast is a pure type-level shim —
  // runtime works correctly on the Workers platform.
  const cache = (caches as unknown as { default: Cache }).default;
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  const slug = String(ctx.params.slug ?? "");
  if (!slug) return new Response("Not found", { status: 404 });

  let pub: Pub | null;
  let template: string;
  try {
    [pub, template] = await Promise.all([loadPub(slug), loadTemplate(ctx.env, url.origin)]);
  } catch (err) {
    console.error("pub function load failed", err);
    return new Response(`Internal error: ${(err as Error).message}`, { status: 500 });
  }

  if (!pub) {
    // Soft 404 — let the static 404.html handle it.
    const fallback = await ctx.env.ASSETS.fetch(`${url.origin}/404.html`);
    return new Response(await fallback.text(), {
      status: 404,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }

  const town = pub.town ?? "";
  const country = pub.country ?? "England";
  const nearby = pub.nearby ?? [];

  const html = renderPubPage(template, { pub, town, country, nearby });

  const response = new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      // Browser cache 1h (so reloads are fast). Edge cache 7 days (so the
      // Function rarely runs again until pubs.json updates and we redeploy,
      // which automatically invalidates the cache via the SHA-keyed key).
      "cache-control": "public, max-age=3600, s-maxage=604800",
    },
  });

  // Store the cloned response in the edge cache asynchronously.
  ctx.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
};
