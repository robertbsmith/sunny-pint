/**
 * Pre-render OG card images for all pubs.
 *
 * Generates a 1200×630 JPEG per pub with the porthole (map tiles +
 * buildings + shadows + garden), score, identity, and branding. These
 * are uploaded to R2 as static files — no Worker computation needed
 * at request time.
 *
 * Uses child processes (same pattern as precompute_sun.ts) for
 * parallelism. Each worker loads building tiles from PMTiles, fetches
 * Mapbox map tiles (cached across nearby pubs), and renders via resvg.
 *
 * Run with:
 *   pnpm tsx scripts/render_og_cards.ts
 *
 * Requires: pubs.json (with sun scores), buildings.pmtiles
 */

import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { Pub } from "../src/types";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const PUBS_JSON = join(ROOT, "public", "data", "pubs.json");
const OG_DIR = join(ROOT, "public", "data", "og");
const TMP_DIR = join(ROOT, "data", "og_tmp");

const NUM_WORKERS = Math.min(8, availableParallelism() - 1);

function runWorker(batchFile: string, outputDir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      "pnpm",
      ["tsx", join(__dirname, "render_og_worker.ts"), batchFile, outputDir],
      { maxBuffer: 50 * 1024 * 1024 },
      (err, _stdout, stderr) => {
        if (stderr) process.stderr.write(stderr);
        if (err) reject(err);
        else resolve();
      },
    );
  });
}

async function main(): Promise<void> {
  let pubs: Pub[];
  try {
    pubs = JSON.parse(readFileSync(PUBS_JSON, "utf-8")) as Pub[];
  } catch {
    console.error(`ERROR: ${PUBS_JSON} not found.`);
    process.exit(1);
  }

  // Only render pubs with slugs + outdoor areas (others get generic banner).
  const qualifying = pubs.filter((p) => p.slug && p.outdoor && p.outdoor.length > 0);
  console.log(`${qualifying.length} qualifying pubs (of ${pubs.length} total)`);

  // Skip already-rendered pubs.
  mkdirSync(OG_DIR, { recursive: true });
  const existing = new Set(readdirSync(OG_DIR).filter((f) => f.endsWith(".jpg")));
  const toRender = qualifying.filter((p) => !existing.has(`${p.slug}.jpg`));
  console.log(`${existing.size} already rendered, ${toRender.length} to render`);

  if (toRender.length === 0) {
    console.log("Nothing to render.");
    return;
  }

  // Sort geographically so each worker batch maximises map tile cache
  // hits (nearby pubs share z18 tiles). Sort by lat rounded to 0.1°
  // then lng — gives rough spatial locality within each batch.
  toRender.sort((a, b) => {
    const aKey = Math.floor(a.lat * 10) * 10000 + Math.floor(a.lng * 10);
    const bKey = Math.floor(b.lat * 10) * 10000 + Math.floor(b.lng * 10);
    return aKey - bKey;
  });

  // Split into batches per worker. Contiguous chunks from the sorted
  // list give each worker a geographic region — maximum tile reuse.
  mkdirSync(TMP_DIR, { recursive: true });
  const workerCount = Math.min(NUM_WORKERS, toRender.length);
  const chunkSize = Math.ceil(toRender.length / workerCount);
  const workerPromises: Promise<void>[] = [];
  const t0 = Date.now();

  for (let w = 0; w < workerCount; w++) {
    const start = w * chunkSize;
    const end = Math.min(start + chunkSize, toRender.length);
    if (start >= toRender.length) break;

    const batch = toRender.slice(start, end);
    const batchFile = join(TMP_DIR, `batch_${w}.json`);
    writeFileSync(batchFile, JSON.stringify(batch));
    workerPromises.push(runWorker(batchFile, OG_DIR));
    console.log(`  worker ${w}: ${batch.length} pubs`);
  }

  console.log(`\nWaiting for ${workerPromises.length} workers...\n`);

  // Poll progress every 30s.
  const progressInterval = setInterval(() => {
    const rendered = readdirSync(OG_DIR).filter((f) => f.endsWith(".jpg")).length;
    const elapsed = (Date.now() - t0) / 1000;
    const rate = (rendered - existing.size) / elapsed;
    const remaining = toRender.length - (rendered - existing.size);
    const eta = rate > 0 ? remaining / rate : 0;
    console.log(
      `  progress: ${rendered - existing.size}/${toRender.length} rendered, ` +
        `${rate.toFixed(1)}/s, ETA ${Math.round(eta)}s`,
    );
  }, 30000);

  const results = await Promise.allSettled(workerPromises);
  clearInterval(progressInterval);

  let failed = 0;
  for (const r of results) {
    if (r.status === "rejected") {
      console.error(`  worker FAILED:`, r.reason);
      failed++;
    }
  }

  const totalRendered = readdirSync(OG_DIR).filter((f) => f.endsWith(".jpg")).length;
  const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
  console.log(
    `\nDone in ${elapsed}s — ${totalRendered} OG cards total (${failed} worker failures)`,
  );

  // Clean up temp files.
  for (let w = 0; w < workerCount; w++) {
    try {
      const bf = join(TMP_DIR, `batch_${w}.json`);
      if (existsSync(bf)) writeFileSync(bf, "");
    } catch {
      /* ignore */
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
