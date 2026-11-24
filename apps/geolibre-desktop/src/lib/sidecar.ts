import { invoke } from "@tauri-apps/api/core";
import i18next from "i18next";
import { setSidecarAuthToken, setSidecarRelayAccess } from "@geolibre/processing";
import { IS_MAS_BUILD } from "./build-flags";
import { isTauri } from "./tauri-io";
import { useDesktopSettingsStore } from "../hooks/useDesktopSettings";
import { createLiveMcpAccessController } from "./live-mcp-access";
import { dismissNotification, notify } from "./notify";

export interface SidecarServerInfo {
  baseUrl: string;
  port: number;
  /** Per-launch auth token the sidecar client must send on every request. */
  token: string;
}

/**
 * The desktop backend found a sidecar from an earlier app session on the port
 * and could not reclaim it. That sidecar rejects this session's token, so every
 * later request would fail with a bare 401 that hides this cause.
 */
export class StaleSidecarError extends Error {
  override name = "StaleSidecarError";
}

// Phrase from STALE_SIDECAR_ERROR (src-tauri/src/lib.rs); tests on both sides
// pin it, so rewording the Rust message fails a test instead of reviving #2959.
const STALE_SIDECAR_MARKER = "does not accept this session's token";

export async function startGeoLibreSidecar(): Promise<SidecarServerInfo> {
  assertSidecarAllowed();
  const generation = stopGeneration;
  let info: SidecarServerInfo;
  try {
    info = await invoke<SidecarServerInfo>("start_geolibre_sidecar");
  } catch (error) {
    // Tauri rejects with the command's error string, not an Error; wrap it so
    // callers that read `.message` show the backend's explanation.
    const message = error instanceof Error ? error.message : String(error);
    throw message.includes(STALE_SIDECAR_MARKER)
      ? new StaleSidecarError(message)
      : error instanceof Error
        ? error
        : new Error(message);
  }
  // Hand the per-launch token to the sidecar client so all subsequent requests
  // (which resolve the base URL themselves) are authenticated.
  if (generation === stopGeneration) {
    setSidecarAuthToken(info.token);
    relayAccess.setServer(info);
    void updateLiveMcpAccess();
  }
  return info;
}

let stopGeneration = 0;
const relayAccess = createLiveMcpAccessController({
  getEnabled: () => useDesktopSettingsStore.getState().desktopSettings.startup.allowLiveMcp,
  send: (info, enabled) => setSidecarRelayAccess(info.baseUrl, enabled),
});
let accessNotice: string | null = null;
relayAccess.subscribe((state) => {
  if (!state.error && accessNotice) {
    dismissNotification(accessNotice);
    accessNotice = null;
  }
  if (state.error && !accessNotice) {
    accessNotice = notify.warning(
      i18next.t(
        state.enabled ? "notifications.liveMcpEnableRetry" : "notifications.liveMcpDisableRetry",
      ),
      { durationMs: null, pinned: true, dedupeKey: "live-mcp-access" },
    );
  }
});

/** Apply the current Live MCP preference without stopping processing jobs. */
export function updateLiveMcpAccess(): Promise<void> {
  return relayAccess.sync();
}

/** Subscribe only while relay access has been confirmed for the current sidecar. */
export function subscribeSidecarRelay(
  listener: (info: SidecarServerInfo | null) => void,
): () => void {
  return relayAccess.subscribe((state) => listener(state.ready));
}
/**
 * `catch` handler for a best-effort start whose follow-up status request
 * reports a missing runtime better than the start error does. A stale sidecar
 * is rethrown: the follow-up would only fail with "Missing or invalid sidecar
 * token" (GeoLibre#2959).
 */
export function ignoreSidecarStartError(error: unknown): void {
  if (error instanceof StaleSidecarError) throw error;
}

export async function stopGeoLibreSidecar(): Promise<void> {
  // Nothing to stop in the Mac App Store build (the sidecar cannot be
  // started); a silent no-op keeps callers' cleanup paths from throwing.
  if (IS_MAS_BUILD) return;
  assertSidecarAllowed();
  await invoke("stop_geolibre_sidecar");
  stopGeneration += 1;
  setSidecarAuthToken(null);
  relayAccess.setServer(null);
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
