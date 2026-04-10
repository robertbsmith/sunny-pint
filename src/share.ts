/**
 * Share — capture the live porthole as a polished 1200×630 share card.
 *
 * Visual layout mirrors the server-side OG card (functions/_lib/og_card.ts)
 * — same tier-based gradient, identity block, score block, footer — but
 * draws in Canvas 2D so the porthole reflects the user's CURRENT sun
 * position, weather, and date instead of the static "best window" we
 * embed in link previews.
 *
 * The two cards drift in style at your peril. If you change one, change
 * the other (or eventually extract a shared layout module).
 */

import SunCalc from "suncalc";
import { renderCircle } from "./circle";
import { selectedPub, state } from "./state";

// ── Card dimensions ─────────────────────────────────────────────────────

const W = 1200;
const H = 630;
const PAD = 56;
const FOOTER_H = 80;

// Porthole sized to dominate the right half. The box is 540×540 but the
// visible circle inside it is only 468×468 — there's 36px of dead padding
// around the circle (BEZEL+34 margin baked into renderCircle). We exploit
// that padding by letting the box extend up into the header zone, since
// the visible circle stays clear of both the wordmark above and the
// footer divider below.
const PORTHOLE_SIZE = 540;
const PORTHOLE_RIGHT_PAD = 50;
const PORTHOLE_X = W - PORTHOLE_RIGHT_PAD - PORTHOLE_SIZE;
// Box top y=26 → visible circle y=62 to 530. Footer divider sits at 562,
// so the circle stays 32px above it; wordmark is at left padding so the
// box extending up into the header zone causes no horizontal overlap.
const PORTHOLE_Y = 26;
const LEFT_X = PAD;
const LEFT_W = PORTHOLE_X - PAD - 30;
const HEADER_H = 130;

// ── Tier styling (mirror og_card.ts) ────────────────────────────────────

interface TierStyle {
  bg: [string, string];
  ink: string;
  inkMuted: string;
  label: string;
}

function tierStyle(score: number | undefined): TierStyle {
  if (score == null)
    return { bg: ["#f3f4f6", "#9ca3af"], ink: "#111827", inkMuted: "#374151", label: "Unrated" };
  if (score >= 80)
    return { bg: ["#fde68a", "#f59e0b"], ink: "#1c1410", inkMuted: "#78350f", label: "Sun trap" };
  if (score >= 60)
    return { bg: ["#fef3c7", "#fbbf24"], ink: "#1c1410", inkMuted: "#92400e", label: "Very sunny" };
  if (score >= 40)
    return { bg: ["#fffbeb", "#fde68a"], ink: "#1c1410", inkMuted: "#92400e", label: "Sunny" };
  if (score >= 20)
    return {
      bg: ["#e5e7eb", "#9ca3af"],
      ink: "#111827",
      inkMuted: "#374151",
      label: "Partly shaded",
    };
  return { bg: ["#9ca3af", "#4b5563"], ink: "#f9fafb", inkMuted: "#e5e7eb", label: "Shaded" };
}

// ── Asset preloading ────────────────────────────────────────────────────

let cachedLogo: HTMLImageElement | null = null;

function loadLogo(): Promise<HTMLImageElement> {
  if (cachedLogo?.complete && cachedLogo.naturalWidth > 0) {
    return Promise.resolve(cachedLogo);
  }
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      cachedLogo = img;
      resolve(img);
    };
    img.onerror = reject;
    img.src = "/icon-192-v2.png";
  });
}

// ── Main entry ──────────────────────────────────────────────────────────

/** Generate a share image and trigger share/download. */
export async function shareSnapshot(): Promise<void> {
  const pub = selectedPub();
  if (!pub) return;

  const dpr = 2;
  const canvas = document.createElement("canvas");
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.scale(dpr, dpr);

  const score = pub.sun?.score;
  const tier = tierStyle(score);
  const town = pub.town ?? "";
  const bestWindow = pub.sun?.best_window ?? null;

  // Preload logo in parallel with porthole render. Logo failure is
  // non-fatal — the wordmark still renders without it.
  const logoPromise = loadLogo().catch(() => null);

  // ── Background: tier gradient + subtle vignette ─────────────────────
  drawBackground(ctx, tier);

  // ── Header: logo + wordmark ─────────────────────────────────────────
  const LOGO_SIZE = 64;
  const logo = await logoPromise;
  if (logo) {
    ctx.drawImage(logo, PAD, PAD, LOGO_SIZE, LOGO_SIZE);
  }
  ctx.fillStyle = tier.ink;
  ctx.font = "700 40px -apple-system, system-ui, 'Segoe UI', sans-serif";
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  ctx.fillText("sunny-pint.co.uk", PAD + LOGO_SIZE + 22, PAD + LOGO_SIZE / 2);

  // ── Identity: pub name + town ───────────────────────────────────────
  // Auto-size by length so common 15–20-char names like "The Edith Cavell"
  // step down enough to fit the narrower left column (524px) without
  // aggressive horizontal compression. fillTextFitted handles the residual.
  let pubNameSize = 76;
  if (pub.name.length > 14) pubNameSize = 58;
  if (pub.name.length > 22) pubNameSize = 46;
  if (pub.name.length > 32) pubNameSize = 36;

  const PUBNAME_TOP = HEADER_H + 12;
  ctx.fillStyle = tier.ink;
  ctx.font = `700 ${pubNameSize}px Georgia, 'Times New Roman', serif`;
  ctx.textBaseline = "top";
  fillTextFitted(ctx, pub.name, LEFT_X, PUBNAME_TOP, LEFT_W);

  const TOWN_TOP = PUBNAME_TOP + pubNameSize + 18;
  const TOWN_FS = 36;
  if (town) {
    ctx.font = `500 ${TOWN_FS}px -apple-system, system-ui, 'Segoe UI', sans-serif`;
    ctx.fillStyle = withAlpha(tier.ink, 0.7);
    ctx.fillText(town, LEFT_X, TOWN_TOP);
  }

  // ── Score block ─────────────────────────────────────────────────────
  const TOWN_BOTTOM = TOWN_TOP + TOWN_FS;
  const EYEBROW_TOP = TOWN_BOTTOM + 56;
  const EYEBROW_FS = 18;
  const SCORE_TOP = EYEBROW_TOP + EYEBROW_FS + 22;
  const SCORE_FS = 78;
  const FACT_TOP = SCORE_TOP + SCORE_FS + 20;
  const FACT_FS = 28;

  if (score != null) {
    // Eyebrow
    ctx.font = `700 ${EYEBROW_FS}px -apple-system, system-ui, sans-serif`;
    ctx.fillStyle = withAlpha(tier.ink, 0.5);
    drawLetterSpaced(ctx, "SUNNY RATING", LEFT_X, EYEBROW_TOP, 4);

    // Score line: ☀ NN /100
    ctx.fillStyle = tier.ink;
    ctx.font = `900 ${SCORE_FS}px -apple-system, system-ui, sans-serif`;
    const sunGlyphSize = Math.round(SCORE_FS * 0.78);
    ctx.font = `400 ${sunGlyphSize}px -apple-system, system-ui, sans-serif`;
    ctx.fillText("☀", LEFT_X, SCORE_TOP + 2);
    const sunGlyphW = ctx.measureText("☀").width;

    ctx.font = `900 ${SCORE_FS}px -apple-system, system-ui, sans-serif`;
    const numText = String(score);
    ctx.fillText(numText, LEFT_X + sunGlyphW + 14, SCORE_TOP);
    const numW = ctx.measureText(numText).width;

    const slashSize = Math.round(SCORE_FS * 0.44);
    ctx.font = `500 ${slashSize}px -apple-system, system-ui, sans-serif`;
    ctx.fillStyle = withAlpha(tier.ink, 0.55);
    // baseline-shift the "/100" to the score's baseline visually
    ctx.fillText(
      "/ 100",
      LEFT_X + sunGlyphW + 14 + numW + 6,
      SCORE_TOP + (SCORE_FS - slashSize) - 4,
    );

    // Fact line: tier label + current time/weather. Squeeze if it would
    // overflow into the porthole column.
    ctx.font = `600 ${FACT_FS}px -apple-system, system-ui, sans-serif`;
    ctx.fillStyle = withAlpha(tier.ink, 0.85);
    fillTextFitted(ctx, buildFactLine(pub, tier, bestWindow), LEFT_X, FACT_TOP, LEFT_W);
  }

  // ── Porthole (live render at current state) ─────────────────────────
  drawPorthole(ctx, PORTHOLE_X, PORTHOLE_Y, PORTHOLE_SIZE);

  // ── Footer: divider + tagline + URL ─────────────────────────────────
  const FOOTER_TOP = H - FOOTER_H;
  const DIVIDER_Y = FOOTER_TOP + 12;
  ctx.strokeStyle = withAlpha(tier.ink, 0.25);
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(PAD, DIVIDER_Y);
  ctx.lineTo(W - PAD, DIVIDER_Y);
  ctx.stroke();

  const FOOTER_TEXT_TOP = FOOTER_TOP + 28;
  ctx.font = "600 26px -apple-system, system-ui, sans-serif";
  ctx.fillStyle = tier.ink;
  ctx.textAlign = "left";
  ctx.fillText("Find your sunny pint", LEFT_X, FOOTER_TEXT_TOP);

  ctx.font = "500 20px -apple-system, system-ui, sans-serif";
  ctx.fillStyle = withAlpha(tier.ink, 0.55);
  ctx.textAlign = "right";
  ctx.fillText(`sunny-pint.co.uk/pub/${pub.slug ?? ""}`, W - PAD, FOOTER_TEXT_TOP + 4);

  // ── Convert and share ───────────────────────────────────────────────
  // Use JPEG for smaller file size (~500 KB vs ~5 MB PNG). Most share
  // targets handle JPEG fine and some silently reject large files.
  const blob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob(resolve, "image/jpeg", 0.92);
  });
  if (!blob) {
    console.warn("[share] toBlob returned null — falling back to dialog");
    return;
  }

  const filename = `sunny-pint-${pub.slug ?? pub.name.toLowerCase().replace(/\s+/g, "-")}.jpg`;
  const file = new File([blob], filename, { type: "image/jpeg", lastModified: Date.now() });

  const shareText = buildShareText(pub, tier);
  const shareUrl = pub.slug ? `${window.location.origin}/pub/${pub.slug}/` : window.location.href;

  if (navigator.share) {
    // Try sharing the image file directly. Two platform quirks:
    //
    // 1. iOS Safari historically drops files when text/title are also
    //    present in the share data — only the text gets shared. Safest
    //    to share {files} alone. The share text + URL are baked into
    //    the card footer so nothing is lost visually.
    //
    // 2. WhatsApp drops images when it detects a URL in the text body,
    //    switching to link-preview mode instead. Sharing files-only
    //    sidesteps this too.
    //
    // Skip canShare() — it returns false on iOS even when sharing works.
    try {
      await navigator.share({ files: [file] });
      return;
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") return;
      console.warn("[share] file share failed, falling back", err);
    }

    // Text + URL fallback (browsers without file sharing, e.g. Firefox).
    try {
      await navigator.share({ text: shareText, url: shareUrl });
      return;
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") return;
      console.warn("[share] text share failed", err);
    }
  }

  showShareDialog(blob, pub.name, shareUrl);
}

// ── Drawing helpers ─────────────────────────────────────────────────────

function drawBackground(ctx: CanvasRenderingContext2D, tier: TierStyle): void {
  const grad = ctx.createLinearGradient(0, 0, W, H);
  grad.addColorStop(0, tier.bg[0]);
  grad.addColorStop(1, tier.bg[1]);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);

  // Subtle radial vignette so the corners feel a touch heavier (matches
  // the OG card's <radialGradient id="og-vignette">).
  const vignette = ctx.createRadialGradient(W / 2, H / 2, 0, W / 2, H / 2, Math.max(W, H) * 0.6);
  vignette.addColorStop(0.6, "rgba(0,0,0,0)");
  vignette.addColorStop(1, "rgba(0,0,0,0.18)");
  ctx.fillStyle = vignette;
  ctx.fillRect(0, 0, W, H);
}

/** Render the live porthole into a temp canvas, then draw it square into
 *  the share canvas. renderCircle() produces a w × (w+32) canvas (the +32
 *  is dead space reserved for the pub-sign overlay in the live app); we
 *  crop the top/bottom 16px when copying. */
function drawPorthole(ctx: CanvasRenderingContext2D, x: number, y: number, size: number): void {
  const tmp = document.createElement("canvas");
  // renderCircle uses dataset.logicalW/H for layout; the actual bitmap can
  // be DPR-scaled. Use 2x so the porthole looks crisp at retina sizes.
  const dpr = 2;
  const w = size;
  const h = w + 32;
  tmp.width = w * dpr;
  tmp.height = h * dpr;
  tmp.dataset.logicalW = String(w);
  tmp.dataset.logicalH = String(h);
  const tctx = tmp.getContext("2d");
  if (!tctx) return;
  tctx.scale(dpr, dpr);
  renderCircle(tmp);

  // Crop the 16px top + 16px bottom of dead space so the circle sits flush
  // against the score block on the left.
  ctx.drawImage(
    tmp,
    /* sx */ 0,
    /* sy */ 16 * dpr,
    /* sw */ w * dpr,
    /* sh */ w * dpr,
    /* dx */ x,
    /* dy */ y,
    /* dw */ size,
    /* dh */ size,
  );
}

/** Squeeze text horizontally if it overflows maxWidth (canvas equivalent
 *  of og_card's textLength="" lengthAdjust="spacingAndGlyphs"). */
function fillTextFitted(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  maxWidth: number,
): void {
  const natural = ctx.measureText(text).width;
  if (natural <= maxWidth) {
    ctx.fillText(text, x, y);
    return;
  }
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(maxWidth / natural, 1);
  ctx.fillText(text, 0, 0);
  ctx.restore();
}

/** Canvas 2D doesn't have native letter-spacing on all browsers, so we
 *  draw character-by-character with a fixed extra advance. */
function drawLetterSpaced(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  spacing: number,
): void {
  let cursor = x;
  for (const ch of text) {
    ctx.fillText(ch, cursor, y);
    cursor += ctx.measureText(ch).width + spacing;
  }
}

/** Apply alpha to a hex colour without depending on a colour parser. */
function withAlpha(hex: string, alpha: number): string {
  const m = hex.match(/^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  if (!m) return hex;
  const r = parseInt(m[1]!, 16);
  const g = parseInt(m[2]!, 16);
  const b = parseInt(m[3]!, 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

// ── Caption strings ─────────────────────────────────────────────────────

function buildFactLine(
  pub: ReturnType<typeof selectedPub>,
  tier: TierStyle,
  _bestWindow: string | null,
): string {
  if (!pub) return tier.label;

  // Build the timestamped date the user is currently viewing.
  const viewing = new Date(state.date);
  viewing.setHours(0, 0, 0, 0);
  viewing.setMinutes(state.timeMins);

  const sun = SunCalc.getPosition(viewing, pub.lat, pub.lng);
  const isDay = sun.altitude > 0;
  const dayLabel = relativeDayLabel(viewing);
  const timeStr = format12h(state.timeMins);

  // "Very sunny today at 1:15pm" / "Sun trap tomorrow at 4pm".
  // Lower-case the tier label after the first word so it reads as a
  // sentence rather than a header ("Sun trap" → "Sun trap", "Very sunny"
  // stays as-is — it's already sentence case).
  const phrase = `${tier.label} ${dayLabel} at ${timeStr}`;
  return isDay ? phrase : `${tier.label} · ${dayLabel} ${timeStr}`;
}

/** "today" / "tomorrow" / "yesterday" / "on Mon 12 Apr" relative to now. */
function relativeDayLabel(d: Date): string {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const target = new Date(d);
  target.setHours(0, 0, 0, 0);
  const diffDays = Math.round((target.getTime() - today.getTime()) / 86400000);
  if (diffDays === 0) return "today";
  if (diffDays === 1) return "tomorrow";
  if (diffDays === -1) return "yesterday";
  // Fall back to "on Mon 12 Apr" for any other date so the share image
  // still makes sense if the user has scrubbed the date input.
  const fmt = target.toLocaleDateString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
  });
  return `on ${fmt}`;
}

/** Convert minutes-since-midnight to "1:15pm" / "4pm" / "9:30am". Drops the
 *  ":00" when the minutes are zero so round hours read more naturally. */
function format12h(timeMins: number): string {
  const total = Math.round(timeMins);
  const h24 = Math.floor(total / 60) % 24;
  const m = total % 60;
  const period = h24 < 12 ? "am" : "pm";
  let h12 = h24 % 12;
  if (h12 === 0) h12 = 12;
  return m === 0 ? `${h12}${period}` : `${h12}:${String(m).padStart(2, "0")}${period}`;
}

function buildShareText(pub: ReturnType<typeof selectedPub>, _tier: TierStyle): string {
  if (!pub) return "Find your sunny pint";
  const d = new Date(state.date);
  d.setHours(0, 0, 0, 0);
  d.setMinutes(state.timeMins);
  const sun = SunCalc.getPosition(d, pub.lat, pub.lng);
  const isDay = sun.altitude > 0;
  if (!isDay) return `🌙 ${pub.name}`;
  if (state.weatherState === "sunny") return `☀️ ${pub.name} — sun's out, pints out? 🍺`;
  if (state.weatherState === "partly-cloudy") return `⛅ ${pub.name} — not bad out there. Pint? 🍺`;
  return `☁️ ${pub.name} — bit grey but sod it. Pint? 🍺`;
}

// ── Desktop share dialog (fallback when navigator.share is missing) ────

function showShareDialog(imageBlob: Blob, pubName: string, shareUrl: string): void {
  document.getElementById("share-dialog")?.remove();

  const imgUrl = URL.createObjectURL(imageBlob);

  const overlay = document.createElement("div");
  overlay.id = "share-dialog";
  overlay.innerHTML = `
    <div class="share-dialog-backdrop"></div>
    <div class="share-dialog-content">
      <button class="share-dialog-close" title="Close">&times;</button>
      <img src="${imgUrl}" alt="Share preview" />
      <div class="share-dialog-actions">
        <button class="share-btn-copy" title="Copy link">Copy link</button>
        <button class="share-btn-download" title="Download image">Download image</button>
      </div>
      <input class="share-dialog-link" type="text" readonly value="${shareUrl}" />
    </div>
  `;

  document.body.appendChild(overlay);

  const close = () => {
    overlay.remove();
    URL.revokeObjectURL(imgUrl);
  };
  overlay.querySelector(".share-dialog-backdrop")!.addEventListener("click", close);
  overlay.querySelector(".share-dialog-close")!.addEventListener("click", close);

  overlay.querySelector(".share-btn-copy")!.addEventListener("click", () => {
    navigator.clipboard.writeText(shareUrl).then(() => {
      const btn = overlay.querySelector(".share-btn-copy") as HTMLButtonElement;
      btn.textContent = "Copied!";
      setTimeout(() => {
        btn.textContent = "Copy link";
      }, 1500);
    });
  });

  overlay.querySelector(".share-btn-download")!.addEventListener("click", () => {
    const a = document.createElement("a");
    a.href = imgUrl;
    a.download = `sunny-pint-${pubName.toLowerCase().replace(/\s+/g, "-")}.png`;
    a.click();
  });

  const linkInput = overlay.querySelector(".share-dialog-link") as HTMLInputElement;
  linkInput.addEventListener("click", () => linkInput.select());
}
