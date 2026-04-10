/**
 * Worker process for precompute_sun.ts.
 *
 * Invoked as: pnpm tsx scripts/precompute_sun_worker.ts <batch.json> <result.json>
 *
 * Reads a batch of {index, pub} items, computes SunMetrics for each,
 * writes [{index, metrics}] to the result file. Exits 0 on success.
 */

import { readFileSync, writeFileSync } from "node:fs";

import SunCalc from "suncalc";

import { M_PER_DEG_LAT } from "../src/config";
import { mPerDegLng } from "../src/geo";
import { computeShadows, isTerrainOccluded } from "../src/shadow";
import type { Pub } from "../src/types";
import { loadBuildingsForPub } from "./lib/tiles_node";

// ── Tunables (must match precompute_sun.ts) ─────────────────────────────

const SAMPLE_MINUTES = 30;
const NUM_SAMPLE_POINTS = 200;
const MAX_REJECTION_TRIES = NUM_SAMPLE_POINTS * 50;
const SAMPLE_DAY = new Date(2026, 2, 20, 12, 0, 0);
const SUN_THRESHOLD = 0.5;
const PREDICATE_THRESHOLD = 0.3;
const MORNING_WINDOW: [number, number] = [9, 12];
const MIDDAY_WINDOW: [number, number] = [12, 15];
const EVENING_WINDOW: [number, number] = [17, 20];

// ── Geometry helpers ────────────────────────────────────────────────────

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

function pointInPolygon(x: number, y: number, polygon: XY[][]): boolean {
  if (polygon.length === 0) return false;
  if (!pointInRing(x, y, polygon[0]!)) return false;
  for (let i = 1; i < polygon.length; i++) {
    if (pointInRing(x, y, polygon[i]!)) return false;
  }
  return true;
}

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

// ── Sun metrics ─────────────────────────────────────────────────────────

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

async function computeSunMetrics(pub: Pub): Promise<SunMetrics | null> {
  if (!pub.outdoor || pub.outdoor.length === 0) return null;

  const frame = makeFrame(pub.clat ?? pub.lat, pub.clng ?? pub.lng);
  const outdoorPoly: XY[][] = pub.outdoor.map((r) => projectRing(r, frame));
  const outdoorArea = polygonArea(outdoorPoly);
  if (outdoorArea <= 0) return null;

  const seed = Math.floor((pub.lat + pub.lng) * 1e6);
  const samplePoints = samplePointsInside(outdoorPoly, NUM_SAMPLE_POINTS, seed);
  if (samplePoints.length === 0) return null;

  const buildings = await loadBuildingsForPub(pub);

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

    const projectedQuads: XY[][] = shadowQuads.map((q) => projectRing(q, frame));

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

  return {
    score,
    label: scoreLabel(score),
    best_window: bestWindow(samples),
    morning_sun: morningAvg >= PREDICATE_THRESHOLD,
    midday_sun: middayAvg >= PREDICATE_THRESHOLD,
    evening_sun: eveningAvg >= PREDICATE_THRESHOLD,
    all_day_sun:
      morningAvg >= PREDICATE_THRESHOLD &&
      middayAvg >= PREDICATE_THRESHOLD &&
      eveningAvg >= PREDICATE_THRESHOLD,
    sample_day: SAMPLE_DAY.toISOString().slice(0, 10),
  };
}

// ── CLI entry point ─────────────────────────────────────────────────────

interface WorkItem {
  index: number;
  pub: Pub;
}

interface WorkResult {
  index: number;
  metrics: SunMetrics | null;
}

const [batchFile, resultFile] = process.argv.slice(2);
if (!batchFile || !resultFile) {
  console.error("Usage: pnpm tsx scripts/precompute_sun_worker.ts <batch.json> <result.json>");
  process.exit(1);
}

const batch: WorkItem[] = JSON.parse(readFileSync(batchFile, "utf-8"));
const results: WorkResult[] = [];

for (const item of batch) {
  try {
    const metrics = await computeSunMetrics(item.pub);
    results.push({ index: item.index, metrics });
  } catch {
    results.push({ index: item.index, metrics: null });
  }

  if (results.length % 25 === 0) {
    const scored = results.filter(r => r.metrics !== null).length;
    process.stderr.write(
      `  worker ${process.pid}: ${results.length}/${batch.length} (${scored} scored)\n`
    );
  }
}

writeFileSync(resultFile, JSON.stringify(results));
