/**
 * Sunny Rating badge — pure HTML helpers.
 *
 * Two sizes: compact (for pub list items) and large (for the pub-info card
 * under the porthole). Both use the same five-tier colour system from
 * style.css. Returns "" when the pub has no precomputed rating so callers
 * can drop the badge in any context without conditional checks.
 */

import type { Pub } from "./types";

/** Map a 0–100 score to its CSS modifier suffix. */
function tierClass(score: number): string {
  if (score >= 80) return "sunny-badge--trap";
  if (score >= 60) return "sunny-badge--very";
  if (score >= 40) return "sunny-badge--sunny";
  if (score >= 20) return "sunny-badge--partial";
  return "sunny-badge--shaded";
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Compact pill — for inline use in pub list items.
 *  Renders as e.g. `<span class="sunny-badge sunny-badge--very" title="Sunny Rating: 84/100 — Very sunny">84</span>`. */
export function smallSunBadgeHtml(pub: Pub): string {
  if (!pub.sun) return "";
  const cls = tierClass(pub.sun.score);
  const title = `Sunny Rating: ${pub.sun.score}/100 — ${pub.sun.label}`;
  return `<span class="sunny-badge ${cls}" title="${escapeHtml(title)}">${pub.sun.score}</span>`;
}

/** Large badge with score, label, best window, "how it works" link.
 *  For the pub-info card under the porthole.
 *
 *  Layout: score on the left (big numeric), label + best window stacked on
 *  the right, explainer link spanning underneath. Uses the available width
 *  efficiently rather than stacking everything on its own line. */
export function largeSunBadgeHtml(pub: Pub): string {
  if (!pub.sun) {
    return `<div class="sunny-badge sunny-badge--lg sunny-badge--partial">
      <span class="sunny-badge-label">Sunny Rating not available</span>
    </div>`;
  }
  const cls = tierClass(pub.sun.score);
  const window = pub.sun.best_window
    ? `<span class="sunny-badge-window">Best sun ${escapeHtml(pub.sun.best_window)}</span>`
    : "";
  // role="meter" requires aria-valuenow/min/max alongside the label so
  // assistive tech can read it as "Sunny Rating, 92 out of 100, Sun trap".
  return `<div class="sunny-badge sunny-badge--lg ${cls}" role="meter" aria-label="Sunny Rating: ${pub.sun.score} out of 100 — ${escapeHtml(pub.sun.label)}" aria-valuenow="${pub.sun.score}" aria-valuemin="0" aria-valuemax="100">
    <div class="sunny-badge-main">
      <span class="sunny-badge-score">${pub.sun.score}<span class="sunny-badge-score-max">/100</span></span>
      <div class="sunny-badge-text">
        <span class="sunny-badge-label">${escapeHtml(pub.sun.label)}</span>
        ${window}
      </div>
    </div>
    <span class="sunny-badge-explainer"><a href="/how-it-works.html#sunny-rating">How is this calculated?</a></span>
  </div>`;
}
