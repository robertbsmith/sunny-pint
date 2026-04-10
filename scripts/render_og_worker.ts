/**
 * Worker process for render_og_cards.ts.
 *
 * Invoked as: pnpm tsx scripts/render_og_worker.ts <batch.json> <output_dir>
 *
 * Reads a batch of pubs, renders OG card SVG → JPEG for each, writes to
 * output_dir/<slug>.jpg. Map tiles are cached across pubs in the batch
 * (nearby pubs share z18 tiles).
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { Resvg } from "@resvg/resvg-js";
import sharp from "sharp";

import { renderOgCard } from "../functions/_lib/og_card";
import { bestWindowSunPosition, prefetchPortholeTiles } from "../functions/_lib/porthole_svg";
import type { Pub } from "../src/types";
import { loadBuildingsForPub } from "./lib/tiles_node";

const FONTS_DIR = join(__dirname, "..", "data", "fonts");
const FONT_BUFFERS = [
  readFileSync(join(FONTS_DIR, "Inter-Bold.ttf")),
  readFileSync(join(FONTS_DIR, "Inter-Regular.ttf")),
  readFileSync(join(FONTS_DIR, "CrimsonText-Regular.ttf")),
];

const STADIA_API_KEY = process.env.STADIA_API_KEY || "";

async function renderPub(pub: Pub, outputDir: string): Promise<boolean> {
  if (!pub.slug) return false;

  try {
    const buildings = await loadBuildingsForPub(pub);
    const sun = bestWindowSunPosition(pub, pub.sun?.best_window ?? null);
    const tileCache = await prefetchPortholeTiles(pub, STADIA_API_KEY || undefined);

    const svg = renderOgCard({ pub, buildings, sun, tileCache });

    // Replace system font families with our loaded fonts.
    const svgWithFonts = svg
      .replace(/-apple-system, system-ui, 'Segoe UI', sans-serif/g, "Inter")
      .replace(/-apple-system, system-ui, sans-serif/g, "Inter")
      .replace(/Georgia, 'Times New Roman', serif/g, "Crimson Text");

    // SVG → PNG via resvg (with fonts).
    const resvg = new Resvg(svgWithFonts, {
      fitTo: { mode: "width", value: 1200 },
      font: {
        fontBuffers: FONT_BUFFERS,
        defaultFontFamily: "Inter",
      },
    });
    const pngBuffer = resvg.render().asPng();

    // PNG → JPEG via sharp (85 quality ≈ 100-150 KB per card).
    const jpegBuffer = await sharp(pngBuffer).jpeg({ quality: 85 }).toBuffer();

    writeFileSync(join(outputDir, `${pub.slug}.jpg`), jpegBuffer);
    return true;
  } catch (err) {
    process.stderr.write(`  FAIL ${pub.slug}: ${err}\n`);
    return false;
  }
}

// ── CLI entry point ─────────────────────────────────────────────────────

const [batchFile, outputDir] = process.argv.slice(2);
if (!batchFile || !outputDir) {
  console.error("Usage: pnpm tsx scripts/render_og_worker.ts <batch.json> <output_dir>");
  process.exit(1);
}

mkdirSync(outputDir, { recursive: true });

const batch: Pub[] = JSON.parse(readFileSync(batchFile, "utf-8"));
let ok = 0;
let fail = 0;

(async () => {
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

  // Write result summary.
  const resultFile = batchFile.replace("batch_", "result_").replace(".json", ".txt");
  writeFileSync(resultFile, `${ok} ok, ${fail} fail\n`);
})();
