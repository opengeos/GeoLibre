import {
  isArcGISWritableLayer,
  saveArcGISLayerEdits,
  getTemporalLayerAdapter,
  isEmbeddableLocalVectorLayer,
  isTimeSliderIdle,
  materializeEmbeddableVectorLayers,
  SKETCHES_SOURCE_KIND,
  TIME_SLIDER_PLUGIN_ID,
} from "@geolibre/plugins";
import {
  type Dispatch,
  type RefObject,
  type SetStateAction,
  useCallback,
  useMemo,
  useRef,
} from "react";
import { useTranslation } from "react-i18next";
import {
  captureLayerLibraryEntry,
  createLayerLibraryEntryId,
  excludeHiddenFieldsFromGeojson,
  resolveLayerCapabilities,
  useAppStore,
} from "@geolibre/core";
import type { GeoLibreLayer } from "@geolibre/core";
import type { FeatureCollection } from "geojson";
import {
  buildMapboxStyle,
  buildGeoLibreQueryStyle,
  buildQml,
  buildSld,
  mapboxStyleToJson,
  geoLibreStyleSourceName,
  type MapEngine,
} from "@geolibre/map";
import { importStyleText } from "@geolibre/map/style-import";
import { readPostgisTable, writePostgisTable, writeVectorToSource } from "@geolibre/processing";
import { commitPendingAttributeDrafts } from "../../../lib/attribute-draft-commit";
import { bindTemporalLayer, createAppAPI, usePluginRegistry } from "../../../hooks/usePlugins";
import {
  bufferPresetsFor,
  formatBufferDistance,
  runQuickAnalysis,
  type QuickBufferPreset,
} from "../../../lib/quick-analysis";
import { exportRasterLayer } from "../../../lib/raster-export";
import {
  exportVectorLayer,
  geojsonVectorSourceId,
  kmlExportErrorMessage,
  resolveLayerGeojson,
  sanitizeExportFileName,
  shapefileFieldWarnings,
  type VectorExportFormat,
} from "../../../lib/vector-export";
import { openLocalDataFileWithFallback, saveTextFileWithFallback } from "../../../lib/tauri-io";
import { importedStyleErrorMessage, importedStyleNote } from "../../../lib/style-import-note";
import {
  postgisBaselineKeys,
  postgisFeatureKeys,
  resolvePostgisConnection,
} from "../../../lib/postgis-connections";
import { isPostgisEditableLayer, type LayerRefreshStatus } from "./layer-panel-utils";

type PluginRegistry = ReturnType<typeof usePluginRegistry>;

interface UseLayerActionsOptions {
  mapControllerRef: RefObject<MapEngine | null>;
  /** Whether collaboration lets this session change the layer. */
  canEditLayer: (layerId: string) => boolean;
  /** The per-layer status notes the actions report into (see useLayerRefresh). */
  setRefreshStatuses: Dispatch<SetStateAction<Record<string, LayerRefreshStatus>>>;
  clearRefreshStatusTimer: (layerId: string) => void;
  scheduleStatusClear: (layerId: string) => void;
  isPluginActive: PluginRegistry["isActive"];
  togglePlugin: PluginRegistry["toggle"];
}

/**
 * The handlers behind the layer actions menu: export (features, symbology,
 * raster), style copy/paste/import, save to the Layer Library, write-back to
 * the source, Sketches export, quick analysis and the direct Time Slider
 * bind/unbind. Each reports its outcome through the row's status note.
 *
 * @param options - The map, the collaboration gate and the status-note setters.
 * @returns The action handlers the menu calls.
 */
export function useLayerActions({
  mapControllerRef,
  canEditLayer,
  setRefreshStatuses,
  clearRefreshStatusTimer,
  scheduleStatusClear,
  isPluginActive,
  togglePlugin,
}: UseLayerActionsOptions) {
  const { i18n, t } = useTranslation();
  const addGeoJsonLayer = useAppStore((s) => s.addGeoJsonLayer);
  const updateLayer = useAppStore((s) => s.updateLayer);
  const moveLayersToGroup = useAppStore((s) => s.moveLayersToGroup);
  const selectLayer = useAppStore((s) => s.selectLayer);
  const copyLayerStyle = useAppStore((s) => s.copyLayerStyle);
  const pasteLayerStyle = useAppStore((s) => s.pasteLayerStyle);
  const saveLayerLibraryEntry = useAppStore((s) => s.saveLayerLibraryEntry);
  // Layer ids with a Save to My Data in flight, so a repeat click during the
  // vector-control materialize cannot create a duplicate library entry.
  const savingToLibraryIdsRef = useRef(new Set<string>());

  // Quick analysis (#1523): run an existing vector tool over a whole layer from
  // its actions menu, with defaults filled in. No new algorithms — each entry
  // dispatches the same tool the Processing dialog would, so the run shows up in
  // the Processing History panel and can be re-run or copied as Python there.
  const quickScaleUnit = useAppStore((s) => s.preferences.map.scaleUnit);
  const quickBufferPresets = useMemo(() => bufferPresetsFor(quickScaleUnit), [quickScaleUnit]);

  const formatQuickDistance = useCallback(
    (preset: QuickBufferPreset) => formatBufferDistance(preset, i18n.language, t),
    [i18n.language, t],
  );

  const runLayerQuickTool = useCallback(
    (layer: GeoLibreLayer, toolId: string, parameters: Record<string, unknown>, name: string) => {
      void runQuickAnalysis({
        toolId,
        parameters: { layer: layer.id, ...parameters },
        resultName: name,
        mapControllerRef,
      });
    },
    [mapControllerRef],
  );

  /** Copy the editor-managed Sketches overlay into an ordinary project layer. */
  const exportSketchesAsLayer = useCallback(
    (layer: GeoLibreLayer, clearAfterExport = false) => {
      if (
        layer.metadata.sourceKind !== SKETCHES_SOURCE_KIND ||
        !Array.isArray(layer.geojson?.features) ||
        layer.geojson.features.length === 0 ||
        (clearAfterExport && !canEditLayer(layer.id))
      ) {
        return;
      }

      const baseName = t("layers.exportedSketchesName");
      const names = new Set(useAppStore.getState().layers.map((item) => item.name));
      let name = baseName;
      for (let suffix = 2; names.has(name); suffix += 1) name = `${baseName} ${suffix}`;

      const id = addGeoJsonLayer(name, structuredClone(layer.geojson));
      updateLayer(id, {
        opacity: layer.opacity,
        visible: layer.visible,
        style: structuredClone(layer.style),
      });
      if (layer.groupId) moveLayersToGroup([id], layer.groupId);
      if (clearAfterExport) {
        updateLayer(layer.id, { geojson: { type: "FeatureCollection", features: [] } });
      }
      selectLayer(id);
    },
    [addGeoJsonLayer, canEditLayer, moveLayersToGroup, selectLayer, t, updateLayer],
  );

  const handleCopyStyle = useCallback(
    (layer: GeoLibreLayer) => {
      // Only confirm when a style was actually captured; the action no-ops on a
      // non-copyable layer.
      if (!copyLayerStyle(layer.id)) return;
      clearRefreshStatusTimer(layer.id);
      setRefreshStatuses((current) => ({
        ...current,
        [layer.id]: {
          type: "success",
          message: t("layers.styleCopied", { name: layer.name }),
        },
      }));
      scheduleStatusClear(layer.id);
    },
    [copyLayerStyle, clearRefreshStatusTimer, scheduleStatusClear, setRefreshStatuses, t],
  );

  const handlePasteStyle = useCallback(
    (layer: GeoLibreLayer) => {
      // Read the source name before pasting; the message names the layer the
      // clipboard style came from.
      const sourceName = useAppStore.getState().copiedLayerStyle?.sourceName ?? "";
      // Only confirm when the style was actually applied; the action no-ops on
      // an empty clipboard or a family mismatch.
      if (!pasteLayerStyle(layer.id)) return;
      clearRefreshStatusTimer(layer.id);
      setRefreshStatuses((current) => ({
        ...current,
        [layer.id]: {
          type: "success",
          message: t("layers.stylePasted", { name: sourceName }),
        },
      }));
      scheduleStatusClear(layer.id);
    },
    [pasteLayerStyle, clearRefreshStatusTimer, scheduleStatusClear, setRefreshStatuses, t],
  );

  /**
   * Save a fully configured layer to the app-level Layer Library (issue #1520)
   * so it can be re-added to any later project from the Browser panel's My Data
   * section. Reuses the per-layer status row for feedback, like the style
   * copy/paste actions above.
   *
   * An Add Vector Layer layer holds its features in the control, not the store,
   * so its current data is read from there first — the same materialization the
   * project Embed/Share flow uses — instead of relying on the store's
   * attribute-table copy, which a tiles-mode layer does not have.
   */
  const handleSaveToLibrary = useCallback(
    async (layer: GeoLibreLayer) => {
      // Guard re-entrancy across the materialize await below: a second invocation
      // for the same layer before the first resolves would save two entries under
      // two freshly generated ids (mirrors handleRefreshLayer's
      // refreshingLayerIdsRef).
      if (savingToLibraryIdsRef.current.has(layer.id)) return;
      savingToLibraryIdsRef.current.add(layer.id);
      try {
        const features = isEmbeddableLocalVectorLayer(layer)
          ? (await materializeEmbeddableVectorLayers([layer])).get(layer.id)
          : undefined;
        // The materialize await can outlive a concurrent style/opacity/join edit,
        // so capture from the current layer rather than the closure's snapshot
        // (mirrors handleImportStyle / handleSaveEditsToSource).
        const latest = useAppStore.getState().layers.find((l) => l.id === layer.id) ?? layer;
        const result = captureLayerLibraryEntry(latest, {
          id: createLayerLibraryEntryId(),
          addedAt: new Date().toISOString(),
          ...(features ? { features } : {}),
        });
        clearRefreshStatusTimer(layer.id);
        setRefreshStatuses((current) => ({
          ...current,
          [layer.id]: result.ok
            ? {
                type: "success",
                message: t("layers.savedToLibrary", { name: layer.name }),
              }
            : {
                type: "error",
                message:
                  result.reason === "features-too-large"
                    ? t("layers.saveToLibraryTooLarge")
                    : result.reason === "config-too-large"
                      ? t("layers.saveToLibraryConfigTooLarge")
                      : t("layers.saveToLibraryNoSource"),
              },
        }));
        scheduleStatusClear(layer.id);
        if (result.ok) saveLayerLibraryEntry(result.entry);
      } finally {
        savingToLibraryIdsRef.current.delete(layer.id);
      }
    },
    [saveLayerLibraryEntry, clearRefreshStatusTimer, scheduleStatusClear, setRefreshStatuses, t],
  );

  // Values typed in the attribute table stay drafts until its own Save runs,
  // while Export and write-back read the layer from the store. Commit the drafts
  // first so both include what the table shows instead of silently using the
  // pre-edit features (#2438, #2439). Returns the up-to-date layer, or null
  // (with an error status set) when the drafts cannot be applied: invalid
  // values, form violations, or a revoked update capability.
  const commitTableDrafts = useCallback(
    (layer: GeoLibreLayer): GeoLibreLayer | null => {
      if (commitPendingAttributeDrafts(layer.id) === "blocked") {
        setRefreshStatuses((current) => ({
          ...current,
          [layer.id]: { type: "error", message: t("layers.pendingTableDraftsBlocked") },
        }));
        scheduleStatusClear(layer.id);
        return null;
      }
      // A commit replaces the layer's features, so read the layer back.
      return useAppStore.getState().layers.find((l) => l.id === layer.id) ?? layer;
    },
    [scheduleStatusClear, setRefreshStatuses, t],
  );

  const handleExportLayer = useCallback(
    async (clickedLayer: GeoLibreLayer, format: VectorExportFormat, precision?: number) => {
      clearRefreshStatusTimer(clickedLayer.id);
      const layer = commitTableDrafts(clickedLayer);
      if (!layer) return;
      try {
        const geojson = await resolveLayerGeojson(
          layer,
          mapControllerRef.current?.getMap() ?? undefined,
        );
        if (!geojson) {
          // A source-backed (Add Vector Layer) layer whose features could not be
          // read is usually a not-yet-ready map source, not a layer that lacks
          // features, so the two cases get different diagnostics.
          const message =
            geojsonVectorSourceId(layer) !== null
              ? t("layers.exportStyleDataNotReady")
              : t("layers.exportNeedsFeatures");
          setRefreshStatuses((current) => ({
            ...current,
            [layer.id]: { type: "error", message },
          }));
          scheduleStatusClear(layer.id);
          return;
        }
        const egressGeojson = layer.fieldVisibility
          ? excludeHiddenFieldsFromGeojson(geojson, layer.fieldVisibility)
          : geojson;
        const polylinePrecision =
          precision ??
          (typeof layer.metadata?.polylinePrecision === "number"
            ? layer.metadata.polylinePrecision
            : 5);
        const savedPath = await exportVectorLayer(
          egressGeojson,
          format,
          sanitizeExportFileName(layer.name),
          layer.name,
          polylinePrecision,
        );
        // A null path means the user cancelled the save dialog, so no note.
        if (savedPath !== null) {
          // Surface Shapefile field-name limitations so renamed/merged
          // attributes do not come as a surprise to QGIS/ArcGIS users.
          const warnings = format === "shapefile" ? shapefileFieldWarnings(geojson) : [];
          setRefreshStatuses((current) => ({
            ...current,
            [layer.id]:
              warnings.length > 0
                ? {
                    type: "warning",
                    message: t("layers.exportedWithWarnings", {
                      warnings: warnings.join(" "),
                    }),
                  }
                : { type: "success", message: t("layers.exported") },
          }));
          scheduleStatusClear(layer.id);
        }
      } catch (error) {
        const message =
          kmlExportErrorMessage(error, t) ??
          (error instanceof Error ? error.message : t("layers.exportLayerError"));
        setRefreshStatuses((current) => ({
          ...current,
          [layer.id]: { type: "error", message },
        }));
        scheduleStatusClear(layer.id);
      }
    },
    [
      clearRefreshStatusTimer,
      commitTableDrafts,
      mapControllerRef,
      scheduleStatusClear,
      setRefreshStatuses,
      t,
    ],
  );

  // Shared symbology-export flow: resolve the layer's features, build the style
  // text via `build`, save it, and set the success/warning/error status. Each
  // format (Mapbox GL / SLD / QML) supplies only its builder and file metadata,
  // so the three export handlers stay in sync as more formats are added. A
  // builder returns `{ error }` to abort with a message (e.g. the Mapbox
  // exporter needs embedded features), or `{ text, warnings }` to save.
  const exportLayerStyle = useCallback(
    async (
      layer: GeoLibreLayer,
      build: (
        geojson: FeatureCollection | null,
      ) => { text: string; warnings: string[] } | { error: string },
      fileMeta: {
        defaultName: string;
        filters: { name: string; extensions: string[] }[];
        browserTypes: {
          description: string;
          accept: Record<string, string[]>;
        }[];
        mimeType: string;
      },
    ) => {
      clearRefreshStatusTimer(layer.id);
      try {
        const geojson = await resolveLayerGeojson(
          layer,
          mapControllerRef.current?.getMap() ?? undefined,
        );
        const built = build(geojson ?? null);
        if ("error" in built) {
          setRefreshStatuses((current) => ({
            ...current,
            [layer.id]: { type: "error", message: built.error },
          }));
          scheduleStatusClear(layer.id);
          return;
        }
        const savedPath = await saveTextFileWithFallback(built.text, fileMeta);
        // A null path means the user cancelled the save dialog, so no note.
        if (savedPath !== null) {
          setRefreshStatuses((current) => ({
            ...current,
            [layer.id]:
              built.warnings.length > 0
                ? {
                    type: "warning",
                    message: `${t("layers.exportStyleSuccess")} ${built.warnings.join(" ")}`,
                  }
                : { type: "success", message: t("layers.exportStyleSuccess") },
          }));
          scheduleStatusClear(layer.id);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : t("layers.exportStyleError");
        setRefreshStatuses((current) => ({
          ...current,
          [layer.id]: { type: "error", message },
        }));
        scheduleStatusClear(layer.id);
      }
    },
    [clearRefreshStatusTimer, mapControllerRef, scheduleStatusClear, setRefreshStatuses, t],
  );

  // Export a vector layer's symbology as a self-contained Mapbox GL / MapLibre
  // style document, so the cartography can be reused in another map or handed to
  // a teammate instead of being locked inside the .geolibre.json project.
  const handleExportStyle = useCallback(
    (layer: GeoLibreLayer) =>
      exportLayerStyle(
        layer,
        (geojson) => {
          if (!geojson) {
            // A source-backed (Add Vector Layer) layer whose features are not
            // readable yet is usually a not-yet-ready map source; the Mapbox
            // export embeds the data, so it cannot proceed without it.
            return {
              error:
                geojsonVectorSourceId(layer) !== null
                  ? t("layers.exportStyleDataNotReady")
                  : t("layers.exportStyleNeedsFeatures"),
            };
          }
          const result = buildMapboxStyle(layer, geojson);
          return { text: mapboxStyleToJson(result), warnings: result.warnings };
        },
        {
          defaultName: `${sanitizeExportFileName(layer.name)}.style.json`,
          filters: [{ name: "Mapbox GL style", extensions: ["json"] }],
          browserTypes: [
            {
              description: "Mapbox GL style",
              accept: { "application/json": [".json"] },
            },
          ],
          mimeType: "application/json",
        },
      ),
    [exportLayerStyle, t],
  );

  // Export the compact style consumed by `?data=…&style=…`. Its render-layer
  // source is the original data filename stem, which also lets one style file
  // target individual GeoJSON members of a ZIP archive.
  const handleExportGeoLibreStyle = useCallback(
    (layer: GeoLibreLayer) =>
      exportLayerStyle(
        layer,
        (geojson) => {
          if (!geojson) {
            return {
              error:
                geojsonVectorSourceId(layer) !== null
                  ? t("layers.exportStyleDataNotReady")
                  : t("layers.exportStyleNeedsFeatures"),
            };
          }
          const result = buildGeoLibreQueryStyle(layer, geojson);
          return { text: mapboxStyleToJson(result), warnings: result.warnings };
        },
        {
          defaultName: `${sanitizeExportFileName(
            geoLibreStyleSourceName(layer),
          )}.geolibre.style.json`,
          filters: [{ name: "GeoLibre URL style", extensions: ["json"] }],
          browserTypes: [
            {
              description: "GeoLibre URL style",
              accept: { "application/json": [".json"] },
            },
          ],
          mimeType: "application/json",
        },
      ),
    [exportLayerStyle, t],
  );

  // Export a vector layer's symbology as an OGC SLD document, the interchange
  // format QGIS, GeoServer, MapServer, and ArcGIS speak. Unlike the Mapbox
  // export, SLD carries no data, so a layer whose features are not readable can
  // still export (geometry detection falls back to a symbolizer superset).
  const handleExportSldStyle = useCallback(
    (layer: GeoLibreLayer) =>
      exportLayerStyle(
        layer,
        (geojson) => {
          const result = buildSld(layer, geojson);
          return { text: result.sld, warnings: result.warnings };
        },
        {
          defaultName: `${sanitizeExportFileName(layer.name)}.sld`,
          filters: [{ name: "OGC SLD", extensions: ["sld", "xml"] }],
          browserTypes: [
            {
              description: "OGC SLD",
              accept: { "application/xml": [".sld", ".xml"] },
            },
          ],
          mimeType: "application/xml",
        },
      ),
    [exportLayerStyle],
  );

  // Export a vector layer's symbology as a QGIS QML style, the native style
  // format QGIS users have on disk, so GeoLibre cartography can be opened in
  // QGIS without rebuilding it by hand.
  const handleExportQmlStyle = useCallback(
    (layer: GeoLibreLayer) =>
      exportLayerStyle(
        layer,
        (geojson) => {
          const result = buildQml(layer, geojson);
          return { text: result.qml, warnings: result.warnings };
        },
        {
          defaultName: `${sanitizeExportFileName(layer.name)}.qml`,
          filters: [{ name: "QGIS QML", extensions: ["qml"] }],
          browserTypes: [
            {
              description: "QGIS QML",
              accept: { "application/xml": [".qml"] },
            },
          ],
          mimeType: "application/xml",
        },
      ),
    [exportLayerStyle],
  );

  // Import a symbology file (including GeoLibre URL and Mapbox/MapLibre style
  // JSON, or an OGC SLD/QGIS QML) and
  // apply it to a vector layer, so cartography authored elsewhere (QGIS,
  // GeoServer, another map, or a style exported from GeoLibre) can be brought
  // back in instead of being rebuilt by hand. The format is detected from the
  // file content (XML vs JSON). Anything the style could not represent is
  // surfaced as a warning rather than dropped silently.
  // Both style-import doors — the file picker and the paste box — land here, so the row says the
  // same thing however the style arrived.
  const noteImportedStyle = useCallback(
    (layerId: string, warnings: string[]) => {
      setRefreshStatuses((current) => ({
        ...current,
        [layerId]: importedStyleNote(t, warnings),
      }));
      scheduleStatusClear(layerId);
    },
    [scheduleStatusClear, setRefreshStatuses, t],
  );

  const handleImportStyle = useCallback(
    async (layer: GeoLibreLayer) => {
      clearRefreshStatusTimer(layer.id);
      const fail = (message: string) => {
        setRefreshStatuses((current) => ({
          ...current,
          [layer.id]: { type: "error", message },
        }));
        scheduleStatusClear(layer.id);
      };
      try {
        const picked = await openLocalDataFileWithFallback({
          filters: [
            {
              name: "Style (GeoLibre URL / Mapbox GL / SLD / QML)",
              extensions: ["json", "sld", "qml", "xml"],
            },
          ],
          // Android filters document pickers by MIME type, but SLD and QML do
          // not have consistently reported MIME types. Leave the native picker
          // broad there, then validate the selected file by content below.
          androidFilters: [],
          accept: ".json,.sld,.qml,.xml,application/json,application/xml,text/xml",
          readText: true,
        });
        // A null result means the user dismissed the file dialog; no note. Guard
        // on `picked` itself (not `picked.text`) so an empty/whitespace file is
        // still parsed and surfaces an "invalid" error rather than a silent
        // no-op that looks like a cancel.
        if (!picked || picked.text === undefined) return;

        const imported = importStyleText(picked.text);
        if (!imported.ok) {
          fail(importedStyleErrorMessage(t, imported));
          return;
        }
        // The file picker await can block while the user edits the Style panel,
        // so merge onto the current store style (not the pre-await snapshot) to
        // avoid clobbering a concurrent edit, matching handleRefreshLayer.
        const latest = useAppStore.getState().layers.find((candidate) => candidate.id === layer.id);
        // Removed while the picker was open. Nothing to style and nothing to report it on, so the
        // menu simply closes.
        if (!latest) return;
        updateLayer(layer.id, {
          style: imported.apply(latest.style),
        });
        noteImportedStyle(layer.id, imported.warnings);
      } catch (error) {
        fail(error instanceof Error ? error.message : t("layers.importStyleError"));
      }
    },
    [
      clearRefreshStatusTimer,
      noteImportedStyle,
      scheduleStatusClear,
      setRefreshStatuses,
      t,
      updateLayer,
    ],
  );

  // Commit the layer's current (edited) features back to the source they were
  // loaded from, via the sidecar: either overwriting the local file in place,
  // or diffing against the PostGIS table by primary key. Unlike Export, there
  // is no save dialog: write-back targets the known source.
  const handleSaveEditsToSource = useCallback(
    async (clickedLayer: GeoLibreLayer) => {
      if (!canEditLayer(clickedLayer.id)) return;
      clearRefreshStatusTimer(clickedLayer.id);
      const layer = commitTableDrafts(clickedLayer);
      if (!layer) return;
      const isPostgis = isPostgisEditableLayer(layer);
      const path = typeof layer.sourcePath === "string" ? layer.sourcePath.trim() : "";
      if (!isPostgis && !isArcGISWritableLayer(layer) && !path) return;
      try {
        if (isArcGISWritableLayer(layer)) {
          const result = await saveArcGISLayerEdits(layer.id);
          setRefreshStatuses((current) => ({
            ...current,
            [layer.id]: {
              type: result.errors.length ? "warning" : "success",
              message: [t("layers.saveEditsArcgisSuccess", result), ...result.errors].join(" "),
            },
          }));
          scheduleStatusClear(layer.id);
          return;
        }
        const geojson = await resolveLayerGeojson(
          layer,
          mapControllerRef.current?.getMap() ?? undefined,
        );
        if (!geojson || geojson.features.length === 0) {
          setRefreshStatuses((current) => ({
            ...current,
            [layer.id]: {
              type: "error",
              message: t("layers.saveEditsNoFeatures"),
            },
          }));
          scheduleStatusClear(layer.id);
          return;
        }
        let message: string;
        if (isPostgis) {
          const connection = resolvePostgisConnection(layer);
          if (!connection) {
            setRefreshStatuses((current) => ({
              ...current,
              [layer.id]: {
                type: "error",
                message: t("layers.saveEditsPostgisNoConnection"),
              },
            }));
            scheduleStatusClear(layer.id);
            return;
          }
          const schema =
            typeof layer.metadata.postgisSchema === "string"
              ? layer.metadata.postgisSchema
              : "public";
          const table = layer.metadata.postgisTable as string;
          const geometryColumn =
            typeof layer.metadata.postgisGeometryColumn === "string"
              ? layer.metadata.postgisGeometryColumn
              : undefined;
          const result = await writePostgisTable({
            connection,
            schema_name: schema,
            table,
            geometry_column: geometryColumn,
            geojson,
            // Scope deletions to the rows this session actually read so a
            // save cannot sweep away rows inserted concurrently elsewhere.
            // The baseline lives on the layer metadata, so it survives a
            // project reload.
            baseline_keys: postgisBaselineKeys(layer),
            // Resolved, not `layer.capabilities`: the sidecar reads an omitted
            // flag as allowed, so a partial override has to be filled in from
            // the same inferred defaults the UI gated on, or the two can
            // disagree about a flag the override never mentioned.
            capabilities: resolveLayerCapabilities(layer),
          });
          // Re-read the table so inserted features pick up their database-
          // assigned primary keys; without this a second save would insert
          // them again as duplicates.
          let fresh;
          try {
            fresh = await readPostgisTable({
              connection,
              schema_name: schema,
              table,
              geometry_column: geometryColumn,
              excluded_fields: layer.fieldVisibility
                ? Object.keys(layer.fieldVisibility).filter(
                    (k) => layer.fieldVisibility![k] === "excluded",
                  )
                : undefined,
            });
          } catch {
            // The write committed; only the refresh failed. Reporting this as
            // a plain failure would invite a retry that re-inserts the still
            // key-less new features, so surface a distinct warning instead.
            setRefreshStatuses((current) => ({
              ...current,
              [layer.id]: {
                type: "error",
                message: t("layers.saveEditsPostgisRefreshWarning"),
              },
            }));
            scheduleStatusClear(layer.id);
            return;
          }
          // Merge into the store's current metadata, not the click-time
          // closure: the write/re-read round trip is slow enough for other
          // updates (auto-refresh, time-slider binding) to land in between.
          const currentMetadata =
            useAppStore.getState().layers.find((l) => l.id === layer.id)?.metadata ??
            layer.metadata;
          updateLayer(layer.id, {
            geojson: fresh.geojson,
            metadata: {
              ...currentMetadata,
              featureCount: fresh.feature_count,
              postgisBaselineKeys: postgisFeatureKeys(fresh.geojson),
            },
          });
          message = t("layers.saveEditsPostgisSuccess", {
            table: `${schema}.${table}`,
            inserted: result.inserted,
            updated: result.updated,
            deleted: result.deleted,
          });
          // The sidecar reports editor-added fields it could not persist
          // (no matching table column); surface that so the drop is not
          // silent behind a plain success toast.
          if (result.skipped_fields?.length) {
            message = `${message} ${t("layers.saveEditsPostgisSkippedFields", {
              fields: result.skipped_fields.join(", "),
            })}`;
          }
        } else {
          const result = await writeVectorToSource({ path, geojson });
          message = t("layers.saveEditsSuccess", {
            count: result.feature_count,
          });
        }
        setRefreshStatuses((current) => ({
          ...current,
          [layer.id]: { type: "success", message },
        }));
        scheduleStatusClear(layer.id);
      } catch (error) {
        const message = error instanceof Error ? error.message : t("layers.saveEditsError");
        setRefreshStatuses((current) => ({
          ...current,
          [layer.id]: { type: "error", message },
        }));
        scheduleStatusClear(layer.id);
      }
    },
    [
      canEditLayer,
      clearRefreshStatusTimer,
      commitTableDrafts,
      mapControllerRef,
      scheduleStatusClear,
      setRefreshStatuses,
      t,
      updateLayer,
    ],
  );

  // Bind a layer whose time is an internal dimension (a Zarr data cube's `time`
  // axis, or a plugin's own custom layer). There is nothing to ask the user:
  // the adapter already knows the axis, so the binding is written and the dock
  // opens in one step rather than through the property-picking dialog.
  const handleBindTemporalLayer = useCallback(
    (layer: GeoLibreLayer) => {
      const adapter = getTemporalLayerAdapter(layer.id);
      if (!adapter) return;
      if (bindTemporalLayer(layer.id, adapter, mapControllerRef)) return;
      setRefreshStatuses((current) => ({
        ...current,
        [layer.id]: { type: "error", message: t("layers.bindNoTimeDimension") },
      }));
      scheduleStatusClear(layer.id);
    },
    [mapControllerRef, scheduleStatusClear, setRefreshStatuses, t],
  );

  // Remove a layer's binding and clear its transient time filter so it shows
  // every feature again. The Time Slider stays active for any other bindings.
  const handleUnbindTimeSlider = useCallback(
    (layer: GeoLibreLayer) => {
      const { timeBinding: _removed, ...metadata } = layer.metadata as Record<string, unknown>;
      updateLayer(layer.id, { metadata, timeFilter: undefined });
      // Switch the plugin off once it has nothing left to drive, so the dock
      // does not linger over a map it no longer affects and the Plugins menu
      // stops showing it as active. The store write above is synchronous, so
      // the layer just unbound is already excluded. Any remaining binding, dock
      // source, or timespan overlay keeps it on.
      if (isPluginActive(TIME_SLIDER_PLUGIN_ID) && isTimeSliderIdle()) {
        togglePlugin(TIME_SLIDER_PLUGIN_ID, createAppAPI(mapControllerRef));
      }
    },
    [updateLayer, isPluginActive, togglePlugin, mapControllerRef],
  );

  const handleExportRasterLayer = useCallback(
    async (layer: GeoLibreLayer) => {
      clearRefreshStatusTimer(layer.id);
      try {
        const savedPath = await exportRasterLayer(layer, sanitizeExportFileName(layer.name));
        // A null path means the user cancelled the save dialog, so no note.
        if (savedPath !== null) {
          setRefreshStatuses((current) => ({
            ...current,
            [layer.id]: {
              type: "success",
              message: t("layers.exportRasterSuccess"),
            },
          }));
          scheduleStatusClear(layer.id);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : t("layers.exportRasterError");
        setRefreshStatuses((current) => ({
          ...current,
          [layer.id]: { type: "error", message },
        }));
        scheduleStatusClear(layer.id);
      }
    },
    [clearRefreshStatusTimer, scheduleStatusClear, setRefreshStatuses, t],
  );

  return {
    quickBufferPresets,
    formatQuickDistance,
    runLayerQuickTool,
    exportSketchesAsLayer,
    handleCopyStyle,
    handlePasteStyle,
    handleSaveToLibrary,
    handleExportLayer,
    handleExportStyle,
    handleExportGeoLibreStyle,
    handleExportSldStyle,
    handleExportQmlStyle,
    noteImportedStyle,
    handleImportStyle,
    handleSaveEditsToSource,
    handleBindTemporalLayer,
    handleUnbindTimeSlider,
    handleExportRasterLayer,
  };
}

/** The layer action handlers {@link useLayerActions} returns. */
export type LayerActions = ReturnType<typeof useLayerActions>;
