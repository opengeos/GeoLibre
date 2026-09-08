import { DEFAULT_LAYER_STYLE, type GeoLibreLayer } from "./types";

// Cesium Ion assets (issue #2290): 3D Tiles and imagery referenced by Ion
// asset id rather than by URL. The globe loads them natively through the Ion
// token the app already holds for World Terrain; the 2D map has no equivalent,
// so these layers are flagged "3D only" there and never painted.

/** `metadata.sourceKind` of a layer that references a Cesium Ion asset. */
export const CESIUM_ION_SOURCE_KIND = "cesium-ion";

/** What an Ion asset id resolves to on the globe. */
export type CesiumIonAssetKind = "3d-tiles" | "imagery";

/** Cesium OSM Buildings, the one-click 3D Tiles asset every Ion account can use. */
export const CESIUM_OSM_BUILDINGS_ASSET_ID = 96188;

/** Bing Maps Aerial through Ion, the imagery asset every Ion account can use. */
export const CESIUM_WORLD_IMAGERY_ASSET_ID = 2;

/** Ion assets offered as one-click picks in the Add Data dialog. */
export const CESIUM_ION_QUICK_PICKS: ReadonlyArray<{
  assetId: number;
  kind: CesiumIonAssetKind;
  name: string;
}> = [
  { assetId: CESIUM_OSM_BUILDINGS_ASSET_ID, kind: "3d-tiles", name: "Cesium OSM Buildings" },
  { assetId: CESIUM_WORLD_IMAGERY_ASSET_ID, kind: "imagery", name: "Bing Maps Aerial (Ion)" },
];

/** Parse an Ion asset id the way the Add Data form and the project file carry it. */
export function parseCesiumIonAssetId(value: unknown): number | null {
  const id = typeof value === "string" ? Number(value.trim()) : value;
  return typeof id === "number" && Number.isInteger(id) && id > 0 ? id : null;
}

/**
 * The Ion asset id a layer references, or null when the layer is not an Ion
 * asset layer (or carries no usable id).
 */
export function cesiumIonAssetId(layer: Pick<GeoLibreLayer, "source" | "metadata">): number | null {
  if (layer.metadata?.sourceKind !== CESIUM_ION_SOURCE_KIND) return null;
  return parseCesiumIonAssetId(layer.source?.ionAssetId);
}

/** Whether `layer` references a Cesium Ion asset. */
export function isCesiumIonLayer(layer: Pick<GeoLibreLayer, "source" | "metadata">): boolean {
  return cesiumIonAssetId(layer) !== null;
}

/** What the Ion asset draws as: a tileset primitive or an imagery layer. */
export function cesiumIonAssetKind(layer: Pick<GeoLibreLayer, "type">): CesiumIonAssetKind {
  return layer.type === "3d-tiles" ? "3d-tiles" : "imagery";
}

/**
 * Whether only the 3D globe can render `layer`: the mirror of the globe's
 * `isCesiumSupportedLayerType`, for the Layers panel to badge on the 2D map.
 */
export function isCesiumOnlyLayer(layer: Pick<GeoLibreLayer, "source" | "metadata">): boolean {
  return isCesiumIonLayer(layer);
}

function newLayerId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export interface CesiumIonLayerOptions {
  id?: string;
  name: string;
  assetId: number;
  kind: CesiumIonAssetKind;
  /** Metres to shift a tileset vertically; ignored for imagery. */
  altitudeOffset?: number;
}

/**
 * Build the store layer for a Cesium Ion asset. A tileset is a `3d-tiles`
 * layer whose `sourceKind` keeps it out of the 2D deck.gl control; imagery is
 * a `raster` layer with no tiles, marked external so the 2D sync leaves it
 * alone. Both persist only the asset id: the token is runtime configuration.
 */
export function createCesiumIonLayer(options: CesiumIonLayerOptions): GeoLibreLayer {
  const id = options.id ?? newLayerId();
  const isTileset = options.kind === "3d-tiles";
  const altitudeOffset = Number.isFinite(options.altitudeOffset) ? options.altitudeOffset! : 0;
  return {
    id,
    name: options.name,
    type: isTileset ? "3d-tiles" : "raster",
    source: {
      type: isTileset ? "3d-tiles" : "raster",
      ionAssetId: options.assetId,
      sourceId: id,
      ...(isTileset ? { altitudeOffset } : {}),
    },
    visible: true,
    opacity: 1,
    style: { ...DEFAULT_LAYER_STYLE },
    metadata: {
      sourceKind: CESIUM_ION_SOURCE_KIND,
      externalNativeLayer: true,
      identifiable: false,
      sourceId: id,
      nativeLayerIds: [id],
      ...(isTileset ? { customLayerType: "3d-tiles", altitudeOffset } : {}),
    },
  };
}
