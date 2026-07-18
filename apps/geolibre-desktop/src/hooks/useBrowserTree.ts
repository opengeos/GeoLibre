import { useAppStore } from "@geolibre/core";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  BUILTIN_SERVICES,
  readUserServices,
  type ServiceLibraryEntry,
} from "../components/layout/add-data/service-library";
import {
  POSTGRES_CONNECTIONS_CHANGED_EVENT,
  readSavedPostgresConnections,
  savedPostgresConnectionLabel,
} from "../lib/saved-postgres-connections";
import {
  folderLabel,
  PINNED_FOLDERS_CHANGED_EVENT,
  readPinnedFolders,
} from "../lib/browser-folders";
import { FAVORITES_CHANGED_EVENT, readBrowserFavorites } from "../lib/browser-favorites";
import { isTauri } from "../lib/tauri-io";
import { buildBrowserTree, type BrowserNode } from "../lib/browser-tree";

export interface BrowserTreeState {
  /** The section/category/leaf tree for the panel to render. */
  tree: BrowserNode[];
  /** Looks a saved-service entry up by id, for the applier. */
  serviceById: (id: string) => ServiceLibraryEntry | undefined;
  /** Ids of currently-favorited nodes, for the star fill state. */
  favoriteIds: Set<string>;
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
  const { t } = useTranslation();
  const recentProjects = useAppStore((s) => s.recentProjects);
  const servicesLabel = t("browser.services");
  const recentLabel = t("browser.recent");
  const databasesLabel = t("browser.databases");
  const filesLabel = t("browser.files");
  const favoritesLabel = t("browser.favorites");

  // Saved connections live in localStorage (no reactive store), so re-read them
  // when one is added/removed — otherwise a connection saved from the Add Data
  // dialog wouldn't appear until the (still-mounted) panel is reopened. The
  // pinned folders are the same story (see the Files section below).
  const [connectionsRevision, setConnectionsRevision] = useState(0);
  const [foldersRevision, setFoldersRevision] = useState(0);
  const [favoritesRevision, setFavoritesRevision] = useState(0);
  useEffect(() => {
    const bumpConnections = () => setConnectionsRevision((n) => n + 1);
    const bumpFolders = () => setFoldersRevision((n) => n + 1);
    const bumpFavorites = () => setFavoritesRevision((n) => n + 1);
    window.addEventListener(POSTGRES_CONNECTIONS_CHANGED_EVENT, bumpConnections);
    window.addEventListener(PINNED_FOLDERS_CHANGED_EVENT, bumpFolders);
    window.addEventListener(FAVORITES_CHANGED_EVENT, bumpFavorites);
    return () => {
      window.removeEventListener(POSTGRES_CONNECTIONS_CHANGED_EVENT, bumpConnections);
      window.removeEventListener(PINNED_FOLDERS_CHANGED_EVENT, bumpFolders);
      window.removeEventListener(FAVORITES_CHANGED_EVENT, bumpFavorites);
    };
  }, []);

  return useMemo(() => {
    const services = [...BUILTIN_SERVICES, ...readUserServices()];
    const byId = new Map(services.map((entry) => [entry.id, entry]));
    // Shown on every platform for discovery; the PostgreSQL add flow itself
    // reports when it needs GeoLibre Desktop (Martin has no mobile build).
    // Kept in the saved list's order (most-recently-used first), deliberately
    // unlike the alphabetized Services list — this mirrors the Recent section.
    const databaseConnections = readSavedPostgresConnections().map((connectionString) => ({
      connectionString,
      label: savedPostgresConnectionLabel(connectionString),
    }));
    // The Files section is desktop-only: directory reading uses the fs plugin's
    // readDir, which only works within the scope the OS folder dialog grants, so
    // the section lists the user's pinned folders (localStorage, MRU-first) that
    // were added via the picker.
    const files = isTauri()
      ? {
          folders: readPinnedFolders().map((path) => ({
            path,
            label: folderLabel(path),
          })),
        }
      : undefined;
    const favorites = readBrowserFavorites();
    return {
      tree: buildBrowserTree({
        services,
        recentProjects,
        databaseConnections,
        files,
        favorites,
        sectionLabels: {
          services: servicesLabel,
          recent: recentLabel,
          databases: databasesLabel,
          files: filesLabel,
          favorites: favoritesLabel,
        },
      }),
      serviceById: (id: string) => byId.get(id),
      favoriteIds: new Set(favorites.map((fav) => fav.id)),
    };
  }, [
    recentProjects,
    servicesLabel,
    recentLabel,
    databasesLabel,
    filesLabel,
    favoritesLabel,
    connectionsRevision,
    foldersRevision,
    favoritesRevision,
  ]);
}
