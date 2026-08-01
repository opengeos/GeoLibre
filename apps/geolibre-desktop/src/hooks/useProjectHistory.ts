import { parseProject, serializeProject, useAppStore } from "@geolibre/core";
import type { MapController } from "@geolibre/map";
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { buildProjectSnapshot } from "../lib/build-project-snapshot";
import {
  addProjectSnapshot,
  clearProjectSnapshots,
  deleteProjectSnapshot,
  listProjectSnapshots,
  type ProjectHistorySnapshot,
} from "../lib/project-history-store";

const SESSION_KEY = "geolibre-project-session";
const LAST_SAVE_KEY = "geolibre-project-last-explicit-save";
const AUTOSAVE_DELAY_MS = 3_000;

export function useProjectHistory(mapControllerRef: RefObject<MapController | null>) {
  const [snapshots, setSnapshots] = useState<ProjectHistorySnapshot[]>([]);
  const [recoverySnapshot, setRecoverySnapshot] = useState<ProjectHistorySnapshot | null>(null);
  const timerRef = useRef<number | null>(null);
  const lastGenerationRef = useRef(useAppStore.getState().projectGeneration);
  const refresh = useCallback(async () => setSnapshots(await listProjectSnapshots()), []);

  useEffect(() => {
    void (async () => {
      const entries = await listProjectSnapshots();
      setSnapshots(entries);
      const previousSession = localStorage.getItem(SESSION_KEY);
      const lastSave = localStorage.getItem(LAST_SAVE_KEY);
      const latest = entries[0];
      if (previousSession === "open" && latest && (!lastSave || latest.createdAt > lastSave)) {
        setRecoverySnapshot(latest);
      }
      localStorage.setItem(SESSION_KEY, "open");
    })();

    const markClean = () => localStorage.setItem(SESSION_KEY, "closed");
    window.addEventListener("pagehide", markClean);
    const unsubscribe = useAppStore.subscribe((state, previous) => {
      if (!state.isDirty && previous.isDirty) {
        localStorage.setItem(LAST_SAVE_KEY, new Date().toISOString());
      }
      if (state.projectGeneration !== lastGenerationRef.current) {
        lastGenerationRef.current = state.projectGeneration;
        if (state.projectPath === null && state.layers.length === 0) {
          void clearProjectSnapshots().then(refresh);
        }
      }
      if (!state.isDirty) return;
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null;
        const content = serializeProject(buildProjectSnapshot(mapControllerRef));
        void addProjectSnapshot(content).then(refresh).catch(console.error);
      }, AUTOSAVE_DELAY_MS);
    });
    return () => {
      unsubscribe();
      window.removeEventListener("pagehide", markClean);
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    };
  }, [mapControllerRef, refresh]);

  const restore = useCallback((snapshot: ProjectHistorySnapshot) => {
    useAppStore.getState().loadProject(parseProject(snapshot.content), null, {
      rememberRecent: false,
      presenting: false,
    });
    useAppStore.setState({ isDirty: true });
    setRecoverySnapshot(null);
  }, []);

  const discardRecovery = useCallback(() => {
    if (recoverySnapshot) void deleteProjectSnapshot(recoverySnapshot.id).then(refresh);
    setRecoverySnapshot(null);
  }, [recoverySnapshot, refresh]);

  return { snapshots, recoverySnapshot, refresh, restore, discardRecovery };
}
