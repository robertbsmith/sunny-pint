/**
 * Email-sending Worker for Sunny Pint contact forms.
 *
 * Called via Service Binding from the Pages Function at /api/contact.
 * Uses Cloudflare's send_email binding to deliver to hello@sunny-pint.co.uk
 * (which forwards via Email Routing to the personal inbox).
 */

import { EmailMessage } from "cloudflare:email";
import { createMimeMessage } from "mimetext/browser";

interface Env {
  SEB: SendEmail;
  DESTINATION_EMAIL: string;
}

interface ContactPayload {
  name?: string;
  email?: string;
  message: string;
  type: "contact" | "report";
  /** Pub slug, included for "report a problem" submissions. */
  pub?: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    let payload: ContactPayload;
    try {
      payload = await request.json();
    } catch {
      return json({ error: "Invalid JSON" }, 400);
    }

    const { message, type, pub } = payload;
    const name = payload.name?.trim() || "Anonymous";
    const email = payload.email?.trim() || "";

    if (!message?.trim()) {
      return json({ error: "Message is required" }, 400);
    }

    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return json({ error: "Invalid email address" }, 400);
    }

    // Build subject
    const subject =
      type === "report" && pub
        ? `[Report] ${pub}`
        : `[Contact] ${name}`;

    // Build plain-text body
    const body = [
      email ? `From: ${name} <${email}>` : `From: ${name} (no email provided)`,
      type === "report" && pub ? `Pub: https://sunny-pint.co.uk/pub/${pub}/` : "",
      `Type: ${type || "contact"}`,
      "",
      message.trim(),
    ]
      .filter(Boolean)
      .join("\n");

    const mime = createMimeMessage();
    mime.setSender({ name: "Sunny Pint", addr: "noreply@sunny-pint.co.uk" });
    mime.setRecipient(env.DESTINATION_EMAIL);
    // Reply-To is already visible in the body text. mimetext's setHeader
    // rejects the Reply-To key, so we set it directly on the raw MIME output
    // after building the message.
    mime.setSubject(subject);
    mime.addMessage({ contentType: "text/plain", data: body });

    try {
      let raw = mime.asRaw();
      if (email) {
        raw = raw.replace("\r\nSubject:", `\r\nReply-To: ${email}\r\nSubject:`);
      }
      const msg = new EmailMessage(
        "noreply@sunny-pint.co.uk",
        env.DESTINATION_EMAIL,
        raw,
      );
      await env.SEB.send(msg);
    } catch (e) {
      console.error("send_email failed:", e);
      return json({ error: "Failed to send email" }, 500);
    }

    return json({ ok: true });
  },
};

function json(data: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
