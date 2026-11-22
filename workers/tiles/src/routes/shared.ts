export const CORS_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
  // Allow the Range request header (the /pmtiles route needs it) and expose the
  // response headers a range reader relies on. Harmless for the tile routes.
  "access-control-allow-headers": "content-type, range",
  "access-control-expose-headers": "content-range, content-length, etag, accept-ranges",
  "access-control-max-age": "86400",
};

export const OVERPASS_UPSTREAM_HEADER = "x-overpass-upstream";

export const OVERPASS_CORS_HEADERS: Record<string, string> = {
  ...CORS_HEADERS,
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-expose-headers": `${CORS_HEADERS["access-control-expose-headers"]}, ${OVERPASS_UPSTREAM_HEADER}`,
};

/**
 * Whether an `Origin` header may use origin-gated service proxy routes.
 * Allowed:
 * - production web app on `*.geolibre.app` (any subdomain, plus the apex)
 * - Cloudflare Pages deploy previews (`*.geolibre-preview.pages.dev`)
 * - desktop webview (`tauri://localhost`, `http(s)://tauri.localhost`)
 * - local dev on `localhost` / `127.0.0.1`
 */
export function isAllowedProxyOrigin(origin: string | null): boolean {
  if (!origin) return false;
  let hostname: string;
  let protocol: string;
  try {
    ({ hostname, protocol } = new URL(origin));
  } catch {
    return false;
  }
  if (protocol === "tauri:" && hostname === "localhost") return true;
  if ((protocol === "http:" || protocol === "https:") && hostname === "tauri.localhost") {
    return true;
  }
  if (protocol === "https:") {
    if (hostname === "geolibre.app" || hostname.endsWith(".geolibre.app")) {
      return true;
    }
    if (hostname.endsWith(".geolibre-preview.pages.dev")) return true;
  }
  if (
    (protocol === "http:" || protocol === "https:") &&
    (hostname === "localhost" || hostname === "127.0.0.1")
  ) {
    return true;
  }
  return false;
}

/**
 * Image elements use `no-cors` mode and normally send `Referer`, not `Origin`.
 * Prefer Origin when present so an untrusted caller cannot hide behind a forged
 * allowed referrer; only fall back for the header shape produced by `<img>`.
 */
export function isAllowedProxyImageRequest(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (origin) return isAllowedProxyOrigin(origin);
  return isAllowedProxyOrigin(request.headers.get("referer"));
}

/** Read a bounded UTF-8 request body, returning null if it exceeds `limit`. */
export async function readRequestBodyWithLimit(
  request: Request,
  limit: number,
): Promise<string | null> {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let byteLength = 0;
  let body = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    byteLength += value.byteLength;
    if (byteLength > limit) {
      await reader.cancel();
      return null;
    }
    body += decoder.decode(value, { stream: true });
  }
  return body + decoder.decode();
}

/** Read an upstream response defensively without letting stream errors escape. */
export async function readResponseBytesWithLimit(
  response: Response,
  limit: number,
): Promise<Uint8Array | null> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > limit) {
    await response.body?.cancel().catch(() => undefined);
    return null;
  }
  const stream = response.body;
  if (!stream) return new Uint8Array();
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > limit) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
  } catch {
    await reader.cancel().catch(() => undefined);
    return null;
  }
  const body = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

/** Clear the upstream deadline only once its response body closes or is cancelled. */
export function streamWithTimeoutCleanup(
  body: ReadableStream,
  timeout: ReturnType<typeof setTimeout>,
): ReadableStream {
  const reader = body.getReader();
  const finish = () => clearTimeout(timeout);
  return new ReadableStream({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          finish();
          controller.close();
        } else {
          controller.enqueue(value);
        }
      } catch (error) {
        finish();
        controller.error(error);
      }
    },
    async cancel(reason) {
      finish();
      await reader.cancel(reason);
    },
  });
}
