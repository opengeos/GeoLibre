import { useDeferredValue, useEffect, useMemo } from "react";
import type { GeoLibreLayer, PrintLayoutConfig } from "@geolibre/core";
import type { MapEngine } from "@geolibre/map";
import {
  buildAtlasPages,
  buildLineAtlasPages,
  collectAtlasFeatures,
  hasLineGeometry,
  listAtlasFields,
  parseAtlasFilter,
  type AtlasTokenContext,
} from "../../../lib/print-atlas";
import { clearAtlasFeatureMask } from "../../../lib/print-atlas-mask";
import { engineStyleMap } from "../../../lib/engine-style-map";

interface UseAtlasSeriesArgs {
  open: boolean;
  layers: GeoLibreLayer[];
  layout: PrintLayoutConfig;
  /** The atlas setting, AND-ed with the renderer being able to drive it. */
  atlasEnabled: boolean;
  atlasIndex: number;
  mapControllerRef: React.RefObject<MapEngine | null>;
}

/**
 * The atlas (map series) derived from the composer's settings (GH #1291): the
 * eligible coverage layers, the page list, the current page, and whether the
 * configuration can be exported. Also removes the temporary feature mask from
 * the live map as soon as it stops applying.
 *
 * @returns The derived series.
 */
export function useAtlasSeries({
  open,
  layers,
  layout,
  atlasEnabled,
  atlasIndex,
  mapControllerRef,
}: UseAtlasSeriesArgs) {
  const {
    atlasLayerId,
    atlasCoverage,
    atlasSegmentKm,
    atlasNameField,
    atlasExtentMode,
    atlasMarginPct,
    atlasMaskEnabled,
    atlasScale,
    atlasSortField,
    atlasSortDescending,
    atlasFilter,
  } = layout;
  // Only vector layers whose features are loaded in the store can drive an
  // atlas; tile-backed layers have no per-feature geometry to iterate.
  const atlasLayers = useMemo(
    () => layers.filter((l) => (l.geojson?.features?.length ?? 0) > 0),
    [layers],
  );
  const atlasLayer = useMemo(
    () => atlasLayers.find((l) => l.id === atlasLayerId) ?? null,
    [atlasLayers, atlasLayerId],
  );
  // The per-vertex geometry walk runs once per coverage layer; sort/filter
  // edits below only re-iterate these lightweight per-feature records.
  const atlasFeatureInfos = useMemo(
    () => (atlasLayer?.geojson ? collectAtlasFeatures(atlasLayer.geojson) : []),
    [atlasLayer],
  );
  // Field names come from ALL features (once per layer, cheap over the
  // precomputed records), so sparse attributes past any sample window still
  // appear in the name/sort selectors.
  const atlasFields = useMemo(() => listAtlasFields(atlasFeatureInfos), [atlasFeatureInfos]);
  // Reparse (and rebuild the page list below) off React's deferred lane, so
  // typing in the filter box does not synchronously re-iterate a large
  // coverage layer on every keystroke.
  const deferredAtlasFilter = useDeferredValue(atlasFilter);
  // null = malformed expression: surface the error and fall back to no filter,
  // so a half-typed condition never blanks the whole page list.
  const atlasFilterPredicate = useMemo(
    () => parseAtlasFilter(deferredAtlasFilter),
    [deferredAtlasFilter],
  );
  // How many features can seed along-a-line coverage (used to message an
  // empty series and to hide the mode for point/polygon-only layers).
  const atlasLineFeatureCount = useMemo(
    () =>
      atlasLayer?.geojson
        ? atlasLayer.geojson.features.filter((f) => hasLineGeometry(f.geometry)).length
        : 0,
    [atlasLayer],
  );
  // Segment length rides the deferred lane like the filter: re-segmenting a
  // long line on every keystroke would jank the input.
  const deferredSegmentKm = useDeferredValue(atlasSegmentKm);
  const atlasPages = useMemo(
    () =>
      atlasCoverage === "line"
        ? atlasLayer?.geojson
          ? buildLineAtlasPages(atlasLayer.geojson, {
              segmentKm: Number(deferredSegmentKm),
              nameField: atlasNameField || undefined,
              filter: atlasFilterPredicate ?? undefined,
            })
          : []
        : buildAtlasPages(atlasFeatureInfos, {
            nameField: atlasNameField || undefined,
            sortField: atlasSortField || undefined,
            sortDescending: atlasSortDescending,
            filter: atlasFilterPredicate ?? undefined,
          }),
    [
      atlasCoverage,
      atlasLayer,
      deferredSegmentKm,
      atlasFeatureInfos,
      atlasNameField,
      atlasSortField,
      atlasSortDescending,
      atlasFilterPredicate,
    ],
  );
  const atlasPageCount = atlasPages.length;
  // Order + membership signature of the series: changes when sorting or
  // filtering reshuffles which feature sits at each page, but not when only
  // the display names do (a name-field switch must not re-drive the map).
  const atlasDriveKey = useMemo(() => atlasPages.map((p) => p.sourceIndex).join(","), [atlasPages]);
  // The stored index can go stale when a filter/sort change shrinks the list.
  const clampedAtlasIndex = Math.min(atlasIndex, Math.max(0, atlasPageCount - 1));
  const currentAtlasPage = atlasEnabled ? (atlasPages[clampedAtlasIndex] ?? null) : null;
  const atlasActive = atlasEnabled && atlasPageCount > 0;
  const currentAtlasFeature = currentAtlasPage
    ? atlasLayer?.geojson?.features[currentAtlasPage.sourceIndex]
    : undefined;
  const atlasMaskAvailable = Boolean(
    atlasCoverage === "features" &&
    (currentAtlasFeature?.geometry?.type === "Polygon" ||
      currentAtlasFeature?.geometry?.type === "MultiPolygon"),
  );
  // The mask is a temporary live-map layer. Remove it immediately when the
  // option, atlas, or dialog is turned off instead of waiting for another
  // camera drive that may never happen.
  useEffect(() => {
    if (open && atlasActive && atlasMaskEnabled && atlasMaskAvailable) return;
    const map = engineStyleMap(mapControllerRef.current);
    if (map) clearAtlasFeatureMask(map);
  }, [open, atlasActive, atlasMaskEnabled, atlasMaskAvailable, mapControllerRef]);
  const atlasFilterValid = atlasFilterPredicate !== null;
  const atlasScaleValid = atlasExtentMode !== "scale" || Number(atlasScale) > 0;
  // A floor (not just > 0) keeps a mistyped tiny length from cutting a long
  // line into an enormous synchronous page list.
  const atlasSegmentValid = atlasCoverage !== "line" || Number(atlasSegmentKm) >= 0.1;
  // atlasPages is built from the *deferred* filter/segment values; block the
  // export while an edit is still catching up so a quick click can never
  // export the previous configuration's pages.
  const atlasDeferredPending =
    atlasFilter !== deferredAtlasFilter ||
    (atlasCoverage === "line" && atlasSegmentKm !== deferredSegmentKm);
  // A visible-but-invalid filter, a blank fixed scale, or a blank segment
  // length must block the export: proceeding would silently export all
  // features / arbitrary extents while the user is looking at an error.
  const atlasConfigBlocked =
    atlasEnabled &&
    (!atlasFilterValid || !atlasScaleValid || !atlasSegmentValid || atlasDeferredPending);
  const atlasTokenCtx = useMemo<AtlasTokenContext | null>(
    () =>
      currentAtlasPage
        ? {
            name: currentAtlasPage.name,
            pageNumber: clampedAtlasIndex + 1,
            total: atlasPageCount,
            properties: currentAtlasPage.properties,
          }
        : null,
    [currentAtlasPage, clampedAtlasIndex, atlasPageCount],
  );
  // Margin applied when fitting an atlas page's bounds, shared by the real
  // fit in captureAtlasPage and the data blocks' pre-capture approximation so
  // the two can never desync (fixed-scale mode fits tight and re-zooms after).
  const atlasFitMarginPct = atlasExtentMode === "margin" ? atlasMarginPct : 0;

  return {
    atlasLayers,
    atlasLayer,
    atlasFields,
    deferredAtlasFilter,
    atlasFilterPredicate,
    atlasLineFeatureCount,
    deferredSegmentKm,
    atlasPages,
    atlasPageCount,
    atlasDriveKey,
    clampedAtlasIndex,
    currentAtlasPage,
    atlasActive,
    atlasMaskAvailable,
    atlasScaleValid,
    atlasSegmentValid,
    atlasConfigBlocked,
    atlasTokenCtx,
    atlasFitMarginPct,
  };
}

/** The derived atlas series, as returned by {@link useAtlasSeries}. */
export type AtlasSeries = ReturnType<typeof useAtlasSeries>;
