import {
  DEFAULT_LAYER_STYLE,
  collectDiagramData,
  geojsonHasZCoordinates,
  isInitialLayerStyle,
  styleValue,
  type GeoLibreLayer,
} from "@geolibre/core";
import { countAtlasDroppedDiagrams } from "@geolibre/plugins";
import { useMemo } from "react";
import { getAttributePropertyNames } from "../../../lib/expression-inputs";
import { buildStyleSuggestions } from "../../../lib/style-suggestions";
import { getPropertyValues } from "../../../lib/vector-style-classification";
import {
  getGeometryFlags,
  isPointOnlyGeoJsonLayer,
  supportsPointRendererFor,
} from "./layer-capabilities";

/**
 * The Style panel's memoized per-feature scans of the selected layer: point
 * and geometry flags, style suggestions, diagram-loss notices, numeric
 * attribute candidates and Z-value support. Each is keyed on the fields it
 * reads so unrelated style edits never re-run a scan.
 *
 * @param layer - The selected layer, or undefined when none is selected.
 * @returns The scan results.
 */
export function useLayerFeatureScans(layer: GeoLibreLayer | undefined) {
  // Heatmap/cluster apply to point layers in two render paths: core GeoJSON
  // layers (drag-drop, processing results) and Add Vector Layer point layers in
  // the geojson render mode (the maplibre-gl-vector control renders those, so
  // type stays "geojson"; tile-rendered layers become "vector-tiles"). Memoize
  // the point-only scan so a large layer isn't re-scanned on every panel render.
  // Must run before the early returns below so the hook order stays stable.
  const isPointOnly = useMemo(() => (layer ? isPointOnlyGeoJsonLayer(layer) : false), [layer]);
  // Memoized so the per-feature geometry scan (up to 2000 features) does not
  // re-run on every render, e.g. while typing in a rule filter textarea. Kept
  // before the early returns below so the hook order stays stable.
  const geometryFlags = useMemo(
    () => (layer ? getGeometryFlags(layer) : { hasPoint: true, hasLine: true, hasPolygon: true }),
    [layer],
  );
  // Style suggestions (#1519). The candidate scan reads every feature's
  // properties, so it is memoized alongside the other per-feature scans rather
  // than re-run on every panel render (an opacity drag, a zoom-range edit).
  // Kept before the early returns below so the hook order stays stable.
  //
  // isInitialLayerStyle is the gate: a layer only gets suggestions while it
  // still wears exactly what it was added with. The renderer mode alone would
  // let an edited fill or a restored project keep being offered advice.
  //
  // Deliberately NOT keyed on `layer`: that is `layers.find(...)`, and every
  // `updateLayer` patch (an opacity drag, a rename, a zoom-range edit) rebuilds
  // the layer object, so a `[layer]` dependency would re-scan on exactly the
  // interactions this memo exists to survive. The fields below are the only
  // ones the call actually reads, and each keeps its identity across an
  // unrelated patch.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const styleSuggestions = useMemo(() => {
    if (!layer || !isInitialLayerStyle(layer.style, layer.geojson)) return [];
    return buildStyleSuggestions(layer, getAttributePropertyNames(layer), {
      // Reuse the memo above rather than re-scanning: supportsPointRendererFor
      // takes `pointOnly` precisely so the caller can.
      supportsPointRenderer: supportsPointRendererFor(layer, isPointOnly),
    });
  }, [layer?.id, layer?.type, layer?.style, layer?.geojson, layer?.metadata, isPointOnly]);
  // Diagram-loss notices: whether the feature cap truncates the drawable
  // dataset (derived from the real scan — features without an anchor or a
  // positive value don't consume the cap, so the raw count alone would
  // false-positive), and whether the icon atlas drops diagrams that don't fit
  // its height/texture bound (e.g. a large diagram size on many features).
  // Dependencies are the geojson and the specific diagram style fields (not
  // the layer object, which is recreated on every style edit) so unrelated
  // panel edits never re-run the feature scan. Kept before the early returns
  // below so the hook order stays stable.
  const diagramGeojson = layer?.geojson;
  const diagramStyleType = layer ? styleValue(layer.style, "diagramType") : "none";
  const diagramStyleFields = layer
    ? styleValue(layer.style, "diagramFields")
    : DEFAULT_LAYER_STYLE.diagramFields;
  const diagramStyleSizeMode = layer
    ? styleValue(layer.style, "diagramSizeMode")
    : DEFAULT_LAYER_STYLE.diagramSizeMode;
  const diagramStyleSize = layer
    ? styleValue(layer.style, "diagramSize")
    : DEFAULT_LAYER_STYLE.diagramSize;
  const diagramStyleSizeProperty = layer ? styleValue(layer.style, "diagramSizeProperty") : "";
  const { diagramTruncated, diagramDrawnCount, diagramAtlasDropped } = useMemo(() => {
    if (!layer || !diagramGeojson || diagramStyleType === "none") {
      return {
        diagramTruncated: false,
        diagramDrawnCount: 0,
        diagramAtlasDropped: 0,
      };
    }
    // One shared scan feeds both notices; countAtlasDroppedDiagrams reuses it
    // instead of rescanning the features.
    const diagramData = collectDiagramData(diagramGeojson, layer.style);
    return {
      diagramTruncated: diagramData.truncated,
      // The notice reports the count actually charted: truncation can come
      // from either the draw cap or the raw-scan cap, so the drawn count is
      // the only number that is accurate in both cases.
      diagramDrawnCount: diagramData.data.length,
      diagramAtlasDropped: countAtlasDroppedDiagrams(
        { geojson: diagramGeojson, style: layer.style },
        diagramData,
      ),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- layer.style is
    // intentionally represented by the specific diagram fields below.
  }, [
    diagramGeojson,
    diagramStyleType,
    diagramStyleFields,
    diagramStyleSizeMode,
    diagramStyleSize,
    diagramStyleSizeProperty,
  ]);
  // Numeric-attribute candidates for the diagram and geometry-generator field
  // pickers. Unlike graduated classification (which needs a value spread), one
  // finite value qualifies. Both consumers only exist on layers that carry a
  // local `geojson`, so scanning it directly (rather than the tiled sampling
  // the proportional-size picker needs) is enough. Memoized on the
  // geojson/metadata (not the layer object) so unrelated panel edits never
  // re-run the per-property feature scans. Kept before the early returns below
  // so the hook order stays stable.
  const diagramMetadata = layer?.metadata;
  const numericPropertyOptions = useMemo(() => {
    if (!diagramGeojson) return [];
    const probe = { geojson: diagramGeojson, metadata: diagramMetadata ?? {} };
    return getAttributePropertyNames(probe).filter((property) =>
      getPropertyValues(probe, property).some((value) => {
        // Blank strings coerce to 0 via Number(""), which would qualify a
        // text column that merely has an empty cell somewhere; require an
        // actual number or a non-blank numeric string.
        if (typeof value === "number") return Number.isFinite(value);
        return typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value));
      }),
    );
  }, [diagramGeojson, diagramMetadata]);
  // Whether the layer's coordinates carry real Z values (e.g. GPX track
  // elevations), which unlocks the "3D (Z values)" visualization mode.
  // Memoized on the geojson reference (not the layer object, which is
  // recreated on every style edit) because the scan touches every coordinate
  // when no Z is present. Kept before the early returns below so the hook
  // order stays stable.
  const supportsElevation3d = useMemo(
    () =>
      layer?.type === "geojson" && layer.geojson ? geojsonHasZCoordinates(layer.geojson) : false,
    [layer?.type, layer?.geojson],
  );

  return {
    isPointOnly,
    geometryFlags,
    styleSuggestions,
    diagramTruncated,
    diagramDrawnCount,
    diagramAtlasDropped,
    numericPropertyOptions,
    supportsElevation3d,
  };
}
