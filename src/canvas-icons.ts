/**
 * Draw Lucide sun/moon icons on a canvas context.
 * Shared between porthole (circle.ts) and sun arc (sunarc.ts).
 */

/** Draw a Lucide-style sun icon centred at (x, y) with given radius. */
export function drawSunCanvas(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  radius: number,
  alpha: number = 1,
): void {
  ctx.save();
  ctx.globalAlpha = alpha;

  // Glow.
  const glow = ctx.createRadialGradient(x, y, radius * 0.3, x, y, radius * 2.2);
  glow.addColorStop(0, "rgba(245,158,11,0.6)");
  glow.addColorStop(0.5, "rgba(245,158,11,0.15)");
  glow.addColorStop(1, "rgba(245,158,11,0)");
  ctx.fillStyle = glow;
  ctx.fillRect(x - radius * 2.5, y - radius * 2.5, radius * 5, radius * 5);

  const s = radius / 12; // scale: Lucide icons are 24x24, centred at 12,12

  ctx.translate(x - 12 * s, y - 12 * s);
  ctx.scale(s, s);

  ctx.strokeStyle = "#D97706";
  ctx.fillStyle = "#F59E0B";
  ctx.lineWidth = 2;
  ctx.lineCap = "round";

  // Centre circle (filled).
  ctx.beginPath();
  ctx.arc(12, 12, 4, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  // Rays.
  const rays: [number, number, number, number][] = [
    [12, 2, 12, 4], // top
    [12, 20, 12, 22], // bottom
    [2, 12, 4, 12], // left
    [20, 12, 22, 12], // right
    [6.34, 6.34, 4.93, 4.93], // top-left
    [17.66, 6.34, 19.07, 4.93], // top-right
    [6.34, 17.66, 4.93, 19.07], // bottom-left
    [17.66, 17.66, 19.07, 19.07], // bottom-right
  ];

  ctx.strokeStyle = "#F59E0B";
  ctx.lineWidth = 2;
  for (const [x1, y1, x2, y2] of rays) {
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
  }

  ctx.restore();
}

/** Draw a Lucide-style moon icon centred at (x, y) with given radius. */
export function drawMoonCanvas(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  radius: number,
  alpha: number = 1,
): void {
  ctx.save();
  ctx.globalAlpha = alpha;

  const s = radius / 12;
  ctx.translate(x - 12 * s, y - 12 * s);
  ctx.scale(s, s);

  ctx.strokeStyle = "#94A3B8";
  ctx.fillStyle = "#CBD5E0";
  ctx.lineWidth = 2;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  // Moon crescent path from Lucide.
  const p = new Path2D(
    "M20.985 12.486a9 9 0 1 1-9.473-9.472c.405-.022.617.46.402.803a6 6 0 0 0 8.268 8.268c.344-.215.825-.004.803.401",
  );
  ctx.fill(p);
  ctx.stroke(p);

  ctx.restore();
}
