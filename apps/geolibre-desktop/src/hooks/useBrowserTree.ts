import {
  layerLibraryEntryNeedsLocalFile,
  useAppStore,
  type LayerLibraryEntry,
} from "@geolibre/core";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  listAllServices,
  readUserServices,
  type ServiceLibraryEntry,
} from "../components/layout/add-data/service-library";
import {
  POSTGRES_CONNECTIONS_CHANGED_EVENT,
  readSavedPostgresConnections,
  savedPostgresConnectionLabel,
} from "../lib/saved-postgres-connections";
import {
  MSSQL_CONNECTIONS_CHANGED_EVENT,
  mssqlConnectionLabel,
  readSavedMssqlConnections,
} from "../lib/saved-mssql-connections";
import {
  folderLabel,
  PINNED_FOLDERS_CHANGED_EVENT,
  readPinnedFolders,
} from "../lib/browser-folders";
import { FAVORITES_CHANGED_EVENT, readBrowserFavorites } from "../lib/browser-favorites";
import { IS_MAS_BUILD } from "../lib/build-flags";
import { isTauri } from "../lib/tauri-io";
import { buildBrowserTree, type BrowserNode } from "../lib/browser-tree";

export interface BrowserTreeState {
  /** The section/category/leaf tree for the panel to render. */
  tree: BrowserNode[];
  /** Looks a saved-service entry up by id, for the applier. */
  serviceById: (id: string) => ServiceLibraryEntry | undefined;
  /** Ids of currently-favorited nodes, for the star fill state. */
  favoriteIds: Set<string>;
  /** Looks a saved Layer Library entry up by id, for the re-add path. */
  libraryLayerById: (id: string) => LayerLibraryEntry | undefined;
}

/**
 * Assembles the Browser panel's tree from live inputs: the saved-service
 * library (built-in presets, deployment services, and the user's localStorage
 * entries), the store's recent-projects list, and the store's Layer Library (My Data).
 *
 * The saved-service library is not a reactive store, so it is read when the
 * panel mounts (the panel is conditionally rendered, so it re-mounts each time
 * it opens) and again whenever the recent-projects list changes. That is enough
 * for the MVP: a service saved from the Add Data dialog appears the next time
 * the panel is opened.
 *
 * @returns The tree plus by-id lookups (saved service, saved layer) for the
 *   one-click add paths.
 */
export function useBrowserTree(): BrowserTreeState {
  const { t } = useTranslation();
  const recentProjects = useAppStore((s) => s.recentProjects);
  // The Layer Library IS a reactive store slice (unlike the localStorage-backed
  // services/folders/favorites below), so My Data refreshes the moment a layer
  // is saved, renamed, or deleted.
  const layerLibrary = useAppStore((s) => s.layerLibrary);
  const servicesLabel = t("browser.services");
  const recentLabel = t("browser.recent");
  const databasesLabel = t("browser.databases");
  const postgresqlLabel = t("browser.postgresql");
  const filesLabel = t("browser.files");
  const favoritesLabel = t("browser.favorites");
  const myDataLabel = t("browser.myData");
  const sqlServerLabel = t("browser.sqlServer");

  // Saved connections are not a reactive store (localStorage on the web, an
  // in-memory cache over the OS credential store on desktop), so re-read them
  // when one is added/removed — otherwise a connection saved from the Add Data
  // dialog wouldn't appear until the (still-mounted) panel is reopened. The
  // pinned folders are the same story (see the Files section below).
  const [connectionsRevision, setConnectionsRevision] = useState(0);
  const [mssqlRevision, setMssqlRevision] = useState(0);
  const [foldersRevision, setFoldersRevision] = useState(0);
  const [favoritesRevision, setFavoritesRevision] = useState(0);
  useEffect(() => {
    const bumpConnections = () => setConnectionsRevision((n) => n + 1);
    const bumpFolders = () => setFoldersRevision((n) => n + 1);
    const bumpFavorites = () => setFavoritesRevision((n) => n + 1);
    const bumpMssql = () => setMssqlRevision((n) => n + 1);
    window.addEventListener(POSTGRES_CONNECTIONS_CHANGED_EVENT, bumpConnections);
    window.addEventListener(PINNED_FOLDERS_CHANGED_EVENT, bumpFolders);
    window.addEventListener(FAVORITES_CHANGED_EVENT, bumpFavorites);
    window.addEventListener(MSSQL_CONNECTIONS_CHANGED_EVENT, bumpMssql);
    return () => {
      window.removeEventListener(POSTGRES_CONNECTIONS_CHANGED_EVENT, bumpConnections);
      window.removeEventListener(PINNED_FOLDERS_CHANGED_EVENT, bumpFolders);
      window.removeEventListener(FAVORITES_CHANGED_EVENT, bumpFavorites);
      window.removeEventListener(MSSQL_CONNECTIONS_CHANGED_EVENT, bumpMssql);
    };
  }, []);

  return useMemo(() => {
    const services = listAllServices(readUserServices());
    const byId = new Map(services.map((entry) => [entry.id, entry]));
    // Keep both engine groups visible on supported builds, including when a
    // saved list is empty so each group retains its own "New connection" (＋).
    // The Mac App Store build cannot run the local processing sidecar, so it
    // passes undefined for both inputs and omits the whole Databases section.
    const databaseConnections = IS_MAS_BUILD
      ? undefined
      : readSavedPostgresConnections().map((connectionString) => ({
          connectionString,
          label: savedPostgresConnectionLabel(connectionString),
        }));
    const mssqlConnections = IS_MAS_BUILD
      ? undefined
      : readSavedMssqlConnections().map((profile) => ({
          id: profile.id,
          label: mssqlConnectionLabel(profile, t),
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
    const layerLibraryById = new Map(layerLibrary.map((entry) => [entry.id, entry]));
    return {
      tree: buildBrowserTree({
        services,
        recentProjects,
        databaseConnections,
        mssqlConnections,
        files,
        favorites,
        libraryLayers: layerLibrary.map((entry) => ({
          id: entry.id,
          name: entry.name,
          needsLocalFile: layerLibraryEntryNeedsLocalFile(entry),
        })),
        sectionLabels: {
          services: servicesLabel,
          postgresql: postgresqlLabel,
          recent: recentLabel,
          databases: databasesLabel,
          sqlServer: sqlServerLabel,
          files: filesLabel,
          favorites: favoritesLabel,
          myData: myDataLabel,
        },
      }),
      serviceById: (id: string) => byId.get(id),
      favoriteIds: new Set(favorites.map((fav) => fav.id)),
      libraryLayerById: (id: string) => layerLibraryById.get(id),
    };
  }, [
    recentProjects,
    layerLibrary,
    servicesLabel,
    recentLabel,
    databasesLabel,
    postgresqlLabel,
    filesLabel,
    favoritesLabel,
    myDataLabel,
    sqlServerLabel,
    connectionsRevision,
    mssqlRevision,
    foldersRevision,
    favoritesRevision,
    t,
  ]);
}
