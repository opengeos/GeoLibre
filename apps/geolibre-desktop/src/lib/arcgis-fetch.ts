import { setArcGISFetch } from "@geolibre/plugins";

/** Route desktop ArcGIS REST downloads through Rust, outside WebView CORS. */
export async function installNativeArcGISFetch(): Promise<void> {
  const { fetch: tauriFetch } = await import("@tauri-apps/plugin-http");
  setArcGISFetch(tauriFetch);
}
