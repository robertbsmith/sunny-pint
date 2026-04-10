/**
 * Cloudflare Pages Function — per-pub OG card image.
 *
 * Serves /og/pub/<slug>.svg for every pub. Renders a 1200x630 social card
 * with the actual pub's porthole (real map tiles + real building shadows
 * for that pub's location), score, identity, and footer.
 *
 * Edge-cached aggressively via the Cache API so the renderer almost never
 * runs more than once per POP per week even under heavy crawler traffic.
 *
 * Endpoints (matching the per-pub HTML in functions/pub/[slug].ts):
 *   GET /og/pub/<slug>          → 200 image/svg+xml
 *   GET /og/pub/<slug>.svg      → 200 image/svg+xml
 *   GET /og/pub/no-such-pub     → 404
 */

import { renderOgCard } from "../../_lib/og_card";
import { bestWindowSunPosition, prefetchPortholeTiles } from "../../_lib/porthole_svg";
import { loadBuildingsForPubAsync, type TileFetcher } from "../../_lib/buildings_async";
import type { Pub } from "../../../src/types";

interface Env {
  ASSETS: Fetcher;
}

// ── Module-scope cache ───────────────────────────────────────────────────
//
// V8 isolates persist between requests on the same instance, so the parsed
// pubs.json + slug index survive across invocations on a warm Worker.

let cachedPubs: Pub[] | null = null;
let cachedIndex: Map<string, Pub> | null = null;

async function loadPubs(env: Env, origin: string): Promise<Map<string, Pub>> {
  if (cachedIndex) return cachedIndex;
  const res = await env.ASSETS.fetch(`${origin}/data/pubs.json`);
  if (!res.ok) throw new Error(`Failed to load pubs.json: ${res.status}`);
  const pubs = (await res.json()) as Pub[];
  const index = new Map<string, Pub>();
  for (const p of pubs) {
    if (p.slug) index.set(p.slug, p);
  }
  cachedPubs = pubs;
  cachedIndex = index;
  return index;
}

// ── Tile fetcher backed by env.ASSETS ───────────────────────────────────
//
// Building tiles live as static assets at /data/tiles/<x>-<y>.pbf. The
// Function fetches them via env.ASSETS.fetch (which doesn't count toward
// the Worker request quota — it's a free static asset read).

function makeTileFetcher(env: Env, origin: string): TileFetcher {
  return async (key: string) => {
    const res = await env.ASSETS.fetch(`${origin}/data/tiles/${key}.pbf`);
    if (!res.ok) return null;
    return await res.arrayBuffer();
  };
}

// ── Route handler ────────────────────────────────────────────────────────

export const onRequestGet: PagesFunction<Env> = async (ctx) => {
  const url = new URL(ctx.request.url);

  // Edge cache lookup, normalised by path only (strip query params so
  // ?utm_source=… etc don't fragment the cache).
  const cacheKey = new Request(`${url.origin}${url.pathname}`, ctx.request);
  const cache = caches.default;
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  // Slug param — accept both /og/pub/<slug> and /og/pub/<slug>.svg
  let slug = String(ctx.params.slug ?? "");
  if (slug.endsWith(".svg")) slug = slug.slice(0, -4);
  if (!slug) return new Response("Not found", { status: 404 });

  let index: Map<string, Pub>;
  try {
    index = await loadPubs(ctx.env, url.origin);
  } catch (err) {
    return new Response(`Internal error: ${(err as Error).message}`, { status: 500 });
  }

  const pub = index.get(slug);
  if (!pub) return new Response("Pub not found", { status: 404 });

  // Load buildings, sun position, map tiles in parallel.
  const tileFetcher = makeTileFetcher(ctx.env, url.origin);
  const sun = bestWindowSunPosition(pub, pub.sun?.best_window ?? null);
  const [buildings, tileCache] = await Promise.all([
    loadBuildingsForPubAsync(pub, tileFetcher),
    prefetchPortholeTiles(pub),
  ]);

  const svg = renderOgCard({ pub, buildings, sun, tileCache });

  const response = new Response(svg, {
    headers: {
      "content-type": "image/svg+xml; charset=utf-8",
      // Browser cache 1h, edge cache 7 days. Pipeline reruns redeploy and
      // automatically invalidate the edge cache, so updated ratings show
      // up within minutes of a fresh deploy.
      "cache-control": "public, max-age=3600, s-maxage=604800",
    },
  });

  ctx.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
};
