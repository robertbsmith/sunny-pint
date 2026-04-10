/**
 * Procedural heraldic device renderer.
 *
 * Draws a small (~32px) shield with deterministic field divisions, tinctures,
 * and optional charges — all seeded from the pub name. Replaces the external
 * Armoria dependency with pure Canvas 2D rendering.
 *
 * Follows traditional heraldic conventions:
 *   - Rule of Tincture: metal on colour or colour on metal (guarantees contrast)
 *   - Standard tincture palette (2 metals, 5 colours)
 *   - Classic field divisions weighted by historical frequency
 *   - Simple silhouette charges legible at icon sizes
 */

// ── Seeded random helpers ──────────────────────────────────────────

/** Simple non-cryptographic string hash. */
function hashStr(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

/** Derive the Nth independent-ish value from a hash. */
function hashN(base: number, n: number): number {
  let h = base;
  for (let i = 0; i < n; i++) {
    h = ((h * 2654435761) >>> 0);
  }
  return h;
}

/** Pick from array using hash value. */
function pick<T>(arr: readonly T[], h: number): T {
  return arr[h % arr.length] as T;
}

// ── Tincture palette ───────────────────────────────────────────────
// Hex values from traditional heraldic conventions (verified against Armoria).

interface Tincture {
  name: string;
  hex: string;
  type: "metal" | "colour";
}

const TINCTURES: readonly Tincture[] = [
  { name: "argent", hex: "#fafafa", type: "metal" },
  { name: "or", hex: "#ffe066", type: "metal" },
  { name: "gules", hex: "#d7374a", type: "colour" },
  { name: "azure", hex: "#377cd7", type: "colour" },
  { name: "sable", hex: "#333333", type: "colour" },
  { name: "vert", hex: "#26c061", type: "colour" },
  { name: "purpure", hex: "#522d5b", type: "colour" },
];

const METALS = TINCTURES.filter(t => t.type === "metal");
const COLOURS = TINCTURES.filter(t => t.type === "colour");

/** Rule of Tincture: return a contrasting tincture type. */
function contrastingTincture(against: Tincture, h: number): Tincture {
  const pool = against.type === "metal" ? COLOURS : METALS;
  return pick(pool, h);
}

// ── Field divisions ────────────────────────────────────────────────
// Each division takes (ctx, w, h) and fills the second tincture region.
// The first tincture is already painted as the full shield background.

type DivisionFn = (ctx: CanvasRenderingContext2D, w: number, h: number) => void;

const DIVISIONS: readonly { name: string; weight: number; draw: DivisionFn }[] = [
  {
    name: "perPale",
    weight: 25,
    draw: (ctx, w, h) => {
      ctx.rect(w / 2, 0, w / 2, h);
    },
  },
  {
    name: "perFess",
    weight: 25,
    draw: (ctx, w, h) => {
      ctx.rect(0, h / 2, w, h / 2);
    },
  },
  {
    name: "perCross",
    weight: 25,
    draw: (ctx, w, h) => {
      // Quartered: top-right + bottom-left
      ctx.rect(w / 2, 0, w / 2, h / 2);
      ctx.rect(0, h / 2, w / 2, h / 2);
    },
  },
  {
    name: "perBend",
    weight: 10,
    draw: (ctx, w, h) => {
      ctx.moveTo(0, 0);
      ctx.lineTo(w, h);
      ctx.lineTo(0, h);
      ctx.closePath();
    },
  },
  {
    name: "perBendSinister",
    weight: 5,
    draw: (ctx, w, h) => {
      ctx.moveTo(w, 0);
      ctx.lineTo(0, h);
      ctx.lineTo(w, h);
      ctx.closePath();
    },
  },
  {
    name: "perChevron",
    weight: 5,
    draw: (ctx, w, h) => {
      ctx.moveTo(0, h);
      ctx.lineTo(w / 2, h * 0.45);
      ctx.lineTo(w, h);
      ctx.closePath();
    },
  },
  {
    name: "perSaltire",
    weight: 5,
    draw: (ctx, w, h) => {
      // Top + bottom triangles
      ctx.moveTo(0, 0);
      ctx.lineTo(w / 2, h / 2);
      ctx.lineTo(w, 0);
      ctx.closePath();
      ctx.moveTo(0, h);
      ctx.lineTo(w / 2, h / 2);
      ctx.lineTo(w, h);
      ctx.closePath();
    },
  },
];

// Build weighted selection array once.
const DIVISION_POOL: number[] = [];
for (let i = 0; i < DIVISIONS.length; i++) {
  const d = DIVISIONS[i];
  if (d) {
    for (let j = 0; j < d.weight; j++) {
      DIVISION_POOL.push(i);
    }
  }
}

// ── Charges ────────────────────────────────────────────────────────
// Simple silhouette paths normalised to a 0-1 unit square.
// Each is a function that traces a path (caller fills).

type ChargeFn = (ctx: CanvasRenderingContext2D) => void;

interface Charge {
  name: string;
  draw: ChargeFn;
}

const CHARGES: readonly Charge[] = [
  {
    name: "cross",
    draw: (ctx) => {
      // Simple Greek cross
      ctx.rect(0.33, 0, 0.34, 1);
      ctx.rect(0, 0.33, 1, 0.34);
    },
  },
  {
    name: "star",
    draw: (ctx) => {
      // 6-point star
      const cx = 0.5, cy = 0.5;
      const outer = 0.48, inner = 0.22;
      const points = 6;
      ctx.moveTo(cx, cy - outer);
      for (let i = 0; i < points; i++) {
        const aOuter = (Math.PI * 2 * i) / points - Math.PI / 2;
        const aInner = aOuter + Math.PI / points;
        ctx.lineTo(cx + Math.cos(aOuter) * outer, cy + Math.sin(aOuter) * outer);
        ctx.lineTo(cx + Math.cos(aInner) * inner, cy + Math.sin(aInner) * inner);
      }
      ctx.closePath();
    },
  },
  {
    name: "fleurDeLis",
    draw: (ctx) => {
      // Simplified fleur-de-lis silhouette
      const cx = 0.5;
      // Centre petal
      ctx.moveTo(cx, 0.05);
      ctx.bezierCurveTo(cx - 0.08, 0.15, cx - 0.12, 0.35, cx - 0.04, 0.5);
      ctx.lineTo(cx - 0.18, 0.5);
      // Left petal
      ctx.bezierCurveTo(cx - 0.45, 0.15, cx - 0.25, 0.0, cx - 0.12, 0.22);
      ctx.bezierCurveTo(cx - 0.18, 0.12, cx - 0.38, 0.1, cx - 0.35, 0.35);
      ctx.lineTo(cx - 0.18, 0.5);
      // Base
      ctx.lineTo(cx - 0.2, 0.58);
      ctx.lineTo(cx - 0.15, 0.55);
      ctx.lineTo(cx - 0.12, 0.7);
      ctx.lineTo(cx - 0.2, 0.75);
      ctx.lineTo(cx - 0.2, 0.82);
      ctx.lineTo(cx + 0.2, 0.82);
      ctx.lineTo(cx + 0.2, 0.75);
      ctx.lineTo(cx + 0.12, 0.7);
      ctx.lineTo(cx + 0.15, 0.55);
      ctx.lineTo(cx + 0.2, 0.58);
      ctx.lineTo(cx + 0.18, 0.5);
      // Right petal (mirror)
      ctx.bezierCurveTo(cx + 0.38, 0.1, cx + 0.18, 0.12, cx + 0.12, 0.22);
      ctx.bezierCurveTo(cx + 0.25, 0.0, cx + 0.45, 0.15, cx + 0.18, 0.5);
      ctx.lineTo(cx + 0.04, 0.5);
      ctx.bezierCurveTo(cx + 0.12, 0.35, cx + 0.08, 0.15, cx, 0.05);
      ctx.closePath();
    },
  },
  {
    name: "crown",
    draw: (ctx) => {
      // Simple 3-point crown
      ctx.moveTo(0.1, 0.75);
      ctx.lineTo(0.1, 0.45);
      ctx.lineTo(0.2, 0.55);
      ctx.lineTo(0.35, 0.25);
      ctx.lineTo(0.5, 0.55);
      ctx.lineTo(0.65, 0.25);
      ctx.lineTo(0.8, 0.55);
      ctx.lineTo(0.9, 0.45);
      ctx.lineTo(0.9, 0.75);
      ctx.closePath();
      // Brim
      ctx.moveTo(0.05, 0.75);
      ctx.lineTo(0.95, 0.75);
      ctx.lineTo(0.95, 0.88);
      ctx.lineTo(0.05, 0.88);
      ctx.closePath();
    },
  },
  {
    name: "lionRampant",
    draw: (ctx) => {
      // Simplified rampant lion silhouette — bold blocky shape
      // Body
      ctx.moveTo(0.55, 0.15);
      ctx.bezierCurveTo(0.65, 0.10, 0.75, 0.15, 0.72, 0.25);
      ctx.bezierCurveTo(0.78, 0.22, 0.82, 0.18, 0.8, 0.12);
      ctx.lineTo(0.85, 0.15);
      ctx.bezierCurveTo(0.85, 0.25, 0.78, 0.30, 0.72, 0.28);
      // Front leg up
      ctx.bezierCurveTo(0.75, 0.35, 0.82, 0.30, 0.85, 0.22);
      ctx.lineTo(0.88, 0.25);
      ctx.bezierCurveTo(0.85, 0.38, 0.75, 0.42, 0.68, 0.40);
      // Torso
      ctx.bezierCurveTo(0.65, 0.50, 0.60, 0.58, 0.55, 0.62);
      // Hind leg
      ctx.bezierCurveTo(0.52, 0.70, 0.55, 0.78, 0.58, 0.85);
      ctx.lineTo(0.62, 0.92);
      ctx.lineTo(0.52, 0.92);
      ctx.lineTo(0.48, 0.82);
      // Other hind leg
      ctx.bezierCurveTo(0.42, 0.85, 0.38, 0.90, 0.38, 0.92);
      ctx.lineTo(0.28, 0.92);
      ctx.lineTo(0.32, 0.82);
      ctx.bezierCurveTo(0.35, 0.72, 0.38, 0.65, 0.40, 0.58);
      // Tail
      ctx.bezierCurveTo(0.30, 0.55, 0.20, 0.45, 0.15, 0.30);
      ctx.bezierCurveTo(0.12, 0.20, 0.15, 0.12, 0.22, 0.10);
      ctx.bezierCurveTo(0.20, 0.18, 0.22, 0.28, 0.28, 0.38);
      ctx.bezierCurveTo(0.32, 0.45, 0.38, 0.50, 0.42, 0.50);
      // Back up
      ctx.bezierCurveTo(0.45, 0.42, 0.48, 0.32, 0.50, 0.22);
      ctx.bezierCurveTo(0.52, 0.18, 0.53, 0.16, 0.55, 0.15);
      ctx.closePath();
    },
  },
  {
    name: "anchor",
    draw: (ctx) => {
      // Simplified anchor
      const cx = 0.5;
      // Ring at top
      ctx.moveTo(cx + 0.08, 0.14);
      ctx.arc(cx, 0.14, 0.08, 0, Math.PI * 2);
      // Shaft
      ctx.moveTo(cx - 0.04, 0.22);
      ctx.lineTo(cx + 0.04, 0.22);
      ctx.lineTo(cx + 0.04, 0.72);
      ctx.lineTo(cx - 0.04, 0.72);
      ctx.closePath();
      // Cross bar
      ctx.moveTo(0.25, 0.30);
      ctx.lineTo(0.75, 0.30);
      ctx.lineTo(0.75, 0.37);
      ctx.lineTo(0.25, 0.37);
      ctx.closePath();
      // Left fluke
      ctx.moveTo(0.18, 0.62);
      ctx.quadraticCurveTo(0.20, 0.78, 0.46, 0.78);
      ctx.lineTo(0.46, 0.72);
      ctx.quadraticCurveTo(0.26, 0.72, 0.25, 0.62);
      ctx.closePath();
      // Right fluke
      ctx.moveTo(0.82, 0.62);
      ctx.quadraticCurveTo(0.80, 0.78, 0.54, 0.78);
      ctx.lineTo(0.54, 0.72);
      ctx.quadraticCurveTo(0.74, 0.72, 0.75, 0.62);
      ctx.closePath();
    },
  },
  {
    name: "castle",
    draw: (ctx) => {
      // Simple castle / tower with 3 merlons
      ctx.moveTo(0.15, 0.90);
      ctx.lineTo(0.15, 0.45);
      ctx.lineTo(0.15, 0.30);
      ctx.lineTo(0.25, 0.30);
      ctx.lineTo(0.25, 0.38);
      ctx.lineTo(0.35, 0.38);
      ctx.lineTo(0.35, 0.30);
      ctx.lineTo(0.45, 0.30);
      ctx.lineTo(0.45, 0.20);
      ctx.lineTo(0.55, 0.20);
      ctx.lineTo(0.55, 0.30);
      ctx.lineTo(0.65, 0.30);
      ctx.lineTo(0.65, 0.38);
      ctx.lineTo(0.75, 0.38);
      ctx.lineTo(0.75, 0.30);
      ctx.lineTo(0.85, 0.30);
      ctx.lineTo(0.85, 0.90);
      ctx.closePath();
      // Door (will be drawn as cutout by winding)
      ctx.moveTo(0.40, 0.90);
      ctx.lineTo(0.40, 0.65);
      ctx.quadraticCurveTo(0.40, 0.55, 0.50, 0.55);
      ctx.quadraticCurveTo(0.60, 0.55, 0.60, 0.65);
      ctx.lineTo(0.60, 0.90);
      ctx.closePath();
    },
  },
  {
    name: "oakLeaf",
    draw: (ctx) => {
      // Simplified oak leaf
      const cx = 0.5;
      ctx.moveTo(cx, 0.90);
      ctx.lineTo(cx, 0.50);
      // Left lobes
      ctx.bezierCurveTo(cx - 0.05, 0.48, cx - 0.25, 0.50, cx - 0.30, 0.42);
      ctx.bezierCurveTo(cx - 0.20, 0.42, cx - 0.10, 0.40, cx - 0.05, 0.38);
      ctx.bezierCurveTo(cx - 0.15, 0.35, cx - 0.30, 0.35, cx - 0.32, 0.28);
      ctx.bezierCurveTo(cx - 0.20, 0.30, cx - 0.10, 0.28, cx - 0.05, 0.26);
      ctx.bezierCurveTo(cx - 0.12, 0.20, cx - 0.20, 0.18, cx - 0.18, 0.12);
      ctx.bezierCurveTo(cx - 0.10, 0.15, cx - 0.05, 0.16, cx, 0.10);
      // Right lobes (mirror)
      ctx.bezierCurveTo(cx + 0.05, 0.16, cx + 0.10, 0.15, cx + 0.18, 0.12);
      ctx.bezierCurveTo(cx + 0.20, 0.18, cx + 0.12, 0.20, cx + 0.05, 0.26);
      ctx.bezierCurveTo(cx + 0.10, 0.28, cx + 0.20, 0.30, cx + 0.32, 0.28);
      ctx.bezierCurveTo(cx + 0.30, 0.35, cx + 0.15, 0.35, cx + 0.05, 0.38);
      ctx.bezierCurveTo(cx + 0.10, 0.40, cx + 0.20, 0.42, cx + 0.30, 0.42);
      ctx.bezierCurveTo(cx + 0.25, 0.50, cx + 0.05, 0.48, cx, 0.50);
      ctx.closePath();
      // Stem
      ctx.moveTo(cx - 0.02, 0.50);
      ctx.lineTo(cx + 0.02, 0.50);
      ctx.lineTo(cx + 0.02, 0.90);
      ctx.lineTo(cx - 0.02, 0.90);
      ctx.closePath();
    },
  },
];

// ── Shield path ────────────────────────────────────────────────────

/** Trace a classic heater shield outline. */
function shieldPath(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  ctx.moveTo(0, 0);
  ctx.lineTo(w, 0);
  ctx.lineTo(w, h * 0.55);
  ctx.quadraticCurveTo(w, h * 0.85, w / 2, h);
  ctx.quadraticCurveTo(0, h * 0.85, 0, h * 0.55);
  ctx.closePath();
}

// ── Main draw function ─────────────────────────────────────────────

/**
 * Draw a procedural heraldic device at (x, y) with the given size.
 *
 * Fully synchronous — no image loading, no async. Deterministic from the
 * pub name via hash seeding.
 */
export function drawHeraldicDevice(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  size: number,
  name: string,
): void {
  const h0 = hashStr(name);
  const h1 = hashN(h0, 1);
  const h2 = hashN(h0, 2);
  const h3 = hashN(h0, 3);
  const h4 = hashN(h0, 4);
  const h5 = hashN(h0, 5);

  // Pick tinctures with Rule of Tincture
  const t1 = pick(TINCTURES, h1);
  const t2 = contrastingTincture(t1, h2);

  // Pick division
  const divIdx = pick(DIVISION_POOL, h3);
  const division = DIVISIONS[divIdx];

  // Pick charge (~60% chance)
  const hasCharge = (h4 % 10) < 6;
  const charge = hasCharge ? pick(CHARGES, h5) : null;
  const chargeColour = hasCharge ? contrastingTincture(t1, h5 + 3) : null;

  // Shield dimensions — slightly taller than wide (classic heater proportions)
  const sw = size;
  const sh = size * 1.15;

  ctx.save();
  ctx.translate(x, y);

  // 1. Clip to shield shape
  ctx.save();
  ctx.beginPath();
  shieldPath(ctx, sw, sh);
  ctx.clip();

  // 2. Fill field with first tincture
  ctx.fillStyle = t1.hex;
  ctx.fillRect(0, 0, sw, sh);

  // 3. Draw division in second tincture
  if (division) {
    ctx.beginPath();
    division.draw(ctx, sw, sh);
    ctx.fillStyle = t2.hex;
    ctx.fill();
  }

  // 4. Draw charge centred on shield
  if (charge && chargeColour) {
    const chargeSize = sw * 0.55;
    const cx = (sw - chargeSize) / 2;
    const cy = (sh - chargeSize) / 2 - sh * 0.02; // nudge up slightly
    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(chargeSize, chargeSize);
    ctx.beginPath();
    charge.draw(ctx);
    ctx.fillStyle = chargeColour.hex;
    ctx.fill("evenodd");
    ctx.restore();
  }

  ctx.restore(); // un-clip

  // 5. Shield outline
  ctx.beginPath();
  shieldPath(ctx, sw, sh);
  ctx.strokeStyle = "#2a2a2a";
  ctx.lineWidth = Math.max(1, size * 0.04);
  ctx.stroke();

  ctx.restore(); // un-translate
}
