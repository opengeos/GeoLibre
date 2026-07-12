import { useAppStore } from "@geolibre/core";
import { useMemo } from "react";
import {
  BUILTIN_SERVICES,
  readUserServices,
  type ServiceLibraryEntry,
} from "../components/layout/add-data/service-library";
import { buildBrowserTree, type BrowserNode } from "../lib/browser-tree";

export interface BrowserTreeState {
  /** The section/category/leaf tree for the panel to render. */
  tree: BrowserNode[];
  /** Looks a saved-service entry up by id, for the applier. */
  serviceById: (id: string) => ServiceLibraryEntry | undefined;
}

/**
 * Assembles the Browser panel's tree from live inputs: the saved-service
 * library (built-in presets + the user's localStorage entries) and the store's
 * recent-projects list.
 *
 * The saved-service library is not a reactive store, so it is read when the
 * panel mounts (the panel is conditionally rendered, so it re-mounts each time
 * it opens) and again whenever the recent-projects list changes. That is enough
 * for the MVP: a service saved from the Add Data dialog appears the next time
 * the panel is opened.
 *
 * @returns The tree plus a by-id service lookup for one-click add.
 */
export function useBrowserTree(): BrowserTreeState {
  const recentProjects = useAppStore((s) => s.recentProjects);

  return useMemo(() => {
    const services = [...BUILTIN_SERVICES, ...readUserServices()];
    const byId = new Map(services.map((entry) => [entry.id, entry]));
    return {
      tree: buildBrowserTree({ services, recentProjects }),
      serviceById: (id: string) => byId.get(id),
    };
  }, [recentProjects]);
}
