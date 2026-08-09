import { useAppStore } from "@geolibre/core";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { dataUrlParameters } from "../lib/data-url";
import { isTauri } from "../lib/is-tauri";
import { projectUrlFromLocation } from "../lib/project-url";
import { startupProjectPath } from "../lib/startup-project";
import { openRecentProjectFile, RecentProjectGoneError } from "../lib/tauri-io";
import { resolveProjectXyzLayers } from "../lib/xyz-url";
import { DEFAULT_STARTUP_SETTINGS, useDesktopSettingsStore } from "./useDesktopSettings";
import { loadRecentProjects } from "./useRecentProjectsPersistence";

export function useStartupProject(): string | null {
  const { t } = useTranslation();
  const [hasWarning, setHasWarning] = useState(false);

  useEffect(() => {
    if (!isTauri()) return;
    // Explicit launch payloads take precedence over the device default. Without
    // this guard, the startup read and a shared project deep link could race,
    // with whichever request happened to finish last replacing the other. Ask
    // the loaders' own parsers rather than naming query keys here, so this guard
    // can never disagree with them about what counts as an explicit payload:
    // `projectUrlFromLocation` covers every key in `PROJECT_URL_PARAMS` plus a
    // bare `?https://...` query, and `dataUrlParameters` only claims a `?data=`
    // that is an absolute http(s) URL -- a malformed one leaves `useDataUrlLoader`
    // a no-op, so yielding to it would strand the user on an empty workspace.
    if (projectUrlFromLocation() !== null) return;
    if (dataUrlParameters(window.location.search) !== null) return;
    const settings = useDesktopSettingsStore.getState().desktopSettings.startup;
    // `useRecentProjectsPersistence` hydrates the store from localStorage in its
    // own mount effect. Fall back to reading storage directly when that has not
    // happened yet, so "last project" mode does not silently no-op if this hook
    // is ever ordered above it in `App.tsx`.
    const stored = useAppStore.getState().recentProjects;
    const path = startupProjectPath(settings, stored.length > 0 ? stored : loadRecentProjects());
    if (!path) return;

    // The workspace this restore is allowed to replace. The XYZ probes below
    // reach the network and the shell is interactive throughout, so the user can
    // open their own project first; `loadProject` swaps the whole store with no
    // unsaved-work prompt, so a restore that lost that race must stand down.
    // `projectGeneration` is the discriminator rather than `projectPath`, which
    // File > New resets to the same `null` the app started on -- a restore
    // landing after that would clobber the new project and look identical to
    // landing on the untouched startup state.
    const restoringOver = useAppStore.getState().projectGeneration;

    let cancelled = false;
    let warningTimer: number | undefined;
    // `cancelled` alone would leave a discarded run's read and XYZ probes in
    // flight; the signal ends them, matching `useProjectUrlLoader`.
    const abortController = new AbortController();
    void (async () => {
      try {
        const result = await openRecentProjectFile(path, abortController.signal);
        const project = await resolveProjectXyzLayers(result.project, abortController.signal);
        if (cancelled) return;
        // `isDirty` too: editing the startup workspace in place (dropping a file
        // on the map) leaves the generation untouched but is still work to keep.
        const { projectGeneration, isDirty } = useAppStore.getState();
        if (projectGeneration !== restoringOver || isDirty) return;
        useAppStore.getState().loadProject(project, result.path);
      } catch (error) {
        if (cancelled) return;
        if (error instanceof RecentProjectGoneError) {
          useAppStore.getState().forgetRecentProject(path);
          // Re-read the preference rather than trusting the snapshot taken
          // before the await: the user may have picked a different startup
          // project while this load was in flight, and clearing that newer
          // choice because an older path turned out to be gone would be wrong.
          const current = useDesktopSettingsStore.getState().desktopSettings;
          if (current.startup.mode === "specific" && current.startup.projectPath === path) {
            useDesktopSettingsStore.getState().setDesktopSettings({
              ...current,
              startup: DEFAULT_STARTUP_SETTINGS,
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
      abortController.abort();
      if (warningTimer !== undefined) window.clearTimeout(warningTimer);
    };
    // Startup restoration is intentionally one-shot. In particular, changing
    // language must not reopen this project over the user's current workspace.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return hasWarning ? t("settings.startup.loadWarning") : null;
}
