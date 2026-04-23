/**
 * Cloudflare Pages Function — handles every /pub/<slug>/ URL.
 *
 * One file in the deployment, infinite virtual pages. Sits comfortably
 * within the 100k requests/day Workers free tier because:
 *
 *   1. We aggressively edge-cache via the Cache API (which ignores client
 *      `Cache-Control: no-cache` headers, unlike HTTP-level caching). After
 *      a Function invocation, the next request to the same URL from the
 *      same POP for the next 7 days is served from cache without re-running
 *      the Function. This neutralises crawler bursts (Googlebot, GPTBot,
 *      ClaudeBot, etc.) that would otherwise eat the daily quota.
 *
 *   2. Static-asset fetches via env.ASSETS.fetch() do NOT count toward the
 *      Workers request quota — they're just file reads from the deployed
 *      bundle, free.
 *
 *   3. The pubs.json parse is cached in module scope so subsequent warm
 *      invocations skip both fetches and parses entirely.
 *
 * Production URL → Function:  /pub/coach-and-horses/         → renders the pub
 * Production URL → 404:        /pub/no-such-pub/             → returns 404
 */

import { nearbyPubs, type Pub, renderPubPage } from "../_lib/render";

interface Env {
  ASSETS: Fetcher;
  // Cloudflare Pages auto-injects this at build AND runtime — used as a
  // cache buster so a new deploy invalidates both the module-scope template
  // cache and the edge Cache API entries from the previous deploy. Without
  // this, returning users hit the stale 7-day cached HTML which still points
  // to the old CSS hash (and therefore the old layout).
  CF_PAGES_COMMIT_SHA?: string;
}

// ── Module-scope cache ───────────────────────────────────────────────────
//
// V8 isolates persist between requests on the same instance, so cached
// state survives across invocations. The Cache API handles inter-instance
// sharing; this just speeds up the same-instance warm path.

let cachedSha: string | null = null;
let cachedTemplate: string | null = null;
let cachedPubs: Pub[] | null = null;
let cachedSlugIndex: Map<string, Pub> | null = null;

async function loadAssets(
  env: Env,
  origin: string,
): Promise<{ template: string; pubs: Pub[]; index: Map<string, Pub> }> {
  const sha = env.CF_PAGES_COMMIT_SHA ?? "dev";
  if (cachedSha === sha && cachedTemplate && cachedPubs && cachedSlugIndex) {
    return { template: cachedTemplate, pubs: cachedPubs, index: cachedSlugIndex };
  }

  const [tplRes, pubsRes] = await Promise.all([
    env.ASSETS.fetch(`${origin}/index.html`),
    fetch("https://data.sunny-pint.co.uk/data/pubs-index.json"),
  ]);

  if (!tplRes.ok) {
    throw new Error(`Failed to load template: ${tplRes.status}`);
  }
  if (!pubsRes.ok) {
    throw new Error(`Failed to load pubs-index.json from R2: ${pubsRes.status}`);
  }

  const template = await tplRes.text();
  const pubs = (await pubsRes.json()) as Pub[];
  const index = new Map<string, Pub>();
  for (const pub of pubs) {
    if (pub.slug) index.set(pub.slug, pub);
  }

  cachedSha = sha;
  cachedTemplate = template;
  cachedPubs = pubs;
  cachedSlugIndex = index;
  return { template, pubs, index };
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

  // Cache lookup using a normalised key (strip query params so cache hits
  // aren't fragmented by ?utm_source=… etc). Include the deploy SHA so a
  // new deploy invalidates the entire cache namespace — without this we'd
  // serve 7-day-old HTML still pointing at the previous CSS hash, which
  // means the layout fixes from a deploy don't reach returning users.
  const sha = ctx.env.CF_PAGES_COMMIT_SHA ?? "dev";
  // Force GET on the cache key so a HEAD probe reuses the GET entry and
  // vice-versa — Cache API keys are method-sensitive by default.
  const cacheKey = new Request(`${url.origin}${url.pathname}?_v=${sha}`, { method: "GET" });
  const cache = caches.default;
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  const slug = String(ctx.params.slug ?? "");
  if (!slug) {
    return new Response("Not found", { status: 404 });
  }

  let assets: { template: string; pubs: Pub[]; index: Map<string, Pub> };
  try {
    assets = await loadAssets(ctx.env, url.origin);
  } catch (err) {
    return new Response(`Internal error: ${(err as Error).message}`, { status: 500 });
  }

  const pub = assets.index.get(slug);
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
  const nearby = nearbyPubs(pub, assets.pubs);

  const html = renderPubPage(assets.template, { pub, town, country, nearby });

  const response = new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      // Browser cache 1h (so reloads are fast). Edge cache 7 days (so the
      // Function rarely runs again until pubs.json updates and we redeploy,
      // which automatically invalidates the cache).
      "cache-control": "public, max-age=3600, s-maxage=604800",
    },
  });

  // Store the cloned response in the edge cache asynchronously — we don't
  // wait for it to complete before responding.
  ctx.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
};
