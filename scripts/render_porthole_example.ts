/**
 * Standalone porthole renderer — for sanity-checking porthole_svg.ts
 * before integrating with the OG card.
 *
 * Run with:
 *   pnpm tsx scripts/render_porthole_example.ts
 *
 * Output:
 *   public/porthole-example.svg
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  bestWindowSunPosition,
  prefetchPortholeTiles,
  renderPortholeSvg,
} from "../functions/_lib/porthole_svg";
import type { Pub } from "../src/types";
import { loadBuildingsForPub } from "./lib/tiles_node";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const PUBS_JSON = join(ROOT, "public", "data", "pubs.json");
const OUT = join(ROOT, "public", "porthole-example.svg");

async function main(): Promise<void> {
  const pubs = JSON.parse(readFileSync(PUBS_JSON, "utf-8")) as Pub[];

  // Pick The Racecourse — the highest-scoring Norwich pub.
  const pub = pubs.find((p) => p.slug === "the-racecourse-norwich");
  if (!pub) {
    console.error("ERROR: the-racecourse-norwich not found in pubs.json");
    process.exit(1);
  }

  console.log(`Pub: ${pub.name} (${pub.lat}, ${pub.lng})`);
  console.log(
    `Sunny rating: ${pub.sun?.score ?? "n/a"}  best window: ${pub.sun?.best_window ?? "n/a"}`,
  );

  const buildings = await loadBuildingsForPub(pub);
  console.log(`Loaded ${buildings.length} buildings`);

  const sun = bestWindowSunPosition(pub, pub.sun?.best_window ?? null);
  console.log(`Sun position: az=${sun.azimuth.toFixed(1)}° alt=${sun.altitude.toFixed(1)}°`);

  console.log("Fetching map tiles…");
  const tileCache = await prefetchPortholeTiles(pub);
  console.log(`Got ${tileCache.size} tiles`);

  const svg = renderPortholeSvg(pub, buildings, sun, { size: 480, tileCache });
  writeFileSync(OUT, svg);
  console.log(`Wrote ${OUT} (${(svg.length / 1024).toFixed(1)} KB)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
