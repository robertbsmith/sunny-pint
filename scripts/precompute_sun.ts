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

import SunCalc from "suncalc";

import { M_PER_DEG_LAT } from "../src/config";
import { mPerDegLng } from "../src/geo";
import { computeShadows, isTerrainOccluded } from "../src/shadow";
import type { Pub } from "../src/types";
import { loadBuildingsForPub } from "./lib/tiles_node";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const PUBS_JSON = join(ROOT, "public", "data", "pubs.json");

// ── Tunables ─────────────────────────────────────────────────────────────

/** Sample interval for sun positions across daylight hours. */
const SAMPLE_MINUTES = 30;

/** Number of random points sampled inside each pub's outdoor polygon to
 *  estimate sun fraction. 200 gives ~7% standard error per sample which
 *  averages out across 24 sun positions to ~1.5% on the final score. */
const NUM_SAMPLE_POINTS = 200;

/** Maximum rejection-sampling attempts before giving up — guards against
 *  pathological polygons where rejection rate is very high. */
const MAX_REJECTION_TRIES = NUM_SAMPLE_POINTS * 50;

/** Sunny Rating sample day — spring equinox. Day length is exactly 12h at
 *  every latitude, so scores are directly comparable across the UK. */
const SAMPLE_DAY = new Date(2026, 2, 20, 12, 0, 0);

/** Threshold for "this slot has meaningful sun" used by best-window detection
 *  and the morning/midday/evening predicates. */
const SUN_THRESHOLD = 0.5;
const PREDICATE_THRESHOLD = 0.3;

// Time windows (in hours from midnight, local time) for the bonus predicates.
const MORNING_WINDOW: [number, number] = [9, 12];
const MIDDAY_WINDOW: [number, number] = [12, 15];
const EVENING_WINDOW: [number, number] = [17, 20];

// (Tile loader lives in scripts/lib/tiles_node.ts — shared with the OG renderer.)

// ── Local-metres projection ──────────────────────────────────────────────
//
// We project lat/lng → metres in a small flat-earth frame centred on the
// pub. The pub-radius is ~250m so equirectangular distortion is negligible.
// All sun-fraction math operates in this 2D metres space.

type XY = [number, number];

interface Frame {
  lat0: number;
  lng0: number;
  mPerLng: number;
}

function makeFrame(lat: number, lng: number): Frame {
  return { lat0: lat, lng0: lng, mPerLng: mPerDegLng(lat) };
}

function projectPoint([lat, lng]: [number, number], frame: Frame): XY {
  return [(lng - frame.lng0) * frame.mPerLng, (lat - frame.lat0) * M_PER_DEG_LAT];
}

function projectRing(ring: [number, number][], frame: Frame): XY[] {
  const out: XY[] = new Array(ring.length);
  for (let i = 0; i < ring.length; i++) out[i] = projectPoint(ring[i]!, frame);
  return out;
}

// ── Point-in-polygon (ray-casting) ───────────────────────────────────────

/** Standard ray-cast point-in-polygon test on a single ring. */
function pointInRing(x: number, y: number, ring: XY[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i]!;
    const b = ring[j]!;
    const yi = a[1];
    const yj = b[1];
    if (yi > y !== yj > y) {
      const t = (b[0] - a[0]) * (y - yi);
      const u = yj - yi;
      if (u !== 0 && x < t / u + a[0]) inside = !inside;
    }
  }
  return inside;
}

/** Test against a ringed polygon (first ring exterior, rest are holes). */
function pointInPolygon(x: number, y: number, polygon: XY[][]): boolean {
  if (polygon.length === 0) return false;
  if (!pointInRing(x, y, polygon[0]!)) return false;
  for (let i = 1; i < polygon.length; i++) {
    if (pointInRing(x, y, polygon[i]!)) return false; // inside a hole
  }
  return true;
}

// ── Random sample-points inside an outdoor polygon ───────────────────────
//
// Rejection sampling: pick uniformly in the bbox, keep points that pass
// the point-in-polygon test. Since pubs vary widely in shape, this is
// simpler and more robust than triangulating + area-weighted sampling.

function ringBbox(rings: XY[][]): [number, number, number, number] {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of rings[0]!) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return [minX, minY, maxX, maxY];
}

/**
 * Deterministic PRNG (mulberry32) seeded from the pub centroid so re-runs
 * produce identical Sunny Ratings — important for stable sitemap lastmod
 * diffing and reproducible test runs.
 */
function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return function rng(): number {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function samplePointsInside(polygon: XY[][], n: number, seed: number): XY[] {
  const [minX, minY, maxX, maxY] = ringBbox(polygon);
  const w = maxX - minX;
  const h = maxY - minY;
  if (w <= 0 || h <= 0) return [];
  const rng = makeRng(seed);
  const points: XY[] = [];
  let tries = 0;
  while (points.length < n && tries < MAX_REJECTION_TRIES) {
    const x = minX + rng() * w;
    const y = minY + rng() * h;
    tries++;
    if (pointInPolygon(x, y, polygon)) points.push([x, y]);
  }
  return points;
}

// ── Polygon area via shoelace (used for sanity checks) ───────────────────

function ringSignedArea(ring: XY[]): number {
  let s = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i]!;
    const b = ring[j]!;
    s += (b[0] - a[0]) * (b[1] + a[1]);
  }
  return s / 2;
}

function polygonArea(polygon: XY[][]): number {
  if (polygon.length === 0) return 0;
  let area = Math.abs(ringSignedArea(polygon[0]!));
  for (let i = 1; i < polygon.length; i++) {
    area -= Math.abs(ringSignedArea(polygon[i]!));
  }
  return area;
}

// ── Single-pub computation ───────────────────────────────────────────────

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

function scoreLabel(score: number): string {
  if (score >= 80) return "Sun trap";
  if (score >= 60) return "Very sunny";
  if (score >= 40) return "Sunny";
  if (score >= 20) return "Partly shaded";
  return "Shaded";
}

interface Sample {
  date: Date;
  fraction: number;
}

function bestWindow(samples: Sample[]): string | null {
  let bestStart = -1;
  let bestEnd = -1;
  let bestLen = 0;
  let curStart = -1;
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i]!;
    if (s.fraction >= SUN_THRESHOLD) {
      if (curStart === -1) curStart = i;
      const len = i - curStart + 1;
      if (len > bestLen) {
        bestLen = len;
        bestStart = curStart;
        bestEnd = i;
      }
    } else {
      curStart = -1;
    }
  }
  if (bestStart === -1 || bestLen < 2) return null;
  const fmt = (d: Date) =>
    `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  return `${fmt(samples[bestStart]!.date)}–${fmt(samples[bestEnd]!.date)}`;
}

function windowAverage(samples: Sample[], window: [number, number]): number {
  const inWin = samples.filter((s) => {
    const h = s.date.getHours() + s.date.getMinutes() / 60;
    return h >= window[0] && h < window[1];
  });
  if (inWin.length === 0) return 0;
  return inWin.reduce((a, b) => a + b.fraction, 0) / inWin.length;
}

function computeSunMetrics(pub: Pub): SunMetrics | null {
  if (!pub.outdoor || pub.outdoor.length === 0) return null;

  const frame = makeFrame(pub.clat ?? pub.lat, pub.clng ?? pub.lng);
  const outdoorPoly: XY[][] = pub.outdoor.map((r) => projectRing(r, frame));
  const outdoorArea = polygonArea(outdoorPoly);
  if (outdoorArea <= 0) return null;

  // Generate sample points once per pub. Seeded by pub coords so re-runs
  // produce identical results — stable Sunny Ratings across pipeline runs.
  const seed = Math.floor((pub.lat + pub.lng) * 1e6);
  const samplePoints = samplePointsInside(outdoorPoly, NUM_SAMPLE_POINTS, seed);
  if (samplePoints.length === 0) return null;

  const buildings = loadBuildingsForPub(pub);

  // Sunrise / sunset for the equinox at this pub's coordinates.
  const times = SunCalc.getTimes(SAMPLE_DAY, pub.lat, pub.lng);
  if (Number.isNaN(times.sunrise.getTime()) || Number.isNaN(times.sunset.getTime())) {
    return null;
  }

  const samples: Sample[] = [];
  for (
    let t = times.sunrise.getTime();
    t < times.sunset.getTime();
    t += SAMPLE_MINUTES * 60 * 1000
  ) {
    const date = new Date(t);
    const pos = SunCalc.getPosition(date, pub.lat, pub.lng);
    const sun = {
      azimuth: ((pos.azimuth * 180) / Math.PI + 180) % 360,
      altitude: (pos.altitude * 180) / Math.PI,
    };

    if (sun.altitude <= 0 || isTerrainOccluded(pub, sun)) {
      samples.push({ date, fraction: 0 });
      continue;
    }

    const shadowQuads = computeShadows(buildings, sun, pub.elev ?? 0);
    if (shadowQuads.length === 0) {
      samples.push({ date, fraction: 1 });
      continue;
    }

    // Project all shadow quads to local metres once per sun position.
    // Each quad becomes an XY[] (4 points; pointInRing handles unclosed rings).
    const projectedQuads: XY[][] = shadowQuads.map((q) => projectRing(q, frame));

    // For each sample point, check if it's covered by ANY shadow. The
    // first hit is enough — we don't care which quad shadows the point.
    let sunlitCount = 0;
    for (const [px, py] of samplePoints) {
      let shadowed = false;
      for (let i = 0; i < projectedQuads.length; i++) {
        if (pointInRing(px, py, projectedQuads[i]!)) {
          shadowed = true;
          break;
        }
      }
      if (!shadowed) sunlitCount++;
    }

    const fraction = sunlitCount / samplePoints.length;
    samples.push({ date, fraction });
  }

  if (samples.length === 0) return null;

  const avg = samples.reduce((a, b) => a + b.fraction, 0) / samples.length;
  const score = Math.round(avg * 100);

  const morningAvg = windowAverage(samples, MORNING_WINDOW);
  const middayAvg = windowAverage(samples, MIDDAY_WINDOW);
  const eveningAvg = windowAverage(samples, EVENING_WINDOW);

  const morning_sun = morningAvg >= PREDICATE_THRESHOLD;
  const midday_sun = middayAvg >= PREDICATE_THRESHOLD;
  const evening_sun = eveningAvg >= PREDICATE_THRESHOLD;
  const all_day_sun = morning_sun && midday_sun && evening_sun;

  return {
    score,
    label: scoreLabel(score),
    best_window: bestWindow(samples),
    morning_sun,
    midday_sun,
    evening_sun,
    all_day_sun,
    sample_day: SAMPLE_DAY.toISOString().slice(0, 10),
  };
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
    } catch { /* ignore */ }
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

  writeFileSync(PUBS_JSON, JSON.stringify(pubs));
  const sizeKb = Math.round(JSON.stringify(pubs).length / 1024);
  console.log(`\nWritten back to ${PUBS_JSON} (${sizeKb} KB)`);

  // Clean up temp files.
  for (let w = 0; w < workerCount; w++) {
    try {
      const bf = join(tmpDir, `batch_${w}.json`);
      const rf = join(tmpDir, `result_${w}.json`);
      if (existsSync(bf)) writeFileSync(bf, ""); // truncate before unlink avoids large temp files
      if (existsSync(rf)) writeFileSync(rf, "");
    } catch { /* ignore */ }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
