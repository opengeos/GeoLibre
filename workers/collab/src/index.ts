// collab.geolibre.app
//
// Relay for GeoLibre live-collaboration sessions. A thin router in front of the
// CollabSession Durable Object:
//
//   POST /sessions          -> create a session, return its code + host token
//   GET  /sessions/:id/ws   -> WebSocket upgrade into that session's actor
//
// The session code namespaces the Durable Object (idFromName), so every
// participant of a session lands on the same actor and gets fanned out to.

import { CollabSession, type Env } from "./session";

export { CollabSession };

// Unambiguous base32 alphabet (no 0/1/O/I) for human-shareable session codes.
const CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const CODE_LENGTH = 8;

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
};

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
      const body = (await request.json().catch(() => ({}))) as {
        mode?: string;
      };
      const mode = body.mode === "view-only" ? "view-only" : "co-edit";
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
          body: JSON.stringify({ mode, hostToken }),
        });
        const initBody = (await initRes.json().catch(() => ({}))) as {
          alreadyInitialized?: boolean;
        };
        if (!initBody.alreadyInitialized) {
          return json({ sessionId, hostToken, mode });
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

    if (url.pathname === "/" || url.pathname === "/health") {
      return json({ ok: true, service: "geolibre-collab" });
    }

    return json({ error: "Not found" }, 404);
  },
};
