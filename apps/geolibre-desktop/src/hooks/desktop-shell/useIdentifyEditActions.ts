import {
  isDuckDBQueryLayer,
  resolveLayerCapabilities,
  useAppStore,
  type GeoLibreLayer,
} from "@geolibre/core";
import type { MapCanvasIdentifyEditActions } from "@geolibre/map";
import {
  canEditLayerGeometry,
  getGeometryEditTargetLayerId,
  isPluginEngineSupported,
  maplibreGeoEditorPlugin,
} from "@geolibre/plugins";
import { useMemo } from "react";
import {
  canOpenLayerAttributeTable,
  isVectorControlAttributeSource,
} from "../../lib/attribute-table-source";
import { geojsonVectorSourceId } from "../../lib/vector-export";

interface IdentifyEditActionsOptions {
  /** Collaboration's per-layer edit permission (always true when solo). */
  canEditLayer: (layerId: string) => boolean;
  /** Starts a geometry-edit session on the layer with the feature selected. */
  editFeatureGeometry: (layerId: string, featureId: string) => Promise<void>;
}

/**
 * Whether a layer's attribute values can be edited in the attribute table.
 * Mirrors the table's own Edit-button gate, so Identify never offers an action
 * that lands on a disabled button.
 *
 * @param layer - The identified feature's layer.
 * @returns True when the attribute table would allow editing this layer.
 */
export function canEditLayerAttributes(layer: GeoLibreLayer): boolean {
  if (!canOpenLayerAttributeTable(layer)) return false;
  const caps = resolveLayerCapabilities(layer);
  if (!caps.update) return false;
  if (!layer.geojson && !isDuckDBQueryLayer(layer)) return false;
  // Add Vector Layer layers render from a source the control owns, so the
  // table keeps them read-only.
  if (geojsonVectorSourceId(layer) !== null || isVectorControlAttributeSource(layer)) return false;
  // The table disables attribute edits while the layer's geometry is edited.
  return getGeometryEditTargetLayerId() !== layer.id;
}

/**
 * The Edit geometry / Edit attributes actions offered on Identify results
 * (#2932): each one selects the feature and opens the matching editor.
 *
 * @param options - The collaboration edit gate and the geometry-edit starter.
 * @returns The actions object for the map canvases.
 */
export function useIdentifyEditActions({
  canEditLayer,
  editFeatureGeometry,
}: IdentifyEditActionsOptions): MapCanvasIdentifyEditActions {
  return useMemo(
    () => ({
      canEditGeometry: (layer) => {
        const target = getGeometryEditTargetLayerId();
        return (
          canEditLayerGeometry(layer) &&
          resolveLayerCapabilities(layer).update &&
          canEditLayer(layer.id) &&
          // The layer menu disables Edit geometry while another layer is in
          // an edit session; the popup follows it.
          (target === null || target === layer.id) &&
          isPluginEngineSupported(maplibreGeoEditorPlugin, useAppStore.getState().primaryRenderer)
        );
      },
      canEditAttributes: (layer) => canEditLayer(layer.id) && canEditLayerAttributes(layer),
      // A popup can outlive a permission change, so recheck at click time.
      editGeometry: ({ layer, featureId }) => {
        if (!canEditLayer(layer.id)) return;
        const store = useAppStore.getState();
        store.selectLayer(layer.id);
        store.selectFeature(featureId);
        // Editing takes over map clicks, so Identify has to let go of them.
        store.setIdentifyLayer(null);
        void editFeatureGeometry(layer.id, featureId);
      },
      editAttributes: ({ layer, featureId }) => {
        if (!canEditLayer(layer.id)) return;
        const store = useAppStore.getState();
        store.selectLayer(layer.id);
        store.selectFeature(featureId);
        // A table filter could hide the row this action opens.
        store.setAttributeFilter("");
        store.requestAttributeTableEdit(layer.id);
      },
    }),
    [canEditLayer, editFeatureGeometry],
  );
}
