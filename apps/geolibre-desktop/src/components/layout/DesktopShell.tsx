import { useAppStore, type GeoLibreLayer } from "@geolibre/core";
import type { FeatureCollection } from "geojson";
import type { MapController, MapDiagnosticEvent } from "@geolibre/map";
import { MapCanvas } from "@geolibre/map";
import {
  addRasterToMap,
  DECK_VIZ_PLUGIN_ID,
  DIRECTIONS_PLUGIN_ID,
  EFFECTS_PLUGIN_ID,
  endLayerGeometryEdit,
  getGeometryEditTargetLayerId,
  restoreDeckViz,
  restoreDirections,
  restoreReverseGeocode,
  REVERSE_GEOCODE_PLUGIN_ID,
  restoreEffects,
  restoreRasterLayers,
  restoreThreeDTilesLayers,
  restoreVectorLayers,
  startLayerGeometryEdit,
  subscribeGeometryEdit,
} from "@geolibre/plugins";
import {
  type CSSProperties,
  type DragEvent,
  type PointerEvent as ReactPointerEvent,
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  isTauri,
  loadDroppedRasterFiles,
  loadDroppedRasterPaths,
  loadDroppedVectorFiles,
  loadDroppedVectorPaths,
  type DroppedRaster,
} from "../../lib/tauri-io";
import type { LargeVectorDataset } from "../../lib/duckdb-vector-guard";
import i18n from "../../i18n";
import {
  addOsmPbfLayers,
  isOsmPbfFileName,
  loadOsmPbf,
  osmPbfBaseName,
  OSM_PBF_SIZE_WARN_BYTES,
} from "../../lib/osm-pbf-loader";
import {
  createAppAPI,
  getPluginManager,
  useExternalPluginsReady,
} from "../../hooks/usePlugins";
import { registerMbtilesProtocol } from "../../lib/mbtiles";
import { hasReverseGeocodeConsent } from "../../lib/reverse-geocode-consent";
import { registerXyzTileProtocol } from "../../lib/xyz-url";
import { useEmbedBridge } from "../../hooks/useEmbedBridge";
import { RemoteCursorsOverlay } from "./RemoteCursorsOverlay";
import { useCommandBridge } from "../../hooks/useCommandBridge";
import {
  appendDiagnostic,
  useDiagnosticsSnapshot,
} from "../../lib/diagnostics";
import { SectionErrorBoundary } from "../common/error-boundaries";
import { AttributeTable } from "../panels/AttributeTable";
import { LayerPanel } from "../panels/LayerPanel";
import { StylePanel } from "../panels/StylePanel";
import { StoryMapPanel } from "../storymap/StoryMapPanel";
import { StoryMapPresenter } from "../storymap/StoryMapPresenter";
import { DiagnosticsDialog } from "./DiagnosticsDialog";
import { StatusBar } from "./StatusBar";
import { TopToolbar } from "./TopToolbar";
import type { LayoutOptions } from "../../hooks/useLayoutOptions";
import type { ThemeMode } from "../../hooks/useThemeMode";
import type { ProjectUrlLoadState } from "../../hooks/useProjectUrlLoader";

/**
 * Confirm loading a vector source whose feature count tripped the loader's
 * large-dataset guard. Mirrors the OSM PBF drop guard's blocking
 * `window.confirm` (see the handlers below): a `false` return aborts that one
 * file's load without affecting the rest of a multi-file drop.
 */
function confirmLargeVectorDataset({ name, featureCount }: LargeVectorDataset) {
  return window.confirm(
    i18n.t("toolbar.item.largeVectorDesc", {
      name,
      count: featureCount.toLocaleString(),
    }),
  );
}

const ProcessingDialog = lazy(() =>
  import("../processing/ProcessingDialog")
    .then((module) => ({
      default: module.ProcessingDialog,
    }))
    .catch((error) => {
      // A failed chunk load (network error, corrupted bundle) would otherwise
      // throw during render and unmount the whole shell. Fall back to a
      // no-op component so the rest of the app stays interactive.
      console.error("Failed to load ProcessingDialog", error);
      const Fallback = (() =>
        null) as unknown as typeof import("../processing/ProcessingDialog").ProcessingDialog;
      return { default: Fallback };
    }),
);

const ConversionDialog = lazy(() =>
  import("../processing/ConversionDialog")
    .then((module) => ({
      default: module.ConversionDialog,
    }))
    .catch((error) => {
      // Same chunk-load fallback rationale as ProcessingDialog above.
      console.error("Failed to load ConversionDialog", error);
      const Fallback = (() =>
        null) as unknown as typeof import("../processing/ConversionDialog").ConversionDialog;
      return { default: Fallback };
    }),
);

const VectorToolsDialog = lazy(() =>
  import("../processing/VectorToolsDialog")
    .then((module) => ({
      default: module.VectorToolsDialog,
    }))
    .catch((error) => {
      // Same chunk-load fallback rationale as ProcessingDialog above.
      console.error("Failed to load VectorToolsDialog", error);
      const Fallback = (() =>
        null) as unknown as typeof import("../processing/VectorToolsDialog").VectorToolsDialog;
      return { default: Fallback };
    }),
);

const ModelBuilderDialog = lazy(() =>
  import("../processing/ModelBuilderDialog")
    .then((module) => ({
      default: module.ModelBuilderDialog,
    }))
    .catch((error) => {
      // Same chunk-load fallback rationale as ProcessingDialog above.
      console.error("Failed to load ModelBuilderDialog", error);
      const Fallback = (() =>
        null) as unknown as typeof import("../processing/ModelBuilderDialog").ModelBuilderDialog;
      return { default: Fallback };
    }),
);

const NetworkToolsDialog = lazy(() =>
  import("../processing/NetworkToolsDialog")
    .then((module) => ({
      default: module.NetworkToolsDialog,
    }))
    .catch((error) => {
      // Same chunk-load fallback rationale as ProcessingDialog above.
      console.error("Failed to load NetworkToolsDialog", error);
      const Fallback = (() =>
        null) as unknown as typeof import("../processing/NetworkToolsDialog").NetworkToolsDialog;
      return { default: Fallback };
    }),
);

const StatisticsToolsDialog = lazy(() =>
  import("../processing/StatisticsToolsDialog")
    .then((module) => ({
      default: module.StatisticsToolsDialog,
    }))
    .catch((error) => {
      // Same chunk-load fallback rationale as ProcessingDialog above.
      console.error("Failed to load StatisticsToolsDialog", error);
      const Fallback = (() =>
        null) as unknown as typeof import("../processing/StatisticsToolsDialog").StatisticsToolsDialog;
      return { default: Fallback };
    }),
);

const GeocodeDialog = lazy(() =>
  import("../processing/GeocodeDialog")
    .then((module) => ({
      default: module.GeocodeDialog,
    }))
    .catch((error) => {
      // Same chunk-load fallback rationale as ProcessingDialog above.
      console.error("Failed to load GeocodeDialog", error);
      const Fallback = (() =>
        null) as unknown as typeof import("../processing/GeocodeDialog").GeocodeDialog;
      return { default: Fallback };
    }),
);

const RasterToolsDialog = lazy(() =>
  import("../processing/RasterToolsDialog")
    .then((module) => ({
      default: module.RasterToolsDialog,
    }))
    .catch((error) => {
      // Same chunk-load fallback rationale as ProcessingDialog above.
      console.error("Failed to load RasterToolsDialog", error);
      const Fallback = (() =>
        null) as unknown as typeof import("../processing/RasterToolsDialog").RasterToolsDialog;
      return { default: Fallback };
    }),
);

const SegmentationDialog = lazy(() =>
  import("../processing/SegmentationDialog")
    .then((module) => ({
      default: module.SegmentationDialog,
    }))
    .catch((error) => {
      console.error("Failed to load SegmentationDialog", error);
      const Fallback = (() =>
        null) as unknown as typeof import("../processing/SegmentationDialog").SegmentationDialog;
      return { default: Fallback };
    }),
);

const SqlWorkspaceDialog = lazy(() =>
  import("../processing/SqlWorkspaceDialog")
    .then((module) => ({
      default: module.SqlWorkspaceDialog,
    }))
    .catch((error) => {
      // Same chunk-load fallback rationale as ProcessingDialog above.
      console.error("Failed to load SqlWorkspaceDialog", error);
      const Fallback = (() =>
        null) as unknown as typeof import("../processing/SqlWorkspaceDialog").SqlWorkspaceDialog;
      return { default: Fallback };
    }),
);

const NotebookPanel = lazy(() =>
  import("../panels/NotebookPanel")
    .then((module) => ({
      default: module.NotebookPanel,
    }))
    .catch((error) => {
      // Same chunk-load fallback rationale as the dialogs above.
      console.error("Failed to load NotebookPanel", error);
      const Fallback = (() =>
        null) as unknown as typeof import("../panels/NotebookPanel").NotebookPanel;
      return { default: Fallback };
    }),
);

const AssistantPanel = lazy(() =>
  import("../panels/AssistantPanel")
    .then((module) => ({
      default: module.AssistantPanel,
    }))
    .catch((error) => {
      // Same chunk-load fallback rationale as the dialogs above.
      console.error("Failed to load AssistantPanel", error);
      const Fallback = (() =>
        null) as unknown as typeof import("../panels/AssistantPanel").AssistantPanel;
      return { default: Fallback };
    }),
);

const PythonConsolePanel = lazy(() =>
  import("../panels/PythonConsolePanel")
    .then((module) => ({
      default: module.PythonConsolePanel,
    }))
    .catch((error) => {
      // Same chunk-load fallback rationale as the dialogs above.
      console.error("Failed to load PythonConsolePanel", error);
      const Fallback = (() =>
        null) as unknown as typeof import("../panels/PythonConsolePanel").PythonConsolePanel;
      return { default: Fallback };
    }),
);

interface DesktopShellProps {
  layoutOptions: LayoutOptions;
  projectUrlLoadState?: ProjectUrlLoadState;
  themeMode: ThemeMode;
  onToggleThemeMode: () => void;
}

function hasDroppedFiles(event: DragEvent<HTMLElement>): boolean {
  return Array.from(event.dataTransfer.types).includes("Files");
}

function fileNameFromPath(path: string): string {
  return path.split(/[/\\]/).pop() ?? path;
}

function layerNameFromPath(path: string): string {
  return fileNameFromPath(path).replace(/\.[^.]+$/, "") || "Vector Layer";
}

type ImportedVectorLayer = Awaited<
  ReturnType<typeof loadDroppedVectorFiles>
>[number];

const DEFAULT_SIDE_PANEL_WIDTH = 256;
const MIN_SIDE_PANEL_WIDTH = 180;
const MAX_SIDE_PANEL_WIDTH = 460;
// The notebook panel hosts a full Jupyter UI, so it needs far more room than
// the layer/style side panels.
const DEFAULT_NOTEBOOK_PANEL_WIDTH = 480;
const MIN_NOTEBOOK_PANEL_WIDTH = 320;
const MAX_NOTEBOOK_PANEL_WIDTH = 1100;
const PANEL_RESIZE_START_EVENT = "geolibre:panel-resize-start";
const PANEL_RESIZE_END_EVENT = "geolibre:panel-resize-end";

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

type ShellStyle = CSSProperties &
  Record<
    "--layer-panel-width" | "--style-panel-width" | "--notebook-panel-width",
    string
  >;

export function DesktopShell({
  layoutOptions,
  projectUrlLoadState,
  themeMode,
  onToggleThemeMode,
}: DesktopShellProps) {
  const shellRef = useRef<HTMLDivElement>(null);
  const verticalResizeGuideRef = useRef<HTMLDivElement>(null);
  // Teardown for an in-progress panel resize, so a pointercancel or an unmount
  // mid-drag still detaches the global listeners and restores document.body.
  const activeResizeCleanupRef = useRef<(() => void) | null>(null);
  useEffect(() => () => activeResizeCleanupRef.current?.(), []);
  const mapControllerRef = useRef<MapController | null>(null);
  const dragDepthRef = useRef(0);
  const dropMessageTimeoutRef = useRef<number | null>(null);
  const materializingRef = useRef(false);
  const togglingGeometryEditRef = useRef(false);
  const addGeoJsonLayer = useAppStore((s) => s.addGeoJsonLayer);
  const projectGeneration = useAppStore((s) => s.projectGeneration);
  const pythonConsoleOpen = useAppStore((s) => s.ui.pythonConsoleOpen);
  const notebookOpen = useAppStore((s) => s.ui.notebookOpen);
  const assistantOpen = useAppStore((s) => s.ui.assistantOpen);
  const geometryEditLayerId = useSyncExternalStore(
    subscribeGeometryEdit,
    getGeometryEditTargetLayerId,
  );
  const [isDraggingFiles, setIsDraggingFiles] = useState(false);
  const [mapReadyGeneration, setMapReadyGeneration] = useState(0);
  const [dropMessage, setDropMessage] = useState<string | null>(null);
  const [dropError, setDropError] = useState<string | null>(null);
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const diagnostics = useDiagnosticsSnapshot();
  const externalPluginsReady = useExternalPluginsReady(mapControllerRef);
  // Sync the project with an embedding host (the GeoLibre Jupyter widget) over
  // postMessage. Inert when the app is not embedded.
  useEmbedBridge(mapControllerRef);
  // Request/reply + event channel backing the Python scripting API (live
  // queries, processing, map events). Also inert when not embedded.
  useCommandBridge(mapControllerRef);
  const [layerPanelWidth, setLayerPanelWidth] = useState(
    DEFAULT_SIDE_PANEL_WIDTH,
  );
  const [stylePanelWidth, setStylePanelWidth] = useState(
    DEFAULT_SIDE_PANEL_WIDTH,
  );
  const [notebookPanelWidth, setNotebookPanelWidth] = useState(
    DEFAULT_NOTEBOOK_PANEL_WIDTH,
  );
  const deferPanelResize = isTauri();
  const shellStyle: ShellStyle = {
    "--layer-panel-width": `${layerPanelWidth}px`,
    "--style-panel-width": `${stylePanelWidth}px`,
    "--notebook-panel-width": `${notebookPanelWidth}px`,
  };

  const clearDropMessageLater = useCallback(() => {
    if (dropMessageTimeoutRef.current !== null) {
      window.clearTimeout(dropMessageTimeoutRef.current);
    }
    dropMessageTimeoutRef.current = window.setTimeout(() => {
      dropMessageTimeoutRef.current = null;
      setDropMessage(null);
      setDropError(null);
    }, 4000);
  }, []);

  const ensureLayerGeojsonFromSource = useCallback(async (layerId: string) => {
    const layer = useAppStore
      .getState()
      .layers.find((candidate) => candidate.id === layerId);
    if (!layer || layer.geojson) return;
    const sourceIds = layer.metadata.sourceIds;
    const sourceId = Array.isArray(sourceIds) ? sourceIds[0] : undefined;
    if (typeof sourceId !== "string") return;
    const source = mapControllerRef.current?.getMap()?.getSource(sourceId) as
      | { getData?: () => Promise<unknown> }
      | undefined;
    if (!source || typeof source.getData !== "function") return;
    try {
      const data = await source.getData();
      if (
        data &&
        typeof data === "object" &&
        (data as { type?: string }).type === "FeatureCollection"
      ) {
        useAppStore
          .getState()
          .updateLayer(layerId, { geojson: data as FeatureCollection });
      }
    } catch {
      // Best effort; startLayerGeometryEdit will fail and surface an error.
    }
  }, []);

  const handleToggleGeometryEdit = useCallback(
    async (layerId: string) => {
      const appAPI = createAppAPI(mapControllerRef);
      if (getGeometryEditTargetLayerId() === layerId) {
        await endLayerGeometryEdit(appAPI, { save: true });
        return;
      }
      // Guard against concurrent invocations: this handler awaits before it sets
      // the session target, so two rapid clicks could otherwise both pass the
      // check above and race into startLayerGeometryEdit for different layers.
      if (togglingGeometryEditRef.current) return;
      togglingGeometryEditRef.current = true;
      // Clear any stale error from a previous failed attempt.
      setDropError(null);
      try {
        // Add Vector Layer (geojson-mode) layers keep their features in a
        // MapLibre source rather than in `layer.geojson`. Read them back once so
        // the editor has features to load. (Plain geojson layers already have
        // `geojson`.)
        await ensureLayerGeojsonFromSource(layerId);
        const manager = getPluginManager();
        if (!manager.isActive("maplibre-gl-geo-editor")) {
          manager.activate("maplibre-gl-geo-editor", appAPI);
          if (!manager.isActive("maplibre-gl-geo-editor")) {
            setDropError(
              "Could not activate the geometry editor. Try again once the map has fully loaded.",
            );
            clearDropMessageLater();
            return;
          }
        }
        const started = await startLayerGeometryEdit(appAPI, layerId);
        if (!started) {
          setDropError(
            "Could not start geometry editing for this layer. Its data may still be loading.",
          );
          clearDropMessageLater();
        }
      } finally {
        togglingGeometryEditRef.current = false;
      }
    },
    [clearDropMessageLater, ensureLayerGeojsonFromSource],
  );

  const handleCancelGeometryEdit = useCallback(() => {
    void endLayerGeometryEdit(createAppAPI(mapControllerRef), { save: false });
  }, []);

  const handleMaterializeDuckDBLayer = useCallback(
    async (layer: GeoLibreLayer) => {
      // Guard against concurrent triggers (double-click, or two layers in quick
      // succession) so we do not add duplicate materialized layers.
      if (materializingRef.current) return;
      const query =
        typeof layer.metadata.query === "string" ? layer.metadata.query : null;
      if (!query) {
        setDropError("This DuckDB layer has no stored query to materialize.");
        clearDropMessageLater();
        return;
      }
      materializingRef.current = true;
      setDropError(null);
      setDropMessage("Materializing DuckDB layer...");
      try {
        // The query is the layer's own stored SQL from the user's project; it is
        // intentionally run unrestricted against the in-memory DuckDB instance.
        // Import the DuckDB-WASM engine lazily here, not at module load: a static
        // import would pull the heavy `@duckdb/duckdb-wasm` chunk into the app's
        // boot graph (DesktopShell is eagerly imported by App), which then has to
        // load before the shell renders. That broke the offline cold boot — the
        // chunk is runtime-cached, not precached, so a cache miss failed the boot
        // and the map never mounted (see e2e/pwa.spec.ts). Loading it on first
        // materialize keeps DuckDB out of the offline-critical boot path.
        const { runSqlQuery } = await import("../../lib/sql-workspace");
        const result = await runSqlQuery(query, useAppStore.getState().layers);
        if (!result.geojson) {
          throw new Error("The query did not return a geometry column.");
        }
        const id = addGeoJsonLayer(`${layer.name} (editable)`, result.geojson);
        const created = useAppStore
          .getState()
          .layers.find((candidate) => candidate.id === id);
        if (created) mapControllerRef.current?.fitLayer(created);
        setDropMessage(
          `Materialized ${result.geojson.features.length.toLocaleString()} features.`,
        );
      } catch (error) {
        setDropMessage(null);
        setDropError(
          error instanceof Error
            ? error.message
            : "Could not materialize this layer.",
        );
      } finally {
        materializingRef.current = false;
        clearDropMessageLater();
      }
    },
    [addGeoJsonLayer, clearDropMessageLater],
  );

  useEffect(() => {
    if (isTauri()) {
      registerMbtilesProtocol();
      registerXyzTileProtocol();
    }
  }, []);

  useEffect(() => {
    // Restoration should run only when a project is loaded (projectGeneration)
    // or the map is reinitialised (mapReadyGeneration), not on every
    // incremental plugin write-back. projectPlugins is read from the store
    // snapshot at call time so it is always current without being a dependency.
    if (
      !externalPluginsReady ||
      !mapReadyGeneration ||
      !mapControllerRef.current
    )
      return;
    const appAPI = createAppAPI(mapControllerRef);
    const pluginManager = getPluginManager();
    pluginManager.restoreProjectState(
      useAppStore.getState().projectPlugins,
      appAPI,
    );
    restoreThreeDTilesLayers(appAPI);
    restoreRasterLayers(appAPI);
    restoreVectorLayers(appAPI);
    // activeByDefault plugins are marked active without activate() being
    // called, so the effects engine must be kicked explicitly to match the
    // restored active state (idempotent).
    restoreEffects(appAPI, pluginManager.isActive(EFFECTS_PLUGIN_ID));
    // Rebind the directions tool to the (possibly new) map instance after a
    // map re-init, since restoreProjectState skips an already-active plugin.
    restoreDirections(appAPI, pluginManager.isActive(DIRECTIONS_PLUGIN_ID));
    // Reverse geocode sends clicked coordinates to a public geocoder. If a
    // restored project marks it active but this device never acknowledged the
    // privacy notice, deactivate it so no coordinates are sent without consent;
    // the user must re-enable it (which shows the notice). This makes the
    // consent gate cover every activation path, not just the toolbar toggle.
    if (
      pluginManager.isActive(REVERSE_GEOCODE_PLUGIN_ID) &&
      !hasReverseGeocodeConsent()
    ) {
      pluginManager.deactivate(REVERSE_GEOCODE_PLUGIN_ID, appAPI);
    }
    restoreReverseGeocode(
      appAPI,
      pluginManager.isActive(REVERSE_GEOCODE_PLUGIN_ID),
    );
    // Same contract for the deck.gl overlay: re-attach it to the current map
    // and re-render any deckgl-viz layers a restored project carries.
    restoreDeckViz(appAPI, pluginManager.isActive(DECK_VIZ_PLUGIN_ID));
    const search = window.location.search;
    void pluginManager
      .handleUrlParameters(
        new URLSearchParams(search),
        appAPI,
        `${projectGeneration}:${search}`,
      )
      .catch(console.error);
  }, [externalPluginsReady, mapReadyGeneration, projectGeneration]);

  useEffect(() => {
    return () => {
      if (dropMessageTimeoutRef.current !== null) {
        window.clearTimeout(dropMessageTimeoutRef.current);
      }
    };
  }, []);

  const handleMapControllerReady = useCallback(() => {
    setMapReadyGeneration((generation) => generation + 1);
  }, []);

  const handleMapDiagnosticEvent = useCallback((event: MapDiagnosticEvent) => {
    appendDiagnostic({
      category: "map",
      level: "error",
      message: event.message,
      detail: event.detail,
      source: event.source,
      status: event.status,
      url: event.url,
    });
  }, []);

  const addImportedVectorLayers = useCallback(
    (importedLayers: ImportedVectorLayer[]) => {
      let lastLayerId: string | null = null;
      for (const layer of importedLayers) {
        lastLayerId = addGeoJsonLayer(
          layer.name ?? layerNameFromPath(layer.path),
          layer.data,
          layer.path,
        );
      }

      const importedLayer = useAppStore
        .getState()
        .layers.find((layer) => layer.id === lastLayerId);
      if (importedLayer) mapControllerRef.current?.fitLayer(importedLayer);
    },
    [addGeoJsonLayer],
  );

  const addDroppedRasters = useCallback(
    async (rasters: DroppedRaster[]): Promise<number> => {
      if (!rasters.length) return 0;
      const appAPI = createAppAPI(mapControllerRef);
      for (const raster of rasters) {
        await addRasterToMap(appAPI, raster.source, { name: raster.name });
      }
      return rasters.length;
    },
    [],
  );

  const finishDrop = useCallback(
    (importedLayers: ImportedVectorLayer[], rasterCount: number) => {
      if (!importedLayers.length && !rasterCount) {
        throw new Error("Drop a supported vector or raster file.");
      }
      if (importedLayers.length) addImportedVectorLayers(importedLayers);
      const parts: string[] = [];
      if (importedLayers.length) {
        parts.push(
          `${importedLayers.length} vector layer${
            importedLayers.length === 1 ? "" : "s"
          }`,
        );
      }
      if (rasterCount) {
        parts.push(`${rasterCount} raster layer${rasterCount === 1 ? "" : "s"}`);
      }
      setDropMessage(`Added ${parts.join(" and ")}.`);
    },
    [addImportedVectorLayers],
  );

  useEffect(() => {
    if (!isTauri()) return;

    let unlisten: (() => void) | null = null;
    let disposed = false;

    void import("@tauri-apps/api/webview").then(({ getCurrentWebview }) => {
      if (disposed) return;
      void getCurrentWebview()
        .onDragDropEvent(async (event) => {
          if (event.payload.type === "enter" || event.payload.type === "over") {
            setIsDraggingFiles(true);
            return;
          }

          if (event.payload.type === "leave") {
            setIsDraggingFiles(false);
            return;
          }

          setIsDraggingFiles(false);
          setDropError(null);
          setDropMessage("Importing data...");

          try {
            const paths = event.payload.paths;
            // OSM PBF files split into three layers, so they bypass the normal
            // single-FeatureCollection pipeline (which would otherwise route a
            // .pbf to DuckDB ST_Read and merge it).
            const pbfPaths = paths.filter((path) => isOsmPbfFileName(path));
            const otherPaths = paths.filter(
              (path) => !isOsmPbfFileName(path),
            );

            if (pbfPaths.length > 0) {
              const { readFile, stat } = await import("@tauri-apps/plugin-fs");
              for (const path of pbfPaths) {
                const name = path.split(/[/\\]/).pop() || "osm";
                try {
                  // Check the size via metadata before reading the file into
                  // memory, so the guard runs before a huge extract is loaded.
                  const { size } = await stat(path);
                  if (size >= OSM_PBF_SIZE_WARN_BYTES) {
                    const sizeMb = Math.round(size / (1024 * 1024));
                    // window.confirm is blocking and adequate here; note that a
                    // few webview builds may suppress JS dialogs, in which case
                    // it returns false and the file is skipped.
                    if (
                      !window.confirm(
                        `${name} is about ${sizeMb} MB. Parsing it may use a lot of memory. Continue?`,
                      )
                    ) {
                      continue;
                    }
                  }
                  setDropMessage(`Parsing ${name}…`);
                  const bytes = await readFile(path);
                  // Guard against a subview Uint8Array: .buffer would include
                  // extra bytes and corrupt the parse, so slice to the exact view.
                  const buffer =
                    bytes.byteOffset === 0 &&
                    bytes.byteLength === bytes.buffer.byteLength
                      ? (bytes.buffer as ArrayBuffer)
                      : (bytes.buffer.slice(
                          bytes.byteOffset,
                          bytes.byteOffset + bytes.byteLength,
                        ) as ArrayBuffer);
                  const layers = await loadOsmPbf(buffer);
                  const added = addOsmPbfLayers(
                    addGeoJsonLayer,
                    osmPbfBaseName(name),
                    path,
                    layers,
                  );
                  if (added > 0 && layers.bounds) {
                    mapControllerRef.current?.fitBounds(layers.bounds);
                  }
                  setDropMessage(
                    added > 0
                      ? `Added ${added} layer${added === 1 ? "" : "s"} from ${name}.`
                      : `No features found in ${name}.`,
                  );
                } catch (err) {
                  // Isolate per-file failures so one bad PBF doesn't abandon the
                  // rest of the drop.
                  setDropMessage(null);
                  setDropError(
                    `Could not parse ${name}: ${err instanceof Error ? err.message : String(err)}`,
                  );
                }
              }
            }

            if (otherPaths.length > 0) {
              const rasterCount = await addDroppedRasters(
                await loadDroppedRasterPaths(otherPaths),
              );
              const importedLayers = await loadDroppedVectorPaths(otherPaths, {
                onLargeDataset: confirmLargeVectorDataset,
              });
              // See the browser handler: skip finishDrop's empty-input error
              // when PBF files were present (even if rejected/failed).
              if (
                importedLayers.length > 0 ||
                rasterCount > 0 ||
                pbfPaths.length === 0
              ) {
                finishDrop(importedLayers, rasterCount);
              }
            }
          } catch (error) {
            setDropMessage(null);
            setDropError(
              error instanceof Error
                ? error.message
                : "Could not import files.",
            );
          } finally {
            clearDropMessageLater();
          }
        })
        .then((nextUnlisten) => {
          if (disposed) {
            nextUnlisten();
          } else {
            unlisten = nextUnlisten;
          }
        })
        .catch((error) => {
          console.warn("Could not attach Tauri drag and drop handler", error);
        });
    });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [clearDropMessageLater, finishDrop, addDroppedRasters, addGeoJsonLayer]);

  const handleDragEnter = useCallback((event: DragEvent<HTMLDivElement>) => {
    if (!hasDroppedFiles(event)) return;
    event.preventDefault();
    dragDepthRef.current += 1;
    setIsDraggingFiles(true);
  }, []);

  const handleDragOver = useCallback((event: DragEvent<HTMLDivElement>) => {
    if (!hasDroppedFiles(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  }, []);

  const handleDragLeave = useCallback((event: DragEvent<HTMLDivElement>) => {
    if (!hasDroppedFiles(event)) return;
    event.preventDefault();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setIsDraggingFiles(false);
  }, []);

  const handleDrop = useCallback(
    async (event: DragEvent<HTMLDivElement>) => {
      if (!hasDroppedFiles(event)) return;
      event.preventDefault();
      dragDepthRef.current = 0;
      setIsDraggingFiles(false);
      setDropError(null);
      setDropMessage("Importing data...");

      try {
        const allFiles = Array.from(event.dataTransfer.files);
        // OSM PBF files produce three separate layers (points/lines/polygons),
        // so they bypass the single-FeatureCollection vector drop pipeline.
        // Handle them first, then run the rest through the normal pipeline —
        // finishDrop throws on an empty list, so only call it when non-PBF
        // files were dropped.
        const pbfFiles = allFiles.filter((file) => isOsmPbfFileName(file.name));
        const otherFiles = allFiles.filter(
          (file) => !isOsmPbfFileName(file.name),
        );

        for (const file of pbfFiles) {
          // Mirror the file-picker path's large-file guard (parsing a huge
          // extract can exhaust memory even off the main thread).
          if (file.size >= OSM_PBF_SIZE_WARN_BYTES) {
            const sizeMb = Math.round(file.size / (1024 * 1024));
            if (
              !window.confirm(
                `${file.name} is about ${sizeMb} MB. Parsing it may use a lot of memory. Continue?`,
              )
            ) {
              continue;
            }
          }
          setDropMessage(`Parsing ${file.name}…`);
          let layers;
          try {
            layers = await loadOsmPbf(await file.arrayBuffer());
          } catch (err) {
            // Isolate per-file failures so one bad PBF doesn't abandon the rest
            // of the drop (including any co-dropped non-PBF files).
            setDropMessage(null);
            setDropError(
              `Could not parse ${file.name}: ${err instanceof Error ? err.message : String(err)}`,
            );
            continue;
          }
          const added = addOsmPbfLayers(
            addGeoJsonLayer,
            osmPbfBaseName(file.name),
            file.name,
            layers,
          );
          if (added > 0 && layers.bounds) {
            mapControllerRef.current?.fitBounds(layers.bounds);
          }
          setDropMessage(
            added > 0
              ? `Added ${added} layer${added === 1 ? "" : "s"} from ${file.name}.`
              : `No features found in ${file.name}.`,
          );
        }

        if (otherFiles.length > 0) {
          const rasterCount = await addDroppedRasters(
            loadDroppedRasterFiles(otherFiles),
          );
          const importedLayers = await loadDroppedVectorFiles(otherFiles, {
            onLargeDataset: confirmLargeVectorDataset,
          });
          // Call finishDrop (which reports success or throws the empty-input
          // error) only when the other files produced something, or when the
          // drop contained no PBF files at all. If PBF files were present —
          // even if they were all rejected or failed — its empty-input error
          // would wrongly clobber the PBF outcome.
          if (
            importedLayers.length > 0 ||
            rasterCount > 0 ||
            pbfFiles.length === 0
          ) {
            finishDrop(importedLayers, rasterCount);
          }
        }
      } catch (error) {
        setDropMessage(null);
        setDropError(
          error instanceof Error ? error.message : "Could not import files.",
        );
      } finally {
        clearDropMessageLater();
      }
    },
    [clearDropMessageLater, finishDrop, addDroppedRasters, addGeoJsonLayer],
  );

  const startLayerPanelResize = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      event.stopPropagation();
      // Route all pointer events for this drag to the handle, so a touch that
      // slides off it (or off-screen) still reaches the listeners below.
      event.currentTarget.setPointerCapture?.(event.pointerId);

      const startX = event.clientX;
      const startWidth = layerPanelWidth;
      const panelRect =
        event.currentTarget.parentElement?.getBoundingClientRect();
      let nextWidth = startWidth;
      let resizeFrame: number | null = null;
      const previousCursor = document.body.style.cursor;
      const previousUserSelect = document.body.style.userSelect;
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      window.dispatchEvent(new Event(PANEL_RESIZE_START_EVENT));

      const onPointerMove = (moveEvent: PointerEvent) => {
        nextWidth = clamp(
          startWidth + moveEvent.clientX - startX,
          MIN_SIDE_PANEL_WIDTH,
          MAX_SIDE_PANEL_WIDTH,
        );
        if (resizeFrame !== null) return;
        resizeFrame = window.requestAnimationFrame(() => {
          resizeFrame = null;
          if (deferPanelResize) {
            if (verticalResizeGuideRef.current && panelRect) {
              verticalResizeGuideRef.current.style.left = `${
                panelRect.left + nextWidth
              }px`;
              verticalResizeGuideRef.current.classList.remove("hidden");
            }
            return;
          }
          shellRef.current?.style.setProperty(
            "--layer-panel-width",
            `${nextWidth}px`,
          );
        });
      };

      const onPointerUp = () => {
        window.removeEventListener("pointermove", onPointerMove);
        window.removeEventListener("pointerup", onPointerUp);
        window.removeEventListener("pointercancel", onPointerUp);
        activeResizeCleanupRef.current = null;
        if (resizeFrame !== null) {
          window.cancelAnimationFrame(resizeFrame);
          resizeFrame = null;
        }
        shellRef.current?.style.setProperty(
          "--layer-panel-width",
          `${nextWidth}px`,
        );
        verticalResizeGuideRef.current?.classList.add("hidden");
        setLayerPanelWidth(nextWidth);
        window.dispatchEvent(new Event(PANEL_RESIZE_END_EVENT));
        document.body.style.cursor = previousCursor;
        document.body.style.userSelect = previousUserSelect;
      };

      // pointercancel fires when the gesture is interrupted (OS scroll, app
      // backgrounded); run the same teardown so styles/listeners don't stick.
      activeResizeCleanupRef.current = onPointerUp;
      window.addEventListener("pointermove", onPointerMove);
      window.addEventListener("pointerup", onPointerUp);
      window.addEventListener("pointercancel", onPointerUp);
    },
    [deferPanelResize, layerPanelWidth],
  );

  const startStylePanelResize = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      event.stopPropagation();
      // Route all pointer events for this drag to the handle, so a touch that
      // slides off it (or off-screen) still reaches the listeners below.
      event.currentTarget.setPointerCapture?.(event.pointerId);

      const startX = event.clientX;
      const startWidth = stylePanelWidth;
      const panelRect =
        event.currentTarget.parentElement?.getBoundingClientRect();
      let nextWidth = startWidth;
      let resizeFrame: number | null = null;
      const previousCursor = document.body.style.cursor;
      const previousUserSelect = document.body.style.userSelect;
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      window.dispatchEvent(new Event(PANEL_RESIZE_START_EVENT));

      const onPointerMove = (moveEvent: PointerEvent) => {
        nextWidth = clamp(
          startWidth + startX - moveEvent.clientX,
          MIN_SIDE_PANEL_WIDTH,
          MAX_SIDE_PANEL_WIDTH,
        );
        if (resizeFrame !== null) return;
        resizeFrame = window.requestAnimationFrame(() => {
          resizeFrame = null;
          if (deferPanelResize) {
            if (verticalResizeGuideRef.current && panelRect) {
              verticalResizeGuideRef.current.style.left = `${
                panelRect.right - nextWidth
              }px`;
              verticalResizeGuideRef.current.classList.remove("hidden");
            }
            return;
          }
          shellRef.current?.style.setProperty(
            "--style-panel-width",
            `${nextWidth}px`,
          );
        });
      };

      const onPointerUp = () => {
        window.removeEventListener("pointermove", onPointerMove);
        window.removeEventListener("pointerup", onPointerUp);
        window.removeEventListener("pointercancel", onPointerUp);
        activeResizeCleanupRef.current = null;
        if (resizeFrame !== null) {
          window.cancelAnimationFrame(resizeFrame);
          resizeFrame = null;
        }
        shellRef.current?.style.setProperty(
          "--style-panel-width",
          `${nextWidth}px`,
        );
        verticalResizeGuideRef.current?.classList.add("hidden");
        setStylePanelWidth(nextWidth);
        window.dispatchEvent(new Event(PANEL_RESIZE_END_EVENT));
        document.body.style.cursor = previousCursor;
        document.body.style.userSelect = previousUserSelect;
      };

      // pointercancel fires when the gesture is interrupted (OS scroll, app
      // backgrounded); run the same teardown so styles/listeners don't stick.
      activeResizeCleanupRef.current = onPointerUp;
      window.addEventListener("pointermove", onPointerMove);
      window.addEventListener("pointerup", onPointerUp);
      window.addEventListener("pointercancel", onPointerUp);
    },
    [deferPanelResize, stylePanelWidth],
  );

  // The notebook panel is right-docked like the Style panel, so its left-edge
  // handle widens the panel as the pointer moves left (mirrors
  // startStylePanelResize, with the notebook's own width constants/CSS var).
  const startNotebookPanelResize = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      event.stopPropagation();
      event.currentTarget.setPointerCapture?.(event.pointerId);

      const startX = event.clientX;
      const startWidth = notebookPanelWidth;
      const panelRect =
        event.currentTarget.parentElement?.getBoundingClientRect();
      let nextWidth = startWidth;
      let resizeFrame: number | null = null;
      const previousCursor = document.body.style.cursor;
      const previousUserSelect = document.body.style.userSelect;
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      window.dispatchEvent(new Event(PANEL_RESIZE_START_EVENT));

      const onPointerMove = (moveEvent: PointerEvent) => {
        nextWidth = clamp(
          startWidth + startX - moveEvent.clientX,
          MIN_NOTEBOOK_PANEL_WIDTH,
          MAX_NOTEBOOK_PANEL_WIDTH,
        );
        if (resizeFrame !== null) return;
        resizeFrame = window.requestAnimationFrame(() => {
          resizeFrame = null;
          if (deferPanelResize) {
            if (verticalResizeGuideRef.current && panelRect) {
              verticalResizeGuideRef.current.style.left = `${
                panelRect.right - nextWidth
              }px`;
              verticalResizeGuideRef.current.classList.remove("hidden");
            }
            return;
          }
          shellRef.current?.style.setProperty(
            "--notebook-panel-width",
            `${nextWidth}px`,
          );
        });
      };

      const onPointerUp = () => {
        window.removeEventListener("pointermove", onPointerMove);
        window.removeEventListener("pointerup", onPointerUp);
        window.removeEventListener("pointercancel", onPointerUp);
        activeResizeCleanupRef.current = null;
        if (resizeFrame !== null) {
          window.cancelAnimationFrame(resizeFrame);
          resizeFrame = null;
        }
        shellRef.current?.style.setProperty(
          "--notebook-panel-width",
          `${nextWidth}px`,
        );
        verticalResizeGuideRef.current?.classList.add("hidden");
        setNotebookPanelWidth(nextWidth);
        window.dispatchEvent(new Event(PANEL_RESIZE_END_EVENT));
        document.body.style.cursor = previousCursor;
        document.body.style.userSelect = previousUserSelect;
      };

      activeResizeCleanupRef.current = onPointerUp;
      window.addEventListener("pointermove", onPointerMove);
      window.addEventListener("pointerup", onPointerUp);
      window.addEventListener("pointercancel", onPointerUp);
    },
    [deferPanelResize, notebookPanelWidth],
  );

  return (
    <div
      ref={shellRef}
      className="relative flex h-full min-w-0 flex-col overflow-hidden bg-background"
      style={shellStyle}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      {layoutOptions.toolbarVisible ? (
        <SectionErrorBoundary label="Toolbar">
          <TopToolbar
            compact={layoutOptions.compact}
            diagnosticsErrorCount={diagnostics.errorCount}
            mapControllerRef={mapControllerRef}
            showLabels={layoutOptions.toolbarLabels}
            showProjectInfo={layoutOptions.showProjectInfo}
            themeMode={themeMode}
            onOpenDiagnostics={() => setDiagnosticsOpen(true)}
            onToggleThemeMode={onToggleThemeMode}
          />
        </SectionErrorBoundary>
      ) : null}
      <div className="relative flex min-h-0 flex-1 flex-col md:flex-row">
        {layoutOptions.layerPanelVisible ? (
          <SectionErrorBoundary label="Layer panel">
            <LayerPanel
              mapControllerRef={mapControllerRef}
              onResizeStart={startLayerPanelResize}
              geometryEditLayerId={geometryEditLayerId}
              onToggleGeometryEdit={handleToggleGeometryEdit}
              onCancelGeometryEdit={handleCancelGeometryEdit}
              onMaterializeDuckDBLayer={handleMaterializeDuckDBLayer}
            />
          </SectionErrorBoundary>
        ) : null}
        <main
          className={`relative min-w-0 flex-1 overflow-hidden ${
            layoutOptions.compact ? "min-h-0" : "min-h-72 md:min-h-0"
          }`}
        >
          {/* Visually-hidden page title: gives the document the single
              top-level heading that assistive tech (and the axe
              `page-has-heading-one` check) expect, without altering the
              chrome-free visual layout. Placed inside the main landmark so it
              is not flagged as content outside a landmark. */}
          <h1 className="sr-only">GeoLibre map workspace</h1>
          <SectionErrorBoundary label="Map" fallbackClassName="h-full w-full">
            <MapCanvas
              controllerRef={mapControllerRef}
              onMapDiagnosticEvent={handleMapDiagnosticEvent}
              onControllerReady={handleMapControllerReady}
            />
            <RemoteCursorsOverlay mapControllerRef={mapControllerRef} />
          </SectionErrorBoundary>
        </main>
        {layoutOptions.stylePanelVisible ? (
          <SectionErrorBoundary label="Style panel">
            <StylePanel
              mapControllerRef={mapControllerRef}
              onResizeStart={startStylePanelResize}
            />
          </SectionErrorBoundary>
        ) : null}
        {notebookOpen ? (
          <SectionErrorBoundary label="Notebook">
            <Suspense fallback={null}>
              <NotebookPanel
                onResizeStart={startNotebookPanelResize}
                mapControllerRef={mapControllerRef}
                themeMode={themeMode}
              />
            </Suspense>
          </SectionErrorBoundary>
        ) : null}
      </div>
      {layoutOptions.attributePanelVisible ? (
        <SectionErrorBoundary label="Attribute table">
          <AttributeTable mapControllerRef={mapControllerRef} />
        </SectionErrorBoundary>
      ) : null}
      {pythonConsoleOpen ? (
        <SectionErrorBoundary label="Python console">
          <Suspense fallback={null}>
            <PythonConsolePanel mapControllerRef={mapControllerRef} />
          </Suspense>
        </SectionErrorBoundary>
      ) : null}
      {assistantOpen ? (
        <SectionErrorBoundary label="Assistant">
          <Suspense fallback={null}>
            <AssistantPanel mapControllerRef={mapControllerRef} />
          </Suspense>
        </SectionErrorBoundary>
      ) : null}
      {layoutOptions.statusBarVisible ? (
        <SectionErrorBoundary label="Status bar">
          <StatusBar
            compact={layoutOptions.compact}
            diagnosticsErrorCount={diagnostics.errorCount}
            diagnosticsWarningCount={diagnostics.warningCount}
            onOpenDiagnostics={() => setDiagnosticsOpen(true)}
          />
        </SectionErrorBoundary>
      ) : null}
      <DiagnosticsDialog
        diagnostics={diagnostics}
        open={diagnosticsOpen}
        onOpenChange={setDiagnosticsOpen}
      />
      <Suspense fallback={null}>
        <ProcessingDialog mapControllerRef={mapControllerRef} />
      </Suspense>
      <Suspense fallback={null}>
        <ConversionDialog />
      </Suspense>
      <Suspense fallback={null}>
        <VectorToolsDialog mapControllerRef={mapControllerRef} />
      </Suspense>
      <Suspense fallback={null}>
        <NetworkToolsDialog mapControllerRef={mapControllerRef} />
      </Suspense>
      <Suspense fallback={null}>
        <ModelBuilderDialog mapControllerRef={mapControllerRef} />
      </Suspense>
      <Suspense fallback={null}>
        <StatisticsToolsDialog mapControllerRef={mapControllerRef} />
      </Suspense>
      <Suspense fallback={null}>
        <GeocodeDialog mapControllerRef={mapControllerRef} />
      </Suspense>
      <Suspense fallback={null}>
        <RasterToolsDialog mapControllerRef={mapControllerRef} />
      </Suspense>
      <Suspense fallback={null}>
        <SegmentationDialog mapControllerRef={mapControllerRef} />
      </Suspense>
      <Suspense fallback={null}>
        <SqlWorkspaceDialog />
      </Suspense>
      <StoryMapPanel mapControllerRef={mapControllerRef} />
      <StoryMapPresenter mapControllerRef={mapControllerRef} />
      <div
        ref={verticalResizeGuideRef}
        className="pointer-events-none fixed bottom-7 top-11 z-50 hidden w-px bg-primary shadow-[0_0_0_1px_hsl(var(--primary)/0.25)]"
      />
      {isDraggingFiles ? (
        <div className="pointer-events-none absolute inset-0 z-50 flex items-center justify-center bg-background/70 backdrop-blur-sm">
          <div className="rounded-md border bg-background px-4 py-3 text-sm font-medium shadow-lg">
            Drop vector or raster files to add layers
          </div>
        </div>
      ) : null}
      {projectUrlLoadState?.message || projectUrlLoadState?.error ? (
        <div
          aria-live="polite"
          className={`pointer-events-none absolute left-1/2 top-14 z-50 max-w-[min(90vw,32rem)] -translate-x-1/2 rounded-md border bg-background px-3 py-2 text-center text-sm shadow-lg ${
            projectUrlLoadState.error ? "text-destructive" : "text-foreground"
          }`}
        >
          {projectUrlLoadState.error ?? projectUrlLoadState.message}
        </div>
      ) : null}
      {dropMessage || dropError ? (
        <div
          aria-live="polite"
          className={`pointer-events-none absolute bottom-10 left-1/2 z-50 -translate-x-1/2 rounded-md border bg-background px-3 py-2 text-sm shadow-lg ${
            dropError ? "text-destructive" : "text-foreground"
          }`}
        >
          {dropError ?? dropMessage}
        </div>
      ) : null}
    </div>
  );
}
