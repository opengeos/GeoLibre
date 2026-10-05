import {
  createProjectLayerSerializationCache,
  parseProject,
  registerProjectRestoreHistory,
  serializeProjectWithLayerCache,
  serializeProjectWithLayerCacheAsync,
  useAppStore,
  type GeoLibreProject,
} from "@geolibre/core";
import type { MapEngine } from "@geolibre/map";
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import i18next from "i18next";
import {
  createAutosaveFailureNotice,
  createAutosaveStatusTracker,
  type AutosaveOutcome,
} from "../lib/autosave-status";
import { buildProjectSnapshot } from "../lib/build-project-snapshot";
import { isEmbedded } from "./embedHost";
import { isTauri } from "../lib/is-tauri";
import { projectChanged } from "../lib/project-broadcast-changed";
import {
  addProjectSnapshot,
  deleteProjectSnapshot,
  listProjectSnapshots,
  probeProjectHistoryStorage,
  type ProjectHistorySnapshot,
} from "../lib/project-history-store";
import {
  announceLiveProjectSession,
  liveProjectSessionTabs,
  markProjectSession,
  readLastExplicitProjectSave,
  readProjectSessionState,
  SESSION_HEARTBEAT_MS,
  shouldOfferProjectRecovery,
} from "../lib/project-history-session";
import { restoreLayerFromSnapshot } from "../lib/snapshot-layer-restore";
import { notify } from "../lib/notify";
const AUTOSAVE_DELAY_MS = 3_000;

function currentProjectKey(): string {
  const { projectPath, projectName } = useAppStore.getState();
  return projectPath ? `path:${projectPath}` : `unsaved:${projectName}`;
}

export function useProjectHistory(mapControllerRef: RefObject<MapEngine | null>) {
  const { t } = useTranslation();
  const [snapshots, setSnapshots] = useState<ProjectHistorySnapshot[]>([]);
  const [recoverySnapshot, setRecoverySnapshot] = useState<ProjectHistorySnapshot | null>(null);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  // True while autosave is skipping snapshots because the project is too large
  // to keep, so the UI can say so instead of crash recovery going silently
  // stale (GeoLibre#2858).
  const [autosavePaused, setAutosavePaused] = useState(false);
  // True when the browser refuses IndexedDB (some private windows, blocked site
  // data), so autosave can never keep a snapshot. Distinct from the size pause:
  // nothing the user does to the project will bring it back (GeoLibre#2860).
  const [autosaveUnavailable, setAutosaveUnavailable] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void probeProjectHistoryStorage().then((ok) => {
      if (!cancelled) setAutosaveUnavailable(!ok);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  const timerRef = useRef<number | null>(null);
  // Each layer's serialized text, reused while the store keeps the same layer
  // record. Without it a camera move re-stringified every embedded GeoJSON
  // layer on the main thread (GeoLibre#2633).
  const layerCacheRef = useRef(createProjectLayerSerializationCache());
  const refresh = useCallback(async () => {
    try {
      setSnapshots(await listProjectSnapshots(currentProjectKey()));
    } catch (error) {
      console.error("Could not load project history.", error);
      notify.warning(i18next.t("notifications.projectHistoryLoadFailed"), {
        dedupeKey: "project-history-load",
      });
    }
  }, []);

  useEffect(() => {
    const crashRecoveryEnabled = !isTauri() && !isEmbedded();
    // Installed before anything awaits, so a sibling tab probing at the same
    // moment gets an answer from this one.
    const stopAnnouncing = crashRecoveryEnabled ? announceLiveProjectSession() : null;
    void (async () => {
      try {
        // The liveness probe waits a fixed window for other tabs to answer, so
        // it is started first and awaited last: its wait overlaps the IndexedDB
        // read instead of being added to it, and the history list still renders
        // the moment the snapshots arrive rather than trailing the probe.
        const liveTabs = crashRecoveryEnabled
          ? liveProjectSessionTabs().catch(() => new Set<string>())
          : Promise.resolve(new Set<string>());
        const entries = await listProjectSnapshots();
        setSnapshots(entries.filter((entry) => entry.projectKey === currentProjectKey()));
        if (crashRecoveryEnabled) {
          const latest = entries[0];
          if (
            shouldOfferProjectRecovery(
              latest,
              readProjectSessionState(await liveTabs),
              readLastExplicitProjectSave(),
            )
          ) {
            setRecoverySnapshot(latest);
          }
        }
      } catch (error) {
        console.error("Could not initialize project recovery.", error);
        // The history list failed to load either way; in the browser that
        // also means a crashed session will not be offered back.
        notify.warning(
          i18next.t(
            crashRecoveryEnabled
              ? "notifications.projectRecoveryUnavailable"
              : "notifications.projectHistoryLoadFailed",
          ),
          { dedupeKey: "project-history-load" },
        );
      } finally {
        if (crashRecoveryEnabled) markProjectSession("open");
      }
    })();

    const markClean = () => markProjectSession("closed");
    // A tab open for hours has to stay distinguishable from one that died, so
    // it restamps its own entry while it lives; see SESSION_HEARTBEAT_MS.
    let heartbeat: number | null = null;
    if (crashRecoveryEnabled) {
      window.addEventListener("pagehide", markClean);
      heartbeat = window.setInterval(() => markProjectSession("open"), SESSION_HEARTBEAT_MS);
    }
    const autosaveStatus = createAutosaveStatusTracker(setAutosavePaused);
    const noticeAutosaveOutcome = createAutosaveFailureNotice(() =>
      notify.warning(i18next.t("notifications.autosaveFailed"), { dedupeKey: "autosave-failed" }),
    );
    const unsubscribe = useAppStore.subscribe((state, previous) => {
      // A save (or opening/creating a project) leaves nothing unsaved to lose,
      // so the warning has nothing left to warn about. The next edit re-checks.
      if (!state.isDirty && previous.isDirty) autosaveStatus.reset();
      if (
        !state.isDirty ||
        (!projectChanged(state, previous) && state.mapView === previous.mapView)
      ) {
        return;
      }
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null;
        const attempt = autosaveStatus.begin();
        // Dirtiness is read when the attempt ends: a tick scheduled before a
        // save still runs after it, and must not flag a project that now has
        // nothing unsaved.
        const settle = (outcome: AutosaveOutcome) => {
          // A superseded attempt's late outcome says nothing about the
          // project now, the same rule the paused indicator follows.
          if (autosaveStatus.isCurrent(attempt)) noticeAutosaveOutcome(outcome);
          autosaveStatus.settle(attempt, outcome, useAppStore.getState().isDirty);
        };
        // A project embedding a large vector layer serializes to more than V8's
        // 536,870,888-byte string cap and throws `RangeError: Invalid string
        // length`. Autosave is best-effort — a project too large to snapshot
        // must degrade to "no crash recovery", never to a crash.
        // Built and serialized in separate steps so the two failures are not
        // conflated: a snapshot that cannot be constructed is a genuine error,
        // while one too large to stringify is an expected limit.
        let snapshot: ReturnType<typeof buildProjectSnapshot>;
        // Read in the same synchronous turn as the snapshot build, so each
        // entry is the record `snapshot.layers` at the same index came from.
        const layerSources = useAppStore.getState().layers;
        try {
          snapshot = buildProjectSnapshot(mapControllerRef);
        } catch (error) {
          console.error("Could not autosave the project.", error);
          settle("failed");
          return;
        }
        // Serialized in slices that hand the main thread back between layers,
        // so a large project is not one long freeze. The key is read now: the
        // project may be switched while the slices run.
        const projectKey = currentProjectKey();
        void serializeProjectWithLayerCacheAsync(
          snapshot,
          layerSources,
          layerCacheRef.current,
        ).then(
          (content) =>
            addProjectSnapshot(content, projectKey).then(settle, (error) => {
              console.error("Could not autosave the project.", error);
              settle("failed");
            }),
          (error) => {
            // Only the string-length cap means "too large"; anything else is a
            // real serialization bug and must not be filed under a size problem,
            // or that class of failure becomes invisible in the wild.
            if (error instanceof RangeError) {
              console.warn(
                "Project autosave skipped: the project is too large to serialize.",
                error,
              );
              settle("unserializable");
            } else {
              console.error("Could not autosave the project.", error);
              settle("failed");
            }
          },
        );
      }, AUTOSAVE_DELAY_MS);
    });
    return () => {
      unsubscribe();
      if (crashRecoveryEnabled) window.removeEventListener("pagehide", markClean);
      if (heartbeat !== null) window.clearInterval(heartbeat);
      stopAnnouncing?.();
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    };
  }, [mapControllerRef, refresh]);

  const restore = useCallback(
    (snapshot: ProjectHistorySnapshot) => {
      setRestoreError(null);
      try {
        const before = buildProjectSnapshot(mapControllerRef);
        const beforePath = useAppStore.getState().projectPath;
        const restored = parseProject(snapshot.content);
        useAppStore.getState().loadProject(restored, beforePath, {
          rememberRecent: false,
          presenting: false,
        });
        registerProjectRestoreHistory(before, beforePath, restored, beforePath);
        useAppStore.setState({ isDirty: true });
        setRecoverySnapshot(null);
        return true;
      } catch (error) {
        console.error("Could not restore the project snapshot.", error);
        setRestoreError(t("projectHistory.restoreError"));
        return false;
      }
    },
    [mapControllerRef, t],
  );

  /**
   * The current project in the shape a snapshot is read back in (serialized
   * and re-parsed), so comparing it with a snapshot reports real edits rather
   * than in-memory versus on-disk shape differences.
   */
  const currentProject = useCallback((): GeoLibreProject => {
    const layerSources = useAppStore.getState().layers;
    const snapshot = buildProjectSnapshot(mapControllerRef);
    return parseProject(
      serializeProjectWithLayerCache(snapshot, layerSources, layerCacheRef.current),
    );
  }, [mapControllerRef]);

  /**
   * Restore one layer from a snapshot as a single undoable step, leaving the
   * rest of the project untouched.
   */
  const restoreLayer = useCallback(
    (snapshot: ProjectHistorySnapshot, layerId: string) => {
      setRestoreError(null);
      try {
        const state = useAppStore.getState();
        const layers = restoreLayerFromSnapshot(
          { layers: state.layers, layerGroups: state.layerGroups },
          parseProject(snapshot.content),
          layerId,
        );
        if (!layers) throw new Error(`Snapshot has no layer ${layerId}.`);
        // One store write, so one Undo step reverts the whole restore.
        useAppStore.setState({ layers, isDirty: true });
        return true;
      } catch (error) {
        console.error("Could not restore the layer from the snapshot.", error);
        setRestoreError(t("projectHistory.diff.restoreLayerError"));
        return false;
      }
    },
    [t],
  );

  const discardRecovery = useCallback(() => {
    if (recoverySnapshot) {
      void deleteProjectSnapshot(recoverySnapshot.id)
        .then(refresh)
        .catch((error) => console.error("Could not discard the recovery snapshot.", error));
    }
    setRecoverySnapshot(null);
  }, [recoverySnapshot, refresh]);

  const dismissRecovery = useCallback(() => setRecoverySnapshot(null), []);
  const clearRestoreError = useCallback(() => setRestoreError(null), []);

  return {
    autosavePaused,
    autosaveUnavailable,
    snapshots,
    recoverySnapshot,
    restoreError,
    refresh,
    restore,
    restoreLayer,
    currentProject,
    discardRecovery,
    dismissRecovery,
    clearRestoreError,
  };
}
