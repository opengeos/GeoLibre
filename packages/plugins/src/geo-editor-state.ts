import { isDuckDBQueryLayer, SQL_QUERY_SOURCE_KIND, type GeoLibreLayer } from "@geolibre/core";

type Native = typeof import("./plugins/maplibre-geo-editor");
type GeoEditorRuntime = Pick<
  Native,
  | "getGeometryEditTargetLayerId"
  | "getLastGeometryEditEnd"
  | "isGeoEditorUsingRightClick"
  | "subscribeGeometryEdit"
  | "startLayerGeometryEdit"
  | "selectGeometryEditFeature"
  | "endLayerGeometryEdit"
  | "isGeoEditorAvailableForImport"
  | "addFeatureToGeoEditor"
  | "getGeoEditorFeatureCount"
  | "hasViewImportBaseline"
  | "loadViewFeaturesIntoEditor"
  | "buildEditorSaveCollection"
>;
let runtime: GeoEditorRuntime | undefined;
let disconnect: (() => void) | undefined;
const listeners = new Set<() => void>();
function notify(): void {
  for (const listener of listeners) {
    try {
      listener();
    } catch (error) {
      console.error("A geometry edit session listener failed:", error);
    }
  }
}

/** Connect host observers after either a catalog or direct SDK import. */
export function provideGeoEditorRuntime(provider: GeoEditorRuntime): void {
  if (provider === runtime) return;
  disconnect?.();
  runtime = provider;
  disconnect = provider.subscribeGeometryEdit(notify);
  notify();
}

export const getGeometryEditTargetLayerId: Native["getGeometryEditTargetLayerId"] = () =>
  runtime?.getGeometryEditTargetLayerId() ?? null;
export const getLastGeometryEditEnd: Native["getLastGeometryEditEnd"] = () =>
  runtime?.getLastGeometryEditEnd() ?? null;
export const isGeoEditorUsingRightClick: Native["isGeoEditorUsingRightClick"] = () =>
  runtime?.isGeoEditorUsingRightClick() ?? false;
export const isGeoEditorAvailableForImport: Native["isGeoEditorAvailableForImport"] = () =>
  runtime?.isGeoEditorAvailableForImport() ?? false;
export const getGeoEditorFeatureCount: Native["getGeoEditorFeatureCount"] = () =>
  runtime?.getGeoEditorFeatureCount() ?? 0;
export const hasViewImportBaseline: Native["hasViewImportBaseline"] = () =>
  runtime?.hasViewImportBaseline() ?? false;
export const buildEditorSaveCollection: Native["buildEditorSaveCollection"] = (...args) =>
  runtime?.buildEditorSaveCollection(...args) ?? null;
export const selectGeometryEditFeature: Native["selectGeometryEditFeature"] = (...args) =>
  runtime?.selectGeometryEditFeature(...args) ?? false;
export const startLayerGeometryEdit: Native["startLayerGeometryEdit"] = (...args) =>
  runtime?.startLayerGeometryEdit(...args) ?? Promise.resolve(false);
export const endLayerGeometryEdit: Native["endLayerGeometryEdit"] = (...args) =>
  runtime?.endLayerGeometryEdit(...args) ?? Promise.resolve();
export const addFeatureToGeoEditor: Native["addFeatureToGeoEditor"] = (...args) =>
  runtime?.addFeatureToGeoEditor(...args) ?? Promise.resolve(false);
export const loadViewFeaturesIntoEditor: Native["loadViewFeaturesIntoEditor"] = async (...args) => {
  if (!runtime) throw new Error("The GeoEditor is not active.");
  return runtime.loadViewFeaturesIntoEditor(...args);
};
export const subscribeGeometryEdit: Native["subscribeGeometryEdit"] = (listener) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
export type { GeometryEditEnd } from "./plugins/maplibre-geo-editor";

/** Metadata sourceKind marking the editor Sketches layer. */
export const SKETCHES_SOURCE_KIND = "geoeditor-sketches";

/**
 * Whether a layer's geometry can be edited in place. Only geojson-mode vector
 * layers qualify ("vector-tiles" / DuckDB-tiles layers do not). DuckDB query
 * layers are excluded and must be materialized to an editable GeoJSON copy
 * first. Add-Vector-Layer geojson-mode layers ARE included: their features live
 * in a MapLibre GeoJSON source and are read back (via the caller's
 * `ensureLayerGeojsonFromSource`) before editing begins.
 *
 * @param layer The candidate layer, or undefined.
 * @returns True when the layer's geometry can be edited in place.
 */
export function canEditLayerGeometry(layer: GeoLibreLayer | undefined): boolean {
  if (!layer) return false;
  if (layer.capabilities?.update === false) return false;
  // Only geojson-mode vector layers; "vector-tiles" (DuckDB tiles) are excluded.
  if (layer.type !== "geojson") return false;
  if (isDuckDBQueryLayer(layer)) return false;
  if (layer.metadata.sourceKind === SKETCHES_SOURCE_KIND) return false;
  // A query result is derived, not writable: refresh re-runs the stored SQL
  // and would overwrite any in-place edits. Load a copy into the editor (or
  // export) to edit the features.
  if (layer.metadata.sourceKind === SQL_QUERY_SOURCE_KIND) return false;

  if (layer.metadata.externalNativeLayer === true) {
    // Externally-rendered layers are only editable when they are Add-Vector-Layer
    // geojson-mode layers, whose features live in a MapLibre GeoJSON source that
    // can be read and written back. Require a usable source id (a non-empty
    // string), otherwise there is nothing to hydrate from or write back to.
    const sourceIds = layer.metadata.sourceIds;
    return (
      layer.metadata.sourceKind === "maplibre-gl-vector" &&
      Array.isArray(sourceIds) &&
      typeof sourceIds[0] === "string" &&
      sourceIds[0].length > 0
    );
  }

  // Plain in-memory geojson layers carry their features in `layer.geojson`.
  return Array.isArray(layer.geojson?.features);
}

export let geoEditorFileTools = true;

/**
 * Show or hide the toolbar's Open/Save GeoJSON file buttons. The host turns
 * them off in the read-only viewer, where they would import and export data
 * around the deployment's capability gates. Read at construction, so it
 * applies the next time the plugin is activated.
 */
export function setGeoEditorFileTools(enabled: boolean): void {
  geoEditorFileTools = enabled;
}
