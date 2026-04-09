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

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

const SITE_URL = "https://sunny-pint.co.uk";

// Only emit a landing page for a town with at least this many qualifying pubs.
// Below this we'd be shipping thin content that the March 2026 Google update
// specifically targets for de-indexing.
const MIN_PUBS_PER_CITY = 8;

// ── Sitemap ──────────────────────────────────────────────────────────────

function renderSitemap(citySlugs: string[], pubSlugs: string[]): string {
  const today = new Date().toISOString().slice(0, 10);
  const urls = [
    `${SITE_URL}/`,
    ...citySlugs.map((s) => `${SITE_URL}/${s}/`),
    ...pubSlugs.map((s) => `${SITE_URL}/pub/${s}/`),
  ];
  const body = urls
    .map((u) => `  <url>\n    <loc>${u}</loc>\n    <lastmod>${today}</lastmod>\n  </url>`)
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

  const emittedSlugs: string[] = [];
  for (const [town, townPubs] of qualifyingTowns.sort(([a], [b]) => a.localeCompare(b))) {
    const country = townPubs[0]?.country ?? "England";
    const slug = slugify(town);
    const html = renderCityPage(template, { town, country, pubs: townPubs });
    const outDir = join(DIST, slug);
    mkdirSync(outDir, { recursive: true });
    const outPath = join(outDir, "index.html");
    writeFileSync(outPath, html);
    const sizeKb = Math.round(html.length / 1024);
    console.log(`  /${slug}/  (${townPubs.length} pubs, ${sizeKb} KB)`);
    emittedSlugs.push(slug);
  }

  // Sitemap — includes every qualifying pub, even though no static file
  // exists. The Pages Function in functions/pub/[slug].ts will serve them
  // on demand when crawled.
  const pubSlugs = pubs
    .filter(qualifying)
    .map((p) => p.slug)
    .filter((s): s is string => !!s)
    .sort();

  const sitemap = renderSitemap(emittedSlugs, pubSlugs);
  writeFileSync(join(DIST, "sitemap.xml"), sitemap);
  console.log(
    `  /sitemap.xml (${1 + emittedSlugs.length + pubSlugs.length} URLs: ` +
      `1 home + ${emittedSlugs.length} cities + ${pubSlugs.length} pubs)`,
  );

  // 404.
  writeFileSync(join(DIST, "404.html"), render404(template));
  console.log("  /404.html");

  console.log(`\nDone. ${emittedSlugs.length} city pages emitted to ${DIST}.`);
}

main();
