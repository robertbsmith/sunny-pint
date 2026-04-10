/**
 * Contact form overlay.
 *
 * Opens as a modal over the app. Supports two modes:
 *   - General contact (footer link)
 *   - Report a problem with a specific pub (pub info card link)
 */

export interface ContactContext {
  pubSlug?: string;
  pubName?: string;
}

let overlayEl: HTMLElement | null = null;

export function initContact(): void {
  overlayEl = document.getElementById("contact-overlay");
  if (!overlayEl) return;

  const closeBtn = overlayEl.querySelector(".contact-overlay-close");
  const backdrop = overlayEl.querySelector(".contact-overlay-backdrop");
  const form = document.getElementById("contact-form") as HTMLFormElement | null;

  closeBtn?.addEventListener("click", closeContact);
  backdrop?.addEventListener("click", closeContact);

  // Footer link
  const footerLink = document.getElementById("footer-contact");
  footerLink?.addEventListener("click", (e) => {
    e.preventDefault();
    openContact();
  });

  // Form submission
  form?.addEventListener("submit", handleSubmit);
}

export function openContact(ctx?: ContactContext): void {
  if (!overlayEl) return;

  const titleEl = document.getElementById("contact-title");
  const descEl = document.getElementById("contact-desc");
  const pubCtx = document.getElementById("contact-pub-context");
  const typeEl = document.getElementById("cf-type") as HTMLSelectElement | null;
  const statusEl = document.getElementById("contact-status");

  // Reset state
  if (statusEl) {
    statusEl.hidden = true;
    statusEl.className = "contact-status";
  }
  (document.getElementById("contact-form") as HTMLFormElement | null)?.reset();

  if (ctx?.pubSlug) {
    if (titleEl) titleEl.textContent = "Report a problem";
    if (descEl) descEl.textContent = "Something wrong with this pub's listing?";
    if (pubCtx) {
      pubCtx.hidden = false;
      pubCtx.textContent = ctx.pubName || ctx.pubSlug;
    }
    if (typeEl) typeEl.value = "report";
    overlayEl.dataset.pub = ctx.pubSlug;
  } else {
    if (titleEl) titleEl.textContent = "Contact";
    if (descEl) descEl.textContent = "Got a question, suggestion, or spotted something wrong?";
    if (pubCtx) pubCtx.hidden = true;
    delete overlayEl.dataset.pub;
    if (typeEl) typeEl.value = "contact";
  }

  overlayEl.hidden = false;
}

export function closeContact(): void {
  if (overlayEl) overlayEl.hidden = true;
}

async function handleSubmit(e: Event): Promise<void> {
  e.preventDefault();

  const message = (document.getElementById("cf-message") as HTMLTextAreaElement).value.trim();
  const name = (document.getElementById("cf-name") as HTMLInputElement).value.trim();
  const email = (document.getElementById("cf-email") as HTMLInputElement).value.trim();
  const type = (document.getElementById("cf-type") as HTMLSelectElement).value;
  const website = (document.getElementById("cf-website") as HTMLInputElement).value;
  const pub = overlayEl?.dataset.pub;

  const btn = document.getElementById("contact-submit") as HTMLButtonElement | null;

  if (!message) {
    showStatus("Please write a message.", "error");
    return;
  }

  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    showStatus("That email doesn't look right.", "error");
    return;
  }

  if (btn) {
    btn.disabled = true;
    btn.textContent = "Sending...";
  }

  try {
    const resp = await fetch("/api/contact", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message,
        name: name || undefined,
        email: email || undefined,
        type,
        website,
        pub: pub || undefined,
      }),
    });
    const data = (await resp.json()) as { ok?: boolean; error?: string };

    if (resp.ok && data.ok) {
      showStatus("Sent! Thanks for getting in touch.", "success");
      (document.getElementById("contact-form") as HTMLFormElement | null)?.reset();
    } else {
      showStatus(data.error || "Something went wrong. Please try again.", "error");
    }
  } catch {
    showStatus("Couldn't connect. Check your internet and try again.", "error");
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = "Send message";
    }
  }
}

function showStatus(msg: string, type: "success" | "error"): void {
  const el = document.getElementById("contact-status");
  if (!el) return;
  el.textContent = msg;
  el.className = `contact-status contact-status--${type}`;
  el.hidden = false;
}
