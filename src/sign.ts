/**
 * Pub sign — hand-drawn hanging tavern sign with iron arm and coat of arms.
 *
 * Renders the swinging tavern sign that appears above the porthole. The sign
 * shape, colour, and coat of arms are deterministically derived from the pub
 * name (so the same pub always looks identical). Layout is measured first to
 * ensure pub names of any length fit legibly.
 */

import { ARMORIA_URL, COA_CACHE_MAX } from "./config";
import { isDark } from "./theme";

/** Layout measurements for a pub sign — computed before rendering. */
export interface SignLayout {
  signW: number;
  signH: number;
  canvasH: number;
  fontSize: number;
  lines: string[];
}

const TARGET_FONT = 11;
const MIN_FONT = 8;
const MIN_SIGN_W = 100;

// ── Coat of arms cache ──────────────────────────────────────────────

const coaCache = new Map<string, HTMLImageElement | null>();
let coaLoadCallback: (() => void) | null = null;

/** Set a callback fired when an async coat-of-arms image finishes loading. */
export function setCoaLoadCallback(callback: () => void): void {
  coaLoadCallback = callback;
}

/**
 * Get a procedurally-generated coat of arms for a pub name.
 *
 * Returns the image element if loaded and ready, otherwise `null` (and kicks
 * off an async fetch from Armoria). The caller should re-render once the
 * load callback fires.
 */
export function getCoatOfArms(name: string): HTMLImageElement | null {
  if (coaCache.has(name)) {
    const img = coaCache.get(name);
    return img?.complete && img.naturalWidth > 0 ? img : null;
  }

  // Mark as loading to prevent duplicate fetches.
  coaCache.set(name, null);

  // Bound the cache to prevent memory leaks.
  if (coaCache.size > COA_CACHE_MAX) {
    const firstKey = coaCache.keys().next().value;
    if (firstKey) coaCache.delete(firstKey);
  }

  const seed = encodeURIComponent(name);
  const img = new Image();
  img.crossOrigin = "anonymous";
  img.onload = () => {
    coaCache.set(name, img);
    coaLoadCallback?.();
  };
  img.onerror = () => {
    coaCache.set(name, null);
  };
  img.src = `${ARMORIA_URL}/?seed=${seed}&format=svg&size=80`;
  return null;
}

// ── Layout helpers ──────────────────────────────────────────────────

/** Simple non-cryptographic string hash, used to derive deterministic colours/shapes. */
function hashStr(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

/** Generate a warm hue from the pub name for the sign background. */
function pubColor(name: string): { bg: string; accent: string; text: string } {
  const h = hashStr(name);
  const hue = 15 + (h % 40); // warm: 15-55°
  const sat = 30 + (h % 25);
  return {
    bg: `hsl(${hue}, ${sat}%, 22%)`,
    accent: `hsl(${hue}, ${sat + 10}%, 35%)`,
    text: `hsl(${hue}, ${sat - 10}%, 85%)`,
  };
}

/** Greedy word-wrap a string to fit within `maxWidth` pixels. */
function wrapText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const words = text.split(" ");
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const test = current ? `${current} ${word}` : word;
    if (ctx.measureText(test).width > maxWidth && current) {
      lines.push(current);
      current = word;
    } else {
      current = test;
    }
  }
  if (current) lines.push(current);
  return lines;
}

/**
 * Pre-measure how a pub name will fit on its sign.
 *
 * Picks a sign width and font size that fits the name in 1–2 lines if
 * possible, falling back to 3 lines at the minimum font size for very long
 * names. Used to size the sign canvas before drawing.
 */
export function measureSignLayout(name: string, maxW: number): SignLayout {
  const mc = document.createElement("canvas").getContext("2d");
  if (!mc) {
    return {
      signW: MIN_SIGN_W,
      signH: 44,
      canvasH: 86,
      fontSize: MIN_FONT,
      lines: [name],
    };
  }

  const hasCoA = !!getCoatOfArms(name);
  const shapeIdx = hashStr(name) % 4;

  const MAX_SIGN_W = Math.min(200, maxW * 0.85);
  const SIDE_INSET = shapeIdx === 3 ? 18 : 8;
  const TOP_INSET = shapeIdx === 1 || shapeIdx === 3 ? 14 : 8;
  const BOT_INSET = shapeIdx === 2 ? 20 : shapeIdx === 3 ? 14 : 8;
  const COA_W = hasCoA ? 32 : 0;

  let bestFontSize = MIN_FONT;
  let bestLines: string[] = [name];
  let bestSignW = MIN_SIGN_W;

  for (let fs = TARGET_FONT; fs >= MIN_FONT; fs--) {
    mc.font = `700 ${fs}px Georgia, serif`;
    for (let tw = 60; tw <= MAX_SIGN_W - SIDE_INSET * 2 - COA_W; tw += 10) {
      const lines = wrapText(mc, name, tw);
      if (lines.length <= 2) {
        const neededSignW = tw + SIDE_INSET * 2 + COA_W + 8;
        const signW = Math.max(MIN_SIGN_W, Math.min(MAX_SIGN_W, neededSignW));
        if (fs > bestFontSize || (fs === bestFontSize && signW <= bestSignW)) {
          bestFontSize = fs;
          bestLines = lines;
          bestSignW = signW;
        }
        break;
      }
    }
    if (bestFontSize === TARGET_FONT) break;
  }

  if (bestLines.length > 2) {
    mc.font = `700 ${MIN_FONT}px Georgia, serif`;
    const tw = MAX_SIGN_W - SIDE_INSET * 2 - COA_W - 8;
    bestLines = wrapText(mc, name, tw);
    if (bestLines.length > 3) bestLines = bestLines.slice(0, 3);
    bestSignW = MAX_SIGN_W;
  }

  const lineH = bestFontSize + 2;
  const textBlockH = bestLines.length * lineH;
  const signH = Math.max(44, textBlockH + TOP_INSET + BOT_INSET + 4);
  const canvasH = 16 + 20 + signH + 6;

  return { signW: bestSignW, signH, canvasH, fontSize: bestFontSize, lines: bestLines };
}

// ── Sign drawing ────────────────────────────────────────────────────

/**
 * Draw the pub sign onto the given canvas context.
 *
 * The sign is composed of:
 *   1. Iron back-plate bolted to the wall (left edge)
 *   2. Curved iron arm extending right
 *   3. Decorative top scroll, bottom brace, and finial
 *   4. Two chains hanging the sign board from the arm
 *   5. Sign board (rectangle, arched, pennant or oval based on hash)
 *   6. Wood-grain texture
 *   7. Coat of arms (if loaded)
 *   8. Pub name text wrapped to fit
 */
export function drawPubSign(
  ctx: CanvasRenderingContext2D,
  W: number,
  H: number,
  name: string,
  layout: SignLayout,
): void {
  const colors = pubColor(name);
  const dark = isDark();

  const iron = dark ? "#5A5550" : "#3E3A35";
  const ironHi = dark ? "#7A756E" : "#5A5550";

  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  function ironBar(lineW = 3): void {
    ctx.strokeStyle = iron;
    ctx.lineWidth = lineW;
    ctx.stroke();
    ctx.strokeStyle = ironHi;
    ctx.lineWidth = lineW * 0.3;
    ctx.globalAlpha = 0.35;
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  // ── Key positions ──
  const plateX = 0;
  const plateW = 6;
  const armY = 16;
  const armStartX = plateX + plateW - 1;
  const armEndX = W - 6;
  const armLen = armEndX - armStartX;

  const signW = layout.signW;
  const signH = layout.signH;
  const signX = armEndX - signW + 4;
  const signY = H - signH - 4;
  const r = 4;

  const hookL = signX + 14;
  const hookR = signX + signW - 14;

  // ── 1. Backplate ──
  ctx.fillStyle = iron;
  ctx.beginPath();
  ctx.rect(plateX, armY - 16, plateW, 46);
  ctx.fill();
  ctx.fillStyle = ironHi;
  for (const by of [armY - 11, armY + 1, armY + 13, armY + 24]) {
    ctx.beginPath();
    ctx.arc(plateW / 2, by, 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = iron;
    ctx.lineWidth = 0.7;
    ctx.beginPath();
    ctx.moveTo(plateW / 2 - 1.5, by);
    ctx.lineTo(plateW / 2 + 1.5, by);
    ctx.stroke();
  }

  // ── 2. Main arm ──
  ctx.beginPath();
  ctx.moveTo(armStartX, armY);
  ctx.bezierCurveTo(
    armStartX + armLen * 0.3,
    armY - 4,
    armStartX + armLen * 0.7,
    armY - 2,
    armEndX,
    armY,
  );
  ironBar(3.5);

  // ── 3. Top scroll ──
  const scrollW = Math.min(armLen * 0.35, 35);
  ctx.beginPath();
  ctx.moveTo(armStartX, armY - 1);
  ctx.bezierCurveTo(
    armStartX + scrollW * 0.3,
    armY - 12,
    armStartX + scrollW * 0.8,
    armY - 14,
    armStartX + scrollW,
    armY - 8,
  );
  ctx.bezierCurveTo(
    armStartX + scrollW * 1.05,
    armY - 4,
    armStartX + scrollW * 0.85,
    armY - 1,
    armStartX + scrollW * 0.65,
    armY - 1,
  );
  ironBar(2);

  // ── 4. Bottom brace ──
  const braceDropY = armY + Math.min(28, H * 0.28);
  ctx.beginPath();
  ctx.moveTo(armStartX, armY + 6);
  ctx.bezierCurveTo(
    armStartX + armLen * 0.1,
    braceDropY,
    armStartX + armLen * 0.3,
    braceDropY + 2,
    armStartX + armLen * 0.5,
    braceDropY - 10,
  );
  ctx.bezierCurveTo(
    armStartX + armLen * 0.7,
    armY + 6,
    armStartX + armLen * 0.85,
    armY + 2,
    armEndX - 4,
    armY + 1,
  );
  ironBar(2.5);

  // ── 5. Fill scroll ──
  const fs1x = armStartX + armLen * 0.12;
  ctx.beginPath();
  ctx.moveTo(fs1x, armY + 4);
  ctx.bezierCurveTo(fs1x + 6, armY + 14, fs1x + 16, armY + 12, fs1x + 12, armY + 4);
  ironBar(1.5);

  // ── 6. Finial ──
  ctx.fillStyle = iron;
  ctx.beginPath();
  ctx.arc(armEndX + 2, armY, 3, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(armEndX + 5, armY);
  ctx.lineTo(armEndX + 9, armY - 1.5);
  ctx.lineTo(armEndX + 9, armY + 1.5);
  ctx.closePath();
  ctx.fill();

  // ── 7. Hooks ──
  for (const hx of [hookL, hookR]) {
    ctx.strokeStyle = iron;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(hx, armY + 1);
    ctx.lineTo(hx, armY + 6);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(hx, armY + 6, 2.5, 0, Math.PI);
    ctx.stroke();
  }

  // ── 8. Chains ──
  const chainTop = armY + 9;
  const chainBot = signY - 1;
  const chainLen = chainBot - chainTop;
  const linkCount = Math.max(2, Math.round(chainLen / 8));

  for (const cx of [hookL, hookR]) {
    const dy = chainLen / linkCount;
    for (let i = 0; i < linkCount; i++) {
      const ly = chainTop + i * dy + dy / 2;
      ctx.beginPath();
      ctx.ellipse(cx, ly, 2.5, dy * 0.35, 0, 0, Math.PI * 2);
      ctx.strokeStyle = i % 2 === 0 ? iron : ironHi;
      ctx.lineWidth = 1.1;
      ctx.stroke();
    }
  }

  // ── 9. Sign rings ──
  for (const rx of [hookL, hookR]) {
    ctx.beginPath();
    ctx.arc(rx, signY + 2, 3, 0, Math.PI * 2);
    ctx.strokeStyle = iron;
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }

  // ── 10. Sign board ──
  const shapeIdx = hashStr(name) % 4;

  function signPath(): void {
    const cx = signX + signW / 2;
    switch (shapeIdx) {
      case 1: // Arched top
        ctx.moveTo(signX, signY + signH);
        ctx.lineTo(signX, signY + signH * 0.35);
        ctx.quadraticCurveTo(signX, signY, cx, signY);
        ctx.quadraticCurveTo(signX + signW, signY, signX + signW, signY + signH * 0.35);
        ctx.lineTo(signX + signW, signY + signH);
        ctx.closePath();
        break;
      case 2: // Pennant
        ctx.roundRect(signX, signY, signW, signH * 0.75, r);
        ctx.moveTo(signX, signY + signH * 0.74);
        ctx.lineTo(cx, signY + signH);
        ctx.lineTo(signX + signW, signY + signH * 0.74);
        break;
      case 3: // Oval
        ctx.ellipse(cx, signY + signH / 2, signW / 2, signH / 2, 0, 0, Math.PI * 2);
        break;
      default: // Rectangle
        ctx.roundRect(signX, signY, signW, signH, r);
    }
  }

  function signFramePath(): void {
    const cx = signX + signW / 2;
    const i = 4;
    const l = signX + i;
    const rr = signX + signW - i;
    const t = signY + i;
    const b = signY + signH - i;
    switch (shapeIdx) {
      case 1:
        ctx.moveTo(l, b);
        ctx.lineTo(l, t + signH * 0.3);
        ctx.quadraticCurveTo(l, t, cx, t);
        ctx.quadraticCurveTo(rr, t, rr, t + signH * 0.3);
        ctx.lineTo(rr, b);
        ctx.closePath();
        break;
      case 2:
        ctx.moveTo(l + r, t);
        ctx.lineTo(rr - r, t);
        ctx.arcTo(rr, t, rr, t + r, r - 1);
        ctx.lineTo(rr, signY + signH * 0.72);
        ctx.lineTo(cx, b);
        ctx.lineTo(l, signY + signH * 0.72);
        ctx.lineTo(l, t + r);
        ctx.arcTo(l, t, l + r, t, r - 1);
        break;
      case 3:
        ctx.ellipse(cx, signY + signH / 2, signW / 2 - i, signH / 2 - i, 0, 0, Math.PI * 2);
        break;
      default:
        ctx.roundRect(l, t, signW - i * 2, signH - i * 2, r - 1);
    }
  }

  ctx.save();
  ctx.shadowColor = "rgba(0,0,0,0.4)";
  ctx.shadowBlur = 8;
  ctx.shadowOffsetY = 3;
  ctx.beginPath();
  signPath();
  ctx.fillStyle = colors.bg;
  ctx.fill();
  ctx.restore();

  // Wood grain.
  ctx.save();
  ctx.beginPath();
  signPath();
  ctx.clip();
  ctx.globalAlpha = 0.05;
  ctx.strokeStyle = colors.text;
  ctx.lineWidth = 0.5;
  const hash = hashStr(name);
  for (let i = 0; i < 10; i++) {
    const gy = signY + 3 + (i * (signH - 6)) / 10 + ((hash >> i) % 2);
    ctx.beginPath();
    ctx.moveTo(signX, gy);
    ctx.lineTo(signX + signW, gy);
    ctx.stroke();
  }
  ctx.restore();

  // Safe text area inset.
  const safeInset = (() => {
    switch (shapeIdx) {
      case 1:
        return { top: 14, bot: 6, side: 8 };
      case 2:
        return { top: 8, bot: signH * 0.32, side: 8 };
      case 3:
        return { top: 14, bot: 14, side: 18 };
      default:
        return { top: 8, bot: 8, side: 8 };
    }
  })();

  const safeTop = signY + safeInset.top;
  const safeBot = signY + signH - safeInset.bot;
  const safeH = safeBot - safeTop;
  const safeLeft = signX + safeInset.side;
  const safeRight = signX + signW - safeInset.side;

  // Coat of arms.
  const coaImg = getCoatOfArms(name);
  const coaSize = Math.min(safeH - 4, 36);
  let coaActualW = 0;

  if (coaImg) {
    const coaX = safeLeft;
    const coaY = safeTop + (safeH - coaSize) / 2;
    ctx.save();
    ctx.beginPath();
    signPath();
    ctx.clip();
    ctx.drawImage(coaImg, coaX, coaY, coaSize, coaSize);
    ctx.restore();
    coaActualW = coaSize + 4;
  }

  // Gold frame.
  ctx.beginPath();
  signFramePath();
  ctx.strokeStyle = colors.accent;
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // Pub name text.
  const textLeft = safeLeft + coaActualW;
  const textRight = safeRight;
  const textW = textRight - textLeft;
  const textCenterX = textLeft + textW / 2;

  ctx.save();
  ctx.beginPath();
  signPath();
  ctx.clip();

  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = colors.text;

  const { fontSize, lines } = layout;
  ctx.font = `700 ${fontSize}px Georgia, serif`;

  const lineHeight = fontSize + 2;
  const textBlockH = lines.length * lineHeight;
  const textStartY = safeTop + (safeH - textBlockH) / 2 + lineHeight / 2;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line) ctx.fillText(line, textCenterX, textStartY + i * lineHeight);
  }
  ctx.restore();
}
