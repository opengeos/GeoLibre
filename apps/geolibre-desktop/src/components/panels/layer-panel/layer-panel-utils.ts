import { isArcGISWritableLayer } from "@geolibre/plugins";
import type { ParseKeys, TFunction } from "i18next";
import { NETCDF_IMAGE_SOURCE_KIND } from "@geolibre/core";
import type { GeoLibreLayer } from "@geolibre/core";
import { MIN_REFRESH_INTERVAL_MS } from "../../../lib/layer-refresh";
import { rasterExportUrl } from "../../../lib/raster-export";
import type { RasterInfo } from "../../../lib/raster-info";
import { IS_MAS_BUILD } from "../../../lib/build-flags";
import { isTauri } from "../../../lib/is-tauri";
import { getNetcdfLayerState } from "../../../lib/netcdf-image-symbology";
import { DATA_SOURCE_CATALOG, type DataSourceCatalogEntry } from "../../../lib/ui-profile";
import type { AddDataKind } from "../../layout/add-data/types";
import { KIND_I18N_KEY } from "../../layout/add-data/constants";

export const BACKGROUND_SELECTION_ID = "__geolibre-background__";

export const REFRESH_INTERVAL_OPTIONS: ReadonlyArray<{
  labelKey: ParseKeys;
  intervalMs: number;
}> = [
  { labelKey: "layers.refreshIntervals.off", intervalMs: 0 },
  { labelKey: "layers.refreshIntervals.s15", intervalMs: 15_000 },
  { labelKey: "layers.refreshIntervals.s30", intervalMs: 30_000 },
  { labelKey: "layers.refreshIntervals.m1", intervalMs: 60_000 },
  { labelKey: "layers.refreshIntervals.m5", intervalMs: 5 * 60_000 },
  { labelKey: "layers.refreshIntervals.m15", intervalMs: 15 * 60_000 },
];
export const CUSTOM_REFRESH_INTERVAL_VALUE = "custom";
export const REFRESH_STATUS_DURATION_MS = 4_000;
/** How often the durable "Last synced …" labels are recomputed. */
export const SYNC_CLOCK_TICK_MS = 60_000;

/**
 * The Add Data sources a group's "Add data to group" submenu can offer, in Add
 * Data menu order. `openAddData` scopes the layers a source creates to a group,
 * so only the sources the Add Data *dialog* owns qualify — `KIND_I18N_KEY` is
 * keyed by `AddDataKind`, so membership in it is that test. The rest of the
 * catalog (vector/raster file pickers, STAC, …) has no group-scoped open.
 * PMTiles, raster, and Zarr also use the dialog when ArcGIS is the primary renderer.
 */
export const ADD_DATA_DIALOG_SOURCES = DATA_SOURCE_CATALOG.filter(
  (entry): entry is DataSourceCatalogEntry & { id: AddDataKind } =>
    entry.id in KIND_I18N_KEY ||
    entry.id === "pmtiles" ||
    entry.id === "raster" ||
    entry.id === "zarr",
);

export type LayerRefreshStatus = {
  type: "refreshing" | "success" | "error" | "warning";
  message: string;
};

export type LayerRefreshTimer = {
  intervalMs: number;
  timer: number;
};

/**
 * The short type tag shown at the end of a layer row.
 *
 * @param layer - The layer the row draws.
 * @param t - The translation function.
 * @returns The label, e.g. "vector" or "cog".
 */
export function layerTypeLabel(layer: GeoLibreLayer, t: TFunction): string {
  if (layer.metadata?.sourceKind === "maplibre-basemap-control") {
    return t("layers.typeBasemap");
  }
  if (layer.type === "geojson" || layer.type === "vector-tiles") {
    return "vector";
  }
  return layer.type;
}

function sourceUrlsFromLayer(layer: GeoLibreLayer): string[] {
  if (layer.type !== "video" || !Array.isArray(layer.source.urls)) {
    return [];
  }
  return layer.source.urls.filter(
    (value): value is string => typeof value === "string" && value.trim().length > 0,
  );
}

// Source formats whose in-place write-back the sidecar supports today. Kept in
// sync with the backend gate in `app/vector.py` (_WRITABLE_EXTENSIONS).
const WRITEBACK_EXTENSIONS = ["gpkg", "geojson", "json"];

/**
 * Whether the layer is an editable PostGIS table with a usable primary key
 * (loaded via Add Data > PostgreSQL in editable mode). The sidecar diffs the
 * features against the source table by that key on save.
 */
export function isPostgisEditableLayer(layer: GeoLibreLayer): boolean {
  return (
    layer.type === "geojson" &&
    layer.metadata.sourceKind === "postgis-table" &&
    typeof layer.metadata.postgisTable === "string" &&
    typeof layer.metadata.postgisPrimaryKey === "string"
  );
}

/**
 * Whether the layer's edits can be committed back to its source: a
 * desktop-only, geojson-backed layer loaded either from a local file in a
 * supported format or from a PostGIS table with a primary key. The sidecar
 * needs real filesystem/database access, so this is false on the web build.
 * This answers only "is there a writable source": the layer's capabilities are
 * applied by the caller (`canWriteBack`), so a layer that allows creates or
 * deletes but not updates still offers the save.
 */
export function canWriteEditsToSource(layer: GeoLibreLayer): boolean {
  if (isArcGISWritableLayer(layer)) return true;
  if (!isTauri() || layer.type !== "geojson") return false;
  // Both write-back paths (PostGIS tables and local files) run through the
  // Python sidecar, which the Mac App Store build compiles out, so edits are
  // export-only there, as on the web build.
  if (IS_MAS_BUILD) return false;
  if (isPostgisEditableLayer(layer)) return true;
  const path = typeof layer.sourcePath === "string" ? layer.sourcePath.trim() : "";
  if (!path) return false;
  const ext = path.split(".").pop()?.toLowerCase();
  return ext ? WRITEBACK_EXTENSIONS.includes(ext) : false;
}

/**
 * Async state of the GeoTIFF header read that backs the raster section of the
 * metadata dialog. `layerId` scopes the state to the layer it was read for:
 * the dialog re-renders for a newly opened layer before the effect below can
 * restart the read, so without it the previous layer's header would show for a
 * frame under the new layer's name.
 */
export type RasterInfoState = { layerId: string } & (
  | { status: "loading" }
  | { status: "ready"; info: RasterInfo }
  | { status: "error" }
);

/**
 * Whether a layer's metadata can be enriched with GeoTIFF header facts: a
 * raster layer whose bytes are reachable as a single file (a remote COG or a
 * retained local-bytes blob). Tile-template rasters have no such file.
 *
 * @param layer - The layer whose metadata dialog is open.
 * @returns A fetchable GeoTIFF URL, or null.
 */
export function rasterInfoUrl(layer: GeoLibreLayer): string | null {
  if (layer.type !== "cog" && layer.type !== "raster") return null;
  return rasterExportUrl(layer);
}

/**
 * Builds the JSON payload shown in the layer metadata dialog. Raster header
 * facts (CRS, pixel size, storage) lead when they have been read, since the
 * store metadata below them only knows the WGS84 bounds and band count.
 *
 * @param layer - The layer whose metadata is shown.
 * @param rasterInfo - GeoTIFF header facts, when read for this layer.
 * @returns The payload to serialize into the dialog.
 */
export function layerMetadataPayload(
  layer: GeoLibreLayer,
  rasterInfo?: RasterInfo | null,
): Record<string, unknown> {
  const videoSourceUrls = sourceUrlsFromLayer(layer);
  return {
    ...(rasterInfo ? { raster: rasterInfo } : {}),
    ...layer.metadata,
    layerName: layer.name,
    layerType: layer.type,
    ...(videoSourceUrls.length > 0
      ? {
          sourceUrl: videoSourceUrls[0],
          ...(videoSourceUrls[1] ? { fallbackSourceUrl: videoSourceUrls[1] } : {}),
        }
      : {}),
    sourcePath: layer.sourcePath,
  };
}

/**
 * The refresh-interval `<select>` value for an interval: the preset's own
 * value, or the custom sentinel when no preset matches.
 *
 * @param intervalMs - The configured interval in milliseconds.
 * @returns The option value to select.
 */
export function refreshIntervalOptionValue(intervalMs: number): string {
  if (REFRESH_INTERVAL_OPTIONS.some((option) => option.intervalMs === intervalMs)) {
    return String(intervalMs);
  }
  return CUSTOM_REFRESH_INTERVAL_VALUE;
}

/**
 * The custom-interval input text for an interval, in whole seconds.
 *
 * @param intervalMs - The configured interval in milliseconds.
 * @returns The seconds as text, or "" when the interval is off.
 */
export function customRefreshIntervalSeconds(intervalMs: number): string {
  if (intervalMs <= 0) return "";
  return String(Math.round(intervalMs / 1000));
}

/**
 * Parses the custom-interval input, clamped to the minimum refresh interval.
 *
 * @param value - The typed number of seconds.
 * @returns The interval in milliseconds, or null when the input is not a positive number.
 */
export function parseCustomRefreshIntervalMs(value: string): number | null {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return Math.max(MIN_REFRESH_INTERVAL_MS, Math.round(seconds * 1000));
}

/**
 * Formats a sync timestamp relative to now ("2 minutes ago").
 *
 * @param iso - The ISO timestamp of the last sync.
 * @param locale - The UI locale.
 * @returns The localized relative time, or `iso` when it cannot be parsed.
 */
export function relativeSyncTime(iso: string, locale: string): string {
  const elapsedSeconds = Math.round((new Date(iso).getTime() - Date.now()) / 1000);
  if (!Number.isFinite(elapsedSeconds)) return iso;
  const formatter = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  if (Math.abs(elapsedSeconds) < 60) return formatter.format(elapsedSeconds, "second");
  const minutes = Math.round(elapsedSeconds / 60);
  if (Math.abs(minutes) < 60) return formatter.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return formatter.format(hours, "hour");
  return formatter.format(Math.round(hours / 24), "day");
}

/**
 * Whether Identify can answer for a layer through a plugin-registered native
 * layer (or, for a NetCDF grid, its retained in-memory values).
 *
 * @param layer - The layer whose row is drawn.
 * @returns True when a click on the map can identify this layer.
 */
export function hasNativeIdentifyLayers(layer: GeoLibreLayer): boolean {
  if (layer.metadata.identifiable === false) return false;

  // A NetCDF grid baked to pixels has no queryable features and no native layer
  // registered by a plugin, but its values are held in memory and read directly
  // by useNetcdfIdentify. Named here rather than given a synthetic
  // `nativeLayerIds`, which would make layer-sync treat it as plugin-owned and
  // stop drawing it. Gated on the grids actually being retained — a project
  // reload drops them — since offering Identify that answers nothing is worse
  // than not offering it. Deliberately the layer state rather than
  // `getNetcdfImageSource`, which is null for an RGB composite: that has no
  // colormap to re-apply but does have three channels a click can read.
  if (layer.metadata.sourceKind === NETCDF_IMAGE_SOURCE_KIND) {
    return getNetcdfLayerState(layer.id) !== null;
  }

  return Array.isArray(layer.metadata.nativeLayerIds) && layer.metadata.nativeLayerIds.length > 0;
}
