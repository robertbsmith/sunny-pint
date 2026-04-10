/**
 * Cloudflare Pages Function — per-pub OG card image.
 *
 * Renders a 1200x630 social card PNG for every pub, with the actual pub's
 * porthole (real map tiles + real building shadows), score, and identity.
 *
 * SVG is rendered first via og_card.ts, then converted to PNG via resvg
 * so WhatsApp/Facebook/Twitter can display it (they don't support SVG).
 *
 * Edge-cached aggressively via the Cache API so the renderer almost never
 * runs more than once per POP per week even under heavy crawler traffic.
 *
 * Endpoints:
 *   GET /og/pub/<slug>          → 200 image/png
 *   GET /og/pub/<slug>.png      → 200 image/png
 *   GET /og/pub/<slug>.svg      → 200 image/png (compat)
 *   GET /og/pub/no-such-pub     → 404
 */

import { Resvg, initWasm } from "@resvg/resvg-wasm";
// @ts-expect-error — WASM import handled by wrangler's asset bundler
import resvgWasm from "@resvg/resvg-wasm/index_bg.wasm";

let wasmInitialized = false;
let cachedFonts: Uint8Array[] | null = null;

const R2_FONTS_URL = "https://data.sunny-pint.co.uk/fonts";
const FONT_FILES = ["Inter-Bold.ttf", "Inter-Regular.ttf", "CrimsonText-Regular.ttf"];

async function loadFonts(): Promise<Uint8Array[]> {
  if (cachedFonts) return cachedFonts;
  const buffers = await Promise.all(
    FONT_FILES.map(async (name) => {
      const res = await fetch(`${R2_FONTS_URL}/${name}`);
      return new Uint8Array(await res.arrayBuffer());
    }),
  );
  cachedFonts = buffers;
  return buffers;
}

import type { Pub } from "../../../src/types";
import { loadBuildingsForPubAsync, type TileFetcher } from "../../_lib/buildings_async";
import { renderOgCard } from "../../_lib/og_card";
import { bestWindowSunPosition, prefetchPortholeTiles } from "../../_lib/porthole_svg";

interface Env {
  ASSETS: Fetcher;
}

// ── Module-scope cache ───────────────────────────────────────────────────
//
// V8 isolates persist between requests on the same instance, so the parsed
// pubs.json + slug index survive across invocations on a warm Worker.

let cachedIndex: Map<string, Pub> | null = null;

const R2_DATA_URL = "https://data.sunny-pint.co.uk/data";

async function loadPubs(env: Env, origin: string): Promise<Map<string, Pub>> {
  if (cachedIndex) return cachedIndex;
  const res = await fetch(`${R2_DATA_URL}/pubs-index.json`);
  if (!res.ok) throw new Error(`Failed to load pubs-index.json from R2: ${res.status}`);
  const pubs = (await res.json()) as Pub[];
  const index = new Map<string, Pub>();
  for (const p of pubs) {
    if (p.slug) index.set(p.slug, p);
  }
  cachedIndex = index;
  return index;
}

/** Fetch heavy per-pub fields (outdoor, elev, horizon) from R2 detail chunk. */
async function loadPubDetail(pub: Pub): Promise<void> {
  if (pub.outdoor !== undefined) return;
  const cellLat = Math.floor(pub.lat * 10) / 10;
  const cellLng = Math.floor(pub.lng * 10) / 10;
  try {
    const resp = await fetch(`${R2_DATA_URL}/detail/${cellLat}_${cellLng}.json`);
    if (!resp.ok) return;
    const chunk = (await resp.json()) as Record<string, Partial<Pub>>;
    if (pub.slug && chunk[pub.slug]) {
      Object.assign(pub, chunk[pub.slug]);
    }
  } catch {
    // Render without outdoor/elev if detail unavailable.
  }
}

// ── Tile fetcher backed by env.ASSETS ───────────────────────────────────
//
// Building tiles live as static assets at /data/tiles/<x>-<y>.pbf. The
// Function fetches them via env.ASSETS.fetch (which doesn't count toward
// the Worker request quota — it's a free static asset read).

function makeTileFetcher(env: Env, origin: string): TileFetcher {
  return async (key: string) => {
    // Try local assets first (dev), then R2 (production).
    let res = await env.ASSETS.fetch(`${origin}/data/tiles/${key}.pbf`);
    if (!res.ok) {
      res = await fetch(`${R2_DATA_URL}/tiles/${key}.pbf`);
    }
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

  // Slug param — accept /og/pub/<slug>, /og/pub/<slug>.png, /og/pub/<slug>.svg
  let slug = String(ctx.params.slug ?? "");
  if (slug.endsWith(".svg") || slug.endsWith(".png")) slug = slug.slice(0, -4);
  if (!slug) return new Response("Not found", { status: 404 });

  let index: Map<string, Pub>;
  try {
    index = await loadPubs(ctx.env, url.origin);
  } catch (err) {
    return new Response(`Internal error: ${(err as Error).message}`, { status: 500 });
  }

  const pub = index.get(slug);
  if (!pub) return new Response("Pub not found", { status: 404 });

  // Fetch heavy detail fields (outdoor, elev) from R2.
  await loadPubDetail(pub);

  // Load buildings, sun position, map tiles in parallel.
  const tileFetcher = makeTileFetcher(ctx.env, url.origin);
  const sun = bestWindowSunPosition(pub, pub.sun?.best_window ?? null);
  const [buildings, tileCache] = await Promise.all([
    loadBuildingsForPubAsync(pub, tileFetcher),
    prefetchPortholeTiles(pub),
  ]);

  const svg = renderOgCard({ pub, buildings, sun, tileCache });

  // Initialize resvg WASM + load fonts on first invocation (persists across warm requests).
  if (!wasmInitialized) {
    await initWasm(resvgWasm);
    wasmInitialized = true;
  }
  const fonts = await loadFonts();

  // The SVG uses system font stacks (-apple-system, Georgia etc) which
  // don't exist in Workers. Replace with our loaded font families before
  // passing to resvg.
  const svgWithFonts = svg
    .replace(/-apple-system, system-ui, 'Segoe UI', sans-serif/g, "Inter")
    .replace(/-apple-system, system-ui, sans-serif/g, "Inter")
    .replace(/Georgia, 'Times New Roman', serif/g, "Crimson Text");

  const resvg = new Resvg(svgWithFonts, {
    fitTo: { mode: "width", value: 1200 },
    font: {
      fontBuffers: fonts,
      defaultFontFamily: "Inter",
    },
  });
  const pngData = resvg.render();
  const pngBuffer = pngData.asPng();

  const response = new Response(pngBuffer, {
    headers: {
      "content-type": "image/png",
      // Browser cache 1h, edge cache 7 days. Pipeline reruns redeploy and
      // automatically invalidate the edge cache, so updated ratings show
      // up within minutes of a fresh deploy.
      "cache-control": "public, max-age=3600, s-maxage=604800",
    },
  });

  ctx.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
};
