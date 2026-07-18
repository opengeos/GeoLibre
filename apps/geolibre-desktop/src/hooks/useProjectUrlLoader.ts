import { useAppStore } from "@geolibre/core";
import { useEffect, useMemo, useRef, useState } from "react";
import { fetchProjectFromUrl, projectUrlFromLocation } from "../lib/project-url";
import { resolveProjectXyzLayers } from "../lib/xyz-url";

export type ProjectUrlLoadState =
  | { error: null; message: null; status: "idle" }
  | { error: null; message: string; status: "loading" | "loaded" }
  | { error: string; message: null; status: "error" };

export function useProjectUrlLoader(): ProjectUrlLoadState {
  const loadProject = useAppStore((state) => state.loadProject);
  const projectUrl = useMemo(() => projectUrlFromLocation(), []);
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
      message: "Loading project from URL...",
      status: "loading",
    });

    void fetchProjectFromUrl(projectUrl, { signal: abortController.signal })
      .then((project) => resolveProjectXyzLayers(project, abortController.signal))
      .then((project) => {
        if (abortController.signal.aborted) return;
        // A `?url=` deep link is reloaded on every visit, so treat it as
        // transient rather than persisting it to the recent-projects list.
        loadProject(project, projectUrl, { rememberRecent: false });
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
  }, [loadProject, projectUrl]);

  return state;
}
