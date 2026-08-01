import {
  parseProject,
  registerProjectRestoreHistory,
  serializeProject,
  useAppStore,
} from "@geolibre/core";
import type { MapController } from "@geolibre/map";
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
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

export function useProjectHistory(mapControllerRef: RefObject<MapController | null>) {
  const [snapshots, setSnapshots] = useState<ProjectHistorySnapshot[]>([]);
  const [recoverySnapshot, setRecoverySnapshot] = useState<ProjectHistorySnapshot | null>(null);
  const timerRef = useRef<number | null>(null);
  const refresh = useCallback(async () => {
    try {
      setSnapshots(await listProjectSnapshots());
    } catch (error) {
      console.error("Could not load project history.", error);
    }
  }, []);

  useEffect(() => {
    const crashRecoveryEnabled = !isTauri() && !isEmbedded();
    void (async () => {
      try {
        const entries = await listProjectSnapshots();
        setSnapshots(entries);
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
        const content = serializeProject(buildProjectSnapshot(mapControllerRef));
        void addProjectSnapshot(content)
          .then((result) => {
            if (result === "added") return refresh();
          })
          .catch((error) => console.error("Could not autosave the project.", error));
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
      try {
        const before = buildProjectSnapshot(mapControllerRef);
        const beforePath = useAppStore.getState().projectPath;
        const restored = parseProject(snapshot.content);
        useAppStore.getState().loadProject(restored, null, {
          rememberRecent: false,
          presenting: false,
        });
        registerProjectRestoreHistory(before, beforePath, restored);
        useAppStore.setState({ isDirty: true });
        setRecoverySnapshot(null);
      } catch (error) {
        console.error("Could not restore the project snapshot.", error);
      }
    },
    [mapControllerRef],
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

  return { snapshots, recoverySnapshot, refresh, restore, discardRecovery, dismissRecovery };
}
