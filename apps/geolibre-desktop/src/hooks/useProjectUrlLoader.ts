import { parseProject, useAppStore } from "@geolibre/core";
import { useEffect, useMemo, useRef, useState } from "react";

export type ProjectUrlLoadState =
  | { error: null; message: null; status: "idle" }
  | { error: null; message: string; status: "loading" | "loaded" }
  | { error: string; message: null; status: "error" };

const PROJECT_URL_PARAMS = ["url", "project", "projectUrl", "project_url"];

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

    void loadProjectFromUrl(projectUrl, abortController.signal)
      .then((project) => {
        loadProject(project, projectUrl);
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
          error:
            error instanceof Error
              ? error.message
              : "Could not load the project URL.",
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

async function loadProjectFromUrl(projectUrl: string, signal: AbortSignal) {
  const response = await fetch(projectUrl, {
    headers: { Accept: "application/json, text/plain;q=0.9, */*;q=0.8" },
    signal,
  });

  if (!response.ok) {
    throw new Error(
      `Could not load project URL: HTTP ${response.status} ${response.statusText}`,
    );
  }

  return parseProject(await response.text());
}

function projectUrlFromLocation(): string | null {
  if (typeof window === "undefined") return null;

  const search = window.location.search;
  const params = new URLSearchParams(search);
  for (const key of PROJECT_URL_PARAMS) {
    const value = params.get(key);
    const url = normalizeProjectUrl(value);
    if (url) return url;
  }

  const bareQuery = search.startsWith("?")
    ? safeDecodeURIComponent(search.slice(1)).trim()
    : "";
  return /^https?:\/\//i.test(bareQuery)
    ? normalizeProjectUrl(bareQuery)
    : null;
}

function normalizeProjectUrl(value: string | null): string | null {
  if (!value?.trim()) return null;

  try {
    const url = new URL(value.trim(), window.location.href);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.href
      : null;
  } catch {
    return null;
  }
}

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
