import { useAppStore, type RecentProjectEntry } from "@geolibre/core";
import { useEffect } from "react";

const RECENT_PROJECTS_STORAGE_KEY = "geolibre.recentProjects";

function isRecentProjectEntry(value: unknown): value is RecentProjectEntry {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<RecentProjectEntry>;
  return (
    typeof candidate.path === "string" &&
    typeof candidate.name === "string" &&
    typeof candidate.openedAt === "string"
  );
}

function loadRecentProjects(): RecentProjectEntry[] {
  if (typeof window === "undefined") return [];

  try {
    const stored = window.localStorage.getItem(RECENT_PROJECTS_STORAGE_KEY);
    if (!stored) return [];
    const parsed = JSON.parse(stored) as unknown;
    return Array.isArray(parsed) ? parsed.filter(isRecentProjectEntry) : [];
  } catch {
    // localStorage may be unavailable (SecurityError) or hold invalid JSON.
    return [];
  }
}

function saveRecentProjects(projects: RecentProjectEntry[]) {
  if (typeof window === "undefined") return;

  try {
    window.localStorage.setItem(RECENT_PROJECTS_STORAGE_KEY, JSON.stringify(projects));
  } catch {
    // Persistence is best-effort; ignore quota or disabled-storage errors.
  }
}

export function useRecentProjectsPersistence() {
  const setRecentProjects = useAppStore((state) => state.setRecentProjects);

  useEffect(() => {
    setRecentProjects(loadRecentProjects());
    // Persist the normalized form now: the subscriber below is attached after
    // this first state change, so any dedup/trim done on load would otherwise
    // never be written back and the raw entries would reappear next load.
    saveRecentProjects(useAppStore.getState().recentProjects);

    return useAppStore.subscribe((state, previous) => {
      if (state.recentProjects !== previous.recentProjects) {
        saveRecentProjects(state.recentProjects);
      }
    });
    // `setRecentProjects` is a stable Zustand action, so this runs once on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
