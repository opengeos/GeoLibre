/**
 * What the Mac App Store build hides, as pure decision helpers. The MAS build
 * cannot spawn the Python sidecar or the martin tile server (App Sandbox), so
 * the surfaces that have no client-side fallback are removed from the UI. The
 * helpers take the flag as a parameter (defaulting to the real build flag) so
 * plain Node tests can exercise both variants.
 */

import { IS_MAS_BUILD } from "./build-flags";

// Add Data sources that are 100% sidecar/martin-backed: PostgreSQL layers are
// served through the martin helper binary, and File Geodatabase reading runs
// on the sidecar's GeoPandas/GDAL stack. Neither has a client-side engine.
export const MAS_HIDDEN_DATA_SOURCES: ReadonlySet<string> = new Set(["postgres", "gdb"]);

// Menu items whose feature is sidecar-only with no fallback: AI Segmentation
// (samgeo runs on the sidecar; the client-side detection tools are separate
// items and stay).
export const MAS_HIDDEN_MENU_ITEMS: ReadonlySet<string> = new Set(["processing.segmentation"]);

/** Whether the Add Data source id is hidden in the Mac App Store build. */
export function masHidesDataSource(id: string, mas: boolean = IS_MAS_BUILD): boolean {
  return mas && MAS_HIDDEN_DATA_SOURCES.has(id);
}

/** Whether the menu item id is hidden in the Mac App Store build. */
export function masHidesMenuItem(id: string, mas: boolean = IS_MAS_BUILD): boolean {
  return mas && MAS_HIDDEN_MENU_ITEMS.has(id);
}

// Extensions of the shapefile parts that ride along with a `.shp`, mirroring
// SHAPEFILE_SIDECAR_EXTENSIONS in tauri-io.ts and the Rust command.
const SHAPEFILE_COMPANION_EXTENSIONS: ReadonlySet<string> = new Set(["dbf", "shx", "prj", "cpg"]);

function splitPath(path: string): { dir: string; name: string } {
  const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return { dir: path.slice(0, cut + 1), name: path.slice(cut + 1) };
}

/**
 * The shapefile companion files (`.dbf`, `.shx`, `.prj`, `.cpg`) for a picked
 * `.shp`, taken from the same file-dialog selection.
 *
 * Under the App Sandbox the Mac App Store build cannot read the `.shp`'s
 * siblings from disk (only files the user actually picked are readable), so the
 * automatic sibling read returns nothing. Users are told to multi-select every
 * shapefile part instead, and this matches those picks back to their `.shp`:
 * same directory, same base name (case-insensitively, like the Rust sibling
 * read), and a companion extension.
 *
 * @param shpPath - The absolute path of the picked `.shp`.
 * @param selectedPaths - Every path in the same dialog selection.
 * @returns The matching companion paths, in selection order.
 */
export function shapefileCompanionPathsFromSelection(
  shpPath: string,
  selectedPaths: string[],
): string[] {
  const shp = splitPath(shpPath);
  const base = shp.name.replace(/\.[^.]+$/, "").toLowerCase();
  return selectedPaths.filter((candidate) => {
    if (candidate === shpPath) return false;
    const part = splitPath(candidate);
    if (part.dir !== shp.dir) return false;
    const dot = part.name.lastIndexOf(".");
    if (dot <= 0) return false;
    const extension = part.name.slice(dot + 1).toLowerCase();
    return (
      SHAPEFILE_COMPANION_EXTENSIONS.has(extension) &&
      part.name.slice(0, dot).toLowerCase() === base
    );
  });
}
