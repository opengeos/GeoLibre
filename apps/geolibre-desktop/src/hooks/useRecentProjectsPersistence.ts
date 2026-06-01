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
  const stored = window.localStorage.getItem(RECENT_PROJECTS_STORAGE_KEY);
  if (!stored) return [];

  try {
    const parsed = JSON.parse(stored) as unknown;
    return Array.isArray(parsed) ? parsed.filter(isRecentProjectEntry) : [];
  } catch {
    return [];
  }
}

function saveRecentProjects(projects: RecentProjectEntry[]) {
  window.localStorage.setItem(
    RECENT_PROJECTS_STORAGE_KEY,
    JSON.stringify(projects),
  );
}

export function useRecentProjectsPersistence() {
  const setRecentProjects = useAppStore((state) => state.setRecentProjects);

  useEffect(() => {
    setRecentProjects(loadRecentProjects());

    return useAppStore.subscribe((state, previous) => {
      if (state.recentProjects !== previous.recentProjects) {
        saveRecentProjects(state.recentProjects);
      }
    });
  }, [setRecentProjects]);
}
