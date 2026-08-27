import { setSidecarFetch } from "@geolibre/processing";

const NATIVE_SIDECAR_ORIGIN = "http://127.0.0.1:8765";

/** Whether a request is inside the native client's exact sidecar scope. */
export function isNativeSidecarRequest(input: RequestInfo | URL): boolean {
  try {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    return new URL(href).origin === NATIVE_SIDECAR_ORIGIN;
  } catch {
    return false;
  }
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
  setSidecarFetch((input, init) => {
    // Preserve VITE_SIDECAR_URL development overrides that point outside the
    // narrowly scoped native capability.
    if (!isNativeSidecarRequest(input)) return globalThis.fetch(input, init);
    return tauriFetch(input, init);
  });
}
