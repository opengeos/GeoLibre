import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "./is-tauri";
import i18next from "i18next";
import {
  buildProtomapsBasemapStyle,
  evictOfflineBasemapStyle,
  hasPMTilesArchive,
  registerPMTilesRangeSource,
  unregisterPMTilesSource,
  PROTOMAPS_FLAVORS,
  registerPersistentOfflineBasemapStyle,
  type ProtomapsFlavor,
} from "@geolibre/map";
import { nativeLocalPmtilesProtocolUrl } from "./local-media-url";
import {
  deleteOfflineBasemap,
  loadOfflineBasemaps,
  renameOfflineBasemap,
  setOfflineBasemapFlavor,
  type OfflineBasemap,
} from "./offline-basemaps";

export interface NativeOfflinePackage extends OfflineBasemap {
  managed: true;
  savedPath: string;
  archiveFormat: "pmtiles" | "mbtiles";
  sha256: string;
}

interface PackageInventory {
  packages: NativeOfflinePackage[];
  problems: { id: string; error: string }[];
}

type PackageDetails = Pick<
  OfflineBasemap,
  "name" | "bbox" | "minZoom" | "maxZoom" | "flavor" | "tileType"
> & {
  archiveFormat: "pmtiles" | "mbtiles";
};

const packageMutations = new Map<string, Promise<unknown>>();
const packageArchiveKeys = new Map<string, string>();

/** Keep rapid metadata changes in user order, independently for each package.
 * A failed update does not prevent a later rename, restyle, or deletion. */
async function mutatePackage<T>(id: string, change: () => Promise<T>): Promise<T> {
  const previous = packageMutations.get(id) ?? Promise.resolve();
  const pending = previous.catch(() => undefined).then(change);
  packageMutations.set(id, pending);
  try {
    return await pending;
  } finally {
    if (packageMutations.get(id) === pending) packageMutations.delete(id);
  }
}

/** The native catalog is authoritative. Legacy exported documents remain
 * available without adopting or deleting files outside the managed store. */
export async function listSavedOfflineBasemaps(): Promise<OfflineBasemap[]> {
  const legacy = loadOfflineBasemaps();
  if (!isTauri()) return legacy;
  const inventory = await invoke<PackageInventory>("list_native_offline_packages");
  for (const entry of inventory.packages) rememberPackageArchive(entry);
  const entries: OfflineBasemap[] = [
    ...inventory.packages,
    ...inventory.problems.map(
      (problem): OfflineBasemap => ({
        id: problem.id,
        name: i18next.t("basemapExtract.unavailablePackage"),
        bbox: [0, 0, 0, 0],
        minZoom: 0,
        maxZoom: 0,
        flavor: null,
        tileType: "raster",
        bytes: 0,
        savedPath: null,
        createdAt: 0,
        managed: true,
        unavailableReason: problem.error,
      }),
    ),
  ];
  const ids = new Set(entries.map((entry) => entry.id));
  return [...entries, ...legacy.filter((entry) => !ids.has(entry.id))];
}

/** Persist bytes directly to private native storage, bypassing export/share
 * dialogs. The returned catalog identity and path survive a process restart. */
export function saveNativeOfflinePackage(
  bytes: Uint8Array,
  details: PackageDetails,
): Promise<NativeOfflinePackage> {
  return invoke<NativeOfflinePackage>("save_native_offline_package", bytes, {
    headers: { "x-package-metadata": encodeURIComponent(JSON.stringify(details)) },
  }).then((entry) => {
    rememberPackageArchive(entry);
    return entry;
  });
}

export async function renameSavedOfflineBasemap(
  entry: OfflineBasemap,
  name: string,
): Promise<void> {
  if (entry.managed) {
    await mutatePackage(entry.id, () =>
      invoke("update_native_offline_package", { id: entry.id, name }),
    );
  } else {
    renameOfflineBasemap(entry.id, name);
  }
}

export async function setSavedOfflineBasemapFlavor(
  entry: OfflineBasemap,
  flavor: ProtomapsFlavor,
): Promise<void> {
  if (entry.managed) {
    await mutatePackage(entry.id, () =>
      invoke("update_native_offline_package", { id: entry.id, flavor }),
    );
  } else {
    setOfflineBasemapFlavor(entry.id, flavor);
  }
}

export async function deleteSavedOfflineBasemap(entry: OfflineBasemap): Promise<void> {
  if (entry.managed) {
    await mutatePackage(entry.id, async () => {
      await invoke("delete_native_offline_package", { id: entry.id });
      forgetNativeOfflinePackage(entry);
    });
  } else deleteOfflineBasemap(entry.id);
}

/** Reconcile a package confirmed absent from the authoritative native catalog. */
export function forgetNativeOfflinePackage(entry: OfflineBasemap): void {
  const key =
    packageArchiveKeys.get(entry.id) ??
    (entry.savedPath ? nativeLocalPmtilesProtocolUrl(entry.savedPath) : undefined);
  if (key) unregisterPMTilesSource(key);
  packageArchiveKeys.delete(entry.id);
  evictOfflineBasemapStyle(entry.id);
}

function rememberPackageArchive(entry: NativeOfflinePackage): void {
  const key = nativeLocalPmtilesProtocolUrl(entry.savedPath);
  packageArchiveKeys.set(entry.id, key);
  // Range-backed readers are lightweight and make no request until used.
  // Overlay and raster packages need the same ownership as styled packages.
  if (entry.archiveFormat === "pmtiles" && !hasPMTilesArchive(key)) registerPMTilesRangeSource(key);
}

/** Verify on explicit use; inventory loading does not rehash every package. */
export function verifyNativeOfflinePackage(id: string): Promise<NativeOfflinePackage> {
  return invoke("verify_native_offline_package", { id });
}

/** Register every flavor without reading whole archives into the WebView.
 * Stable package URLs let an old saved project resolve its own flavor. */
export function registerNativeOfflinePackageStyles(entry: NativeOfflinePackage): void {
  rememberPackageArchive(entry);
  if (entry.archiveFormat !== "pmtiles" || entry.tileType !== "vector" || entry.flavor == null)
    return;
  const sourceUrl = nativeLocalPmtilesProtocolUrl(entry.savedPath);
  const assetsBaseUrl = new URL(`${import.meta.env.BASE_URL}basemaps-assets`, document.baseURI)
    .href;
  for (const flavor of PROTOMAPS_FLAVORS) {
    registerPersistentOfflineBasemapStyle(entry.id, flavor, () => {
      // This source belongs to the managed package, unlike a shared remote URL.
      // Register ownership so deletion can release its reader and cached tiles.
      if (!hasPMTilesArchive(sourceUrl)) registerPMTilesRangeSource(sourceUrl);
      return buildProtomapsBasemapStyle({ sourceUrl, flavor, assetsBaseUrl });
    });
  }
}

export function nativeOfflineBasemapStyleUrl(
  entry: NativeOfflinePackage,
  flavor: ProtomapsFlavor,
): string {
  registerNativeOfflinePackageStyles(entry);
  return `geolibre://offline-basemap/${entry.id}/${flavor}`;
}

/** Restore native path authorization and styles before any startup project is
 * rendered. Reopening the panel retries catalog errors instead of losing data. */
export async function initializeNativeOfflinePackages(): Promise<number> {
  if (!isTauri()) return 0;
  const inventory = await invoke<PackageInventory>("list_native_offline_packages");
  for (const entry of inventory.packages) registerNativeOfflinePackageStyles(entry);
  return inventory.problems.length;
}
