import { resolveLayerCapabilities, useAppStore, type GeoLibreLayer } from "@geolibre/core";
import type { MapCanvasIdentifyEditActions } from "@geolibre/map";
import {
  canEditLayerGeometry,
  getGeometryEditTargetLayerId,
  isPluginEngineSupported,
  maplibreGeoEditorPlugin,
} from "@geolibre/plugins";
import { useMemo } from "react";
import {
  canEditAttributeValues,
  canOpenLayerAttributeTable,
} from "../../lib/attribute-table-source";

interface IdentifyEditActionsOptions {
  /** Collaboration's per-layer edit permission (always true when solo). */
  canEditLayer: (layerId: string) => boolean;
  /** Starts a geometry-edit session on the layer with the feature selected. */
  editFeatureGeometry: (layerId: string, featureId: string) => Promise<void>;
}

/**
 * Whether Identify offers Edit attributes for a layer: the table must open on
 * it, and its Edit button must be enabled (the shared gate).
 *
 * @param layer - The identified feature's layer.
 * @returns True when the attribute table would allow editing this layer.
 */
export function canEditLayerAttributes(layer: GeoLibreLayer): boolean {
  return (
    canOpenLayerAttributeTable(layer) &&
    canEditAttributeValues(layer, getGeometryEditTargetLayerId())
  );
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
  return useMemo(() => {
    const canEditGeometry = (layer: GeoLibreLayer) => {
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
    };
    const canEditAttributes = (layer: GeoLibreLayer) =>
      canEditLayer(layer.id) && canEditLayerAttributes(layer);
    // A popup can outlive the state it was built from (a permission change, a
    // geometry session started on another layer), so each action re-runs its
    // gate against the layer's current state when clicked.
    const currentLayer = (layerId: string) =>
      useAppStore.getState().layers.find((candidate) => candidate.id === layerId);
    return {
      canEditGeometry,
      canEditAttributes,
      editGeometry: ({ layer: target, featureId }) => {
        const layer = currentLayer(target.id);
        if (!layer || !canEditGeometry(layer)) return;
        const store = useAppStore.getState();
        store.selectLayer(layer.id);
        store.selectFeature(featureId);
        // Editing takes over map clicks, so Identify has to let go of them.
        store.setIdentifyLayer(null);
        void editFeatureGeometry(layer.id, featureId);
      },
      editAttributes: ({ layer: target, featureId }) => {
        const layer = currentLayer(target.id);
        if (!layer || !canEditAttributes(layer)) return;
        const store = useAppStore.getState();
        store.selectLayer(layer.id);
        store.selectFeature(featureId);
        store.requestAttributeTableEdit(layer.id);
      },
    } satisfies MapCanvasIdentifyEditActions;
  }, [canEditLayer, editFeatureGeometry]);
}
