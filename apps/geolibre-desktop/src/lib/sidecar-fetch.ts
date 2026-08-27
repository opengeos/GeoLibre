import { setSidecarFetch } from "@geolibre/processing";

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
  setSidecarFetch(tauriFetch);
}
