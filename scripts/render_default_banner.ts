/**
 * One-shot renderer for the homepage og:image (public/banner.png).
 *
 * Reuses the per-pub renderOgCard machinery in `home: true` mode so the
 * homepage card looks visually identical to per-pub shares — same header,
 * same porthole, same footer — but the left column shows the brand
 * headline instead of a specific pub's name and score.
 *
 * The Racecourse is used as the porthole's geometry source because it
 * renders well and is already the canonical example pub for og-example.svg.
 * Its name is never shown on the home variant, so this doesn't read as
 * "the homepage advertises one specific pub".
 *
 * Run with:
 *   pnpm tsx scripts/render_default_banner.ts
 *
 * Outputs:
 *   public/banner.png   — 1200×630 PNG (the og:image)
 *   public/banner.svg   — same content as SVG (debugging/reference)
 *
 * Run this manually after any visual change to og_card.ts.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Resvg } from "@resvg/resvg-js";

import { renderOgCard } from "../functions/_lib/og_card";
import { bestWindowSunPosition, prefetchPortholeTiles } from "../functions/_lib/porthole_svg";
import type { Pub } from "../src/types";
import { loadBuildingsForPub } from "./lib/tiles_node";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const PUBS_JSON = join(ROOT, "public", "data", "pubs.json");
const OUT_PNG = join(ROOT, "public", "banner.png");
const OUT_SVG = join(ROOT, "public", "banner.svg");

async function main(): Promise<void> {
  const pubs = JSON.parse(readFileSync(PUBS_JSON, "utf-8")) as Pub[];

  const pub = pubs.find((p) => p.slug === "the-racecourse-norwich");
  if (!pub) {
    console.error("ERROR: the-racecourse-norwich not found in pubs.json");
    process.exit(1);
  }

  console.log(`Porthole pub: ${pub.name}, ${pub.town} (geometry only — name not shown)`);

  const buildings = loadBuildingsForPub(pub);
  console.log(`Buildings: ${buildings.length}`);

  const sun = bestWindowSunPosition(pub, pub.sun?.best_window ?? null);
  console.log(`Sun: az=${sun.azimuth.toFixed(1)}° alt=${sun.altitude.toFixed(1)}°`);

  console.log("Fetching map tiles…");
  const tileCache = await prefetchPortholeTiles(pub);
  console.log(`Got ${tileCache.size} tiles`);

  const svg = renderOgCard({ pub, buildings, sun, tileCache, home: true });
  writeFileSync(OUT_SVG, svg);
  console.log(`Wrote ${OUT_SVG} (${(svg.length / 1024).toFixed(1)} KB)`);

  // Rasterise to PNG at native 1200×630. resvg handles nested <svg>,
  // clipPaths, gradients, and embedded raster image hrefs (the basemap
  // tiles) — ImageMagick's SVG renderer does not.
  const resvg = new Resvg(svg, {
    fitTo: { mode: "width", value: 1200 },
    background: "rgba(0,0,0,0)",
  });
  const png = resvg.render().asPng();
  writeFileSync(OUT_PNG, png);
  console.log(`Wrote ${OUT_PNG} (${(png.length / 1024).toFixed(1)} KB)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
