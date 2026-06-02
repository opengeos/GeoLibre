import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "./tauri-io";

export interface SidecarServerInfo {
  baseUrl: string;
  port: number;
}

export async function startGeoLibreSidecar(): Promise<SidecarServerInfo> {
  assertTauri();
  return invoke<SidecarServerInfo>("start_geolibre_sidecar");
}

export async function stopGeoLibreSidecar(): Promise<void> {
  assertTauri();
  await invoke("stop_geolibre_sidecar");
}

function assertTauri(): void {
  if (!isTauri()) {
    throw new Error("Starting the processing server requires GeoLibre Desktop.");
  }
}
