import { useAppStore, type MapProjection, type MapViewState } from "@geolibre/core";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { dataUrlParameters, serviceUrlParameter } from "../lib/data-url";
import { isTauri } from "../lib/is-tauri";
import { projectUrlFromLocation } from "../lib/project-url";
import { planStartup, startupDefaultWorkspace, type StartupPlan } from "../lib/startup-project";
import { openRecentProjectFile, RecentProjectGoneError } from "../lib/tauri-io";
import { resolveProjectXyzLayers } from "../lib/xyz-url";
import { DEFAULT_STARTUP_SETTINGS, useDesktopSettingsStore } from "./useDesktopSettings";
import { loadRecentProjects } from "./useRecentProjectsPersistence";

/**
 * How long the shell stays unmounted waiting for a startup restore. The read and
 * the XYZ probes below have no deadline of their own, so without this a project
 * whose tile host black-holes the connection would leave the window blank with
 * no way to reach Settings and change the startup project. On expiry the shell
 * mounts over the default workspace and the restore is allowed to keep going --
 * that is the pre-restore-gate behavior, so the worst case is the projection
 * flash this hook exists to avoid, not a hang.
 */
const RESTORE_GATE_TIMEOUT_MS = 10_000;

/**
 * Whether the launch carried an explicit project payload, which takes precedence
 * over the device default. Without this guard, the startup read and a shared
 * project deep link could race, with whichever request happened to finish last
 * replacing the other. Ask the loaders' own parsers rather than naming query
 * keys here, so this guard can never disagree with them about what counts as an
 * explicit payload: `projectUrlFromLocation` covers every key in
 * `PROJECT_URL_PARAMS` plus a bare `?https://...` query, and `dataUrlParameters`
 * only claims a `?data=` that is an absolute http(s) URL -- a malformed one
 * leaves `useDataUrlLoader` a no-op, so yielding to it would strand the user on
 * an empty workspace.
 */
function hasExplicitLaunchPayload(): boolean {
  if (projectUrlFromLocation() !== null) return true;
  if (dataUrlParameters(window.location.search) !== null) return true;
  if (serviceUrlParameter(window.location.search) !== null) return true;
  return false;
}

/**
 * This launch's startup plan, read from the live stores.
 *
 * Called from both the render-time gate and the effect below; `planStartup` is
 * the single decision, so the two cannot disagree about whether a restore is
 * happening. Every source it reads is synchronous and settled before the first
 * render (`useDesktopSettingsStore` hydrates from localStorage at store-creation
 * time), so both calls see the same answer.
 */
function currentStartupPlan(): StartupPlan {
  // `useRecentProjectsPersistence` hydrates the store from localStorage in its
  // own mount effect. Fall back to reading storage directly when that has not
  // happened yet, so "last project" mode does not silently no-op if this hook is
  // ever ordered above it in `App.tsx`.
  const stored = useAppStore.getState().recentProjects;
  return planStartup({
    explicitPayload: hasExplicitLaunchPayload(),
    desktop: isTauri(),
    settings: useDesktopSettingsStore.getState().desktopSettings.startup,
    recentProjects: stored.length > 0 ? stored : loadRecentProjects(),
  });
}

/** Seed the empty workspace's camera and projection without marking the project dirty. */
function applyDefaultWorkspace(
  workspace: Pick<MapViewState, "center" | "zoom"> & { projection: MapProjection },
): void {
  useAppStore.setState((state) => ({
    mapView: {
      ...state.mapView,
      center: [...workspace.center],
      zoom: workspace.zoom,
    },
    preferences: {
      ...state.preferences,
      map: { ...state.preferences.map, projection: workspace.projection },
    },
  }));
}

export function useStartupProject(): {
  warning: string | null;
  restoring: boolean;
} {
  const { t } = useTranslation();
  const [hasWarning, setHasWarning] = useState(false);
  // Keep the workspace unmounted while a configured startup project is being
  // read. Otherwise MapCanvas is created from the empty project's defaults
  // (notably globe projection), and the asynchronous project restore has to
  // repair an already-live map. Besides showing the wrong projection during
  // startup, that lets MapLibre's projection events race the project preference
  // back into the store. Starting the shell only after loadProject makes the
  // startup project the map controller's initial state.
  //
  // Only a real restore gates the shell. The empty workspace needs its
  // projection applied before MapCanvas creates the map, but MapCanvas does that
  // in its own mount effect, which React runs *before* this component's -- so
  // the store is seeded here during the first render instead, and the launches
  // with nothing to restore (every browser and Jupyter-embed load, and desktop's
  // default mode) mount straight away with no spinner. Writing to the store
  // during render is safe here: it happens once, before any subscriber has
  // rendered, and re-running the initializer would set the same value.
  const [restoring, setRestoring] = useState(() => {
    const plan = currentStartupPlan();
    if (plan.kind === "default") applyDefaultWorkspace(plan);
    return plan.kind === "restore";
  });

  useEffect(() => {
    const plan = currentStartupPlan();
    // Both other cases were settled by the initializer above.
    if (plan.kind !== "restore") return;
    const path = plan.path;
    const settings = useDesktopSettingsStore.getState().desktopSettings.startup;
    const openDefaultWorkspace = () => {
      applyDefaultWorkspace(startupDefaultWorkspace(settings));
      setRestoring(false);
    };

    // The workspace this restore is allowed to replace. The XYZ probes below
    // reach the network, and the shell becomes interactive as soon as the gate
    // above expires (and immediately, on the browser paths that never gate), so
    // the user can open their own project first; `loadProject` swaps the whole
    // store with no unsaved-work prompt, so a restore that lost that race must
    // stand down.
    // `projectGeneration` is the discriminator rather than `projectPath`, which
    // File > New resets to the same `null` the app started on -- a restore
    // landing after that would clobber the new project and look identical to
    // landing on the untouched startup state.
    const restoringOver = useAppStore.getState().projectGeneration;

    let cancelled = false;
    let warningTimer: number | undefined;
    // Bounded gate: mount the shell over the default workspace if the restore
    // has not settled in time. The restore itself is left running -- it can
    // still land, guarded by `restoringOver`/`isDirty` below -- so a merely slow
    // project is not lost, while a stalled one no longer holds a blank window.
    // No `projectGeneration`/`isDirty` check here, unlike the two paths below:
    // while the gate is up the shell is unmounted, so there is nothing the user
    // could have opened or edited for this to overwrite. That invariant is what
    // makes the omission safe -- rendering anything interactive behind the
    // spinner would break it, and this call would need the same guard.
    const gateTimer = window.setTimeout(() => {
      if (cancelled) return;
      openDefaultWorkspace();
    }, RESTORE_GATE_TIMEOUT_MS);
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
            // Clear only the project selection. `globeByDefault` describes the
            // empty workspace, not the missing file, so resetting the whole
            // block would silently flip a saved Mercator preference back to
            // globe on the next launch.
            useDesktopSettingsStore.getState().setDesktopSettings({
              ...current,
              startup: {
                ...current.startup,
                mode: DEFAULT_STARTUP_SETTINGS.mode,
                projectPath: DEFAULT_STARTUP_SETTINGS.projectPath,
                projectName: DEFAULT_STARTUP_SETTINGS.projectName,
              },
            });
          }
        }
        console.warn("Could not restore the startup project.", error);
        // Same ownership test as the success path. Once the gate above expires
        // the shell is live, so a failure arriving after that must not reset the
        // projection of a workspace the user has since opened or edited -- nor
        // claim in the banner that the default workspace was opened for them.
        // Both cleanups above are unconditional on purpose: a project file that
        // is gone stays gone whoever owns the workspace now.
        const { projectGeneration, isDirty } = useAppStore.getState();
        if (projectGeneration !== restoringOver || isDirty) return;
        setHasWarning(true);
        warningTimer = window.setTimeout(() => setHasWarning(false), 8000);
        openDefaultWorkspace();
      } finally {
        window.clearTimeout(gateTimer);
        if (!cancelled) setRestoring(false);
      }
    })();
    return () => {
      cancelled = true;
      abortController.abort();
      window.clearTimeout(gateTimer);
      if (warningTimer !== undefined) window.clearTimeout(warningTimer);
    };
    // Startup restoration is intentionally one-shot. In particular, changing
    // language must not reopen this project over the user's current workspace.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return {
    warning: hasWarning ? t("settings.startup.loadWarning") : null,
    restoring,
  };
}
