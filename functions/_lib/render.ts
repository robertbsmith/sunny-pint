/**
 * Shared SEO landing-page renderer.
 *
 * Pure string-in / string-out, no DOM, no fs — so the same module is used by:
 *
 *   - scripts/generate_pages.ts (Node, build-time): emits dist/<city>/index.html
 *     for every qualifying town.
 *   - functions/pub/[slug].ts (Cloudflare Workers, request-time): renders
 *     individual pub pages on demand.
 *
 * Both consumers pass in the dist/index.html template (which already has
 * the production-hashed Vite asset paths) plus their context, and get back
 * a full HTML document ready to ship.
 *
 * One renderer, one source of truth — when we add a meta tag or change the
 * structured data, it's a single edit affecting both static and runtime
 * pages identically.
 */

// ── Types ────────────────────────────────────────────────────────────────

export interface SunMetrics {
  /** 0–100, the headline Sunny Rating. */
  score: number;
  /** Human-readable bucket: Sun trap / Very sunny / Sunny / Partly shaded / Shaded. */
  label: string;
  /** Longest contiguous span ≥50% sun, e.g. "13:30–16:30", or null. */
  best_window: string | null;
  morning_sun: boolean;
  midday_sun: boolean;
  evening_sun: boolean;
  all_day_sun: boolean;
  sample_day: string;
}

export interface Pub {
  id: string;
  name: string;
  lat: number;
  lng: number;
  clat?: number;
  clng?: number;
  slug?: string;
  town?: string;
  country?: string;
  outdoor_area_m2?: number;
  opening_hours?: string;
  brand?: string;
  brewery?: string;
  website?: string;
  /** Precomputed Sunny Rating (added by scripts/precompute_sun.ts). */
  sun?: SunMetrics;
}

export interface CityContext {
  town: string;
  country: string;
  pubs: Pub[];
}

export interface PubContext {
  pub: Pub;
  town: string;
  country: string;
  nearby: Pub[];
}

// ── Constants ────────────────────────────────────────────────────────────

const SITE_URL = "https://sunny-pint.co.uk";
const NEARBY_LIMIT = 6;

// ── Pure helpers ─────────────────────────────────────────────────────────

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/['\u2019]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

export function htmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Centroid of a town's pubs — used as the city's initial map view. */
export function townCentroid(pubs: Pub[]): { lat: number; lng: number } {
  const lats = pubs.map((p) => p.clat ?? p.lat);
  const lngs = pubs.map((p) => p.clng ?? p.lng);
  return {
    lat: lats.reduce((a, b) => a + b, 0) / lats.length,
    lng: lngs.reduce((a, b) => a + b, 0) / lngs.length,
  };
}

/** Haversine distance in metres. Used to pick nearby pubs for cross-linking. */
function haversineM(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/**
 * For a given pub, find the N nearest other pubs (any town). Used on per-pub
 * pages for internal linking — Google uses link-graph density as a topical
 * authority signal and a "nearby gardens" section is also genuinely useful UX.
 */
export function nearbyPubs(target: Pub, all: Pub[], limit: number = NEARBY_LIMIT): Pub[] {
  const tLat = target.clat ?? target.lat;
  const tLng = target.clng ?? target.lng;
  const others = all
    .filter((p) => p.id !== target.id && p.slug && qualifying(p))
    .map((p) => ({
      pub: p,
      dist: haversineM(tLat, tLng, p.clat ?? p.lat, p.clng ?? p.lng),
    }));
  others.sort((a, b) => a.dist - b.dist);
  return others.slice(0, limit).map((x) => x.pub);
}

/**
 * A pub qualifies for landing-page inclusion only if it has a town and a
 * computed Sunny Rating. The rating is the unique-data hook that makes the
 * page genuinely different from a generic directory listing — without it
 * we'd be shipping templated thin content that the Google March 2026
 * scaled-content classifier would demote.
 */
export function qualifying(pub: Pub): boolean {
  return Boolean(pub.town && pub.sun);
}

/** Group qualifying pubs by town. Used by the city page generator. */
export function groupByTown(pubs: Pub[]): Map<string, Pub[]> {
  const groups = new Map<string, Pub[]>();
  for (const pub of pubs) {
    if (!qualifying(pub)) continue;
    const town = pub.town as string;
    if (!groups.has(town)) groups.set(town, []);
    groups.get(town)!.push(pub);
  }
  return groups;
}

// ── Template substitution (shared by city + pub renderers) ───────────────

interface PageMeta {
  title: string;
  description: string;
  canonicalPath: string;
  spArea: string;
  spAreaName: string;
  spAreaLat: number;
  spAreaLng: number;
  spPub: string;
  jsonLd: string[];
  seoIntro: string;
  /** Path to the og:image. Defaults to /banner.png if absent. */
  ogImagePath?: string;
  /** Mime type override for og:image (so we can declare image/svg+xml). */
  ogImageType?: string;
}

/**
 * Apply page-level substitutions to the index.html template. Both the city
 * generator and the pub Function pass through here so the meta-tag layout
 * stays consistent.
 */
function applyTemplate(template: string, meta: PageMeta): string {
  let out = template;

  // Title.
  out = out.replace(/<title>[^<]*<\/title>/, `<title>${htmlEscape(meta.title)}</title>`);

  // Description.
  out = out.replace(
    /<meta name="description" content="[^"]*"\s*\/?>/,
    `<meta name="description" content="${htmlEscape(meta.description)}" />`,
  );

  // Canonical.
  out = out.replace(
    /<link rel="canonical" href="[^"]*"\s*\/?>/,
    `<link rel="canonical" href="${SITE_URL}${meta.canonicalPath}" />`,
  );

  // sp:area block — replace the empty placeholder with a populated set so
  // main.ts can hydrate from it on first paint without a second fetch.
  const spAreaBlock =
    `<meta name="sp:area" content="${meta.spArea}" />\n` +
    `    <meta name="sp:area-name" content="${htmlEscape(meta.spAreaName)}" />\n` +
    `    <meta name="sp:area-lat" content="${meta.spAreaLat.toFixed(4)}" />\n` +
    `    <meta name="sp:area-lng" content="${meta.spAreaLng.toFixed(4)}" />`;
  out = out.replace(/<meta name="sp:area" content=""\s*\/?>/, spAreaBlock);

  // sp:pub.
  out = out.replace(
    /<meta name="sp:pub" content="[^"]*"\s*\/?>/,
    `<meta name="sp:pub" content="${meta.spPub}" />`,
  );

  // OG / Twitter cards.
  const ogUrl = `${SITE_URL}${meta.canonicalPath}`;
  out = out.replace(
    /<meta property="og:title" content="[^"]*"\s*\/?>/,
    `<meta property="og:title" content="${htmlEscape(meta.title)}" />`,
  );
  out = out.replace(
    /<meta property="og:description" content="[^"]*"\s*\/?>/,
    `<meta property="og:description" content="${htmlEscape(meta.description)}" />`,
  );
  out = out.replace(
    /<meta property="og:url" content="[^"]*"\s*\/?>/,
    `<meta property="og:url" content="${ogUrl}" />`,
  );
  out = out.replace(
    /<meta name="twitter:title" content="[^"]*"\s*\/?>/,
    `<meta name="twitter:title" content="${htmlEscape(meta.title)}" />`,
  );
  out = out.replace(
    /<meta name="twitter:description" content="[^"]*"\s*\/?>/,
    `<meta name="twitter:description" content="${htmlEscape(meta.description)}" />`,
  );

  // og:image / twitter:image — point at a custom URL when the page supplies
  // one (per-pub OG card via the /og/pub/<slug>.svg Function), otherwise
  // leave the default banner.png in place.
  if (meta.ogImagePath) {
    const ogImageUrl = meta.ogImagePath.startsWith("http")
      ? meta.ogImagePath
      : `${SITE_URL}${meta.ogImagePath}`;
    out = out.replace(
      /<meta property="og:image" content="[^"]*"\s*\/?>/,
      `<meta property="og:image" content="${ogImageUrl}" />`,
    );
    out = out.replace(
      /<meta name="twitter:image" content="[^"]*"\s*\/?>/,
      `<meta name="twitter:image" content="${ogImageUrl}" />`,
    );
    // Insert image:type hint after og:image if it isn't already there.
    if (meta.ogImageType && !/og:image:type/.test(out)) {
      out = out.replace(
        /(<meta property="og:image" content="[^"]*"\s*\/?>)/,
        `$1\n    <meta property="og:image:type" content="${meta.ogImageType}" />`,
      );
    }
  }

  // JSON-LD blocks before </head>.
  if (meta.jsonLd.length > 0) {
    const blocks = meta.jsonLd
      .map((json) => `    <script type="application/ld+json">\n${json}\n    </script>`)
      .join("\n");
    out = out.replace("</head>", `${blocks}\n  </head>`);
  }

  // SEO intro section — replace the homepage's sr-only block with the
  // landing-page variant.
  out = out.replace(/<section id="seo-intro"[^>]*>[\s\S]*?<\/section>/, meta.seoIntro);

  return out;
}

// ── JSON-LD builders ─────────────────────────────────────────────────────

interface BreadcrumbItem {
  name: string;
  path: string;
}

function breadcrumbListJsonLd(items: BreadcrumbItem[]): string {
  return JSON.stringify(
    {
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      itemListElement: items.map((item, i) => ({
        "@type": "ListItem",
        position: i + 1,
        name: item.name,
        item: `${SITE_URL}${item.path}`,
      })),
    },
    null,
    2,
  );
}

function barOrPubJsonLd(pub: Pub, town: string): object {
  return {
    "@type": "BarOrPub",
    name: pub.name,
    url: `${SITE_URL}/pub/${pub.slug}/`,
    geo: {
      "@type": "GeoCoordinates",
      latitude: pub.clat ?? pub.lat,
      longitude: pub.clng ?? pub.lng,
    },
    address: {
      "@type": "PostalAddress",
      addressLocality: town,
      addressCountry: "GB",
    },
  };
}

function itemListJsonLd(town: string, pubs: Pub[]): string {
  return JSON.stringify(
    {
      "@context": "https://schema.org",
      "@type": "ItemList",
      name: `Sunny beer gardens in ${town}`,
      numberOfItems: pubs.length,
      itemListElement: pubs.map((pub, i) => ({
        "@type": "ListItem",
        position: i + 1,
        item: barOrPubJsonLd(pub, town),
      })),
    },
    null,
    2,
  );
}

// ── Breadcrumb HTML helper ───────────────────────────────────────────────

function breadcrumbHtml(items: BreadcrumbItem[]): string {
  const parts = items.map((item, i) => {
    const isLast = i === items.length - 1;
    if (isLast) return htmlEscape(item.name);
    return `<a href="${item.path}">${htmlEscape(item.name)}</a>`;
  });
  return `<nav class="seo-breadcrumb" aria-label="Breadcrumb">${parts.join(" · ")}</nav>`;
}

// ── City page renderer ───────────────────────────────────────────────────

export function renderCityPage(template: string, ctx: CityContext): string {
  const { town, country, pubs } = ctx;
  const slug = slugify(town);
  const { lat, lng } = townCentroid(pubs);

  // Sunny Rating stats. Average is the city's headline; "sunniest" picks
  // the highest-scoring pub for the intro paragraph; the per-pub list is
  // sorted by score descending so the best gardens are surfaced first.
  const scored = pubs.filter((p) => p.sun != null);
  const avgScore =
    scored.length > 0
      ? Math.round(scored.reduce((s, p) => s + (p.sun?.score ?? 0), 0) / scored.length)
      : 0;
  const sunniest = [...scored].sort((a, b) => (b.sun?.score ?? 0) - (a.sun?.score ?? 0))[0];

  const title = `Sunny beer gardens in ${town} — Sunny Pint`;
  const description =
    `${pubs.length} pub gardens in ${town} ranked by Sunny Rating (average ${avgScore}/100). ` +
    `Find the sunniest beer gardens, the best evening sun spots, and pick the best seat for your pint.`;

  const breadcrumbs: BreadcrumbItem[] = [
    { name: "Sunny Pint", path: "/" },
    { name: country, path: `/${slugify(country)}/` },
    { name: town, path: `/${slug}/` },
  ];

  // Sort the visible list by Sunny Rating descending so the best gardens
  // appear first. Stable secondary sort by name for deterministic diffs.
  const sortedPubs = [...pubs].sort((a, b) => {
    const sb = (b.sun?.score ?? -1) - (a.sun?.score ?? -1);
    if (sb !== 0) return sb;
    return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
  });

  const listItems = sortedPubs
    .map((p) => {
      const score = p.sun ? ` — ${p.sun.score}` : "";
      return `      <li><a href="/pub/${htmlEscape(p.slug ?? "")}/">${htmlEscape(p.name)}${score}</a></li>`;
    })
    .join("\n");

  const sunniestSentence = sunniest?.sun
    ? ` The sunniest is <strong>${htmlEscape(sunniest.name)}</strong> with a Sunny Rating of <strong>${sunniest.sun.score}/100</strong>${sunniest.sun.best_window ? ` (best ${sunniest.sun.best_window})` : ""}.`
    : "";

  const intro =
    `${pubs.length} pub gardens in ${htmlEscape(town)} have a computed Sunny Rating. ` +
    `Average rating <strong>${avgScore}/100</strong>.${sunniestSentence} ` +
    `<a href="/how-it-works.html#sunny-rating">How is this calculated?</a>`;

  const seoIntro =
    `<section id="seo-intro" class="seo-intro seo-intro--landing">\n` +
    `  ${breadcrumbHtml(breadcrumbs)}\n` +
    `  <h1>Sunny beer gardens in ${htmlEscape(town)}</h1>\n` +
    `  <p>${intro}</p>\n` +
    `  <details class="seo-pub-list-wrap">\n` +
    `    <summary>View all ${pubs.length} pubs</summary>\n` +
    `    <ul class="seo-pub-list">\n` +
    `${listItems}\n` +
    `    </ul>\n` +
    `  </details>\n` +
    `</section>`;

  return applyTemplate(template, {
    title,
    description,
    canonicalPath: `/${slug}/`,
    spArea: slug,
    spAreaName: town,
    spAreaLat: lat,
    spAreaLng: lng,
    spPub: "",
    jsonLd: [breadcrumbListJsonLd(breadcrumbs), itemListJsonLd(town, sortedPubs)],
    seoIntro,
  });
}

// ── Pub page renderer ────────────────────────────────────────────────────

export function renderPubPage(template: string, ctx: PubContext): string {
  const { pub, town, country, nearby } = ctx;
  const slug = pub.slug ?? slugify(pub.name);
  const lat = pub.clat ?? pub.lat;
  const lng = pub.clng ?? pub.lng;

  const ratingText = pub.sun
    ? `Sunny Rating ${pub.sun.score}/100 — ${pub.sun.label}`
    : "Sunny Rating not available";

  const title = pub.sun
    ? `${pub.name} — Sunny Rating ${pub.sun.score}/100 — Sunny Pint`
    : `${pub.name} — Sunny Pint`;

  const description = pub.sun
    ? `${pub.name}${town ? ` in ${town}` : ""}. ${ratingText}` +
      (pub.sun.best_window ? `, best sun ${pub.sun.best_window}` : "") +
      `. See exactly which seats catch the sun across the day.`
    : `${pub.name}${town ? ` in ${town}` : ""}. See exactly which seats catch the sun across the day.`;

  const townSlug = slugify(town);
  const countrySlug = slugify(country);
  const breadcrumbs: BreadcrumbItem[] = [
    { name: "Sunny Pint", path: "/" },
    { name: country, path: `/${countrySlug}/` },
    { name: town, path: `/${townSlug}/` },
    { name: pub.name, path: `/pub/${slug}/` },
  ];

  // Intro paragraph — Sunny Rating is the headline. Best window + brand are
  // secondary facts on the same line.
  const factParts: string[] = [];
  if (pub.sun) {
    factParts.push(`<strong>Sunny Rating ${pub.sun.score}/100</strong> — ${pub.sun.label}`);
    if (pub.sun.best_window) factParts.push(`best sun ${pub.sun.best_window}`);
  }
  if (pub.brand) factParts.push(htmlEscape(pub.brand));
  else if (pub.brewery) factParts.push(htmlEscape(pub.brewery));
  const factsLine = factParts.join(" · ");

  const ratingExplainer = pub.sun
    ? ` <a href="/how-it-works.html#sunny-rating">How is this calculated?</a>`
    : "";

  const nearbyHtml =
    nearby.length > 0
      ? `  <details class="seo-pub-list-wrap">\n` +
        `    <summary>Other sunny gardens nearby</summary>\n` +
        `    <ul class="seo-pub-list">\n` +
        nearby
          .map((p) => {
            const score = p.sun ? ` — ${p.sun.score}` : "";
            return `      <li><a href="/pub/${htmlEscape(p.slug ?? "")}/">${htmlEscape(p.name)}${score}</a></li>`;
          })
          .join("\n") +
        `\n    </ul>\n  </details>\n`
      : "";

  const seoIntro =
    `<section id="seo-intro" class="seo-intro seo-intro--landing">\n` +
    `  ${breadcrumbHtml(breadcrumbs)}\n` +
    `  <h1>${htmlEscape(pub.name)}${town ? ` <span class="pub-town">${htmlEscape(town)}</span>` : ""}</h1>\n` +
    (factsLine ? `  <p>${factsLine}.${ratingExplainer}</p>\n` : "") +
    nearbyHtml +
    `</section>`;

  // BarOrPub JSON-LD for this specific pub. Use additionalProperty for the
  // Sunny Rating — that's the schema.org-correct way to attach a custom
  // computed metric. We deliberately don't use aggregateRating because
  // Google reserves that for actual user reviews and penalises misuse.
  const pubLd: Record<string, unknown> = {
    "@context": "https://schema.org",
    ...barOrPubJsonLd(pub, town),
    description,
  };
  if (pub.sun) {
    pubLd.additionalProperty = [
      {
        "@type": "PropertyValue",
        name: "Sunny Rating",
        value: pub.sun.score,
        minValue: 0,
        maxValue: 100,
        description:
          "Average percentage of the outdoor seating area in direct sun across the daylight hours of the spring equinox.",
      },
    ];
  }
  const pubJsonLd = JSON.stringify(pubLd, null, 2);

  return applyTemplate(template, {
    title,
    description,
    canonicalPath: `/pub/${slug}/`,
    spArea: townSlug,
    spAreaName: town,
    spAreaLat: lat,
    spAreaLng: lng,
    spPub: slug,
    jsonLd: [breadcrumbListJsonLd(breadcrumbs), pubJsonLd],
    seoIntro,
    // OG cards are pre-rendered by the pipeline and served from R2.
    ogImagePath: `https://data.sunny-pint.co.uk/og/${slug}.jpg`,
  });
}

// ── Theme pages ──────────────────────────────────────────────────────────
//
// Filter + sort the pubs in a city by a theme predicate, render a focused
// landing page targeting the specific search intent. Themes are the long-
// tail SEO unlock — each one targets a distinct query like "sunniest beer
// garden norwich" or "biggest beer garden bristol", powered by data we
// already have.

export interface ThemeDef {
  /** Slug used in the URL: /<city>/<slug>/ */
  slug: string;
  /** Title-cased name shown in headings. */
  name: string;
  /** Plain-language description for the intro paragraph. */
  blurb: (town: string, count: number) => string;
  /** Predicate for whether a pub qualifies for this theme. */
  filter: (pub: Pub) => boolean;
  /** Sort comparator (descending). */
  sort: (a: Pub, b: Pub) => number;
  /** Maximum number of pubs to surface in the visible list. */
  limit: number;
  /** Format for the per-item suffix shown after each pub name. */
  itemSuffix: (pub: Pub) => string;
}

export const THEMES: ThemeDef[] = [
  {
    slug: "sunniest",
    name: "Sunniest beer gardens",
    blurb: (town, count) =>
      `These ${count} pub gardens in ${town} score highest on the Sunny Rating — ` +
      `pubs whose outdoor seating gets direct sun across most of an average day.`,
    filter: (p) => Boolean(p.sun),
    sort: (a, b) => (b.sun?.score ?? 0) - (a.sun?.score ?? 0),
    limit: 30,
    itemSuffix: (p) => (p.sun ? ` — ${p.sun.score}/100` : ""),
  },
  {
    slug: "evening-sun",
    name: "Pubs with evening sun",
    blurb: (town, count) =>
      `${count} pub gardens in ${town} that catch the sun in the evening — ` +
      `the after-work pint window. The best spots when the rest of town is in shadow.`,
    filter: (p) => Boolean(p.sun?.evening_sun),
    sort: (a, b) => (b.sun?.score ?? 0) - (a.sun?.score ?? 0),
    limit: 40,
    itemSuffix: (p) =>
      p.sun?.best_window ? ` — best ${p.sun.best_window}` : p.sun ? ` — ${p.sun.score}/100` : "",
  },
  {
    slug: "all-day-sun",
    name: "Pubs with all-day sun",
    blurb: (town, count) =>
      `${count} pub gardens in ${town} that get direct sun across the morning, ` +
      `midday, and evening — a full sunny day from open till close, ` +
      `weather permitting.`,
    filter: (p) => Boolean(p.sun?.all_day_sun),
    sort: (a, b) => (b.sun?.score ?? 0) - (a.sun?.score ?? 0),
    limit: 40,
    itemSuffix: (p) => (p.sun ? ` — ${p.sun.score}/100` : ""),
  },
  {
    slug: "biggest",
    name: "Biggest beer gardens",
    blurb: (town, count) =>
      `${count} pub gardens in ${town} ranked by outdoor seating area. ` +
      `Bigger isn't always sunnier — check the Sunny Rating before you commit.`,
    filter: (p) => Boolean(p.outdoor_area_m2),
    sort: (a, b) => (b.outdoor_area_m2 ?? 0) - (a.outdoor_area_m2 ?? 0),
    limit: 30,
    itemSuffix: (p) => (p.outdoor_area_m2 ? ` — ${Math.round(p.outdoor_area_m2)} m²` : ""),
  },
];

export interface ThemeContext {
  town: string;
  country: string;
  theme: ThemeDef;
  /** All qualifying pubs in the town (the renderer filters internally). */
  pubs: Pub[];
}

/** Render a single theme page. Returns the HTML string. */
export function renderThemePage(template: string, ctx: ThemeContext): string {
  const { town, country, theme, pubs } = ctx;
  const slug = slugify(town);
  const { lat, lng } = townCentroid(pubs);

  // Apply the theme's filter + sort. The visible list is capped at
  // theme.limit but the count we report in the intro is the full match
  // count, so users know whether they're seeing a representative slice.
  const matched = pubs.filter(theme.filter);
  matched.sort(theme.sort);
  const shown = matched.slice(0, theme.limit);

  const title = `${theme.name} in ${town} — Sunny Pint`;
  const description =
    `${matched.length} pub gardens in ${town} matching "${theme.name.toLowerCase()}". ` +
    `Pick the best beer garden for your pint.`;

  const breadcrumbs: BreadcrumbItem[] = [
    { name: "Sunny Pint", path: "/" },
    { name: country, path: `/${slugify(country)}/` },
    { name: town, path: `/${slug}/` },
    { name: theme.name, path: `/${slug}/${theme.slug}/` },
  ];

  const listItems = shown
    .map(
      (p) =>
        `      <li><a href="/pub/${htmlEscape(p.slug ?? "")}/">` +
        `${htmlEscape(p.name)}${htmlEscape(theme.itemSuffix(p))}</a></li>`,
    )
    .join("\n");

  const seoIntro =
    `<section id="seo-intro" class="seo-intro seo-intro--landing">\n` +
    `  ${breadcrumbHtml(breadcrumbs)}\n` +
    `  <h1>${htmlEscape(theme.name)} in ${htmlEscape(town)}</h1>\n` +
    `  <p>${theme.blurb(htmlEscape(town), matched.length)} ` +
    `<a href="/how-it-works.html#sunny-rating">How is this calculated?</a></p>\n` +
    `  <details class="seo-pub-list-wrap" open>\n` +
    `    <summary>Top ${shown.length} of ${matched.length}</summary>\n` +
    `    <ul class="seo-pub-list">\n` +
    `${listItems}\n` +
    `    </ul>\n` +
    `  </details>\n` +
    `</section>`;

  const itemList = JSON.stringify(
    {
      "@context": "https://schema.org",
      "@type": "ItemList",
      name: `${theme.name} in ${town}`,
      numberOfItems: matched.length,
      itemListElement: shown.map((pub, i) => ({
        "@type": "ListItem",
        position: i + 1,
        item: barOrPubJsonLd(pub, town),
      })),
    },
    null,
    2,
  );

  return applyTemplate(template, {
    title,
    description,
    canonicalPath: `/${slug}/${theme.slug}/`,
    spArea: slug,
    spAreaName: town,
    spAreaLat: lat,
    spAreaLng: lng,
    spPub: "",
    jsonLd: [breadcrumbListJsonLd(breadcrumbs), itemList],
    seoIntro,
  });
}

// ── Explore page renderers ─────────────────────────────────────────────

export interface ExploreCountryStats {
  name: string;
  slug: string;
  pubCount: number;
  avgScore: number | null;
}

export interface ExploreCountyStats {
  name: string;
  slug: string;
  country: string;
  countrySlug: string;
  pubCount: number;
  avgScore: number | null;
  towns: { name: string; slug: string; pubCount: number; avgScore: number | null; lat?: number; lng?: number }[];
  topPubs: Pub[];
}

/** Render the /explore/ overview page. */
export function renderExplorePage(
  template: string,
  countries: ExploreCountryStats[],
  mapSvg: string,
  topCities: { name: string; slug: string; pubCount: number }[],
  totalPubs: number,
  allCountyStats?: ExploreCountyStats[],
): string {
  const title = "Explore sunny beer gardens across the UK — Sunny Pint";
  const description =
    `Browse ${totalPubs.toLocaleString()} pub gardens across England, Scotland, and Wales. ` +
    `Find the sunniest beer gardens near you with our interactive sun score map.`;

  const breadcrumbs: BreadcrumbItem[] = [
    { name: "Sunny Pint", path: "/" },
    { name: "Explore", path: "/explore/" },
  ];

  const countryCards = countries
    .map(
      (c) =>
        `  <a href="/explore/${c.slug}/" class="explore-card">\n` +
        `    <h3>${htmlEscape(c.name)}</h3>\n` +
        `    <p>${c.pubCount.toLocaleString()} pubs` +
        `${c.avgScore !== null ? ` · avg ${Math.round(c.avgScore)}/100` : ""}</p>\n` +
        `  </a>`,
    )
    .join("\n");

  const cityList = topCities
    .map(
      (c) =>
        `    <li><a href="/${c.slug}/">${htmlEscape(c.name)}</a> (${c.pubCount} pubs)</li>`,
    )
    .join("\n");

  const seoIntro =
    `<section id="seo-intro" class="seo-intro seo-intro--landing seo-intro--explore">\n` +
    `  ${breadcrumbHtml(breadcrumbs)}\n` +
    `  <h1>Explore sunny beer gardens across the UK</h1>\n` +
    `  <p>${totalPubs.toLocaleString()} pub gardens ranked by Sunny Rating — find where the sun shines longest.</p>\n` +
    `  <div class="explore-countries">\n${countryCards}\n  </div>\n` +
    `  <div class="explore-layout">\n` +
    `    <div class="explore-map-wrap">\n` +
    `      ${mapSvg}\n` +
    `      <div class="explore-tooltip" id="map-tooltip"></div>\n` +
    `    </div>\n` +
    `    <div class="explore-sidebar">\n` +
    `      <h2>Popular areas</h2>\n` +
    `      <ul class="explore-city-list">\n${cityList}\n      </ul>\n` +
    `    </div>\n` +
    `  </div>\n` +
    `  <script>\n` +
    `    (function(){\n` +
    `      var tip=document.getElementById("map-tooltip");\n` +
    `      var svg=document.querySelector(".explore-map");\n` +
    `      if(!svg||!tip)return;\n` +
    `      svg.addEventListener("mousemove",function(e){\n` +
    `        var p=e.target.closest("path");\n` +
    `        if(!p){tip.style.display="none";return;}\n` +
    `        var t=p.querySelector("title");\n` +
    `        if(!t){tip.style.display="none";return;}\n` +
    `        tip.textContent=t.textContent;\n` +
    `        tip.style.display="block";\n` +
    `        var r=svg.getBoundingClientRect();\n` +
    `        tip.style.left=(e.clientX-r.left+12)+"px";\n` +
    `        tip.style.top=(e.clientY-r.top-28)+"px";\n` +
    `      });\n` +
    `      svg.addEventListener("mouseleave",function(){tip.style.display="none";});\n` +
    `      svg.querySelectorAll("path").forEach(function(p){\n` +
    `        p.addEventListener("mouseenter",function(){p.style.opacity="1";p.style.strokeWidth="1.5";});\n` +
    `        p.addEventListener("mouseleave",function(){p.style.opacity="";p.style.strokeWidth="";});\n` +
    `      });\n` +
    `    })();\n` +
    `  </script>\n` +
    (allCountyStats
      ? `  <script id="explore-data" type="application/json">${JSON.stringify(
          allCountyStats.map((c) => ({
            name: c.name,
            slug: c.slug,
            country: c.country,
            countrySlug: c.countrySlug,
            pubCount: c.pubCount,
            avgScore: c.avgScore,
            towns: c.towns,
          })),
        )}</script>\n`
      : "") +
    `</section>`;

  return applyTemplate(template, {
    title,
    description,
    canonicalPath: "/explore/",
    spArea: "",
    spAreaName: "UK",
    spAreaLat: 54.5,
    spAreaLng: -2.0,
    spPub: "",
    jsonLd: [breadcrumbListJsonLd(breadcrumbs)],
    seoIntro,
  });
}

/** Render a /explore/england/ country page. */
export function renderCountryPage(
  template: string,
  countryName: string,
  countrySlug: string,
  counties: ExploreCountyStats[],
  mapSvg: string,
  totalPubs: number,
): string {
  const title = `Sunny beer gardens in ${countryName} — Sunny Pint`;
  const description =
    `${totalPubs.toLocaleString()} pub gardens across ${counties.length} counties in ${countryName}. ` +
    `Browse by county to find the sunniest beer gardens.`;

  const breadcrumbs: BreadcrumbItem[] = [
    { name: "Sunny Pint", path: "/" },
    { name: "Explore", path: "/explore/" },
    { name: countryName, path: `/explore/${countrySlug}/` },
  ];

  const countyList = [...counties]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(
      (c) =>
        `    <li><a href="/explore/${countrySlug}/${c.slug}/">${htmlEscape(c.name)}</a> — ` +
        `${c.pubCount} pubs${c.avgScore !== null ? `, avg ${Math.round(c.avgScore)}/100` : ""}</li>`,
    )
    .join("\n");

  const seoIntro =
    `<section id="seo-intro" class="seo-intro seo-intro--landing seo-intro--explore">\n` +
    `  ${breadcrumbHtml(breadcrumbs)}\n` +
    `  <h1>Sunny beer gardens in ${htmlEscape(countryName)}</h1>\n` +
    `  <p>${totalPubs.toLocaleString()} pubs across ${counties.length} counties.</p>\n` +
    `  <div class="explore-map-wrap">${mapSvg}</div>\n` +
    `  <h2>Counties</h2>\n` +
    `  <ul class="explore-county-list">\n${countyList}\n  </ul>\n` +
    `</section>`;

  return applyTemplate(template, {
    title,
    description,
    canonicalPath: `/explore/${countrySlug}/`,
    spArea: "",
    spAreaName: countryName,
    spAreaLat: countryName === "Scotland" ? 56.5 : countryName === "Wales" ? 52.3 : 52.5,
    spAreaLng: countryName === "Scotland" ? -4.0 : countryName === "Wales" ? -3.5 : -1.5,
    spPub: "",
    jsonLd: [breadcrumbListJsonLd(breadcrumbs)],
    seoIntro,
  });
}

/** Render a /explore/england/norfolk/ county page. */
export function renderCountyPage(
  template: string,
  county: ExploreCountyStats,
): string {
  const title = `Sunny beer gardens in ${county.name} — Sunny Pint`;
  const description =
    `${county.pubCount} pub gardens across ${county.towns.length} towns in ${county.name}. ` +
    `Browse by town to find the sunniest beer gardens.`;

  const breadcrumbs: BreadcrumbItem[] = [
    { name: "Sunny Pint", path: "/" },
    { name: "Explore", path: "/explore/" },
    { name: county.country, path: `/explore/${county.countrySlug}/` },
    { name: county.name, path: `/explore/${county.countrySlug}/${county.slug}/` },
  ];

  const townList = [...county.towns]
    .sort((a, b) => (b.avgScore ?? 0) - (a.avgScore ?? 0))
    .map((t) => {
      const link = t.pubCount >= 8
        ? `<a href="/${t.slug}/">${htmlEscape(t.name)}</a>`
        : htmlEscape(t.name);
      return `    <li>${link} — ${t.pubCount} pubs${t.avgScore !== null ? `, avg ${Math.round(t.avgScore)}/100` : ""}</li>`;
    })
    .join("\n");

  const topPubList = county.topPubs
    .slice(0, 15)
    .map(
      (p) =>
        `    <li><a href="/pub/${htmlEscape(p.slug ?? "")}/">${htmlEscape(p.name)}</a>` +
        `${p.sun ? ` — ${p.sun.score}/100` : ""}` +
        `${p.town ? ` <small>(${htmlEscape(p.town)})</small>` : ""}</li>`,
    )
    .join("\n");

  const seoIntro =
    `<section id="seo-intro" class="seo-intro seo-intro--landing seo-intro--explore">\n` +
    `  ${breadcrumbHtml(breadcrumbs)}\n` +
    `  <h1>Sunny beer gardens in ${htmlEscape(county.name)}</h1>\n` +
    `  <p>${county.pubCount} pubs across ${county.towns.length} towns in ${htmlEscape(county.name)}` +
    `${county.avgScore !== null ? `, average Sunny Rating ${Math.round(county.avgScore)}/100` : ""}.</p>\n` +
    `  <h2>Towns</h2>\n` +
    `  <ul class="explore-town-list">\n${townList}\n  </ul>\n` +
    (county.topPubs.length > 0
      ? `  <h2>Sunniest pubs in ${htmlEscape(county.name)}</h2>\n` +
        `  <ul class="explore-pub-list">\n${topPubList}\n  </ul>\n`
      : "") +
    `</section>`;

  return applyTemplate(template, {
    title,
    description,
    canonicalPath: `/explore/${county.countrySlug}/${county.slug}/`,
    spArea: "",
    spAreaName: county.name,
    spAreaLat: 0,
    spAreaLng: 0,
    spPub: "",
    jsonLd: [breadcrumbListJsonLd(breadcrumbs)],
    seoIntro,
  });
}
