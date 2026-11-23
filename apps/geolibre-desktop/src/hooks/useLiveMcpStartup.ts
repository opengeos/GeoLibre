import { useEffect } from "react";
import { IS_MAS_BUILD } from "../lib/build-flags";
import { isTauri } from "../lib/is-tauri";
import { startGeoLibreSidecar } from "../lib/sidecar";
import { useDesktopSettingsStore } from "./useDesktopSettings";

/**
 * Start the processing sidecar when Settings → Startup → "Allow AI agents to
 * drive the map" is on, so its Live MCP relay is up without opening the
 * Jupyter Notebook panel. useJupyterRelay connects to the relay as soon as the
 * sidecar is running.
 *
 * Runs at launch and again when the setting is turned on. Turning it off does
 * not stop a running sidecar: other tools may be using it. Inert on web and in
 * the Mac App Store build, where the sidecar cannot run.
 */
export function useLiveMcpStartup(): void {
  const allowLiveMcp = useDesktopSettingsStore(
    (state) => state.desktopSettings.startup.allowLiveMcp,
  );
  useEffect(() => {
    if (!allowLiveMcp || IS_MAS_BUILD || !isTauri()) return;
    startGeoLibreSidecar().catch((error: unknown) => {
      // Best effort: Live MCP reports "not connected" and every processing
      // tool still starts (and explains) the sidecar on demand.
      console.warn("Live MCP: could not start the processing sidecar", error);
    });
  }, [allowLiveMcp]);
}
