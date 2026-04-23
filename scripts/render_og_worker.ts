/**
 * Worker process for render_og_cards.ts.
 *
 * Invoked as: pnpm tsx scripts/render_og_worker.ts <batch.json> <output_dir>
 *
 * Reads a batch of pubs, renders OG card SVG → JPEG for each, writes to
 * output_dir/<slug>.jpg. Map tiles are cached across pubs in the batch
 * via the module-scope tile cache in porthole_svg.ts (nearby pubs share
 * z18 tiles — a batch of geographically sorted pubs gets heavy reuse).
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Resvg } from "@resvg/resvg-js";
import sharp from "sharp";

import { renderOgCard } from "../functions/_lib/og_card";
import { bestWindowSunPosition, prefetchPortholeTiles } from "../functions/_lib/porthole_svg";
import type { Pub } from "../src/types";
import { loadBuildingsForPub } from "./lib/tiles_node";

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dir, "..");

// Load fonts once — reused for every pub in this worker.
const FONT_BUFFERS = [
  readFileSync(join(ROOT, "data", "fonts", "Inter-Bold.ttf")),
  readFileSync(join(ROOT, "data", "fonts", "Inter-Regular.ttf")),
  readFileSync(join(ROOT, "data", "fonts", "CrimsonText-Regular.ttf")),
];

const RESVG_OPTIONS = {
  fitTo: { mode: "width" as const, value: 1200 },
  font: {
    fontBuffers: FONT_BUFFERS,
    defaultFontFamily: "Inter",
  },
};

const STADIA_KEY = process.env.STADIA_API_KEY || "";

/** Font family replacements — system fonts → our loaded TTFs. */
function fixFonts(svg: string): string {
  return svg
    .replace(/-apple-system, system-ui, 'Segoe UI', sans-serif/g, "Inter")
    .replace(/-apple-system, system-ui, sans-serif/g, "Inter")
    .replace(/Georgia, 'Times New Roman', serif/g, "Crimson Text");
}

async function renderPub(pub: Pub, outputDir: string): Promise<boolean> {
  if (!pub.slug) return false;

  try {
    // Load buildings + map tiles in parallel.
    const [buildings, tileCache] = await Promise.all([
      loadBuildingsForPub(pub),
      prefetchPortholeTiles(pub, STADIA_KEY || undefined),
    ]);

    const sun = bestWindowSunPosition(pub, pub.sun?.best_window ?? null);
    const svg = fixFonts(renderOgCard({ pub, buildings, sun, tileCache }));

    // SVG → PNG → JPEG.
    const png = new Resvg(svg, RESVG_OPTIONS).render().asPng();
    const jpeg = await sharp(png).jpeg({ quality: 85 }).toBuffer();

    writeFileSync(join(outputDir, `${pub.slug}.jpg`), jpeg);
    return true;
  } catch (err) {
    process.stderr.write(`  FAIL ${pub.slug}: ${err}\n`);
    return false;
  }
}

// ── Main ────────────────────────────────────────────────────────────────

const [rawBatchFile, rawOutputDir] = process.argv.slice(2);
if (!rawBatchFile || !rawOutputDir) {
  console.error("Usage: pnpm tsx scripts/render_og_worker.ts <batch.json> <output_dir>");
  process.exit(1);
}
// Aliased after the narrow above so TS sees these as `string`, not
// `string | undefined`. process.exit returns never but tsc doesn't always
// propagate the narrowing through the destructure at call sites.
const batchFile: string = rawBatchFile;
const outputDir: string = rawOutputDir;

mkdirSync(outputDir, { recursive: true });

const batch: Pub[] = JSON.parse(readFileSync(batchFile, "utf-8"));
let ok = 0;
let fail = 0;

async function main(): Promise<void> {
  for (const pub of batch) {
    const success = await renderPub(pub, outputDir);
    if (success) ok++;
    else fail++;

    if ((ok + fail) % 25 === 0) {
      process.stderr.write(
        `  worker ${process.pid}: ${ok + fail}/${batch.length} (${ok} ok, ${fail} fail)\n`,
      );
    }
  }

  const resultFile = batchFile.replace("batch_", "result_").replace(".json", ".txt");
  writeFileSync(resultFile, `${ok} ok, ${fail} fail\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
