/**
 * OG image renderer — full 1200×630 social card.
 *
 * Hand-crafted SVG (no satori) so we can embed the porthole inline as
 * native SVG elements with clip-path / gradients / filters intact. Satori's
 * SVG support is limited and would have stripped the porthole's clipping.
 *
 * Layout (1200×630):
 *
 *   ┌──────────────────────────────────────────────┐
 *   │ [logo64]  sunny-pint.co.uk                   │   header (80px)
 *   │                                              │
 *   │  THE RACECOURSE          ╭───────────╮       │
 *   │  Norwich                 │           │       │
 *   │                          │  PORTHOLE │       │   middle (440px)
 *   │  ☀ 92 / 100              │           │       │
 *   │  Sun trap · best 14:00   ╰───────────╯       │
 *   │                                              │
 *   │ ──────────────────────────────────────────── │   footer (50px)
 *   │ Find your sunny pint                         │
 *   └──────────────────────────────────────────────┘
 *
 * The porthole content uses the same `renderPortholeSvg` we ship as a
 * standalone SVG; we just inline its body (sans the outer `<svg>` wrapper)
 * inside a translated <g> here. Single source of truth.
 */

import { renderPortholeSvg } from "./porthole_svg";
import type { Building, Pub, SunPosition } from "../../src/types";

// ── Card dimensions ─────────────────────────────────────────────────────

const W = 1200;
const H = 630;
const PAD = 56;

// Header zone height (logo + wordmark + breathing room before identity)
const HEADER_H = 130;
// Footer zone height (divider + tagline)
const FOOTER_H = 80;

const PORTHOLE_SIZE = 430;
const PORTHOLE_X = W - PAD - PORTHOLE_SIZE; // right-aligned
// Sit the porthole in the middle band but biased toward the top so it
// reads as visually attached to the header rather than floating low.
const PORTHOLE_Y = HEADER_H - 18;

// Left column (identity + score block) — leaves a 40px gap before the porthole
const LEFT_X = PAD;
const LEFT_W = PORTHOLE_X - PAD - 40;

// Approximate cap-height ratio for converting "top of text" → "SVG baseline".
// SVG <text y=...> is the baseline, but laying out top-down is much easier
// to reason about, so we convert at emit time.
const CAP = 0.74;
function baselineFromTop(top: number, fontSize: number): number {
  return top + fontSize * CAP;
}

// ── Tier styling ────────────────────────────────────────────────────────

interface TierStyle {
  /** Two stops for the diagonal background gradient. */
  bg: [string, string];
  /** Primary text/ink colour with high contrast on the background. */
  ink: string;
  /** Muted variant for secondary text. */
  inkMuted: string;
  /** Human label. */
  label: string;
}

function tierStyle(score: number | undefined): TierStyle {
  if (score == null)
    return {
      bg: ["#f3f4f6", "#9ca3af"],
      ink: "#111827",
      inkMuted: "#374151",
      label: "Unrated",
    };
  if (score >= 80)
    return {
      bg: ["#fde68a", "#f59e0b"],
      ink: "#1c1410",
      inkMuted: "#78350f",
      label: "Sun trap",
    };
  if (score >= 60)
    return {
      bg: ["#fef3c7", "#fbbf24"],
      ink: "#1c1410",
      inkMuted: "#92400e",
      label: "Very sunny",
    };
  if (score >= 40)
    return {
      bg: ["#fffbeb", "#fde68a"],
      ink: "#1c1410",
      inkMuted: "#92400e",
      label: "Sunny",
    };
  if (score >= 20)
    return {
      bg: ["#e5e7eb", "#9ca3af"],
      ink: "#111827",
      inkMuted: "#374151",
      label: "Partly shaded",
    };
  return {
    bg: ["#9ca3af", "#4b5563"],
    ink: "#f9fafb",
    inkMuted: "#e5e7eb",
    label: "Shaded",
  };
}

// ── Helpers ─────────────────────────────────────────────────────────────

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Estimate the width of a string at a given font size for one of our text
 * styles. Used to decide when to compress with textLength. The numbers are
 * rough but consistent — we're checking "does this overflow the column"
 * not measuring exactly.
 */
function approxTextWidth(text: string, fontSize: number, family: "serif" | "sans"): number {
  // Average glyph width as a fraction of font size, very roughly:
  //   serif (Georgia): ~0.55
  //   sans (system-ui at weight 700): ~0.55
  //   sans (system-ui at weight 500): ~0.50
  const avgChar = family === "serif" ? 0.55 : 0.52;
  return text.length * fontSize * avgChar;
}

/**
 * Emit a `<text>` positioned by the TOP of the cap height (not the SVG
 * baseline), so callers can lay things out top-down without juggling per-
 * font baseline metrics. Compresses horizontally if the natural width
 * exceeds maxWidth — otherwise renders at natural width (no stretching).
 */
function topText(
  content: string,
  x: number,
  top: number,
  fontSize: number,
  maxWidth: number,
  attrs: {
    family: "serif" | "sans";
    weight?: number;
    fill?: string;
    fillOpacity?: number;
    letterSpacing?: number;
  },
): string {
  const y = baselineFromTop(top, fontSize);
  const natural = approxTextWidth(content, fontSize, attrs.family);
  const lengthAttr =
    natural > maxWidth ? ` textLength="${maxWidth.toFixed(0)}" lengthAdjust="spacingAndGlyphs"` : "";
  const familyAttr =
    attrs.family === "serif"
      ? `font-family="Georgia, 'Times New Roman', serif"`
      : `font-family="-apple-system, system-ui, 'Segoe UI', sans-serif"`;
  const weight = attrs.weight ? ` font-weight="${attrs.weight}"` : "";
  const fill = ` fill="${attrs.fill ?? "#1c1410"}"`;
  const op = attrs.fillOpacity != null ? ` fill-opacity="${attrs.fillOpacity}"` : "";
  const ls = attrs.letterSpacing ? ` letter-spacing="${attrs.letterSpacing}"` : "";
  return `<text x="${x}" y="${y}" ${familyAttr} font-size="${fontSize}"${weight}${fill}${op}${ls}${lengthAttr}>${escapeXml(content)}</text>`;
}

/** Strip the outer `<svg>` wrapper from a porthole SVG so we can inline
 *  its body inside a parent SVG. */
function unwrapSvg(svg: string): string {
  return svg.replace(/^<svg[^>]*>/, "").replace(/<\/svg>$/, "");
}

// ── Inlined Sunny Pint logo ─────────────────────────────────────────────
//
// Embeds public/icon.svg verbatim inside a nested <svg> with the original
// viewBox. The browser handles the coordinate mapping for us — no manual
// path rewriting (which is how the previous version got the geometry
// wrong). The clipPath ID is suffixed `og-` to avoid colliding with any
// other clip-paths used by the porthole.

function inlineLogo(x: number, y: number, size: number): string {
  return (
    `<svg x="${x}" y="${y}" width="${size}" height="${size}" viewBox="12 20 120 120">` +
    `<defs>` +
    `<clipPath id="og-pin-clip">` +
    // No transform on the path — the clipPath inherits the user-space
    // transform from the element being clipped (the rect/glass below sit
    // inside <g transform="translate(8,8)">), so any transform here would
    // double-apply and offset the clip from the visible outline.
    `<path d="M 64 16 C 94 16 112 38 112 64 C 112 96 64 128 64 128 C 64 128 16 96 16 64 C 16 38 34 16 64 16 Z"/>` +
    `</clipPath>` +
    `</defs>` +
    `<g transform="translate(8,8)">` +
    // Pin background (clipped to pin shape)
    `<rect x="0" y="0" width="128" height="128" fill="#F4B73C" clip-path="url(#og-pin-clip)"/>` +
    // Shadow polygon — top edge traces the glass base, then extends out
    // and down to the pin tip. Clipped to the pin so the right edge tucks
    // neatly inside the curve.
    `<g clip-path="url(#og-pin-clip)">` +
    `<path d="M 54 82 Q 54 86 58 86 L 70 86 Q 74 86 74 82 L 140 115 L 64 128 Z" fill="#2B3B4A"/>` +
    `</g>` +
    // Pint glass with foam strip on top, also clipped to the pin
    `<g clip-path="url(#og-pin-clip)">` +
    `<path d="M 52 40 L 76 40 L 74 82 Q 74 86 70 86 L 58 86 Q 54 86 54 82 Z" fill="#FFFFFF" stroke="#1C1410" stroke-width="2.25" stroke-linejoin="round"/>` +
    `<rect x="52" y="40" width="24" height="5" fill="#1C1410"/>` +
    `</g>` +
    // Pin outline (no clipping — drawn on top so the stroke is sharp)
    `<path d="M 64 16 C 94 16 112 38 112 64 C 112 96 64 128 64 128 C 64 128 16 96 16 64 C 16 38 34 16 64 16 Z" fill="none" stroke="#1C1410" stroke-width="2.75" stroke-linejoin="round"/>` +
    `</g>` +
    `</svg>`
  );
}

// ── Public renderer ─────────────────────────────────────────────────────

export interface OgCardOptions {
  pub: Pub;
  buildings: Building[];
  sun: SunPosition;
  /** Pre-fetched CARTO tile cache for the porthole. */
  tileCache?: Map<string, string>;
  /** Tagline shown in the footer. */
  tagline?: string;
  /** Render the homepage variant: brand/tagline in the left column instead
   *  of pub identity + score. The porthole still renders the supplied pub
   *  so the card looks like the real product, but the pub name is never
   *  shown — it's just representative geometry. */
  home?: boolean;
}

export function renderOgCard(opts: OgCardOptions): string {
  const { pub, buildings, sun, tileCache, home } = opts;
  const tagline = opts.tagline ?? "Find your sunny pint";
  const score = pub.sun?.score;
  // Home variant always uses the top "Sun trap" tier so the brand colours
  // come through regardless of which pub we picked for the porthole.
  const tier = home ? tierStyle(95) : tierStyle(score);
  const town = pub.town ?? "";
  const bestWindow = pub.sun?.best_window ?? null;

  // Home variant gives the porthole a much bigger square — it's the main
  // visual on the homepage card, so we let it span almost the full height
  // between top padding and the footer divider. The left column's max
  // width shrinks to match.
  const portholeSize = home ? 500 : PORTHOLE_SIZE;
  const portholeX = W - PAD - portholeSize;
  const portholeY = home ? PAD : PORTHOLE_Y;
  const leftW = portholeX - PAD - 40;

  // ── Background ────────────────────────────────────────────────────
  const bg =
    `<defs>` +
    `<linearGradient id="og-bg" x1="0" y1="0" x2="1" y2="1">` +
    `<stop offset="0%" stop-color="${tier.bg[0]}"/>` +
    `<stop offset="100%" stop-color="${tier.bg[1]}"/>` +
    `</linearGradient>` +
    `<radialGradient id="og-vignette" cx="0.5" cy="0.5" r="0.85">` +
    `<stop offset="60%" stop-color="#000" stop-opacity="0"/>` +
    `<stop offset="100%" stop-color="#000" stop-opacity="0.18"/>` +
    `</radialGradient>` +
    `</defs>` +
    `<rect width="${W}" height="${H}" fill="url(#og-bg)"/>` +
    `<rect width="${W}" height="${H}" fill="url(#og-vignette)"/>`;

  // ── Header: logo + URL wordmark ───────────────────────────────────
  // Logo and wordmark are vertically centred in a 64px-tall band starting
  // at the top padding. Wordmark cap-height is centred against the logo.
  const LOGO_SIZE = 64;
  const LOGO_X = PAD;
  const LOGO_Y = PAD;
  const WORDMARK_FS = 40;
  const WORDMARK_TOP = LOGO_Y + (LOGO_SIZE - WORDMARK_FS * CAP) / 2;

  const header =
    inlineLogo(LOGO_X, LOGO_Y, LOGO_SIZE) +
    topText("sunny-pint.co.uk", LOGO_X + LOGO_SIZE + 22, WORDMARK_TOP, WORDMARK_FS, 700, {
      family: "sans",
      weight: 700,
      fill: tier.ink,
      letterSpacing: -0.5,
    });

  // ── Identity zone ─────────────────────────────────────────────────
  // Layout is sequential top-down: each element's TOP is the previous
  // element's BOTTOM plus a gap. No more baseline arithmetic.
  //
  // Home variant: brand headline + tagline instead of pub name + town.
  // The pub object is still used for the porthole geometry on the right
  // but its name is never shown. Larger headline (no need to scale for
  // long pub names) and a two-line sub explaining what the site does.

  let identity: string;
  let TOWN_BOTTOM: number;

  if (home) {
    // Sequential top-down: headline (2 lines) → sub (2 lines).
    const HEAD_FS = 92;
    const HEAD_LINE_GAP = 6;
    const SUB_FS = 34;
    const SUB_LINE_GAP = 8;
    const HEAD_TO_SUB_GAP = 28;

    const HEAD1_TOP = HEADER_H + 24;
    const HEAD2_TOP = HEAD1_TOP + HEAD_FS + HEAD_LINE_GAP;
    const SUB1_TOP = HEAD2_TOP + HEAD_FS + HEAD_TO_SUB_GAP;
    const SUB2_TOP = SUB1_TOP + SUB_FS + SUB_LINE_GAP;

    TOWN_BOTTOM = SUB2_TOP + SUB_FS;

    identity =
      topText("Sunny beer", LEFT_X, HEAD1_TOP, HEAD_FS, leftW, {
        family: "serif",
        weight: 700,
        fill: tier.ink,
        letterSpacing: -1.5,
      }) +
      topText("gardens", LEFT_X, HEAD2_TOP, HEAD_FS, leftW, {
        family: "serif",
        weight: 700,
        fill: tier.ink,
        letterSpacing: -1.5,
      }) +
      topText("Real-time shadow maps", LEFT_X, SUB1_TOP, SUB_FS, leftW, {
        family: "sans",
        weight: 500,
        fill: tier.ink,
        fillOpacity: 0.75,
      }) +
      topText("for UK pub gardens", LEFT_X, SUB2_TOP, SUB_FS, leftW, {
        family: "sans",
        weight: 500,
        fill: tier.ink,
        fillOpacity: 0.75,
      });
  } else {
    // Pub name font size scales down for long names so we never overflow.
    let pubNameSize = 84;
    if (pub.name.length > 22) pubNameSize = 68;
    if (pub.name.length > 32) pubNameSize = 52;

    const PUBNAME_TOP = HEADER_H + 12;
    const TOWN_GAP = 18;
    const TOWN_FS = 36;
    const TOWN_TOP = PUBNAME_TOP + pubNameSize + TOWN_GAP;
    TOWN_BOTTOM = TOWN_TOP + TOWN_FS;

    identity =
      topText(pub.name, LEFT_X, PUBNAME_TOP, pubNameSize, LEFT_W, {
        family: "serif",
        weight: 700,
        fill: tier.ink,
        letterSpacing: -1,
      }) +
      (town
        ? topText(town, LEFT_X, TOWN_TOP, TOWN_FS, LEFT_W, {
            family: "sans",
            weight: 500,
            fill: tier.ink,
            fillOpacity: 0.7,
          })
        : "");
  }

  // ── Score block ───────────────────────────────────────────────────
  // Sequential layout: eyebrow → score line → fact line. Each gap is the
  // PREVIOUS element's font height plus a fixed margin.

  const SCORE_ZONE_GAP = 56; // gap between town bottom and eyebrow top
  const EYEBROW_FS = 18;
  const SCORE_FS = 78;
  const FACT_FS = 28;
  const EYEBROW_TO_SCORE_GAP = 22;
  const SCORE_TO_FACT_GAP = 20;

  const EYEBROW_TOP = TOWN_BOTTOM + SCORE_ZONE_GAP;
  const SCORE_TOP = EYEBROW_TOP + EYEBROW_FS + EYEBROW_TO_SCORE_GAP;
  const SCORE_BASELINE = baselineFromTop(SCORE_TOP, SCORE_FS);
  const FACT_TOP = SCORE_TOP + SCORE_FS + SCORE_TO_FACT_GAP;

  let scoreBlock = "";
  if (score != null && !home) {
    scoreBlock += topText("SUNNY RATING", LEFT_X, EYEBROW_TOP, EYEBROW_FS, 250, {
      family: "sans",
      weight: 700,
      fill: tier.ink,
      fillOpacity: 0.5,
      letterSpacing: 4,
    });
    // Score line: "☀ 92 / 100" — composed of inline tspans on a single
    // <text> so the baseline is shared. Positioned by SVG baseline.
    scoreBlock +=
      `<text x="${LEFT_X}" y="${SCORE_BASELINE}" ` +
      `font-family="-apple-system, system-ui, sans-serif" font-size="${SCORE_FS}" ` +
      `font-weight="900" fill="${tier.ink}" letter-spacing="-3">` +
      `<tspan font-size="${Math.round(SCORE_FS * 0.78)}" baseline-shift="2">☀</tspan>` +
      `<tspan dx="14">${score}</tspan>` +
      `<tspan dx="6" font-size="${Math.round(SCORE_FS * 0.44)}" font-weight="500" fill-opacity="0.55">/ 100</tspan>` +
      `</text>`;
    const factLine = bestWindow ? `${tier.label} · best sun ${bestWindow}` : tier.label;
    scoreBlock += topText(factLine, LEFT_X, FACT_TOP, FACT_FS, LEFT_W, {
      family: "sans",
      weight: 600,
      fill: tier.ink,
      fillOpacity: 0.85,
    });
  }

  // ── Porthole on the right ─────────────────────────────────────────
  const portholeSvg = renderPortholeSvg(pub, buildings, sun, {
    size: portholeSize,
    tileCache,
  });
  const porthole = `<g transform="translate(${portholeX},${portholeY})">${unwrapSvg(portholeSvg)}</g>`;

  // ── Footer ────────────────────────────────────────────────────────
  // Footer occupies the bottom FOOTER_H. Divider near the top of the band,
  // tagline + URL aligned to the same baseline lower down.
  const FOOTER_TOP = H - FOOTER_H;
  const DIVIDER_Y = FOOTER_TOP + 12;
  const FOOTER_TEXT_TOP = FOOTER_TOP + 28;
  const TAGLINE_FS = 26;
  const URL_FS = 20;

  const footer =
    `<line x1="${PAD}" y1="${DIVIDER_Y}" x2="${W - PAD}" y2="${DIVIDER_Y}" ` +
    `stroke="${tier.ink}" stroke-opacity="0.25" stroke-width="2"/>` +
    topText(tagline, LEFT_X, FOOTER_TEXT_TOP, TAGLINE_FS, 700, {
      family: "sans",
      weight: 600,
      fill: tier.ink,
    }) +
    (home
      ? ""
      : `<text x="${W - PAD}" y="${baselineFromTop(FOOTER_TEXT_TOP + 4, URL_FS)}" ` +
        `font-family="-apple-system, system-ui, sans-serif" font-size="${URL_FS}" font-weight="500" ` +
        `fill="${tier.ink}" fill-opacity="0.55" text-anchor="end">` +
        `sunny-pint.co.uk/pub/${escapeXml(pub.slug ?? "")}` +
        `</text>`);

  // ── Compose ───────────────────────────────────────────────────────
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">` +
    bg +
    header +
    identity +
    scoreBlock +
    porthole +
    footer +
    `</svg>`
  );
}
