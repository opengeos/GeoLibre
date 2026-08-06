import {
  parseProject,
  registerProjectRestoreHistory,
  serializeProject,
  useAppStore,
} from "@geolibre/core";
import type { MapController } from "@geolibre/map";
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { buildProjectSnapshot } from "../lib/build-project-snapshot";
import { isEmbedded } from "./embedHost";
import { isTauri } from "../lib/is-tauri";
import { projectChanged } from "../lib/project-broadcast-changed";
import {
  addProjectSnapshot,
  deleteProjectSnapshot,
  listProjectSnapshots,
  type ProjectHistorySnapshot,
} from "../lib/project-history-store";
import {
  markProjectSession,
  readLastExplicitProjectSave,
  readProjectSessionState,
} from "../lib/project-history-session";
const AUTOSAVE_DELAY_MS = 3_000;

function currentProjectKey(): string {
  const { projectPath, projectName } = useAppStore.getState();
  return projectPath ? `path:${projectPath}` : `unsaved:${projectName}`;
}

export function useProjectHistory(mapControllerRef: RefObject<MapController | null>) {
  const { t } = useTranslation();
  const [snapshots, setSnapshots] = useState<ProjectHistorySnapshot[]>([]);
  const [recoverySnapshot, setRecoverySnapshot] = useState<ProjectHistorySnapshot | null>(null);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const timerRef = useRef<number | null>(null);
  const refresh = useCallback(async () => {
    try {
      setSnapshots(await listProjectSnapshots(currentProjectKey()));
    } catch (error) {
      console.error("Could not load project history.", error);
    }
  }, []);

  useEffect(() => {
    const crashRecoveryEnabled = !isTauri() && !isEmbedded();
    void (async () => {
      try {
        const entries = await listProjectSnapshots();
        setSnapshots(entries.filter((entry) => entry.projectKey === currentProjectKey()));
        if (crashRecoveryEnabled) {
          const previousSession = readProjectSessionState();
          const lastSave = readLastExplicitProjectSave();
          const latest = entries[0];
          if (previousSession === "open" && latest && (!lastSave || latest.createdAt > lastSave)) {
            setRecoverySnapshot(latest);
          }
        }
      } catch (error) {
        console.error("Could not initialize project recovery.", error);
      } finally {
        if (crashRecoveryEnabled) markProjectSession("open");
      }
    })();

    const markClean = () => markProjectSession("closed");
    if (crashRecoveryEnabled) window.addEventListener("pagehide", markClean);
    const unsubscribe = useAppStore.subscribe((state, previous) => {
      if (
        !state.isDirty ||
        (!projectChanged(state, previous) && state.mapView === previous.mapView)
      ) {
        return;
      }
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null;
        // `serializeProject` runs synchronously, so its failure cannot be caught
        // by the promise chain below. A project embedding a large vector layer
        // serializes to more than V8's 536,870,888-byte string cap and throws
        // `RangeError: Invalid string length`, which previously escaped as an
        // unhandled error on every autosave tick. Autosave is best-effort — a
        // project too large to snapshot must degrade to "no crash recovery",
        // never to a crash.
        // Built and serialized in separate steps so the two failures are not
        // conflated: a snapshot that cannot be constructed is a genuine error,
        // while one too large to stringify is an expected limit.
        let snapshot: ReturnType<typeof buildProjectSnapshot>;
        try {
          snapshot = buildProjectSnapshot(mapControllerRef);
        } catch (error) {
          console.error("Could not autosave the project.", error);
          return;
        }
        let content: string;
        try {
          content = serializeProject(snapshot);
        } catch (error) {
          // Only the string-length cap means "too large"; anything else is a
          // real serialization bug and must not be filed under a size problem,
          // or that class of failure becomes invisible in the wild.
          if (error instanceof RangeError) {
            console.warn("Project autosave skipped: the project is too large to serialize.", error);
          } else {
            console.error("Could not autosave the project.", error);
          }
          return;
        }
        void addProjectSnapshot(content, currentProjectKey()).catch((error) =>
          console.error("Could not autosave the project.", error),
        );
      }, AUTOSAVE_DELAY_MS);
    });
    return () => {
      unsubscribe();
      if (crashRecoveryEnabled) window.removeEventListener("pagehide", markClean);
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
    snapshots,
    recoverySnapshot,
    restoreError,
    refresh,
    restore,
    discardRecovery,
    dismissRecovery,
    clearRestoreError,
  };
}
