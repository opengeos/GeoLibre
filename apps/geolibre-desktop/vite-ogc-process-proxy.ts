import type { IncomingMessage, ServerResponse } from "node:http";
import {
  fetchWithGuard,
  PROXY_MAX_REDIRECT_HOPS,
  readBodyWithLimit,
  validatePublicUrl,
} from "./vite-proxy-guard";
import {
  MAX_PROCESS_INPUT_BYTES,
  MAX_PROCESS_METADATA_BYTES,
  MAX_PROCESS_RESULT_BYTES,
  OGC_PROCESS_PROXY_PATH,
} from "./src/lib/ogc-process-limits";

class ProcessProxyError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Buffer a small JSON execution body without destroying the response on overflow. */
async function readInputs(req: IncomingMessage): Promise<Buffer> {
  if (Number(req.headers["content-length"]) > MAX_PROCESS_INPUT_BYTES)
    throw new ProcessProxyError(413, "OGC process inputs exceed 1 MiB.");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > MAX_PROCESS_INPUT_BYTES)
      throw new ProcessProxyError(413, "OGC process inputs exceed 1 MiB.");
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

/** Follow HTTP redirects with Fetch's method/body rules and a guard at every hop. */
async function processRequest(
  initialUrl: string,
  initialMethod: string,
  body: string | undefined,
  headers: Headers,
  signal: AbortSignal,
): Promise<{ response: Response; url: string }> {
  let url = initialUrl;
  let method = initialMethod;
  for (let hop = 0; hop <= PROXY_MAX_REDIRECT_HOPS; hop++) {
    const response = await fetchWithGuard(
      url,
      { method, body, headers, signal },
      {
        timeoutMs: 120_000,
        followRedirects: false,
      },
    );
    if (![301, 302, 303, 307, 308].includes(response.status)) return { response, url };
    const location = response.headers.get("location");
    if (!location) return { response, url };
    await response.body?.cancel().catch(() => {});
    const next = new URL(location, url);
    if (validatePublicUrl(next.href))
      throw new ProcessProxyError(502, "OGC process redirect is not allowed.");
    if (
      (response.status === 303 && method !== "GET") ||
      ([301, 302].includes(response.status) && method === "POST")
    ) {
      method = "GET";
      body = undefined;
      for (const name of [
        "content-type",
        "content-encoding",
        "content-language",
        "content-location",
        "content-length",
        "prefer",
      ])
        headers.delete(name);
    }
    if (next.origin !== new URL(url).origin) {
      headers.delete("authorization");
      headers.delete("cookie");
    }
    url = next.href;
  }
  throw new ProcessProxyError(502, "Too many OGC process redirects.");
}

/** Same-origin development transport for bounded process execution and job controls. */
export async function proxyOgcProcessRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const abort = new AbortController();
  const disconnected = () => {
    if (!res.writableEnded) abort.abort();
  };
  res.on("close", disconnected);
  try {
    const origin = req.headers.origin;
    if (origin) {
      let sameOrigin = false;
      try {
        const parsed = new URL(origin);
        sameOrigin = /^https?:$/.test(parsed.protocol) && parsed.host === req.headers.host;
      } catch {
        /* Opaque or malformed origins are not same-origin requests. */
      }
      if (!sameOrigin)
        throw new ProcessProxyError(403, "Cross-origin process proxy requests are not allowed.");
    }
    const method = req.method ?? "GET";
    if (!["GET", "POST", "DELETE"].includes(method)) {
      res.setHeader("allow", "GET, POST, DELETE");
      throw new ProcessProxyError(405, "Unsupported OGC process method.");
    }
    const url = new URL(
      req.url ?? "",
      `http://localhost${OGC_PROCESS_PROXY_PATH}`,
    ).searchParams.get("url");
    if (!url || validatePublicUrl(url))
      throw new ProcessProxyError(400, "Invalid OGC process URL.");
    if (
      method === "POST" &&
      !/^application\/json(?:\s*;|$)/i.test(req.headers["content-type"] ?? "")
    )
      throw new ProcessProxyError(415, "OGC process execution requires application/json.");
    const input = await readInputs(req);
    let body: string | undefined;
    if (method === "POST") {
      let value: unknown;
      try {
        body = new TextDecoder("utf-8", { fatal: true }).decode(input);
        value = JSON.parse(body);
      } catch {
        throw new ProcessProxyError(400, "OGC process inputs must be valid JSON.");
      }
      if (!value || typeof value !== "object" || Array.isArray(value))
        throw new ProcessProxyError(400, "OGC process execution requires a JSON object.");
    } else if (input.length)
      throw new ProcessProxyError(400, "Only execution POST accepts a body.");
    const requestedLimit = req.headers["x-geolibre-max-bytes"];
    const maxBytes =
      requestedLimit === undefined ? MAX_PROCESS_METADATA_BYTES : Number(requestedLimit);
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_PROCESS_RESULT_BYTES)
      throw new ProcessProxyError(400, "Invalid OGC process response limit.");
    const headers = new Headers({ Accept: req.headers.accept ?? "application/json" });
    if (method === "POST") {
      headers.set("Content-Type", "application/json");
      if (req.headers.prefer === "respond-async") headers.set("Prefer", "respond-async");
    }
    const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(120_000)]);
    const upstream = await processRequest(url, method, body, headers, signal);
    let data: Buffer;
    try {
      data = await readBodyWithLimit(
        upstream.response,
        upstream.response.ok ? maxBytes : Math.min(maxBytes, 64 * 1024),
      );
    } catch (error) {
      await upstream.response.body?.cancel().catch(() => {});
      if (upstream.response.ok)
        throw new ProcessProxyError(502, "OGC process response exceeds its download limit.");
      if (signal.aborted) throw error;
      data = Buffer.alloc(0);
    }
    res.statusCode = upstream.response.status;
    res.setHeader("cache-control", "no-store");
    res.setHeader(
      "content-type",
      upstream.response.headers.get("content-type") ?? "application/octet-stream",
    );
    res.setHeader("x-geolibre-final-url", upstream.url);
    for (const name of ["location", "retry-after"]) {
      const value = upstream.response.headers.get(name);
      if (value) res.setHeader(name, value);
    }
    res.setHeader("content-length", String(data.length));
    res.end(data);
  } catch (error) {
    req.resume();
    if (!res.destroyed) {
      res.statusCode = error instanceof ProcessProxyError ? error.status : 502;
      res.setHeader("cache-control", "no-store");
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          description:
            error instanceof ProcessProxyError ? error.message : "OGC process request failed.",
        }),
      );
    }
  } finally {
    res.removeListener("close", disconnected);
  }
}
