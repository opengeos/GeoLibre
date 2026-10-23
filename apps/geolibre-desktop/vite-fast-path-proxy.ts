import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";

/**
 * Dev-server route for the assistant's TypeSafe fast path.
 *
 * Neither endpoint the fast path can use is reachable from a browser dev
 * server. `api.typesafe.ai` returns no `Access-Control-Allow-Origin` for
 * `http://localhost:5173`, and the `ai.geolibre.app` Worker requires an
 * `X-GeoLibre-Instance-Token` that nginx injects in a Docker deployment and a
 * page cannot supply. Without this middleware the fast path simply never has
 * anywhere to send a question, and — because it is built to fail silently —
 * every prompt goes to the model with nothing to show that anything is wrong.
 *
 * So the dev server does what the deployment's reverse proxy does: it accepts
 * `/systemone` from the page and forwards it with the credential attached.
 * Which credential decides where it goes:
 *
 *   GEOLIBRE_AI_PROXY_TOKEN -> the deployed Worker (the production path)
 *   JEV_API_KEY             -> api.typesafe.ai directly
 *
 * Neither ever enters the client bundle; they are read from the dev process.
 * With neither set the route is not registered at all, and the fast path stays
 * off exactly as it does today.
 */

export const FAST_PATH_PROXY_PATH = "/systemone";

const TYPESAFE_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const DEFAULT_WORKER_URL = "https://ai.geolibre.app/systemone";

/** How the dev server will reach the routing service, or null when unconfigured. */
export function resolveFastPathProxyTarget(env: NodeJS.ProcessEnv = process.env): {
  url: string;
  headers: Record<string, string>;
  via: string;
} | null {
  const instanceToken = env.GEOLIBRE_AI_PROXY_TOKEN?.trim();
  if (instanceToken) {
    const url = env.GEOLIBRE_AI_PROXY_URL?.trim().replace(/\/+$/, "") ?? "";
    return {
      url: url ? `${url}/systemone` : DEFAULT_WORKER_URL,
      headers: { "X-GeoLibre-Instance-Token": instanceToken },
      via: url ? `${url}/systemone` : DEFAULT_WORKER_URL,
    };
  }
  const apiKey = env.JEV_API_KEY?.trim();
  if (apiKey) {
    return {
      url: TYPESAFE_ENDPOINT,
      headers: { Authorization: `Bearer ${apiKey}` },
      via: TYPESAFE_ENDPOINT,
    };
  }
  return null;
}

/** Read a bounded request body; routing questions are small by construction. */
async function readBody(request: IncomingMessage, maximumBytes = 131_072): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    total += (chunk as Buffer).byteLength;
    if (total > maximumBytes) throw new Error("Request body is too large");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function send(response: ServerResponse, status: number, body: string): void {
  response.statusCode = status;
  response.setHeader("content-type", "application/json");
  response.setHeader("cache-control", "no-store");
  response.end(body);
}

export function fastPathProxyPlugin(): Plugin {
  return {
    name: "geolibre-fast-path-proxy",
    config() {
      const target = resolveFastPathProxyTarget();
      if (!target) return;
      // Point the client at this origin's route. Only the path reaches the
      // bundle; the credential stays in the dev process.
      process.env.VITE_GEOLIBRE_FAST_PATH_URL ??= FAST_PATH_PROXY_PATH;
    },
    configureServer(server) {
      const target = resolveFastPathProxyTarget();
      if (!target) {
        server.config.logger.info(
          "[geolibre] assistant fast path disabled: set GEOLIBRE_AI_PROXY_TOKEN (to use the deployed Worker) or JEV_API_KEY (to call TypeSafe directly)",
        );
        return;
      }
      server.config.logger.info(`[geolibre] assistant fast path proxying to ${target.via}`);

      server.middlewares.use(FAST_PATH_PROXY_PATH, async (request, response) => {
        if (request.method !== "POST") {
          send(response, 405, JSON.stringify({ error: { message: "Method not allowed" } }));
          return;
        }
        try {
          const body = await readBody(request);
          const upstream = await fetch(target.url, {
            method: "POST",
            headers: { "Content-Type": "application/json", ...target.headers },
            body,
          });
          send(response, upstream.status, await upstream.text());
        } catch (error) {
          const message = error instanceof Error ? error.message : "Fast path proxy failed";
          send(response, 502, JSON.stringify({ error: { message } }));
        }
      });
    },
  };
}
