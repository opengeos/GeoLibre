import { mapCrsPreferencePatch, useAppStore, type GeoLibreProject } from "@geolibre/core";
import { resolveMapCrs } from "@geolibre/map";
import { useEffect, useMemo, useRef, useState } from "react";
import { coordinateTargetFromSearch } from "../lib/coordinate-url";
import { mapCrsRequestFromSearch, type MapCrsUrlRequest } from "../lib/map-crs-url";
import { fetchProjectFromUrl, projectUrlFromLocation } from "../lib/project-url";
import { resolveProjectXyzLayers } from "../lib/xyz-url";

export type ProjectUrlLoadState =
  | { error: null; message: null; status: "idle" }
  | { error: null; message: string; status: "loading" | "loaded" }
  | { error: string; message: null; status: "error" };

/**
 * Lay a link's `crs` over a project's own, as its coordinates override the saved
 * view. A code that does not resolve leaves the project as saved (`useMapCrsUrl`
 * reports it).
 */
async function withLinkedMapCrs(
  project: GeoLibreProject,
  request: MapCrsUrlRequest | null,
): Promise<GeoLibreProject> {
  const mapCrs = request?.mapCrs;
  if (mapCrs === undefined) return project;
  if (mapCrs !== null && !(await resolveMapCrs(mapCrs).catch(() => null))) return project;
  return {
    ...project,
    preferences: {
      ...project.preferences,
      map: { ...project.preferences.map, ...mapCrsPreferencePatch(mapCrs) },
    },
  };
}

export function useProjectUrlLoader(): ProjectUrlLoadState {
  const loadProject = useAppStore((state) => state.loadProject);
  const projectUrl = useMemo(() => projectUrlFromLocation(), []);
  // Capture before live URL synchronization can write a temporary startup view.
  const urlView = useMemo(() => coordinateTargetFromSearch(window.location.search), []);
  const urlCrs = useMemo(() => mapCrsRequestFromSearch(window.location.search), []);
  const clearMessageTimeoutRef = useRef<number | null>(null);
  const [state, setState] = useState<ProjectUrlLoadState>({
    error: null,
    message: null,
    status: "idle",
  });

  useEffect(() => {
    if (!projectUrl) return;

    const abortController = new AbortController();
    setState({
      error: null,
      message: "Loading project from URL…",
      status: "loading",
    });

    void fetchProjectFromUrl(projectUrl, { signal: abortController.signal })
      .then((project) => resolveProjectXyzLayers(project, abortController.signal))
      .then((project) => withLinkedMapCrs(project, urlCrs))
      .then((project) => {
        if (abortController.signal.aborted) return;
        // A `?url=` deep link is reloaded on every visit, so treat it as
        // transient rather than persisting it to the recent-projects list.
        loadProject(
          urlView ? { ...project, mapView: { ...project.mapView, ...urlView } } : project,
          projectUrl,
          { rememberRecent: false },
        );
        setState({
          error: null,
          message: `Loaded ${project.name}`,
          status: "loaded",
        });
        clearMessageTimeoutRef.current = window.setTimeout(() => {
          clearMessageTimeoutRef.current = null;
          setState({ error: null, message: null, status: "idle" });
        }, 4000);
      })
      .catch((error: unknown) => {
        if (abortController.signal.aborted) return;
        setState({
          error: error instanceof Error ? error.message : "Could not load the project URL.",
          message: null,
          status: "error",
        });
      });

    return () => {
      abortController.abort();
      if (clearMessageTimeoutRef.current !== null) {
        window.clearTimeout(clearMessageTimeoutRef.current);
        clearMessageTimeoutRef.current = null;
      }
    };
  }, [loadProject, projectUrl, urlCrs, urlView]);

  return state;
}
