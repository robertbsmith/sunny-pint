/**
 * Renders an example OG image SVG via Satori for design iteration.
 *
 * Authors the layout in HTML+CSS (via satori-html) instead of raw SVG, so
 * flexbox, padding, line wrapping, and font metrics all work like a normal
 * web page. Satori produces an SVG output we can ship as a static file or
 * via a Cloudflare Worker once we're happy with the design.
 *
 * Run with:
 *   pnpm tsx scripts/render_og_example.ts
 *
 * Output:
 *   public/og-example.svg
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import satori from "satori";
import { html } from "satori-html";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const FONTS_DIR = join(ROOT, "data", "fonts");
const OUT = join(ROOT, "public", "og-example.svg");

// ── Tier styling (same palette as the rest of the site) ─────────────────

interface TierStyle {
  bg: string; // background gradient (CSS)
  ink: string; // primary text colour
  ribbon: string; // accent / border colour
  label: string; // human label
}

function tierStyle(score: number): TierStyle {
  if (score >= 80)
    return {
      bg: "linear-gradient(135deg, #fde68a 0%, #fbbf24 55%, #f59e0b 100%)",
      ink: "#1c1410",
      ribbon: "#78350f",
      label: "Sun trap",
    };
  if (score >= 60)
    return {
      bg: "linear-gradient(135deg, #fef3c7 0%, #fcd34d 55%, #f59e0b 100%)",
      ink: "#1c1410",
      ribbon: "#78350f",
      label: "Very sunny",
    };
  if (score >= 40)
    return {
      bg: "linear-gradient(135deg, #fffbeb 0%, #fde68a 55%, #fbbf24 100%)",
      ink: "#1c1410",
      ribbon: "#92400e",
      label: "Sunny",
    };
  if (score >= 20)
    return {
      bg: "linear-gradient(135deg, #f3f4f6 0%, #d1d5db 55%, #9ca3af 100%)",
      ink: "#111827",
      ribbon: "#374151",
      label: "Partly shaded",
    };
  return {
    bg: "linear-gradient(135deg, #d1d5db 0%, #9ca3af 55%, #6b7280 100%)",
    ink: "#111827",
    ribbon: "#1f2937",
    label: "Shaded",
  };
}

// ── The Sunny Pint logo, inlined as an SVG data URI ─────────────────────
//
// satori-html supports <img src=...> with data URIs, which is the cleanest
// way to embed our logo without satori having to parse it as JSX.

function logoDataUri(): string {
  const svg = readFileSync(join(ROOT, "public", "icon.svg"), "utf-8");
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

// ── The card template ───────────────────────────────────────────────────

interface OgData {
  pubName: string;
  town: string;
  score: number;
  bestWindow: string | null;
  slug: string;
}

function template(data: OgData): string {
  const tier = tierStyle(data.score);
  const logo = logoDataUri();
  const fullUrl = `sunny-pint.co.uk/pub/${data.slug}/`;

  // The whole card is one big flex container. The author experience is
  // basically "write the HTML you want and CSS-flexbox it". satori handles
  // the rest — text wraps automatically inside flex children, padding
  // works, percentages work.
  // Note for satori: every container with more than one child must have an
  // explicit display: flex (or display: none/contents). Plain block layout
  // is not implemented. Each <div> below either holds a single child / text
  // node, or sets display: flex.
  return `
    <div style="
      display: flex;
      width: 1200px;
      height: 630px;
      background: ${tier.bg};
      color: ${tier.ink};
      font-family: 'Inter';
      padding: 56px 64px;
      flex-direction: column;
      justify-content: space-between;
    ">
      <!-- Top bar: logo + wordmark -->
      <div style="display: flex; align-items: center;">
        <img src="${logo}" width="64" height="64" style="margin-right: 18px;" />
        <div style="display: flex; font-family: 'Crimson Text'; font-size: 42px; font-weight: 700; letter-spacing: -0.5px;">
          Sunny Pint
        </div>
      </div>

      <!-- Middle: pub identity (left) + score circle (right) -->
      <div style="display: flex; align-items: center; margin-top: -20px;">
        <!-- Identity column. flex:1 takes whatever space the score doesn't. -->
        <div style="display: flex; flex-direction: column; flex: 1; min-width: 0; margin-right: 48px;">
          <div style="
            display: flex;
            font-family: 'Crimson Text';
            font-size: 88px;
            font-weight: 700;
            line-height: 0.95;
            letter-spacing: -2px;
            color: ${tier.ink};
          ">${escapeHtml(data.pubName)}</div>
          <div style="
            display: flex;
            font-family: 'Inter';
            font-size: 36px;
            font-weight: 500;
            line-height: 1.2;
            margin-top: 14px;
            opacity: 0.7;
          ">${escapeHtml(data.town)}</div>

          <div style="display: flex; align-items: center; margin-top: 36px;">
            <div style="
              display: flex;
              font-size: 18px;
              font-weight: 700;
              text-transform: uppercase;
              letter-spacing: 4px;
              opacity: 0.5;
              margin-right: 14px;
            ">Sunny Rating</div>
            <div style="
              display: flex;
              width: 80px;
              height: 2px;
              background: ${tier.ink};
              opacity: 0.3;
            "></div>
          </div>
          <div style="
            display: flex;
            font-family: 'Inter';
            font-size: 32px;
            font-weight: 600;
            margin-top: 12px;
            line-height: 1.2;
          ">
            ${escapeHtml(tier.label)}${data.bestWindow ? ` · best sun ${escapeHtml(data.bestWindow)}` : ""}
          </div>
        </div>

        <!-- Score circle. Fixed width so the identity column flexes around it. -->
        <div style="
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          width: 320px;
          height: 320px;
          border-radius: 9999px;
          background: rgba(255, 255, 255, 0.92);
          border: 5px solid ${tier.ink};
          box-shadow: 0 12px 24px rgba(0,0,0,0.18);
        ">
          <div style="
            display: flex;
            font-family: 'Inter';
            font-size: 200px;
            font-weight: 900;
            line-height: 1;
            letter-spacing: -10px;
            color: ${tier.ink};
          ">${data.score}</div>
          <div style="
            display: flex;
            font-family: 'Inter';
            font-size: 32px;
            font-weight: 500;
            margin-top: 6px;
            opacity: 0.55;
            color: ${tier.ink};
          ">/ 100</div>
        </div>
      </div>

      <!-- Footer: URL bar -->
      <div style="display: flex; flex-direction: column;">
        <div style="
          display: flex;
          height: 2px;
          background: ${tier.ink};
          opacity: 0.25;
          margin-bottom: 18px;
        "></div>
        <div style="display: flex; justify-content: space-between; align-items: baseline;">
          <div style="
            display: flex;
            font-family: 'Inter';
            font-size: 28px;
            font-weight: 700;
            color: ${tier.ink};
          ">
            sunny-pint.co.uk<span style="font-weight: 400; opacity: 0.55;">/pub/${escapeHtml(data.slug)}/</span>
          </div>
          <div style="
            display: flex;
            font-family: 'Inter';
            font-size: 22px;
            font-weight: 500;
            opacity: 0.6;
            color: ${tier.ink};
          ">
            Real-time shadow maps
          </div>
        </div>
      </div>
    </div>
  `;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ── Render ──────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const data: OgData = {
    pubName: "The Racecourse",
    town: "Norwich",
    score: 92,
    bestWindow: "06:29–17:59",
    slug: "the-racecourse-norwich",
  };

  const interRegular = readFileSync(join(FONTS_DIR, "Inter-Regular.ttf"));
  const interBold = readFileSync(join(FONTS_DIR, "Inter-Bold.ttf"));
  const interBlack = readFileSync(join(FONTS_DIR, "Inter-Black.ttf"));
  const crimsonRegular = readFileSync(join(FONTS_DIR, "CrimsonText-Regular.ttf"));
  const crimsonBold = readFileSync(join(FONTS_DIR, "CrimsonText-Bold.ttf"));

  const markup = html(template(data));

  const svg = await satori(markup as any, {
    width: 1200,
    height: 630,
    fonts: [
      { name: "Inter", data: interRegular, weight: 400, style: "normal" },
      { name: "Inter", data: interBold, weight: 700, style: "normal" },
      { name: "Inter", data: interBlack, weight: 900, style: "normal" },
      { name: "Crimson Text", data: crimsonRegular, weight: 400, style: "normal" },
      { name: "Crimson Text", data: crimsonBold, weight: 700, style: "normal" },
    ],
  });

  writeFileSync(OUT, svg);
  const sizeKb = Math.round(svg.length / 1024);
  console.log(`Wrote ${OUT} (${sizeKb} KB)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
