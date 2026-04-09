/**
 * First-visit welcome modal.
 *
 * Shown only on the homepage (`/`) the very first time someone visits with
 * no saved location and no shared `?lat=&lng=` URL. Explains what the app
 * does in friendly language and gives the user three ways forward:
 *
 *   1. "Use my location" — triggers GPS via the existing location picker
 *      machinery so the reverse-geocode + label-update + persist flow runs
 *      exactly as if they'd opened the location picker themselves.
 *   2. "Pick a town" — closes the welcome and opens the existing location
 *      overlay (which already has a Nominatim search input + GPS button).
 *   3. "Skip" — closes the welcome and leaves the default city in place.
 *
 * After ANY of those three actions we mark the welcome as dismissed in
 * localStorage so it never reappears for that browser. Returning visitors
 * with a saved location skip the modal entirely (location is hydrated
 * from storage on init).
 *
 * SEO note: the modal HTML is created at runtime via JS, so it's not in
 * the static prerendered DOM that crawlers index. Landing pages (city,
 * theme, pub) never see this modal because the caller suppresses it when
 * a `sp:area` or `sp:pub` meta tag is present.
 */

import { requestGPSLocation } from "./location";
import { isWelcomeDismissed, markWelcomeDismissed } from "./storage";

/**
 * Show the welcome modal if appropriate. Returns immediately (no-op) when
 * the user has already dismissed it, or when the modal would otherwise be
 * inappropriate (caller decides — this function trusts that the caller
 * checked landing-page meta tags and shared-URL params before calling).
 */
export function maybeShowWelcome(): void {
  if (isWelcomeDismissed()) return;
  if (document.getElementById("welcome-modal")) return;

  const modal = buildModal();
  document.body.appendChild(modal);

  // Focus the primary action so keyboard users get a sensible default
  // and screen readers announce the modal as expected.
  setTimeout(() => {
    const primary = modal.querySelector<HTMLButtonElement>(".welcome-primary");
    primary?.focus();
  }, 50);
}

function buildModal(): HTMLElement {
  const overlay = document.createElement("div");
  overlay.id = "welcome-modal";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-labelledby", "welcome-title");

  // Building HTML as a template literal for clarity. We immediately wire
  // up event listeners by querySelector so the click handlers don't have
  // to live in inline onclick attributes (which would also break our CSP
  // if we added one later).
  overlay.innerHTML = `
    <div class="welcome-backdrop"></div>
    <div class="welcome-content">
      <div class="welcome-header">
        <img src="/icon.svg" alt="" class="welcome-logo" width="56" height="56" />
        <h2 id="welcome-title">Welcome to Sunny Pint</h2>
      </div>
      <p class="welcome-blurb">
        Find sunny beer garden seats at UK pubs.
        Pick a pub and see exactly which seats catch the sun right now —
        and where the shadows will fall as the afternoon goes on.
      </p>
      <p class="welcome-question">Where are you drinking?</p>
      <div class="welcome-actions">
        <button type="button" class="welcome-primary" data-action="gps">
          <span class="welcome-icon-pin" aria-hidden="true">📍</span>
          Use my location
        </button>
        <button type="button" class="welcome-secondary" data-action="search">
          <span class="welcome-icon-search" aria-hidden="true">🔎</span>
          Pick a town
        </button>
      </div>
      <button type="button" class="welcome-skip" data-action="skip">
        Skip — show me Norwich
      </button>
    </div>
  `;

  const close = (): void => {
    markWelcomeDismissed();
    overlay.remove();
  };

  overlay.querySelector(".welcome-backdrop")?.addEventListener("click", close);

  overlay.querySelector<HTMLButtonElement>('[data-action="gps"]')?.addEventListener("click", () => {
    close();
    // Defer one frame so the modal disappears before the browser's
    // permission prompt pops up — otherwise the prompt overlaps the
    // closing animation and looks janky.
    requestAnimationFrame(() => requestGPSLocation());
  });

  overlay
    .querySelector<HTMLButtonElement>('[data-action="search"]')
    ?.addEventListener("click", () => {
      close();
      // Trigger the existing location picker overlay rather than
      // duplicating the Nominatim search UI in the welcome modal.
      document.getElementById("btn-location")?.click();
    });

  overlay
    .querySelector<HTMLButtonElement>('[data-action="skip"]')
    ?.addEventListener("click", close);

  document.addEventListener("keydown", function escHandler(e) {
    if (e.key === "Escape" && document.body.contains(overlay)) {
      close();
      document.removeEventListener("keydown", escHandler);
    }
  });

  return overlay;
}
