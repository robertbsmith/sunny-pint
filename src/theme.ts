/**
 * Theme detection and colour interpolation helpers.
 *
 * Provides a single source of truth for whether the app is currently in dark
 * mode, plus a `lerpColor` utility used by the canvas renderers to smoothly
 * transition colours between day and night.
 */

/** Whether the app is currently rendering in dark mode. */
export function isDark(): boolean {
  return document.documentElement.classList.contains("dark");
}

/**
 * Linearly interpolate between two hex colours.
 *
 * @param a Start colour, e.g. `"#1A2B3C"`.
 * @param b End colour, e.g. `"#FFFFFF"`.
 * @param t Interpolation factor, 0 = a, 1 = b.
 * @returns CSS `rgb(...)` string.
 */
export function lerpColor(a: string, b: string, t: number): string {
  const ar = parseInt(a.slice(1, 3), 16);
  const ag = parseInt(a.slice(3, 5), 16);
  const ab = parseInt(a.slice(5, 7), 16);
  const br = parseInt(b.slice(1, 3), 16);
  const bg = parseInt(b.slice(3, 5), 16);
  const bb = parseInt(b.slice(5, 7), 16);
  const r = Math.round(ar + (br - ar) * t);
  const g = Math.round(ag + (bg - ag) * t);
  const bl = Math.round(ab + (bb - ab) * t);
  return `rgb(${r},${g},${bl})`;
}
