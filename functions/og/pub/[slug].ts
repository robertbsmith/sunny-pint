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

import { initWasm, Resvg } from "@resvg/resvg-wasm";
// @ts-expect-error — WASM import handled by wrangler's asset bundler
import resvgWasm from "@resvg/resvg-wasm/index_bg.wasm";
import { PMTiles } from "pmtiles";
import { BUILDING_TILE_ZOOM } from "../../../src/config";

let wasmInitPromise: Promise<void> | null = null;
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
  CF_PAGES_COMMIT_SHA?: string;
}

const R2_DATA_URL = "https://data.sunny-pint.co.uk/data";

/** Fetch the per-pub JSON from R2. Returns null on 404 so the Function can
 *  emit a clean 404 response instead of throwing. Per-pub files contain the
 *  full pub record (outdoor polygon, elev, horizon, schema fields), so a
 *  single fetch replaces the old index-then-detail two-fetch dance. */
async function loadPub(slug: string): Promise<Pub | null> {
  const res = await fetch(`${R2_DATA_URL}/pub/${slug}.json`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Failed to load pub/${slug}.json: ${res.status}`);
  return (await res.json()) as Pub;
}

// ── PMTiles-backed tile fetcher ─────────────────────────────────────────
//
// Buildings live in a single PMTiles archive on R2 at
// data.sunny-pint.co.uk/data/buildings.pmtiles. We use the pmtiles library's
// HTTP range-request source to fetch only the bytes we need per tile.
//
// The old `.pbf`-per-tile path predates the PMTiles migration and was
// effectively dead — individual tiles haven't been deployed since the
// switch. Left-over .pbf URLs on this code path always 404'd, so the
// Function rendered OG images without building shadows. Pre-rendered
// OG JPGs masked the issue in production; this path only fires for brand
// new pubs the pipeline hasn't rendered yet.

let pmtilesInstance: PMTiles | null = null;
function getPMTiles(): PMTiles {
  if (!pmtilesInstance) {
    pmtilesInstance = new PMTiles(`${R2_DATA_URL}/buildings.pmtiles`);
  }
  return pmtilesInstance;
}

function makeTileFetcher(_env: Env, _origin: string): TileFetcher {
  return async (key: string) => {
    // key is "<tx>-<ty>" at BUILDING_TILE_ZOOM — parse and query the archive.
    const [txStr, tyStr] = key.split("-");
    if (!txStr || !tyStr) return null;
    const tx = Number.parseInt(txStr, 10);
    const ty = Number.parseInt(tyStr, 10);
    try {
      const tile = await getPMTiles().getZxy(BUILDING_TILE_ZOOM, tx, ty);
      return tile?.data ?? null;
    } catch {
      return null;
    }
  };
}

// ── Route handler ────────────────────────────────────────────────────────

export const onRequest: PagesFunction<Env> = async (ctx) => {
  if (ctx.request.method !== "GET" && ctx.request.method !== "HEAD") {
    return new Response("Method not allowed", { status: 405 });
  }
  const url = new URL(ctx.request.url);
  const sha = ctx.env.CF_PAGES_COMMIT_SHA ?? "dev";

  // Edge cache lookup, SHA-keyed so each deploy invalidates cleanly. Force GET
  // so HEAD probes reuse the same cache entry as GETs.
  const cacheKey = new Request(`${url.origin}${url.pathname}?_v=${sha}`, { method: "GET" });
  // `caches.default` is a Cloudflare Workers extension not present in the
  // standard DOM CacheStorage type. The cast is a pure type-level shim —
  // runtime works correctly on the Workers platform.
  const cache = (caches as unknown as { default: Cache }).default;
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  // Slug param — accept /og/pub/<slug>, /og/pub/<slug>.png, /og/pub/<slug>.svg
  let slug = String(ctx.params.slug ?? "");
  if (slug.endsWith(".svg") || slug.endsWith(".png")) slug = slug.slice(0, -4);
  if (!slug) return new Response("Not found", { status: 404 });

  try {
    const pub = await loadPub(slug);
    if (!pub) return new Response("Pub not found", { status: 404 });

    // Load buildings, sun position, map tiles in parallel.
    const tileFetcher = makeTileFetcher(ctx.env, url.origin);
    const sun = bestWindowSunPosition(pub, pub.sun?.best_window ?? null);
    const [buildings, tileCache] = await Promise.all([
      loadBuildingsForPubAsync(pub, tileFetcher),
      prefetchPortholeTiles(pub),
    ]);

    const svg = renderOgCard({ pub, buildings, sun, tileCache });

    // Initialize resvg WASM once per isolate. Promise-guarded so concurrent
    // first-hits on a cold isolate don't both call initWasm (it isn't
    // idempotent — the second call throws "already initialized").
    if (!wasmInitPromise) wasmInitPromise = initWasm(resvgWasm);
    await wasmInitPromise;
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
    // `asPng()` returns Uint8Array which Workers accepts as a Response body,
    // but the DOM BodyInit type narrows to ArrayBuffer / Blob / etc. Cast to
    // BufferSource to satisfy TS without changing runtime behaviour.
    const pngBuffer = pngData.asPng() as unknown as BufferSource;

    const response = new Response(pngBuffer, {
      headers: {
        "content-type": "image/png",
        // Browser cache 1h, edge cache 7 days. SHA-keyed cache invalidates on
        // every deploy, so updated ratings show up on next crawl.
        "cache-control": "public, max-age=3600, s-maxage=604800",
      },
    });

    ctx.waitUntil(cache.put(cacheKey, response.clone()));
    return response;
  } catch (err) {
    // Log + bubble a clean 500 rather than leaving the isolate to crash with
    // an uncaught exception (which would leave subsequent warm requests
    // unable to resolve their own init promises).
    console.error("OG render failed", err);
    return new Response("OG render failed", { status: 500 });
  }
};
