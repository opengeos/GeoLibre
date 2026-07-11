import { invoke } from "@tauri-apps/api/core";
import { setSidecarAuthToken } from "@geolibre/processing";
import { isTauri } from "./tauri-io";

export interface SidecarServerInfo {
  baseUrl: string;
  port: number;
  /** Per-launch auth token the sidecar client must send on every request. */
  token: string;
}

export async function startGeoLibreSidecar(): Promise<SidecarServerInfo> {
  assertTauri();
  const info = await invoke<SidecarServerInfo>("start_geolibre_sidecar");
  // Hand the per-launch token to the sidecar client so all subsequent requests
  // (which resolve the base URL themselves) are authenticated.
  setSidecarAuthToken(info.token);
  return info;
}

export async function stopGeoLibreSidecar(): Promise<void> {
  assertTauri();
  await invoke("stop_geolibre_sidecar");
  setSidecarAuthToken(null);
}

function assertTauri(): void {
  if (!isTauri()) {
    throw new Error("Starting the processing server requires GeoLibre Desktop.");
  }
}
