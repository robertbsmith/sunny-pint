/**
 * Sunny Rating precompute.
 *
 * For every qualifying pub, samples the sun's position every 30 minutes
 * across the daylight hours of the spring equinox (a fair "average day"),
 * computes the fraction of the outdoor seating polygon in direct sunlight
 * at each sample, averages them, and writes a single 0–100 score plus a
 * handful of bonus fields back into pubs.json.
 *
 * The Sunny Rating is the headline metric for the whole site:
 *
 *   - Latitude-independent (the % normalises out day length)
 *   - Size-independent (the % normalises out garden area)
 *   - Robust to imperfect outdoor polygons (the *fraction* is meaningful
 *     even if the polygon is the wrong size — the m² metric was fragile
 *     because of cadastral mismatches; the fraction isn't)
 *   - Computed once from the same `src/shadow.ts` the live app uses, so
 *     there's a single source of truth between offline rating and runtime
 *     porthole rendering
 *
 * See `public/how-it-works.html` (Sunny Rating section) for the user-facing
 * methodology explanation.
 *
 * Run with:
 *   pnpm tsx scripts/precompute_sun.ts
 */

import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { Pub } from "../../src/types";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const PUBS_JSON = join(ROOT, "public", "data", "pubs.json");

// ── Types (must match worker) ───────────────────────────────────────────

interface SunMetrics {
  score: number;
  label: string;
  best_window: string | null;
  morning_sun: boolean;
  midday_sun: boolean;
  evening_sun: boolean;
  all_day_sun: boolean;
  sample_day: string;
}

// ── Main ─────────────────────────────────────────────────────────────────

interface PubWithSun extends Pub {
  sun?: SunMetrics;
}

const NUM_WORKERS = Math.min(12, availableParallelism() - 1);

/** Spawn a child process that runs pnpm tsx on the worker script. */
function runWorker(batchFile: string, resultFile: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      "pnpm",
      ["tsx", join(__dirname, "precompute_sun_worker.ts"), batchFile, resultFile],
      { maxBuffer: 50 * 1024 * 1024 },
      (err) => {
        if (err) reject(err);
        else resolve();
      },
    );
  });
}

async function main(): Promise<void> {
  let pubs: PubWithSun[];
  try {
    pubs = JSON.parse(readFileSync(PUBS_JSON, "utf-8")) as PubWithSun[];
  } catch {
    console.error(`ERROR: ${PUBS_JSON} not found. Run the data pipeline first.`);
    process.exit(1);
  }

  const workerCount = pubs.length < 200 ? 1 : NUM_WORKERS;
  console.log(`Computing Sunny Rating for ${pubs.length} pubs with ${workerCount} workers...`);
  const t0 = Date.now();

  // Create temp dir for batch/result files.
  const tmpDir = join(ROOT, "data", "sun_tmp");
  if (!existsSync(tmpDir)) mkdirSync(tmpDir, { recursive: true });

  // Partition pubs across workers. Each worker gets a contiguous chunk.
  const chunkSize = Math.ceil(pubs.length / workerCount);
  const workerPromises: Promise<void>[] = [];

  for (let w = 0; w < workerCount; w++) {
    const start = w * chunkSize;
    const end = Math.min(start + chunkSize, pubs.length);
    if (start >= pubs.length) break;

    const batch = [];
    for (let i = start; i < end; i++) {
      batch.push({ index: i, pub: pubs[i]! });
    }

    const batchFile = join(tmpDir, `batch_${w}.json`);
    const resultFile = join(tmpDir, `result_${w}.json`);
    writeFileSync(batchFile, JSON.stringify(batch));

    workerPromises.push(runWorker(batchFile, resultFile));
    console.log(`  worker ${w}: pubs ${start}–${end - 1} (${batch.length} pubs)`);
  }

  console.log(`\nWaiting for ${workerPromises.length} workers...`);

  // Poll result files for progress while workers run.
  const progressFile = join(ROOT, "data", "sun_progress.json");
  const progressInterval = setInterval(() => {
    let totalDone = 0;
    let totalScored = 0;
    for (let w = 0; w < workerPromises.length; w++) {
      const rf = join(tmpDir, `result_${w}.json`);
      try {
        // Result file only exists once worker finishes — check batch file size
        // as a proxy. Instead, check if result exists = worker done.
        if (existsSync(rf)) {
          const data = JSON.parse(readFileSync(rf, "utf-8")) as { metrics: unknown }[];
          totalDone += data.length;
          totalScored += data.filter((r) => r.metrics !== null).length;
        }
      } catch {
        // Worker still running or file being written.
      }
    }
    const elapsed = (Date.now() - t0) / 1000;
    const rate = totalDone / elapsed;
    const eta = totalDone > 0 ? (pubs.length - totalDone) / rate : 0;
    const progress = {
      total: pubs.length,
      done: totalDone,
      scored: totalScored,
      rate: Math.round(rate * 10) / 10,
      eta_s: Math.round(eta),
      elapsed_s: Math.round(elapsed),
    };
    try {
      writeFileSync(progressFile, JSON.stringify(progress, null, 2));
    } catch {
      /* ignore */
    }
    if (totalDone > 0) {
      console.log(
        `  progress: ${totalDone}/${pubs.length} done, ${totalScored} scored, ` +
          `${rate.toFixed(1)}/s, ETA ${Math.round(eta)}s`,
      );
    }
  }, 30000); // every 30 seconds

  // Wait for all workers.
  const results = await Promise.allSettled(workerPromises);
  clearInterval(progressInterval);

  let scored = 0;
  let skipped = 0;
  const distribution: Record<string, number> = {};

  // Merge results back into pubs array.
  for (let w = 0; w < results.length; w++) {
    const r = results[w]!;
    if (r.status === "rejected") {
      console.error(`  worker ${w} FAILED:`, r.reason);
      continue;
    }

    const resultFile = join(tmpDir, `result_${w}.json`);
    type WorkResult = { index: number; metrics: SunMetrics | null };
    let workerResults: WorkResult[];
    try {
      workerResults = JSON.parse(readFileSync(resultFile, "utf-8")) as WorkResult[];
    } catch {
      console.error(`  worker ${w}: could not read result file`);
      continue;
    }

    for (const wr of workerResults) {
      if (wr.metrics) {
        pubs[wr.index]!.sun = wr.metrics;
        scored++;
        distribution[wr.metrics.label] = (distribution[wr.metrics.label] ?? 0) + 1;
      } else {
        skipped++;
      }
    }
    console.log(`  worker ${w}: merged ${workerResults.length} results`);
  }

  // Stats.
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\nDone in ${elapsed}s — ${scored} scored, ${skipped} skipped.`);
  console.log("Score distribution:");
  for (const label of ["Sun trap", "Very sunny", "Sunny", "Partly shaded", "Shaded"]) {
    const count = distribution[label] ?? 0;
    const pct = scored > 0 ? Math.round((count / scored) * 100) : 0;
    console.log(`  ${label.padEnd(15)} ${count.toString().padStart(4)}  ${pct}%`);
  }

  // Write to temp file then rename — prevents truncating pubs.json if the
  // process crashes mid-write (which zeroes the file and loses all data).
  const tmpPath = `${PUBS_JSON}.tmp`;
  const jsonStr = JSON.stringify(pubs);
  writeFileSync(tmpPath, jsonStr);
  const { renameSync } = await import("node:fs");
  renameSync(tmpPath, PUBS_JSON);
  const sizeKb = Math.round(jsonStr.length / 1024);
  console.log(`\nWritten back to ${PUBS_JSON} (${sizeKb} KB)`);

  // Clean up temp files.
  for (let w = 0; w < workerCount; w++) {
    try {
      const bf = join(tmpDir, `batch_${w}.json`);
      const rf = join(tmpDir, `result_${w}.json`);
      if (existsSync(bf)) writeFileSync(bf, ""); // truncate before unlink avoids large temp files
      if (existsSync(rf)) writeFileSync(rf, "");
    } catch {
      /* ignore */
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
