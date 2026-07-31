import { invoke } from "@tauri-apps/api/core";
import i18next from "i18next";
import { setSidecarAuthToken } from "@geolibre/processing";
import { IS_MAS_BUILD } from "./build-flags";
import { isTauri } from "./tauri-io";

export interface SidecarServerInfo {
  baseUrl: string;
  port: number;
  /** Per-launch auth token the sidecar client must send on every request. */
  token: string;
}

export async function startGeoLibreSidecar(): Promise<SidecarServerInfo> {
  assertSidecarAllowed();
  const info = await invoke<SidecarServerInfo>("start_geolibre_sidecar");
  // Hand the per-launch token to the sidecar client so all subsequent requests
  // (which resolve the base URL themselves) are authenticated.
  setSidecarAuthToken(info.token);
  return info;
}

export async function stopGeoLibreSidecar(): Promise<void> {
  // Nothing to stop in the Mac App Store build (the sidecar cannot be
  // started); a silent no-op keeps callers' cleanup paths from throwing.
  if (IS_MAS_BUILD) return;
  assertSidecarAllowed();
  await invoke("stop_geolibre_sidecar");
  setSidecarAuthToken(null);
}

function assertSidecarAllowed(): void {
  // The Mac App Store build cannot spawn the Python sidecar (App Sandbox), so
  // fail here before invoking the stubbed Tauri command. This guarantees every
  // consumer degrades with a clear message even if a UI gate is missed.
  if (IS_MAS_BUILD) {
    throw new Error(i18next.t("masBuild.unavailable"));
  }
  if (!isTauri()) {
    throw new Error("Starting the processing server requires GeoLibre Desktop.");
  }
}
