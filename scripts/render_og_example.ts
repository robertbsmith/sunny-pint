/**
 * Renders an example OG image SVG for design iteration.
 *
 * Uses scripts/lib/og_card.ts which composes the full 1200x630 card by hand
 * with the porthole embedded inline (no satori — its limited SVG support
 * couldn't handle our porthole's clipPath / gradients / filters).
 *
 * Run with:
 *   pnpm tsx scripts/render_og_example.ts
 *
 * Output:
 *   public/og-example.svg
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { renderOgCard } from "../functions/_lib/og_card";
import { bestWindowSunPosition, prefetchPortholeTiles } from "../functions/_lib/porthole_svg";
import type { Pub } from "../src/types";
import { loadBuildingsForPub } from "./lib/tiles_node";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const PUBS_JSON = join(ROOT, "public", "data", "pubs.json");
const OUT = join(ROOT, "public", "og-example.svg");

async function main(): Promise<void> {
  const pubs = JSON.parse(readFileSync(PUBS_JSON, "utf-8")) as Pub[];

  // The Racecourse — top-rated Norwich pub.
  const pub = pubs.find((p) => p.slug === "the-racecourse-norwich");
  if (!pub) {
    console.error("ERROR: the-racecourse-norwich not found in pubs.json");
    process.exit(1);
  }

  console.log(`Pub: ${pub.name}, ${pub.town}`);
  console.log(`Sunny rating: ${pub.sun?.score} (${pub.sun?.label}), best ${pub.sun?.best_window}`);

  const buildings = await loadBuildingsForPub(pub);
  console.log(`Buildings: ${buildings.length}`);

  const sun = bestWindowSunPosition(pub, pub.sun?.best_window ?? null);
  console.log(`Sun: az=${sun.azimuth.toFixed(1)}° alt=${sun.altitude.toFixed(1)}°`);

  console.log("Fetching map tiles…");
  const tileCache = await prefetchPortholeTiles(pub);
  console.log(`Got ${tileCache.size} tiles`);

  const svg = renderOgCard({ pub, buildings, sun, tileCache });
  writeFileSync(OUT, svg);
  console.log(`Wrote ${OUT} (${(svg.length / 1024).toFixed(1)} KB)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
