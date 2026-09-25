import {
  DEFAULT_LAYER_STYLE,
  styleValue,
  useAppStore,
  type GeoLibreLayer,
  type VectorStyleMode,
  type VectorStyleStop,
} from "@geolibre/core";
import { getVectorLayerPropertyValues } from "@geolibre/plugins";
import type { MapEngine } from "@geolibre/map";
import { type RefObject, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  loadedVectorTileFeatures,
  vectorTileMap,
} from "../../../hooks/useVectorTileGeometryBackfill";
import { proportionalSizeBounds } from "../../../lib/vector-style-classification";
import {
  completeCategorizedValueCount,
  createDefaultStops,
  normalizeClassificationScheme,
  normalizeVectorStyleClassCount,
} from "./classification-helpers";

/**
 * How long to wait for a tiled source to produce features before reporting its
 * attributes as unavailable. A tiled layer whose data sits outside the viewport
 * never yields a sample, and the map may already be idle, so the wait has to be
 * bounded in wall-clock time rather than in retries.
 */
const VECTOR_TILE_SAMPLE_TIMEOUT_MS = 6000;

/**
 * Per-layer draft state for the Style panel: the unapplied vector symbology
 * and extrusion edits, the insert-below selection, the attribute samples that
 * classification and proportional sizing read for tiled layers, and the
 * section error messages. Every field re-seeds from the selected layer when it
 * changes, so the state lives here (above the panel's early returns and its
 * per-renderer sections) rather than in a section that could unmount.
 *
 * @param layer - The selected layer, or undefined when none is selected.
 * @param mapControllerRef - The map engine, read to sample loaded tiles.
 * @returns The draft values, their setters and the derived category counts.
 */
export function useStylePanelDrafts(
  layer: GeoLibreLayer | undefined,
  mapControllerRef: RefObject<MapEngine | null>,
) {
  const setLayerStyle = useAppStore((s) => s.setLayerStyle);
  const [draftBeforeId, setDraftBeforeId] = useState("");
  const [showBasemapStyleLayers, setShowBasemapStyleLayers] = useState(false);
  const [draftColorExpression, setDraftColorExpression] = useState("");
  const [draftHeightExpression, setDraftHeightExpression] = useState("");
  const [draftVectorStyleMode, setDraftVectorStyleMode] = useState<VectorStyleMode>(
    DEFAULT_LAYER_STYLE.vectorStyleMode,
  );
  const [draftVectorStyleProperty, setDraftVectorStyleProperty] = useState(
    DEFAULT_LAYER_STYLE.vectorStyleProperty,
  );
  const [draftVectorStyleClassCount, setDraftVectorStyleClassCount] = useState(
    DEFAULT_LAYER_STYLE.vectorStyleClassCount,
  );
  // "All categories" is a draft-only selection: the applied style records the
  // class count it resolved to, so the panel seeds this flag from that count and
  // then keeps it as the source of truth. Re-deriving it from
  // `classCount === categorizedValueCount` would confuse "All" with a literal
  // count that happens to match, and the two behave differently once the
  // attribute changes underneath them.
  const [draftVectorStyleAllCategories, setDraftVectorStyleAllCategories] = useState(false);
  const [draftVectorStyleColorRamp, setDraftVectorStyleColorRamp] = useState(
    DEFAULT_LAYER_STYLE.vectorStyleColorRamp,
  );
  const [draftVectorStyleClassificationScheme, setDraftVectorStyleClassificationScheme] = useState(
    DEFAULT_LAYER_STYLE.vectorStyleClassificationScheme,
  );
  const [draftVectorStyleStops, setDraftVectorStyleStops] = useState<VectorStyleStop[]>(
    DEFAULT_LAYER_STYLE.vectorStyleStops,
  );
  const [draftVectorStyleExpression, setDraftVectorStyleExpression] = useState(
    DEFAULT_LAYER_STYLE.vectorStyleExpression,
  );
  const [draftExtrusionColor, setDraftExtrusionColor] = useState(
    DEFAULT_LAYER_STYLE.extrusionColor,
  );
  const [draftExtrusionOpacity, setDraftExtrusionOpacity] = useState(
    DEFAULT_LAYER_STYLE.extrusionOpacity,
  );
  const [draftExtrusionHeightProperty, setDraftExtrusionHeightProperty] = useState(
    DEFAULT_LAYER_STYLE.extrusionHeightProperty,
  );
  const [draftExtrusionHeightScale, setDraftExtrusionHeightScale] = useState(
    DEFAULT_LAYER_STYLE.extrusionHeightScale,
  );
  const [draftExtrusionBase, setDraftExtrusionBase] = useState(DEFAULT_LAYER_STYLE.extrusionBase);
  const [draftAdvancedExtrusionEnabled, setDraftAdvancedExtrusionEnabled] = useState(
    DEFAULT_LAYER_STYLE.extrusionAdvancedStyleEnabled,
  );
  const [vectorStyleError, setVectorStyleError] = useState<string | null>(null);
  const [extrusionError, setExtrusionError] = useState<string | null>(null);
  const [proportionalSizeError, setProportionalSizeError] = useState<string | null>(null);
  // Tracks auto-seeded proportional min/max so later tile samples can refine the
  // range without overwriting a user's intentional 0–100 (or other) edit.
  const seededProportionalBoundsRef = useRef<{
    key: string;
    min: number;
    max: number;
  } | null>(null);
  const [loadedVectorPropertyValues, setLoadedVectorPropertyValues] = useState<{
    layerId: string;
    /** Attribute samples keyed by property name (classification and/or size field). */
    byProperty: Record<string, unknown[]>;
  } | null>(null);
  const [vectorPropertyValuesLoading, setVectorPropertyValuesLoading] = useState(false);
  const [vectorPropertyValuesUnavailable, setVectorPropertyValuesUnavailable] = useState(false);

  useEffect(() => {
    if (!layer) {
      setDraftBeforeId("");
      setDraftColorExpression("");
      setDraftHeightExpression("");
      setDraftVectorStyleMode(DEFAULT_LAYER_STYLE.vectorStyleMode);
      setDraftVectorStyleProperty(DEFAULT_LAYER_STYLE.vectorStyleProperty);
      setDraftVectorStyleClassCount(DEFAULT_LAYER_STYLE.vectorStyleClassCount);
      setDraftVectorStyleAllCategories(false);
      setDraftVectorStyleColorRamp(DEFAULT_LAYER_STYLE.vectorStyleColorRamp);
      setDraftVectorStyleClassificationScheme(DEFAULT_LAYER_STYLE.vectorStyleClassificationScheme);
      setDraftVectorStyleStops(DEFAULT_LAYER_STYLE.vectorStyleStops);
      setDraftVectorStyleExpression(DEFAULT_LAYER_STYLE.vectorStyleExpression);
      setDraftExtrusionColor(DEFAULT_LAYER_STYLE.extrusionColor);
      setDraftExtrusionOpacity(DEFAULT_LAYER_STYLE.extrusionOpacity);
      setDraftExtrusionHeightProperty(DEFAULT_LAYER_STYLE.extrusionHeightProperty);
      setDraftExtrusionHeightScale(DEFAULT_LAYER_STYLE.extrusionHeightScale);
      setDraftExtrusionBase(DEFAULT_LAYER_STYLE.extrusionBase);
      setDraftAdvancedExtrusionEnabled(DEFAULT_LAYER_STYLE.extrusionAdvancedStyleEnabled);
      setVectorStyleError(null);
      setExtrusionError(null);
      return;
    }

    setDraftBeforeId(layer.beforeId ?? "");
    setDraftColorExpression(styleValue(layer.style, "extrusionColorExpression"));
    setDraftHeightExpression(styleValue(layer.style, "extrusionHeightExpression"));
    const vectorStyleMode = styleValue(layer.style, "vectorStyleMode");
    setDraftVectorStyleMode(vectorStyleMode);
    const vectorStyleProperty = styleValue(layer.style, "vectorStyleProperty");
    setDraftVectorStyleProperty(vectorStyleProperty);
    const vectorStyleClassCount = normalizeVectorStyleClassCount(
      vectorStyleMode,
      styleValue(layer.style, "vectorStyleClassCount"),
    );
    setDraftVectorStyleClassCount(vectorStyleClassCount);
    // Values that load asynchronously are not available yet, so a re-opened
    // panel recognizes "All" only for layers whose features are already in the
    // store — elsewhere the resolved number stays selected until the user picks
    // "All" again.
    setDraftVectorStyleAllCategories(
      vectorStyleMode === "categorized" &&
        vectorStyleClassCount ===
          completeCategorizedValueCount(layer, vectorStyleProperty, undefined),
    );
    setDraftVectorStyleColorRamp(styleValue(layer.style, "vectorStyleColorRamp"));
    setDraftVectorStyleClassificationScheme(
      normalizeClassificationScheme(
        vectorStyleMode,
        styleValue(layer.style, "vectorStyleClassificationScheme"),
      ),
    );
    setDraftVectorStyleStops(styleValue(layer.style, "vectorStyleStops"));
    setDraftVectorStyleExpression(styleValue(layer.style, "vectorStyleExpression"));
    setDraftExtrusionColor(styleValue(layer.style, "extrusionColor"));
    setDraftExtrusionOpacity(styleValue(layer.style, "extrusionOpacity"));
    setDraftExtrusionHeightProperty(styleValue(layer.style, "extrusionHeightProperty"));
    setDraftExtrusionHeightScale(styleValue(layer.style, "extrusionHeightScale"));
    setDraftExtrusionBase(styleValue(layer.style, "extrusionBase"));
    setDraftAdvancedExtrusionEnabled(styleValue(layer.style, "extrusionAdvancedStyleEnabled"));
    setVectorStyleError(null);
    setExtrusionError(null);
  }, [
    layer?.beforeId,
    layer?.id,
    layer?.style.extrusionAdvancedStyleEnabled,
    layer?.style.extrusionBase,
    layer?.style.extrusionColor,
    layer?.style.extrusionColorExpression,
    layer?.style.extrusionHeightProperty,
    layer?.style.extrusionHeightExpression,
    layer?.style.extrusionHeightScale,
    layer?.style.extrusionOpacity,
    layer?.style.vectorStyleExpression,
    layer?.style.vectorStyleClassCount,
    layer?.style.vectorStyleClassificationScheme,
    layer?.style.vectorStyleColorRamp,
    layer?.style.vectorStyleMode,
    layer?.style.vectorStyleProperty,
    layer?.style.vectorStyleStops,
  ]);

  // Add Vector Layer keeps large tiled datasets in DuckDB instead of copying
  // their geometry into the app store. Read only the selected attribute(s) when
  // classification or proportional sizing needs values, so categorized /
  // graduated styling and size-by-value remain available without defeating
  // tiled rendering. Classification and size fields are sampled together when
  // they differ so proportional min/max can still seed from field B while
  // graduated colors load field A.
  useEffect(() => {
    if (!layer) return;
    const usesDuckDbVector = layer.metadata.sourceKind === "maplibre-gl-vector";
    const usesVectorTiles =
      layer.type === "vector-tiles" || layer.type === "pmtiles" || layer.type === "mbtiles";
    if (!(usesDuckDbVector || usesVectorTiles) || layer.geojson) {
      setLoadedVectorPropertyValues(null);
      setVectorPropertyValuesLoading(false);
      setVectorPropertyValuesUnavailable(false);
      return;
    }

    const classificationNeedsValues =
      (draftVectorStyleMode === "graduated" || draftVectorStyleMode === "categorized") &&
      draftVectorStyleProperty !== "";
    const proportionalPropertyToLoad = styleValue(layer.style, "proportionalSizeProperty");
    const proportionalNeedsValues =
      styleValue(layer.style, "proportionalSizeEnabled") && proportionalPropertyToLoad !== "";
    const propertiesToLoad = [
      ...(classificationNeedsValues ? [draftVectorStyleProperty] : []),
      ...(proportionalNeedsValues ? [proportionalPropertyToLoad] : []),
    ].filter((property, index, all) => property !== "" && all.indexOf(property) === index);

    if (propertiesToLoad.length === 0) {
      setLoadedVectorPropertyValues(null);
      setVectorPropertyValuesLoading(false);
      setVectorPropertyValuesUnavailable(false);
      return;
    }

    let cancelled = false;
    setLoadedVectorPropertyValues((current) =>
      current?.layerId === layer.id &&
      propertiesToLoad.every((property) =>
        Object.prototype.hasOwnProperty.call(current.byProperty, property),
      )
        ? current
        : null,
    );
    setVectorPropertyValuesLoading(true);
    setVectorPropertyValuesUnavailable(false);

    if (!usesDuckDbVector) {
      // Tiled sources only expose the features currently loaded, so an empty
      // sample means the tiles have not arrived yet rather than an empty
      // attribute — keep re-reading until the map settles with features.
      const engine = mapControllerRef.current;
      const map = vectorTileMap(engine);
      if (!map) {
        setLoadedVectorPropertyValues(null);
        setVectorPropertyValuesUnavailable(true);
        setVectorPropertyValuesLoading(false);
        return;
      }
      const sampleValues = (): boolean => {
        const features = loadedVectorTileFeatures(map, layer, engine?.kind);
        if (features.length === 0) return false;
        const byProperty: Record<string, unknown[]> = {};
        for (const property of propertiesToLoad) {
          byProperty[property] = features
            .map((feature) => feature.properties?.[property])
            .filter((value) => value !== null && value !== undefined);
        }
        setLoadedVectorPropertyValues({ layerId: layer.id, byProperty });
        setVectorPropertyValuesLoading(false);
        return true;
      };
      if (sampleValues()) return;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const onIdle = (): void => {
        if (cancelled || !sampleValues()) return;
        map.off("idle", onIdle);
        clearTimeout(timer);
      };
      // The sample may never fill: the layer's data can lie outside the
      // viewport, and a map that is already idle fires no further events. Give
      // up rather than leaving the panel loading with Apply disabled forever.
      timer = setTimeout(() => {
        if (cancelled) return;
        map.off("idle", onIdle);
        setLoadedVectorPropertyValues(null);
        setVectorPropertyValuesUnavailable(true);
        setVectorPropertyValuesLoading(false);
      }, VECTOR_TILE_SAMPLE_TIMEOUT_MS);
      map.on("idle", onIdle);
      return () => {
        cancelled = true;
        map.off("idle", onIdle);
        clearTimeout(timer);
      };
    }

    void Promise.all(
      propertiesToLoad.map(async (property) => {
        const values = await getVectorLayerPropertyValues(layer.id, property);
        return [property, values] as const;
      }),
    )
      .then((entries) => {
        if (cancelled) return;
        const byProperty: Record<string, unknown[]> = {};
        for (const [property, values] of entries) {
          if (values === null) {
            setLoadedVectorPropertyValues(null);
            setVectorPropertyValuesUnavailable(true);
            return;
          }
          byProperty[property] = values;
        }
        setLoadedVectorPropertyValues({ layerId: layer.id, byProperty });
      })
      .catch((error) => {
        if (!cancelled) {
          console.error("[GeoLibre] Could not read vector attribute values", error);
          setLoadedVectorPropertyValues(null);
          setVectorPropertyValuesUnavailable(true);
        }
      })
      .finally(() => {
        if (!cancelled) setVectorPropertyValuesLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [
    draftVectorStyleMode,
    draftVectorStyleProperty,
    layer?.geojson,
    layer?.id,
    layer?.metadata.sourceKind,
    layer?.style.proportionalSizeEnabled,
    layer?.style.proportionalSizeProperty,
    layer?.type,
  ]);

  useEffect(() => {
    if (
      !layer ||
      !loadedVectorPropertyValues ||
      loadedVectorPropertyValues.layerId !== layer.id ||
      (draftVectorStyleMode !== "graduated" && draftVectorStyleMode !== "categorized")
    ) {
      return;
    }
    const values = loadedVectorPropertyValues.byProperty[draftVectorStyleProperty];
    if (!values) return;

    setDraftVectorStyleStops(
      createDefaultStops(
        { geojson: layer.geojson },
        draftVectorStyleMode,
        draftVectorStyleProperty,
        draftVectorStyleClassCount,
        draftVectorStyleColorRamp,
        draftVectorStyleClassificationScheme,
        values,
      ),
    );
  }, [
    draftVectorStyleClassCount,
    draftVectorStyleClassificationScheme,
    draftVectorStyleColorRamp,
    draftVectorStyleMode,
    draftVectorStyleProperty,
    layer?.geojson,
    layer?.id,
    layer?.metadata.sourceKind,
    loadedVectorPropertyValues,
  ]);

  // When tiled attribute samples arrive for the proportional size field, seed
  // (or refine) min/max. A ref records the last auto-applied range so a user's
  // intentional 0–100 is never overwritten, while a partial first tile sample
  // can still widen as more tiles load.
  useEffect(() => {
    if (!layer || !loadedVectorPropertyValues) return;
    if (!styleValue(layer.style, "proportionalSizeEnabled")) return;
    const property = styleValue(layer.style, "proportionalSizeProperty");
    if (!property || loadedVectorPropertyValues.layerId !== layer.id) return;
    const values = loadedVectorPropertyValues.byProperty[property];
    // An empty tile sample is inconclusive — wait for features with values.
    if (!values || values.length === 0) return;
    const bounds = proportionalSizeBounds(layer, property, values);
    if (!bounds) return;

    const seedKey = `${layer.id}:${property}`;
    const minValue = styleValue(layer.style, "proportionalSizeMinValue");
    const maxValue = styleValue(layer.style, "proportionalSizeMaxValue");
    const seeded = seededProportionalBoundsRef.current;

    if (seeded?.key === seedKey) {
      // Still wearing our auto-seed: refine when a richer sample expands/shifts it.
      if (
        minValue === seeded.min &&
        maxValue === seeded.max &&
        (bounds.min !== seeded.min || bounds.max !== seeded.max)
      ) {
        seededProportionalBoundsRef.current = {
          key: seedKey,
          min: bounds.min,
          max: bounds.max,
        };
        setLayerStyle(layer.id, {
          proportionalSizeMinValue: bounds.min,
          proportionalSizeMaxValue: bounds.max,
        });
      }
      return;
    }

    // New layer/property pair: only auto-seed from the unseeded defaults.
    if (
      minValue !== DEFAULT_LAYER_STYLE.proportionalSizeMinValue ||
      maxValue !== DEFAULT_LAYER_STYLE.proportionalSizeMaxValue
    ) {
      // Non-default without our seed record → intentional; don't overwrite.
      seededProportionalBoundsRef.current = { key: seedKey, min: minValue, max: maxValue };
      return;
    }

    seededProportionalBoundsRef.current = {
      key: seedKey,
      min: bounds.min,
      max: bounds.max,
    };
    setLayerStyle(layer.id, {
      proportionalSizeMinValue: bounds.min,
      proportionalSizeMaxValue: bounds.max,
    });
  }, [layer, loadedVectorPropertyValues, setLayerStyle]);

  // Reset the "show basemap layers" advanced toggle back to its clean default
  // whenever a different layer is selected. Keyed on the layer id alone so it
  // does not re-collapse while the user edits other style fields.
  useEffect(() => {
    setShowBasemapStyleLayers(false);
    seededProportionalBoundsRef.current = null;
    setProportionalSizeError(null);
  }, [layer?.id]);
  const countCompleteCategorizedValues = useCallback(
    (property: string): number =>
      completeCategorizedValueCount(
        layer,
        property,
        layer && loadedVectorPropertyValues?.layerId === layer.id
          ? loadedVectorPropertyValues.byProperty[property]
          : undefined,
      ),
    // The count reads only these stable layer fields. Depending on the whole
    // layer object would rescan every feature on any unrelated style edit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      layer?.geojson,
      layer?.id,
      layer?.metadata.sourceKind,
      layer?.type,
      loadedVectorPropertyValues,
    ],
  );
  const categorizedValueCount = useMemo(
    () =>
      draftVectorStyleMode === "categorized"
        ? countCompleteCategorizedValues(draftVectorStyleProperty)
        : 0,
    [countCompleteCategorizedValues, draftVectorStyleMode, draftVectorStyleProperty],
  );

  // The distinct-value count can land after the attribute was picked (DuckDB
  // loads values asynchronously), so reconcile the class count once it arrives:
  // "All" follows the new attribute's count, an explicit count only shrinks to
  // fit. Tracking the "All" selection as its own flag — rather than inferring it
  // from `classCount === categorizedValueCount` — is what makes the two cases
  // distinguishable when the counts happen to coincide.
  useEffect(() => {
    if (draftVectorStyleMode !== "categorized" || categorizedValueCount === 0) return;
    setDraftVectorStyleClassCount((current) =>
      draftVectorStyleAllCategories || current > categorizedValueCount
        ? categorizedValueCount
        : current,
    );
  }, [categorizedValueCount, draftVectorStyleAllCategories, draftVectorStyleMode]);

  return {
    draftBeforeId,
    setDraftBeforeId,
    showBasemapStyleLayers,
    setShowBasemapStyleLayers,
    draftColorExpression,
    setDraftColorExpression,
    draftHeightExpression,
    setDraftHeightExpression,
    draftVectorStyleMode,
    setDraftVectorStyleMode,
    draftVectorStyleProperty,
    setDraftVectorStyleProperty,
    draftVectorStyleClassCount,
    setDraftVectorStyleClassCount,
    draftVectorStyleAllCategories,
    setDraftVectorStyleAllCategories,
    draftVectorStyleColorRamp,
    setDraftVectorStyleColorRamp,
    draftVectorStyleClassificationScheme,
    setDraftVectorStyleClassificationScheme,
    draftVectorStyleStops,
    setDraftVectorStyleStops,
    draftVectorStyleExpression,
    setDraftVectorStyleExpression,
    draftExtrusionColor,
    setDraftExtrusionColor,
    draftExtrusionOpacity,
    setDraftExtrusionOpacity,
    draftExtrusionHeightProperty,
    setDraftExtrusionHeightProperty,
    draftExtrusionHeightScale,
    setDraftExtrusionHeightScale,
    draftExtrusionBase,
    setDraftExtrusionBase,
    draftAdvancedExtrusionEnabled,
    setDraftAdvancedExtrusionEnabled,
    vectorStyleError,
    setVectorStyleError,
    extrusionError,
    setExtrusionError,
    proportionalSizeError,
    setProportionalSizeError,
    seededProportionalBoundsRef,
    loadedVectorPropertyValues,
    vectorPropertyValuesLoading,
    vectorPropertyValuesUnavailable,
    countCompleteCategorizedValues,
    categorizedValueCount,
  };
}

export type StylePanelDrafts = ReturnType<typeof useStylePanelDrafts>;
