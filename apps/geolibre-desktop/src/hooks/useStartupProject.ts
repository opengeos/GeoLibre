import { useAppStore } from "@geolibre/core";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { isTauri } from "../lib/is-tauri";
import { openRecentProjectFile, RecentProjectGoneError } from "../lib/tauri-io";
import { resolveProjectXyzLayers } from "../lib/xyz-url";
import { useDesktopSettingsStore } from "./useDesktopSettings";

export function useStartupProject(): string | null {
  const { t } = useTranslation();
  const [hasWarning, setHasWarning] = useState(false);

  useEffect(() => {
    if (!isTauri()) return;
    // Explicit launch payloads take precedence over the device default. Without
    // this guard, the startup read and a shared ?url= project could race, with
    // whichever request happened to finish last replacing the other.
    const params = new URLSearchParams(window.location.search);
    if (params.has("url") || params.has("data")) return;
    const settings = useDesktopSettingsStore.getState().desktopSettings.startup;
    if (settings.mode === "default") return;
    const recentProjects = useAppStore.getState().recentProjects;
    const path =
      settings.mode === "specific" ? settings.projectPath : (recentProjects[0]?.path ?? null);
    if (!path) return;

    let cancelled = false;
    let warningTimer: number | undefined;
    void (async () => {
      try {
        const result = await openRecentProjectFile(path);
        const project = await resolveProjectXyzLayers(result.project);
        if (!cancelled) useAppStore.getState().loadProject(project, result.path);
      } catch (error) {
        if (cancelled) return;
        if (error instanceof RecentProjectGoneError) {
          useAppStore.getState().forgetRecentProject(path);
          if (settings.mode === "specific") {
            const current = useDesktopSettingsStore.getState().desktopSettings;
            useDesktopSettingsStore.getState().setDesktopSettings({
              ...current,
              startup: { mode: "default", projectPath: null, projectName: null },
            });
          }
        }
        console.warn("Could not restore the startup project.", error);
        setHasWarning(true);
        warningTimer = window.setTimeout(() => setHasWarning(false), 8000);
      }
    })();
    return () => {
      cancelled = true;
      if (warningTimer !== undefined) window.clearTimeout(warningTimer);
    };
    // Startup restoration is intentionally one-shot. In particular, changing
    // language must not reopen this project over the user's current workspace.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return hasWarning ? t("settings.startup.loadWarning") : null;
}
