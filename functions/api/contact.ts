/**
 * Pages Function — contact form handler.
 *
 * Validates the form submission, checks a honeypot field for bots, then
 * forwards to the email-sending Worker via a Service Binding.
 */

interface Env {
  EMAIL_WORKER: Fetcher;
}

/** Rate-limit: one submission per IP per 60 seconds. */
const recentSubmissions = new Map<string, number>();
const RATE_LIMIT_MS = 60_000;

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const { request } = context;

  // ── CORS ──
  const origin = request.headers.get("Origin") ?? "";
  const allowed =
    origin === "https://sunny-pint.co.uk" ||
    origin.endsWith(".sunny-pint.co.uk") ||
    origin.startsWith("http://localhost") ||
    origin.startsWith("http://127.0.0.1");

  const corsHeaders: Record<string, string> = {
    "Access-Control-Allow-Origin": allowed ? origin : "https://sunny-pint.co.uk",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  // ── Rate limiting (per-isolate, best-effort) ──
  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  const now = Date.now();
  const last = recentSubmissions.get(ip);
  if (last && now - last < RATE_LIMIT_MS) {
    return json({ error: "Please wait a minute before sending another message" }, 429, corsHeaders);
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400, corsHeaders);
  }

  // ── Honeypot — bots fill this hidden field ──
  if (body.website) {
    // Silently accept so bots think it worked
    return json({ ok: true }, 200, corsHeaders);
  }

  // ── Forward to email worker ──
  try {
    const resp = await context.env.EMAIL_WORKER.fetch(
      new Request("https://email-worker/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    );

    const result = await resp.json<Record<string, unknown>>();

    if (resp.ok) {
      recentSubmissions.set(ip, now);
    }

    return json(result, resp.status, corsHeaders);
  } catch (e) {
    console.error("Email worker error:", e);
    return json({ error: "Failed to send message" }, 500, corsHeaders);
  }
};

/** Handle CORS preflight. */
export const onRequestOptions: PagesFunction<Env> = async (context) => {
  const origin = context.request.headers.get("Origin") ?? "";
  const allowed =
    origin === "https://sunny-pint.co.uk" ||
    origin.endsWith(".sunny-pint.co.uk") ||
    origin.startsWith("http://localhost") ||
    origin.startsWith("http://127.0.0.1");

  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": allowed ? origin : "https://sunny-pint.co.uk",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    },
  });
};

function json(data: Record<string, unknown>, status: number, extra?: Record<string, string>): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...extra },
  });
}
