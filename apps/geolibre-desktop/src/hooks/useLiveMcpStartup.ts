import { useEffect } from "react";
import { isDesktopRuntime } from "../lib/is-mobile";
import { updateLiveRelayAccess } from "../lib/live-relay";
import { useDesktopSettingsStore } from "./useDesktopSettings";

/**
 * Apply Settings → Startup → "Allow AI agents to drive the map" to the desktop
 * shell's Live MCP relay, so the MCP server's live tools can reach this map
 * with no Jupyter notebook or processing sidecar running.
 *
 * Runs at launch and again when the setting changes. Turning it off closes the
 * relay, fails pending commands and withdraws its discovery file. Failed
 * updates retry and display a persistent notice until the shell confirms them.
 * Inert on web and mobile; works in every desktop build, the Mac App Store one
 * included.
 */
export function useLiveMcpStartup(): void {
  const allowLiveMcp = useDesktopSettingsStore(
    (state) => state.desktopSettings.startup.allowLiveMcp,
  );
  useEffect(() => {
    if (!isDesktopRuntime()) return;
    void updateLiveRelayAccess();
  }, [allowLiveMcp]);
}
