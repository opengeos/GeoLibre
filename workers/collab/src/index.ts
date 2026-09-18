// collab.geolibre.app
//
// Relay for GeoLibre live-collaboration sessions. A thin router in front of the
// CollabSession Durable Object:
//
//   POST /sessions          -> create a session, return its code + host token
//   GET  /sessions/:id/ws   -> WebSocket upgrade into that session's actor
//   GET  /sessions/:id/log  -> host-only session log (Authorization: Bearer)
//   DELETE /sessions/:id/log -> host-only: clear the session log
//
// The session code namespaces the Durable Object (idFromName), so every
// participant of a session lands on the same actor and gets fanned out to.

import { isIdentityConfigured } from "@geolibre/collab-core";
import { CollabSession, type Env } from "./session";

export { CollabSession };

// Unambiguous base32 alphabet (no 0/1/O/I) for human-shareable session codes.
const CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const CODE_LENGTH = 8;

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Max-Age": "86400",
};

const MAX_RATE_LIMIT_KEYS = 10_000;
const SWEEP_INTERVAL_MS = 60_000;
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
let lastRateLimitSweep = 0;

function cleanupRateLimitMap(now: number): void {
  for (const [k, rec] of rateLimitMap.entries()) {
    if (now > rec.resetAt) rateLimitMap.delete(k);
  }
  while (rateLimitMap.size >= MAX_RATE_LIMIT_KEYS) {
    const oldestKey = rateLimitMap.keys().next().value;
    if (oldestKey === undefined) break;
    rateLimitMap.delete(oldestKey);
  }
  lastRateLimitSweep = now;
}

function isAllowedOrigin(originHeader: string | null, envAllowed?: string): boolean {
  if (!originHeader) return true;
  const allowedList = envAllowed
    ? envAllowed
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : [
        "https://geolibre.app",
        "https://web.geolibre.app",
        "https://viewer.geolibre.app",
        "https://studio.geolibre.app",
        "https://collab.geolibre.app",
        "http://localhost",
        "http://127.0.0.1",
        "tauri://localhost",
      ];

  try {
    const originUrl = new URL(originHeader);
    const host = originUrl.hostname;
    if (!envAllowed) {
      if (host === "localhost" || host === "127.0.0.1" || host.endsWith(".localhost")) return true;
      const previewSuffix = ".geolibre-preview.pages.dev";
      const previewLabel = host.endsWith(previewSuffix) ? host.slice(0, -previewSuffix.length) : "";
      if (
        originUrl.protocol === "https:" &&
        !originUrl.port &&
        previewLabel &&
        !previewLabel.includes(".")
      ) {
        return true;
      }
    }
    return allowedList.some((allowed) => {
      if (allowed === "*") return true;
      try {
        const allowedUrl = new URL(allowed);
        return originUrl.origin === allowedUrl.origin;
      } catch {
        return originHeader === allowed || host === allowed;
      }
    });
  } catch {
    return false;
  }
}

function checkRateLimit(key: string, maxRequests = 10, windowMs = 60_000): boolean {
  const now = Date.now();
  if (now - lastRateLimitSweep > SWEEP_INTERVAL_MS || rateLimitMap.size >= MAX_RATE_LIMIT_KEYS) {
    cleanupRateLimitMap(now);
  }
  const record = rateLimitMap.get(key);
  if (!record || now > record.resetAt) {
    rateLimitMap.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (record.count >= maxRequests) {
    return false;
  }
  record.count += 1;
  return true;
}

function randomCode(): string {
  const bytes = new Uint8Array(CODE_LENGTH);
  crypto.getRandomValues(bytes);
  let code = "";
  for (const byte of bytes) {
    code += CODE_ALPHABET[byte % CODE_ALPHABET.length];
  }
  return code;
}

function randomToken(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // Create a session.
    if (url.pathname === "/sessions" && request.method === "POST") {
      const origin = request.headers.get("Origin") ?? request.headers.get("Referer");
      if (!isAllowedOrigin(origin, env.ALLOWED_ORIGINS)) {
        return json({ error: "Origin not allowed to create sessions." }, 403);
      }

      const clientKey = request.headers.get("CF-Connecting-IP") ?? origin ?? "anonymous";
      if (!checkRateLimit(clientKey)) {
        return json({ error: "Too many session creation requests. Please try again later." }, 429);
      }

      const body = (await request.json().catch(() => ({}))) as {
        mode?: string;
        requireIdentity?: boolean;
      };
      const mode = body.mode === "view-only" ? "view-only" : "co-edit";
      const requireIdentity = body.requireIdentity === true;
      // Fail the create rather than silently downgrading: a host who asked for
      // a sign-in gate should hear that this relay has no issuer, not discover
      // it by watching anonymous guests walk in.
      if (requireIdentity && !isIdentityConfigured(env.COLLAB_IDENTITY_SECRET)) {
        return json({ error: "This relay has no sign-in provider configured." }, 400);
      }
      // Retry on the (rare) collision with an existing active session: /init
      // is a no-op when the code is already taken, so without this the caller
      // would receive a hostToken that doesn't match the stored one and be
      // silently downgraded to a guest in someone else's session.
      for (let attempt = 0; attempt < 5; attempt++) {
        const sessionId = randomCode();
        const hostToken = randomToken();
        const stub = env.COLLAB_SESSION.get(env.COLLAB_SESSION.idFromName(sessionId));
        const initRes = await stub.fetch("https://collab/init", {
          method: "POST",
          body: JSON.stringify({ mode, hostToken, requireIdentity }),
        });
        const initBody = (await initRes.json().catch(() => ({}))) as {
          alreadyInitialized?: boolean;
        };
        if (!initBody.alreadyInitialized) {
          return json({ sessionId, hostToken, mode, requireIdentity });
        }
      }
      return json({ error: "Could not allocate a session code. Please try again." }, 503);
    }

    // Join a session over WebSocket: /sessions/:id/ws
    const wsMatch = url.pathname.match(/^\/sessions\/([^/]+)\/ws$/);
    if (wsMatch && request.method === "GET") {
      const sessionId = wsMatch[1];
      const stub = env.COLLAB_SESSION.get(env.COLLAB_SESSION.idFromName(sessionId));
      // Rewrite to the actor's internal /ws path, preserving the upgrade
      // headers and method by copying them from the incoming request.
      return stub.fetch(new Request("https://collab/ws", request));
    }

    // Host-only session log: GET downloads it, DELETE clears it. The host
    // token travels as `Authorization: Bearer <hostToken>`; the actor checks it.
    const logMatch = url.pathname.match(/^\/sessions\/([^/]+)\/log$/);
    if (logMatch && (request.method === "GET" || request.method === "DELETE")) {
      const stub = env.COLLAB_SESSION.get(env.COLLAB_SESSION.idFromName(logMatch[1]));
      const res = await stub.fetch(new Request("https://collab/log", request));
      const headers = new Headers(res.headers);
      for (const [key, value] of Object.entries(CORS_HEADERS)) headers.set(key, value);
      return new Response(res.body, { status: res.status, headers });
    }

    if (url.pathname === "/" || url.pathname === "/health") {
      // `identitySupported` lets the client hide the "require a signed-in
      // account" option before it ever tries to create a session.
      return json({
        ok: true,
        service: "geolibre-collab",
        identitySupported: isIdentityConfigured(env.COLLAB_IDENTITY_SECRET),
      });
    }

    return json({ error: "Not found" }, 404);
  },
};
