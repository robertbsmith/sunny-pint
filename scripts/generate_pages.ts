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
 *   dist/sitemap.xml                  Sitemap index — references the children below
 *   dist/sitemap-core.xml             Homepage + explore pages
 *   dist/sitemap-cities.xml           City + theme landing pages
 *   dist/sitemap-pubs-en-a-m.xml      English pub URLs, slugs a-m
 *   dist/sitemap-pubs-en-n-z.xml      English pub URLs, slugs n-z
 *   dist/sitemap-pubs-scotland.xml    Scottish pub URLs
 *   dist/sitemap-pubs-wales.xml       Welsh pub URLs
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
import { type CountyData, renderCountySvg } from "../functions/_lib/geo_svg";
import {
  type ExploreCountryStats,
  type ExploreCountyStats,
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
} from "../functions/_lib/render";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const DIST = join(ROOT, "dist");
const PUBS_JSON = join(ROOT, "public", "data", "pubs.json");
const LASTMOD_STATE = join(ROOT, "data", "lastmod_state.json");

const SITE_URL = "https://sunny-pint.co.uk";

// Only emit a landing page for a town with at least this many qualifying
// pubs. Below this we'd be shipping thin content that the March 2026
// Google update specifically targets for de-indexing.
//
// Originally 8 (very conservative). Lowered to 3 once the Sunny Rating
// proved to be genuinely unique per-pub content — a 3-pub city page with
// individual sun scores is not templated spam. Unlocks ~800 additional
// town landing pages (599 → ~1,400 towns). Revisit if Google's
// "Crawled - currently not indexed" count spikes.
const MIN_PUBS_PER_CITY = 3;
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

/** Render a sitemap index pointing at child sitemaps. Each child's lastmod is
 *  the max lastmod across URLs inside it — Google uses this to decide whether
 *  to re-fetch the child. */
function renderSitemapIndex(children: { filename: string; lastmod: string }[]): string {
  const body = children
    .map(
      (c) =>
        `  <sitemap>\n    <loc>${SITE_URL}/${c.filename}</loc>\n    <lastmod>${c.lastmod}</lastmod>\n  </sitemap>`,
    )
    .join("\n");
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    `${body}\n` +
    `</sitemapindex>\n`
  );
}

/** Slug bucket for English pubs: slugs starting 'a'-'m' vs 'n'-'z'.
 *  Non-alphabetical leading characters (digits, hyphens) fall into 'am'.
 *  Strips a leading "the-" because ~60% of pub slugs start with it; bucketing
 *  on the raw first char would put everything in n-z. */
function englishPubBucket(slug: string): "am" | "nz" {
  const key = slug.startsWith("the-") ? slug.slice(4) : slug;
  const first = key.charCodeAt(0);
  // 'n' = 110 — everything before n (including digits, hyphens, a-m) goes to am.
  return first < 110 ? "am" : "nz";
}

function maxLastmod(entries: SitemapEntry[]): string {
  const first = entries[0];
  if (!first) return new Date().toISOString().slice(0, 10);
  return entries.reduce((m, e) => (e.lastmod > m ? e.lastmod : m), first.lastmod);
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

  // Sitemap URLs are bucketed by type + geography so each child sitemap stays
  // under the ~30k-URL processing sweet spot and Google Search Console shows
  // per-segment indexing stats. See docs/INFRA_AUDIT.md for rationale.
  const coreEntries: SitemapEntry[] = []; // homepage + explore pages
  const cityEntries: SitemapEntry[] = []; // city + theme landing pages
  const pubsEnglandAM: SitemapEntry[] = [];
  const pubsEnglandNZ: SitemapEntry[] = [];
  const pubsScotland: SitemapEntry[] = [];
  const pubsWales: SitemapEntry[] = [];

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
  coreEntries.push({
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
    cityEntries.push({
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
        cityEntries.push({
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
  // Build a slug→pub lookup so the per-pub loop doesn't do a linear find each
  // iteration (31k × 31k would be ~1B ops, noticeable at build time).
  const pubBySlug = new Map<string, Pub>();
  for (const p of allQualifying) if (p.slug) pubBySlug.set(p.slug, p);
  for (const slug of pubSlugList) {
    const pub = pubBySlug.get(slug);
    if (!pub) continue;
    const key = `/pub/${slug}/`;
    const hash = hashPub(pub);
    const wasNew = lastmodState[key]?.hash !== hash;
    if (wasNew) pubChangedCount++;
    const entry: SitemapEntry = {
      url: `${SITE_URL}${key}`,
      lastmod: resolveLastmod(lastmodState, key, hash, today),
    };
    const country = pub.country ?? "England";
    if (country === "Scotland") pubsScotland.push(entry);
    else if (country === "Wales") pubsWales.push(entry);
    else if (englishPubBucket(slug) === "am") pubsEnglandAM.push(entry);
    else pubsEnglandNZ.push(entry);
  }

  console.log(
    `  lastmod: ${cityChangedCount} cities + ${themeChangedCount} themes + ${pubChangedCount} pubs bumped (rest reuse previous date)`,
  );

  // ── Explore pages ─────────────────────────────────────────────────────

  const COUNTY_MAP_PATH = join(ROOT, "data", "county_map.json");
  const ONS_COUNTIES_PATH = join(ROOT, "data", "ons_counties.geojson");
  // Counties with <8 pubs aren't even emitted. Between 8 and MIN_COUNTY_INDEX
  // they emit with noindex (nav-only from /explore/{country}/). At or above
  // MIN_COUNTY_INDEX they're full SEO landing pages with sitemap entry.
  //
  // Originally 20. Lowered to 10 alongside the MIN_PUBS_PER_CITY relaxation
  // because the Sunny Rating makes a 10-pub county page genuinely unique
  // content rather than a templated stub. Large benefit for Scottish/Welsh
  // counties which have fewer pubs per county.
  const MIN_COUNTY_PUBS = 8;
  const MIN_COUNTY_INDEX = 10;

  if (existsSync(COUNTY_MAP_PATH) && existsSync(ONS_COUNTIES_PATH)) {
    console.log("\n  Generating explore pages...");

    const countyMap: Record<string, { county: string; country: string }> = JSON.parse(
      readFileSync(COUNTY_MAP_PATH, "utf-8"),
    );
    const onsCounties = JSON.parse(readFileSync(ONS_COUNTIES_PATH, "utf-8"));
    const ONS_TO_COUNTY_PATH = join(ROOT, "data", "ons_to_county.json");
    const onsToCounty: Record<string, string> = existsSync(ONS_TO_COUNTY_PATH)
      ? JSON.parse(readFileSync(ONS_TO_COUNTY_PATH, "utf-8"))
      : {};

    // Group all qualifying pubs by county.
    const pubsByCounty = new Map<string, { country: string; pubs: Pub[] }>();
    for (const pub of allQualifying) {
      const la = pub.local_authority;
      const mapping = la ? countyMap[la] : undefined;
      const county = pub.county || mapping?.county;
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
      const avgScore =
        scored.length > 0
          ? Math.round(scored.reduce((s, p) => s + (p.sun?.score ?? 0), 0) / scored.length)
          : null;

      // Group by town within county.
      const townGroups = groupByTown(countyPubs);
      const towns = [...townGroups.entries()]
        .map(([town, tPubs]) => {
          const tScored = tPubs.filter((p) => p.sun != null);
          const tAvg =
            tScored.length > 0
              ? Math.round(tScored.reduce((s, p) => s + (p.sun?.score ?? 0), 0) / tScored.length)
              : null;
          const lat = tPubs.reduce((s, p) => s + p.lat, 0) / tPubs.length;
          const lng = tPubs.reduce((s, p) => s + p.lng, 0) / tPubs.length;
          return {
            name: town,
            slug: slugify(town),
            pubCount: tPubs.length,
            avgScore: tAvg,
            lat: +lat.toFixed(4),
            lng: +lng.toFixed(4),
          };
        })
        .sort((a, b) => b.pubCount - a.pubCount);

      // All county pubs sorted by rating. Renderer shows top 15 visibly
      // and hides the rest in a collapsible "see all" block.
      const topPubs = [...countyPubs]
        .filter((p) => p.sun != null)
        .sort((a, b) => (b.sun?.score ?? 0) - (a.sun?.score ?? 0));

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
    const countryStats: ExploreCountryStats[] = countryNames
      .map((name) => {
        const cPubs = allQualifying.filter((p) => p.country === name);
        const scored = cPubs.filter((p) => p.sun != null);
        const avgScore =
          scored.length > 0
            ? Math.round(scored.reduce((s, p) => s + (p.sun?.score ?? 0), 0) / scored.length)
            : null;
        return { name, slug: slugify(name), pubCount: cPubs.length, avgScore };
      })
      .filter((c) => c.pubCount > 0);

    // Top cities for the overview.
    const topCities = qualifyingTowns
      .sort(([, a], [, b]) => b.length - a.length)
      .slice(0, 20)
      .map(([town, tPubs]) => ({ name: town, slug: slugify(town), pubCount: tPubs.length }));

    // UK overview uses county boundary map — each county clickable, colored by avg score.
    // Voronoi is reserved for county-level detail pages.

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

    // /explore/ overview page — county boundary map of all GB.
    const ukMapSvg = renderCountySvg(onsCounties.features, countyDataMap, {
      linkPrefix: "/explore/",
      onsToCounty,
    });

    const exploreDir = join(DIST, "explore");
    mkdirSync(exploreDir, { recursive: true });
    writeFileSync(
      join(exploreDir, "index.html"),
      renderExplorePage(
        template,
        countryStats,
        ukMapSvg,
        topCities,
        allQualifying.length,
        allCountyStats,
      ),
    );
    const exploreKey = "/explore/";
    const exploreHash = createHash("sha256")
      .update(allQualifying.length.toString())
      .digest("hex")
      .slice(0, 16);
    coreEntries.push({
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
        onsToCounty,
      });

      const countryDir = join(exploreDir, cs.slug);
      mkdirSync(countryDir, { recursive: true });
      writeFileSync(
        join(countryDir, "index.html"),
        renderCountryPage(template, cs.name, cs.slug, countryCounties, countrySvg, cs.pubCount),
      );
      const countryKey = `/explore/${cs.slug}/`;
      coreEntries.push({
        url: `${SITE_URL}${countryKey}`,
        lastmod: resolveLastmod(lastmodState, countryKey, cs.pubCount.toString(), today),
      });
      console.log(
        `  /explore/${cs.slug}/  (${countryCounties.length} counties, ${cs.pubCount} pubs)`,
      );

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
          coreEntries.push({
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

  // Sitemap index + child sitemaps. Empty buckets are omitted from the index
  // so Google doesn't waste fetches on empty files (Scotland is ~10 URLs today
  // but will balloon when the outdoor-area data catch-up lands).
  const children: { filename: string; entries: SitemapEntry[] }[] = [
    { filename: "sitemap-core.xml", entries: coreEntries },
    { filename: "sitemap-cities.xml", entries: cityEntries },
    { filename: "sitemap-pubs-en-a-m.xml", entries: pubsEnglandAM },
    { filename: "sitemap-pubs-en-n-z.xml", entries: pubsEnglandNZ },
    { filename: "sitemap-pubs-scotland.xml", entries: pubsScotland },
    { filename: "sitemap-pubs-wales.xml", entries: pubsWales },
  ].filter((c) => c.entries.length > 0);

  let totalUrls = 0;
  for (const c of children) {
    writeFileSync(join(DIST, c.filename), renderSitemap(c.entries));
    totalUrls += c.entries.length;
    console.log(`  /${c.filename} (${c.entries.length} URLs)`);
  }

  const indexXml = renderSitemapIndex(
    children.map((c) => ({ filename: c.filename, lastmod: maxLastmod(c.entries) })),
  );
  writeFileSync(join(DIST, "sitemap.xml"), indexXml);
  console.log(
    `  /sitemap.xml (index → ${children.length} child sitemaps, ${totalUrls} URLs total)`,
  );

  // 404.
  writeFileSync(join(DIST, "404.html"), render404(template));
  console.log("  /404.html");

  console.log(`\nDone.`);
}

main();
