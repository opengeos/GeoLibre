import { LOCAL_SIDECAR_URL, setSidecarFetch } from "@geolibre/processing";

const NATIVE_SIDECAR_ORIGIN = new URL(LOCAL_SIDECAR_URL).origin;

/** Whether a request is inside the native client's exact sidecar scope. */
export function isNativeSidecarRequest(input: RequestInfo | URL): boolean {
  try {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    return new URL(href).origin === NATIVE_SIDECAR_ORIGIN;
  } catch {
    return false;
  }
}

/** The subset of Tauri's native `fetch` init that this adapter sets. */
type NativeFetchInit = RequestInit & {
  maxRedirections?: number;
  proxy?: { all?: { url: string; noProxy?: string } };
};
type NativeFetch = (input: RequestInfo | URL, init?: NativeFetchInit) => Promise<Response>;

/**
 * Force a direct connection to the loopback sidecar.
 *
 * `reqwest` (behind `@tauri-apps/plugin-http`) applies the system proxy by
 * default, and its Windows reader copies the registry `ProxyOverride` list
 * verbatim — it does not expand the `<local>` entry that Windows writes for
 * "bypass proxy server for local addresses". A machine behind a corporate proxy
 * would therefore send loopback sidecar traffic, including the per-launch
 * `X-GeoLibre-Token`, to that proxy, where WebView2 had connected directly.
 *
 * The plugin exposes no "disable proxy" switch, but supplying any proxy clears
 * reqwest's automatic system-proxy lookup, and a `*` exclusion list means the
 * supplied proxy never intercepts either — so every sidecar request goes direct.
 */
const NO_PROXY: NativeFetchInit["proxy"] = {
  all: { url: NATIVE_SIDECAR_ORIGIN, noProxy: "*" },
};

/**
 * Build the sidecar transport that runs on top of a native `fetch`.
 *
 * Requests outside the loopback sidecar origin fall back to the browser fetch,
 * so a `VITE_SIDECAR_URL` development override still works instead of failing a
 * capability-scope check. Sidecar requests carry the per-launch
 * `X-GeoLibre-Token`, and unlike the WebView fetch the native client would
 * replay that header on a redirect to another host, so redirects are disabled
 * and the system proxy is bypassed (see {@link NO_PROXY}).
 *
 * @param tauriFetch - Tauri's native HTTP client fetch.
 * @returns A transport suitable for {@link setSidecarFetch}.
 */
export function createNativeSidecarFetch(tauriFetch: NativeFetch): typeof globalThis.fetch {
  return ((input: RequestInfo | URL, init?: RequestInit) => {
    if (!isNativeSidecarRequest(input)) return globalThis.fetch(input, init);
    return tauriFetch(input, { ...init, maxRedirections: 0, proxy: NO_PROXY });
  }) as typeof globalThis.fetch;
}

/**
 * Route desktop processing-server traffic through Tauri's native HTTP client.
 *
 * The Windows WebView2 runtime applies browser CORS and Local Network Access
 * policy to `fetch("http://127.0.0.1:8765")`, even though the desktop shell
 * launched that loopback server. Native fetch is not subject to WebView policy,
 * and its Tauri capability is restricted to this exact host and port.
 */
export async function installNativeSidecarFetch(): Promise<void> {
  const { fetch: tauriFetch } = await import("@tauri-apps/plugin-http");
  setSidecarFetch(createNativeSidecarFetch(tauriFetch));
}
