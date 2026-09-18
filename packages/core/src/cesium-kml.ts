import { DEFAULT_LAYER_STYLE, type GeoLibreLayer } from "./types";

/** Native KML/KMZ documents retain their own styling on the globe. */
export const CESIUM_KML_SOURCE_KIND = "cesium-kml";

export function isCesiumKmlLayer(layer: Pick<GeoLibreLayer, "metadata">): boolean {
  return layer.metadata?.sourceKind === CESIUM_KML_SOURCE_KIND;
}

export interface CesiumKmlLayerOptions {
  id?: string;
  name: string;
  /** HTTP(S) KML or KMZ URL. Relative resources resolve against this URL. */
  url?: string;
  /** Inline XML, or a KMZ data URL so local archives survive project saves. */
  data?: string;
  sourcePath?: string;
}

export function cesiumKmlSource(layer: Pick<GeoLibreLayer, "source" | "metadata">): string | null {
  if (!isCesiumKmlLayer(layer)) return null;
  for (const value of [layer.source.kmlData, layer.source.url]) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

export function createCesiumKmlLayer(options: CesiumKmlLayerOptions): GeoLibreLayer {
  const data = options.data?.trim();
  const url = options.url?.trim();
  if (!data && !url) throw new Error("Provide a KML/KMZ document or URL.");
  const id = options.id ?? crypto.randomUUID();
  return {
    id,
    name: options.name,
    type: "3d-tiles",
    ...(options.sourcePath ? { sourcePath: options.sourcePath } : {}),
    source: { type: "3d-tiles", sourceId: id, ...(data ? { kmlData: data } : { url }) },
    visible: true,
    opacity: 1,
    style: { ...DEFAULT_LAYER_STYLE },
    metadata: {
      sourceKind: CESIUM_KML_SOURCE_KIND,
      externalNativeLayer: true,
      identifiable: false,
    },
  };
}
