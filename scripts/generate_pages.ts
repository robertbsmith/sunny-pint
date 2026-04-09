/**
 * Build-time SEO landing-page generator (TypeScript).
 *
 * Replaces the previous Python `generate_pages.py`. Imports the same shared
 * renderer used by the Cloudflare Pages Function, so static city pages and
 * runtime per-pub pages produce identical HTML structure, meta tags, and
 * structured data — one source of truth.
 *
 * Runs AFTER `vite build` so it can template off `dist/index.html` (which
 * already has Vite's production-hashed asset paths baked in).
 *
 * Outputs:
 *   dist/<town-slug>/index.html       One per qualifying town
 *   dist/sitemap.xml                  Homepage + cities + every per-pub URL
 *   dist/404.html                     Lightweight, noindex
 *
 * Per-pub URLs are NOT generated as files — the Pages Function in
 * `functions/pub/[slug].ts` renders them on demand. The sitemap still lists
 * them so Google discovers them.
 *
 * Run with:
 *   pnpm tsx scripts/generate_pages.ts
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  groupByTown,
  type Pub,
  qualifying,
  renderCityPage,
  slugify,
} from "../functions/_lib/render";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const DIST = join(ROOT, "dist");
const PUBS_JSON = join(ROOT, "public", "data", "pubs.json");
const LASTMOD_STATE = join(ROOT, "data", "lastmod_state.json");

const SITE_URL = "https://sunny-pint.co.uk";

// Only emit a landing page for a town with at least this many qualifying pubs.
// Below this we'd be shipping thin content that the March 2026 Google update
// specifically targets for de-indexing.
const MIN_PUBS_PER_CITY = 8;

// ── Hash-diffed lastmod state ───────────────────────────────────────────
//
// We persist a per-URL hash of the user-visible content. On each release
// the generator compares the new hash to the old; if unchanged, it keeps
// the previous lastmod date. Only genuinely-changed URLs get a fresh
// lastmod, so the sitemap carries truthful crawl-freshness signals
// instead of telling Google to recrawl ~16k pages on every release.

interface LastmodEntry {
  hash: string;
  lastmod: string;
}

type LastmodState = Record<string, LastmodEntry>;

function loadLastmodState(): LastmodState {
  if (!existsSync(LASTMOD_STATE)) return {};
  try {
    return JSON.parse(readFileSync(LASTMOD_STATE, "utf-8")) as LastmodState;
  } catch {
    console.warn(`  WARNING: ${LASTMOD_STATE} is corrupted, starting fresh`);
    return {};
  }
}

function saveLastmodState(state: LastmodState): void {
  // Sorted keys for stable diffs.
  const sorted = Object.fromEntries(Object.entries(state).sort(([a], [b]) => a.localeCompare(b)));
  mkdirSync(dirname(LASTMOD_STATE), { recursive: true });
  writeFileSync(LASTMOD_STATE, JSON.stringify(sorted, null, 2));
}

/** Hash a pub's user-visible fields. Anything that affects what Google
 *  would actually see on the rendered page goes in here; pipeline-internal
 *  fields are deliberately excluded. */
function hashPub(pub: Pub): string {
  const payload = JSON.stringify({
    name: pub.name,
    town: pub.town,
    country: pub.country,
    sun: pub.sun,
    outdoor_area_m2: pub.outdoor_area_m2,
    opening_hours: pub.opening_hours,
    brand: pub.brand,
    brewery: pub.brewery,
  });
  return createHash("sha256").update(payload).digest("hex").slice(0, 16);
}

/** Hash a city page's content. Bumps if any pub in the city changes, OR
 *  if the city's pub count changes. */
function hashCity(townPubs: Pub[]): string {
  const payload = townPubs
    .map((p) => `${p.slug ?? ""}:${hashPub(p)}`)
    .sort()
    .join("|");
  return createHash("sha256").update(payload).digest("hex").slice(0, 16);
}

/** Decide a URL's lastmod by comparing its hash to the previous run.
 *  Mutates `state` in place to record the new hash + lastmod. */
function resolveLastmod(
  state: LastmodState,
  key: string,
  hash: string,
  today: string,
): string {
  const prev = state[key];
  if (prev && prev.hash === hash) {
    return prev.lastmod;
  }
  state[key] = { hash, lastmod: today };
  return today;
}

// ── Sitemap ──────────────────────────────────────────────────────────────

interface SitemapEntry {
  url: string;
  lastmod: string;
}

function renderSitemap(entries: SitemapEntry[]): string {
  const body = entries
    .map(
      (e) =>
        `  <url>\n    <loc>${e.url}</loc>\n    <lastmod>${e.lastmod}</lastmod>\n  </url>`,
    )
    .join("\n");
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    `${body}\n` +
    `</urlset>\n`
  );
}

// ── 404 page ─────────────────────────────────────────────────────────────

function render404(template: string): string {
  let out = template;
  out = out.replace(/<title>[^<]*<\/title>/, `<title>Page not found — Sunny Pint</title>`);
  out = out.replace("</head>", `    <meta name="robots" content="noindex" />\n  </head>`);
  out = out.replace(
    /<section id="seo-intro"[^>]*>[\s\S]*?<\/section>/,
    `<section id="seo-intro" class="seo-intro seo-intro--landing">\n` +
      `  <h1>Pub not found</h1>\n` +
      `  <p>That URL doesn't match a pub or city we know about. ` +
      `Try the <a href="/">homepage</a> or use the location search to find a pub near you.</p>\n` +
      `</section>`,
  );
  return out;
}

// ── Main ─────────────────────────────────────────────────────────────────

function main(): void {
  const templatePath = join(DIST, "index.html");

  let template: string;
  try {
    template = readFileSync(templatePath, "utf-8");
  } catch {
    console.error(`ERROR: ${templatePath} not found. Run \`pnpm build\` first.`);
    process.exit(1);
  }

  let pubs: Pub[];
  try {
    pubs = JSON.parse(readFileSync(PUBS_JSON, "utf-8")) as Pub[];
  } catch {
    console.error(`ERROR: ${PUBS_JSON} not found. Run the data pipeline first.`);
    process.exit(1);
  }

  console.log(`Loaded ${pubs.length} pubs from ${PUBS_JSON}`);

  // City pages.
  const groups = groupByTown(pubs);
  const qualifyingTowns = [...groups.entries()].filter(([, ps]) => ps.length >= MIN_PUBS_PER_CITY);
  console.log(
    `  ${qualifyingTowns.length} towns with ≥${MIN_PUBS_PER_CITY} qualifying pubs ` +
      `(out of ${groups.size} total)`,
  );

  // Hash-diffed lastmod tracking — only bump per-URL freshness when the
  // user-visible content actually changes. Without this, every release
  // would tell Google to recrawl every URL whether or not anything changed.
  const lastmodState = loadLastmodState();
  const today = new Date().toISOString().slice(0, 10);
  const sitemapEntries: SitemapEntry[] = [];

  // Homepage lastmod: bumps when any qualifying pub or city changes,
  // since the homepage's "browse" experience depends on the underlying
  // index. Compute a hash over all qualifying pubs.
  const allQualifying = pubs.filter(qualifying);
  const homeHash = createHash("sha256")
    .update(allQualifying.map((p) => `${p.slug ?? ""}:${hashPub(p)}`).sort().join("|"))
    .digest("hex")
    .slice(0, 16);
  sitemapEntries.push({
    url: `${SITE_URL}/`,
    lastmod: resolveLastmod(lastmodState, "/", homeHash, today),
  });

  // City pages
  let cityChangedCount = 0;
  for (const [town, townPubs] of qualifyingTowns.sort(([a], [b]) => a.localeCompare(b))) {
    const country = townPubs[0]?.country ?? "England";
    const slug = slugify(town);
    const html = renderCityPage(template, { town, country, pubs: townPubs });
    const outDir = join(DIST, slug);
    mkdirSync(outDir, { recursive: true });
    const outPath = join(outDir, "index.html");
    writeFileSync(outPath, html);
    const sizeKb = Math.round(html.length / 1024);

    const cityKey = `/${slug}/`;
    const cityHash = hashCity(townPubs);
    const wasNew = lastmodState[cityKey]?.hash !== cityHash;
    if (wasNew) cityChangedCount++;
    sitemapEntries.push({
      url: `${SITE_URL}${cityKey}`,
      lastmod: resolveLastmod(lastmodState, cityKey, cityHash, today),
    });

    console.log(`  /${slug}/  (${townPubs.length} pubs, ${sizeKb} KB)`);
  }

  // Per-pub URLs — served by the Function but listed in the sitemap so
  // crawlers discover them. Each pub's lastmod independently tracks its
  // own data, so renaming a pub or changing its sun rating is a per-URL
  // freshness bump rather than a site-wide one.
  let pubChangedCount = 0;
  const pubSlugList = allQualifying
    .map((p) => p.slug)
    .filter((s): s is string => !!s)
    .sort();
  for (const slug of pubSlugList) {
    const pub = allQualifying.find((p) => p.slug === slug);
    if (!pub) continue;
    const key = `/pub/${slug}/`;
    const hash = hashPub(pub);
    const wasNew = lastmodState[key]?.hash !== hash;
    if (wasNew) pubChangedCount++;
    sitemapEntries.push({
      url: `${SITE_URL}${key}`,
      lastmod: resolveLastmod(lastmodState, key, hash, today),
    });
  }

  saveLastmodState(lastmodState);

  const sitemap = renderSitemap(sitemapEntries);
  writeFileSync(join(DIST, "sitemap.xml"), sitemap);
  console.log(
    `  /sitemap.xml (${sitemapEntries.length} URLs: ` +
      `1 home + ${qualifyingTowns.length} cities + ${pubSlugList.length} pubs)`,
  );
  console.log(
    `  lastmod: ${cityChangedCount} cities + ${pubChangedCount} pubs bumped (rest reuse previous date)`,
  );

  // 404.
  writeFileSync(join(DIST, "404.html"), render404(template));
  console.log("  /404.html");

  console.log(`\nDone. ${qualifyingTowns.length} city pages emitted to ${DIST}.`);
}

main();
