import {
  effectiveLayerRenderState,
  styleValue,
  type GeoLibreLayer,
  type LayerGroup,
} from "@geolibre/core";
import type { Map as MapLibreMap } from "maplibre-gl";

export function screenshotReadinessEnabled(search: string): boolean {
  const params = new URLSearchParams(search);
  return (
    params.has("loading") &&
    ["", "true", "1", "yes", "on"].includes(params.get("loading")!.trim().toLowerCase())
  );
}

export interface LayerLoadProbe {
  raster: (id: string) => {
    loading: boolean;
    error: string | null;
    native: boolean;
    deckTracked: boolean;
  };
  deck: (id: string) => { found: boolean; loading: boolean; error: string | null };
}

/**
 * Whether `nativeId` is a native layer this store layer draws under, named by
 * deriving from its own id.
 *
 * Renderers that own their MapLibre layers name them `<layer id>-<suffix>` with
 * a generated suffix — the Time Slider's client-rendered mosaics come through as
 * `acdom-mosaic-xra0fk3`, for instance. Those ids cannot be predicted when the
 * mirrored store layer is built, so `metadata.nativeLayerIds` still records only
 * the store id and the exact-match checks all miss.
 *
 * A bare prefix test would let `acdom` claim `acdom-2`'s layers, so a candidate
 * is rejected when another store layer's id is a longer prefix of it — that
 * layer is the real owner.
 */
function ownsDerivedNativeLayer(
  layerId: string,
  nativeId: string,
  layers: GeoLibreLayer[],
): boolean {
  if (!nativeId.startsWith(`${layerId}-`)) return false;
  return !layers.some(
    (other) => other.id.length > layerId.length && nativeId.startsWith(`${other.id}-`),
  );
}

/** Never infer readiness from a saved layer entry or from a custom layer's mere presence. */
export function inspectScreenshotLayers(
  map: MapLibreMap,
  layers: GeoLibreLayer[],
  groups: LayerGroup[],
  probe: LayerLoadProbe,
): { pending: string[]; errors: string[] } {
  const pending: string[] = [];
  const errors: string[] = [];
  // getStyle() serializes sources (potentially large embedded GeoJSON).
  const nativeLayers = map.getLayersOrder().flatMap((id) => {
    const native = map.getLayer(id);
    return native ? [native] : [];
  });
  const zoom = map.getZoom();
  for (const layer of layers) {
    const effective = effectiveLayerRenderState(layer, groups);
    if (!effective.visible || effective.opacity === 0) continue;
    if (zoom < styleValue(layer.style, "minZoom") || zoom >= styleValue(layer.style, "maxZoom"))
      continue;
    if (typeof layer.metadata.error === "string") {
      errors.push(`${layer.name}: ${layer.metadata.error}`);
      continue;
    }
    const isRaster = layer.metadata.sourceKind === "maplibre-gl-raster";
    let requiresDeck = false;
    if (isRaster) {
      const raster = probe.raster(layer.id);
      if (raster.error) {
        errors.push(`${layer.name}: ${raster.error}`);
        continue;
      }
      if (raster.loading) {
        pending.push(layer.name);
        continue;
      }
      // A raster is either drawn as a native MapLibre layer (checked below), or
      // by deck.gl. Only the interleaved deck path registers with the shared
      // overlay; the overlaid one (Tauri) owns a private deck canvas the probe
      // cannot see, so the control's own state above is all the evidence there
      // is -- requiring a deck entry would leave it pending forever.
      if (!raster.native && !raster.deckTracked) continue;
      requiresDeck = raster.deckTracked;
    }
    const deck = probe.deck(layer.id);
    if (deck.found) {
      if (deck.error) errors.push(`${layer.name}: ${deck.error}`);
      else if (deck.loading) pending.push(layer.name);
      continue;
    }
    if (requiresDeck) {
      pending.push(layer.name);
      continue;
    }
    // deck-viz layers register with the shared overlay under their own layer id,
    // so the probe above IS their readiness check. Reaching here means the
    // overlay built no deck layer for this one, which is a broken/unsupported
    // configuration rather than a rendered layer -- fail closed, but say so
    // accurately.
    if (layer.type === "deckgl-viz") {
      errors.push(`${layer.name}: no deck.gl output was built for this layer`);
      continue;
    }
    // Streaming/custom renderers need their own probe. Fail closed instead of
    // returning ready for an idle basemap while a point cloud is still fetching.
    if (["lidar", "3d-tiles", "gaussian-splat", "zarr", "video"].includes(layer.type)) {
      errors.push(`${layer.name}: screenshot readiness is not supported for ${layer.type}`);
      continue;
    }
    const ids = Array.isArray(layer.metadata.nativeLayerIds) ? layer.metadata.nativeLayerIds : [];
    const rendered = nativeLayers.filter(
      (item) =>
        ids.includes(item.id) ||
        item.id === layer.id ||
        item.id.startsWith(`layer-${layer.id}-`) ||
        ownsDerivedNativeLayer(layer.id, item.id, layers),
    );
    if (rendered.length === 0) {
      pending.push(layer.name);
      continue;
    }
    if (rendered.some((item) => item.type === "custom")) {
      errors.push(`${layer.name}: screenshot readiness is not supported for this custom renderer`);
      continue;
    }
    if (
      rendered.some(
        (item) =>
          "source" in item && (!map.getSource(item.source) || !map.isSourceLoaded(item.source)),
      )
    )
      pending.push(layer.name);
  }
  return { pending, errors };
}
