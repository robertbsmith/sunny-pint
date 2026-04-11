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
  renderCountryPage,
  renderCountyPage,
  renderExplorePage,
  renderThemePage,
  slugify,
  THEMES,
  type ThemeDef,
  type ExploreCountryStats,
  type ExploreCountyStats,
} from "../functions/_lib/render";
import {
  renderCountySvg,
  renderVoronoiSvg,
  renderCountryOverlay,
  type CountyData,
  type VoronoiPoint,
} from "../functions/_lib/geo_svg";

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
// Theme pages: skip entirely below this; emit but `noindex` between this
// and MIN_THEME_INDEX; emit normally above.
const MIN_THEME_PAGES = 4;
const MIN_THEME_INDEX = 8;

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
function resolveLastmod(state: LastmodState, key: string, hash: string, today: string): string {
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
    .map((e) => `  <url>\n    <loc>${e.url}</loc>\n    <lastmod>${e.lastmod}</lastmod>\n  </url>`)
    .join("\n");
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    `${body}\n` +
    `</urlset>\n`
  );
}

// ── Theme page noindex injection ─────────────────────────────────────────

/** Inject `<meta name="robots" content="noindex,follow">` into a rendered
 *  page. Used for theme pages that have too few matching pubs to deserve
 *  indexing — they exist for navigation but not for ranking. */
function injectNoindex(html: string): string {
  return html.replace("</head>", `    <meta name="robots" content="noindex,follow" />\n  </head>`);
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

async function main(): Promise<void> {
  const templatePath = join(DIST, "index.html");

  let template: string;
  try {
    template = readFileSync(templatePath, "utf-8");
  } catch {
    console.error(`ERROR: ${templatePath} not found. Run \`pnpm build\` first.`);
    process.exit(1);
  }

  let pubs: Pub[];
  const INDEX_JSON = join(ROOT, "public", "data", "pubs-index.json");
  const R2_INDEX_URL = "https://data.sunny-pint.co.uk/data/pubs-index.json";
  try {
    // Prefer full pubs.json (local pipeline), fall back to slim index
    // (local or R2). SEO pages only need name/slug/town/sun — all in the index.
    pubs = JSON.parse(readFileSync(PUBS_JSON, "utf-8")) as Pub[];
  } catch {
    try {
      pubs = JSON.parse(readFileSync(INDEX_JSON, "utf-8")) as Pub[];
    } catch {
      // Neither local file exists (CI/CD build) — fetch index from R2.
      console.log(`  Local pubs files not found, fetching from R2...`);
      try {
        const resp = await fetch(R2_INDEX_URL);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        pubs = (await resp.json()) as Pub[];
      } catch (err) {
        console.error(`ERROR: Could not load pub data from local files or R2: ${err}`);
        process.exit(1);
      }
    }
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
    .update(
      allQualifying
        .map((p) => `${p.slug ?? ""}:${hashPub(p)}`)
        .sort()
        .join("|"),
    )
    .digest("hex")
    .slice(0, 16);
  sitemapEntries.push({
    url: `${SITE_URL}/`,
    lastmod: resolveLastmod(lastmodState, "/", homeHash, today),
  });

  // City pages + theme pages.
  let cityChangedCount = 0;
  let themeEmitted = 0;
  let themeIndexed = 0;
  let themeNoindex = 0;
  let themeChangedCount = 0;

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

    // Theme pages: each (city, theme) emits its own /<city>/<theme>/ page.
    // The page is skipped entirely if too few pubs match the theme; emitted
    // with `noindex,follow` for borderline counts so it's still navigable
    // without polluting Google's index with thin pages; emitted normally
    // (and listed in the sitemap) once it has a proper number of matches.
    for (const theme of THEMES as ThemeDef[]) {
      const matched = townPubs.filter(theme.filter);
      if (matched.length < MIN_THEME_PAGES) continue;

      const indexed = matched.length >= MIN_THEME_INDEX;
      let themeHtml = renderThemePage(template, { town, country, theme, pubs: townPubs });
      if (!indexed) themeHtml = injectNoindex(themeHtml);

      const themeDir = join(DIST, slug, theme.slug);
      mkdirSync(themeDir, { recursive: true });
      writeFileSync(join(themeDir, "index.html"), themeHtml);
      themeEmitted++;

      if (indexed) {
        themeIndexed++;
        // Theme pages get their own sitemap entry, hashed on the matched
        // subset so renaming a pub or changing its rating only bumps the
        // theme pages it actually affects.
        const themeKey = `/${slug}/${theme.slug}/`;
        const themeHash = hashCity(matched);
        const wasThemeNew = lastmodState[themeKey]?.hash !== themeHash;
        if (wasThemeNew) themeChangedCount++;
        sitemapEntries.push({
          url: `${SITE_URL}${themeKey}`,
          lastmod: resolveLastmod(lastmodState, themeKey, themeHash, today),
        });
      } else {
        themeNoindex++;
      }
    }
  }

  if (themeEmitted > 0) {
    console.log(
      `  themes: ${themeEmitted} emitted (${themeIndexed} indexable, ${themeNoindex} noindex)`,
    );
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

  console.log(
    `  lastmod: ${cityChangedCount} cities + ${themeChangedCount} themes + ${pubChangedCount} pubs bumped (rest reuse previous date)`,
  );

  // ── Explore pages ─────────────────────────────────────────────────────

  const COUNTY_MAP_PATH = join(ROOT, "data", "county_map.json");
  const ONS_COUNTIES_PATH = join(ROOT, "data", "ons_counties.geojson");
  const ONS_COUNTRIES_PATH = join(ROOT, "data", "ons_countries.geojson");
  const MIN_COUNTY_PUBS = 8;
  const MIN_COUNTY_INDEX = 20;

  if (existsSync(COUNTY_MAP_PATH) && existsSync(ONS_COUNTIES_PATH)) {
    console.log("\n  Generating explore pages...");

    const countyMap: Record<string, { county: string; country: string }> =
      JSON.parse(readFileSync(COUNTY_MAP_PATH, "utf-8"));
    const onsCounties = JSON.parse(readFileSync(ONS_COUNTIES_PATH, "utf-8"));
    const onsCountries = existsSync(ONS_COUNTRIES_PATH)
      ? JSON.parse(readFileSync(ONS_COUNTRIES_PATH, "utf-8"))
      : null;

    // Group all qualifying pubs by county.
    const pubsByCounty = new Map<string, { country: string; pubs: Pub[] }>();
    for (const pub of allQualifying) {
      const la = (pub as Record<string, unknown>).local_authority as string | undefined;
      const mapping = la ? countyMap[la] : undefined;
      const county = (pub as Record<string, unknown>).county as string | undefined
        || mapping?.county;
      const country = pub.country || mapping?.country || "England";
      if (!county) continue;
      const entry = pubsByCounty.get(county) || { country, pubs: [] };
      entry.pubs.push(pub);
      pubsByCounty.set(county, entry);
    }

    // Build county stats.
    const allCountyStats: ExploreCountyStats[] = [];
    for (const [countyName, { country, pubs: countyPubs }] of pubsByCounty) {
      const scored = countyPubs.filter((p) => p.sun != null);
      const avgScore = scored.length > 0
        ? Math.round(scored.reduce((s, p) => s + (p.sun?.score ?? 0), 0) / scored.length)
        : null;

      // Group by town within county.
      const townGroups = groupByTown(countyPubs);
      const towns = [...townGroups.entries()]
        .map(([town, tPubs]) => {
          const tScored = tPubs.filter((p) => p.sun != null);
          const tAvg = tScored.length > 0
            ? Math.round(tScored.reduce((s, p) => s + (p.sun?.score ?? 0), 0) / tScored.length)
            : null;
          return { name: town, slug: slugify(town), pubCount: tPubs.length, avgScore: tAvg };
        })
        .sort((a, b) => b.pubCount - a.pubCount);

      const topPubs = [...countyPubs]
        .filter((p) => p.sun != null)
        .sort((a, b) => (b.sun?.score ?? 0) - (a.sun?.score ?? 0))
        .slice(0, 15);

      allCountyStats.push({
        name: countyName,
        slug: slugify(countyName),
        country,
        countrySlug: slugify(country),
        pubCount: countyPubs.length,
        avgScore,
        towns,
        topPubs,
      });
    }

    // Country stats.
    const countryNames = ["England", "Scotland", "Wales"];
    const countryStats: ExploreCountryStats[] = countryNames.map((name) => {
      const cPubs = allQualifying.filter((p) => p.country === name);
      const scored = cPubs.filter((p) => p.sun != null);
      const avgScore = scored.length > 0
        ? Math.round(scored.reduce((s, p) => s + (p.sun?.score ?? 0), 0) / scored.length)
        : null;
      return { name, slug: slugify(name), pubCount: cPubs.length, avgScore };
    }).filter((c) => c.pubCount > 0);

    // Top cities for the overview.
    const topCities = qualifyingTowns
      .sort(([, a], [, b]) => b.length - a.length)
      .slice(0, 20)
      .map(([town, tPubs]) => ({ name: town, slug: slugify(town), pubCount: tPubs.length }));

    // Build Voronoi SVG for the UK overview using 0.1° grid cells (~2.5k points)
    // instead of individual pubs (~28k) to keep the SVG lightweight.
    const gridCells = new Map<string, { lat: number; lng: number; scores: number[]; count: number }>();
    for (const p of allQualifying.filter((p) => p.sun != null)) {
      const cellLat = Math.floor(p.lat * 10) / 10 + 0.05; // cell centroid
      const cellLng = Math.floor(p.lng * 10) / 10 + 0.05;
      const key = `${cellLat}_${cellLng}`;
      const cell = gridCells.get(key) || { lat: cellLat, lng: cellLng, scores: [], count: 0 };
      cell.scores.push(p.sun?.score ?? 0);
      cell.count++;
      gridCells.set(key, cell);
    }

    const voronoiPoints: VoronoiPoint[] = [...gridCells.values()].map((cell) => {
      const avgScore = Math.round(cell.scores.reduce((a, b) => a + b, 0) / cell.scores.length);
      return {
        lng: cell.lng,
        lat: cell.lat,
        score: avgScore,
        label: `${cell.count} pubs, avg ${avgScore}/100`,
        href: "/explore/",
      };
    });

    const countryOverlay = onsCountries
      ? renderCountryOverlay(onsCountries.features)
      : "";
    const ukMapSvg = voronoiPoints.length > 10
      ? renderVoronoiSvg(voronoiPoints, { overlayPaths: countryOverlay })
      : "";
    console.log(`  Voronoi map: ${voronoiPoints.length} grid cells`);

    // Build county boundary SVG data for country pages.
    const countyDataMap = new Map<string, CountyData>();
    for (const cs of allCountyStats) {
      countyDataMap.set(cs.name, {
        name: cs.name,
        slug: cs.slug,
        country: cs.country,
        pubCount: cs.pubCount,
        avgScore: cs.avgScore,
      });
    }

    // /explore/ overview page.
    const exploreDir = join(DIST, "explore");
    mkdirSync(exploreDir, { recursive: true });
    writeFileSync(
      join(exploreDir, "index.html"),
      renderExplorePage(template, countryStats, ukMapSvg, topCities, allQualifying.length),
    );
    const exploreKey = "/explore/";
    const exploreHash = createHash("sha256")
      .update(allQualifying.length.toString())
      .digest("hex")
      .slice(0, 16);
    sitemapEntries.push({
      url: `${SITE_URL}${exploreKey}`,
      lastmod: resolveLastmod(lastmodState, exploreKey, exploreHash, today),
    });
    console.log(`  /explore/  (${allQualifying.length} pubs)`);

    // Country pages.
    for (const cs of countryStats) {
      const countryCounties = allCountyStats.filter((c) => c.country === cs.name);
      const countrySvg = renderCountySvg(onsCounties.features, countyDataMap, {
        countryFilter: cs.name,
        linkPrefix: "/explore/",
      });

      const countryDir = join(exploreDir, cs.slug);
      mkdirSync(countryDir, { recursive: true });
      writeFileSync(
        join(countryDir, "index.html"),
        renderCountryPage(template, cs.name, cs.slug, countryCounties, countrySvg, cs.pubCount),
      );
      const countryKey = `/explore/${cs.slug}/`;
      sitemapEntries.push({
        url: `${SITE_URL}${countryKey}`,
        lastmod: resolveLastmod(lastmodState, countryKey, cs.pubCount.toString(), today),
      });
      console.log(`  /explore/${cs.slug}/  (${countryCounties.length} counties, ${cs.pubCount} pubs)`);

      // County pages.
      let countyEmitted = 0;
      for (const county of countryCounties) {
        if (county.pubCount < MIN_COUNTY_PUBS) continue;

        let countyHtml = renderCountyPage(template, county);
        if (county.pubCount < MIN_COUNTY_INDEX) {
          countyHtml = injectNoindex(countyHtml);
        }

        const countyDir = join(exploreDir, cs.slug, county.slug);
        mkdirSync(countyDir, { recursive: true });
        writeFileSync(join(countyDir, "index.html"), countyHtml);
        countyEmitted++;

        if (county.pubCount >= MIN_COUNTY_INDEX) {
          const countyKey = `/explore/${cs.slug}/${county.slug}/`;
          sitemapEntries.push({
            url: `${SITE_URL}${countyKey}`,
            lastmod: resolveLastmod(lastmodState, countyKey, county.pubCount.toString(), today),
          });
        }
      }
      console.log(`    ${countyEmitted} county pages emitted`);
    }
  } else {
    console.log("\n  Skipping explore pages (county_map.json or ONS boundaries not found)");
  }

  // ── Finalize ────────────────────────────────────────────────────────

  saveLastmodState(lastmodState);

  const sitemap = renderSitemap(sitemapEntries);
  writeFileSync(join(DIST, "sitemap.xml"), sitemap);
  console.log(
    `\n  /sitemap.xml (${sitemapEntries.length} URLs)`,
  );

  // 404.
  writeFileSync(join(DIST, "404.html"), render404(template));
  console.log("  /404.html");

  console.log(`\nDone.`);
}

main();
