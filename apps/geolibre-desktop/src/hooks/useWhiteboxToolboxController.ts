import { downloadBytes } from "../lib/download-bytes";
import { useSidecarJobCancellation } from "./useSidecarJobCancellation";
import {
  shouldZoomToNewLayers,
  useAppStore,
  useLayersWhen,
  type GeoLibreLayer,
} from "@geolibre/core";
import { getLayerBounds, type MapEngine } from "@geolibre/map";
import {
  clearRemoteWhiteboxCatalogSnapshotCache,
  cancelWhiteboxJob,
  fetchWhiteboxJob,
  fetchWhiteboxJsonOutput,
  fetchRemoteWhiteboxCatalogSnapshot,
  fetchWhiteboxStatus,
  fetchWhiteboxTools,
  listWasmToolManifests,
  mergeWasmToolManifests,
  runWhiteboxTool,
  runWhiteboxToolWasm,
  outputBaseName,
  isLas,
  lidarBytesExtension,
  type WhiteboxJob,
  type WhiteboxTool,
  type WhiteboxToolParameter,
} from "@geolibre/processing";
import type { FeatureCollection } from "geojson";
import { type RefObject, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { isTauri } from "../lib/tauri-io";
import { uniqueLayerName } from "../lib/unique-layer-name";
import { subsetUrlFieldValues, subsetUrlToolKind } from "../lib/subset-tool-url";
import { buildWhiteboxToolShareUrl, whiteboxToolShareBase } from "../lib/whitebox-tool-url";
import { searchWhiteboxTools } from "../lib/whitebox-tool-search";
import { useWhiteboxSemanticSearch } from "./useWhiteboxSemanticSearch";
import { parameterKind } from "../lib/whitebox-param-kind";
import { isTiff } from "../lib/scripting/binary-output";
import { fetchLayerBytes } from "../lib/whitebox-layer-inputs";
import {
  cornerExtentParameters,
  extentFieldValues,
  isCornerExtentParameter,
  type ExtentBounds,
} from "../lib/whitebox-extent";
import { clearPrintExtent, drawPrintExtent } from "../lib/print-extent";
import { IS_MAS_BUILD } from "../lib/build-flags";
import { startGeoLibreSidecar, stopGeoLibreSidecar } from "../lib/sidecar";
import {
  beginProcessingRun,
  MAX_TRACKED_HISTORY_JOBS,
  type ProcessingRunTracker,
} from "../lib/processing-history";
import {
  DOWNLOAD_GLOBAL_DEM_TOOL_ID,
  GlobalDemError,
  downloadGlobalDem,
  withGlobalDemTool,
} from "../lib/global-dem";
import {
  whiteboxParameterLabel,
  translateWhiteboxParameterLabel,
} from "../lib/processing-tool-i18n";
import {
  createDefaultValues,
  humanize,
  isDistanceParameter,
  isFeatureCollection,
  mergeCatalogParameterFallbacks,
  outputPath,
  toolLabel,
  wgs84ToolLayerIds,
  type ParameterValues,
} from "../lib/processing-params";
import {
  binaryOutputExtension,
  buildCategoryOptions,
  collectLayerFieldNames,
  combinedMidLatitude,
  countToolSources,
  evictOldestEntries,
  fieldOptionsForParameter,
  geoJsonOutputEntries,
  isJobRunning,
  keepOrFirstToolId,
  keywordOnlyTools,
  localCatalogLoadError,
  matchesToolSource,
  parseBrowsedInput,
  resetVectorOutputFormats,
  resolveRunInputs,
  resolveSelectedTool,
  runVectorOutputFormat,
  scopeTools,
  semanticMatchTools,
  shareLinkParameters,
  subsetCompanionReset,
  toolSearchFields,
  type BrowsedInput,
  type LayerBounds,
} from "../lib/processing-dialog-model";

/**
 * The catalog, runtime, job and download services the Whitebox toolbox
 * controller calls. Production uses {@link WHITEBOX_TOOLBOX_SERVICES}; tests
 * pass a stable replacement so no sidecar, WASM module or network is needed.
 */
export interface WhiteboxToolboxServices {
  clearRemoteWhiteboxCatalogSnapshotCache: typeof clearRemoteWhiteboxCatalogSnapshotCache;
  fetchRemoteWhiteboxCatalogSnapshot: typeof fetchRemoteWhiteboxCatalogSnapshot;
  listWasmToolManifests: typeof listWasmToolManifests;
  fetchWhiteboxStatus: typeof fetchWhiteboxStatus;
  fetchWhiteboxTools: typeof fetchWhiteboxTools;
  fetchWhiteboxJob: typeof fetchWhiteboxJob;
  fetchWhiteboxJsonOutput: typeof fetchWhiteboxJsonOutput;
  runWhiteboxTool: typeof runWhiteboxTool;
  runWhiteboxToolWasm: typeof runWhiteboxToolWasm;
  cancelWhiteboxJob: typeof cancelWhiteboxJob;
  startGeoLibreSidecar: typeof startGeoLibreSidecar;
  stopGeoLibreSidecar: typeof stopGeoLibreSidecar;
  downloadGlobalDem: typeof downloadGlobalDem;
  fetchLayerBytes: typeof fetchLayerBytes;
  downloadBytes: typeof downloadBytes;
}

/** The production services: the real sidecar, WASM runner and downloads. */
export const WHITEBOX_TOOLBOX_SERVICES: WhiteboxToolboxServices = {
  clearRemoteWhiteboxCatalogSnapshotCache,
  fetchRemoteWhiteboxCatalogSnapshot,
  listWasmToolManifests,
  fetchWhiteboxStatus,
  fetchWhiteboxTools,
  fetchWhiteboxJob,
  fetchWhiteboxJsonOutput,
  runWhiteboxTool,
  runWhiteboxToolWasm,
  cancelWhiteboxJob,
  startGeoLibreSidecar,
  stopGeoLibreSidecar,
  downloadGlobalDem,
  fetchLayerBytes,
  downloadBytes,
};

/** Options for {@link useWhiteboxToolboxController}. */
export interface WhiteboxToolboxControllerOptions {
  /** The active map engine, read for "Use map extent", drawing and zooming. */
  mapControllerRef: RefObject<MapEngine | null>;
  /** Renders a raster output (a Cloud Optimized GeoTIFF) as a map layer. */
  onAddRaster?: (bytes: Uint8Array, name: string, fileName?: string) => Promise<void> | void;
  /**
   * Renders a LiDAR output as a point cloud layer. Resolves false when the
   * LiDAR control could not be mounted, so the output is downloaded instead.
   */
  onAddLidar?: (bytes: Uint8Array, name: string, fileName: string) => Promise<boolean>;
  /**
   * Catalog, runtime and download services. Must be referentially stable:
   * the catalog load and job polling re-run when it changes.
   */
  services?: WhiteboxToolboxServices;
}

/**
 * Own the Whitebox toolbox's catalog, form, jobs and map-extent tools.
 *
 * The controller loads the catalog from the WASM runner or the sidecar (with
 * the remote snapshot as a fallback), applies menu preselections and History
 * re-runs, keeps the parameter form, dispatches runs, polls sidecar jobs,
 * records History entries, imports outputs into the project, and drives the
 * "Use map extent" / "Draw on map" shortcuts. The dialog owns only its
 * floating-window geometry, focus handling and rendering.
 *
 * @param options - The map engine ref, output callbacks and services.
 * @returns The toolbox view-model the dialog renders.
 */
export function useWhiteboxToolboxController({
  mapControllerRef,
  onAddRaster,
  onAddLidar,
  services = WHITEBOX_TOOLBOX_SERVICES,
}: WhiteboxToolboxControllerOptions) {
  const { t, i18n } = useTranslation();
  const open = useAppStore((s) => s.ui.processingOpen);
  const setProcessingOpen = useAppStore((s) => s.setProcessingOpen);
  const processingInitialTool = useAppStore((s) => s.ui.processingInitialTool);
  const setProcessingInitialTool = useAppStore((s) => s.setProcessingInitialTool);
  // Layers are only read while the dialog is open; closed, it stays mounted (to
  // keep its form, window position and job polling) without re-rendering on
  // layer edits.
  const layers = useLayersWhen(open);
  const addGeoJsonLayer = useAppStore((s) => s.addGeoJsonLayer);
  const rerun = useAppStore((s) => s.ui.processingRerun);
  const setProcessingRerun = useAppStore((s) => s.setProcessingRerun);

  const [tools, setTools] = useState<WhiteboxTool[]>([]);
  const [selectedToolId, setSelectedToolId] = useState("");
  const [values, setValues] = useState<ParameterValues>({});
  const [historyRestoreRevision, setHistoryRestoreRevision] = useState(0);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("All");
  // Tool provenance filter: "All" | "geolibre" | "whitebox". Only meaningful in
  // WASM mode, where GeoLibre-authored tools are mixed into the catalog.
  const [source, setSource] = useState("All");
  const [loadingTools, setLoadingTools] = useState(false);
  const [runtimeMessage, setRuntimeMessage] = useState("");
  const [runtimeAvailable, setRuntimeAvailable] = useState<boolean | null>(null);
  // Cache the desktop check once, matching the sibling processing dialogs
  // (ConversionDialog, RasterToolsDialog).
  const desktop = isTauri();
  // Whether this build can spawn/stop the sidecar server: desktop, except the
  // Mac App Store build, whose App Sandbox forbids the sidecar process. All
  // server UI gates use this; the WASM runner keeps working either way.
  const desktopServer = desktop && !IS_MAS_BUILD;
  // Run tools locally in WebAssembly (no Python sidecar). Default on in the
  // browser, where there is no sidecar; off under Tauri, where the sidecar is
  // available and can read native file paths that the WASM runner cannot fetch.
  const [runLocal, setRunLocal] = useState(!desktopServer);
  const [error, setError] = useState<string | null>(null);
  const [startingServer, setStartingServer] = useState(false);
  const [stoppingServer, setStoppingServer] = useState(false);
  const [job, setJob] = useState<WhiteboxJob | null>(null);
  // True while a run is in flight. The WASM runner resolves straight to a
  // terminal job (never "pending"/"running"), so without this flag the Run
  // button would stay enabled mid-execution and allow concurrent runs.
  const [runningLocal, setRunningLocal] = useState(false);
  // Transient "Copied!" state for the share-link button, cleared after 2s.
  const [linkCopied, setLinkCopied] = useState(false);
  const linkCopyTimer = useRef<number | null>(null);

  // True while a "Draw on map" rubber-band is in progress.
  const [drawing, setDrawing] = useState(false);
  const drawAbortRef = useRef<AbortController | null>(null);
  // Cancels the network-bound global DEM request when the panel closes or a
  // replacement run starts. The regular WASM/sidecar jobs manage their own
  // lifecycle and do not use this controller.
  const globalDemAbortRef = useRef<AbortController | null>(null);
  // Viewport-space corners of the in-progress draw box, drawn as an SVG overlay
  // (not a MapLibre layer) so the rubber-band sits above an interleaved deck.gl
  // raster, which occludes MapLibre layers.
  const [drawPoints, setDrawPoints] = useState<{ x: number; y: number }[] | null>(null);

  const importedJobIdRef = useRef<string | null>(null);
  // A tool id queued from the Processing menu, applied once the catalog finishes
  // loading (see the apply effect below). `wasLoadingRef` tracks whether a load
  // has actually started, so the apply only fires on a true -> false transition.
  const pendingInitialToolRef = useRef<string | null>(null);
  const wasLoadingRef = useRef(false);
  // History trackers per dispatched job id (#1292). Entries stay after finish
  // (finish is idempotent) so async output imports can still report layers;
  // the map is capped (oldest evicted, Map preserves insertion order) so a
  // long batch session cannot grow it without bound.
  const historyTrackersRef = useRef<Map<string, ProcessingRunTracker>>(new Map());
  // Bytes of input files the user browsed from disk (web build, where the
  // browser cannot expose a real path). Keyed by parameter name; consumed by
  // the in-browser WASM runner. GeoJSON files are parsed up front so vector
  // tools receive a FeatureCollection, matching the layer-input path.
  const browsedInputsRef = useRef<Map<string, BrowsedInput[]>>(new Map());
  // Parameters passed to each run, keyed by the resulting job id, so output
  // naming can honor the output path the user actually typed (which the finished
  // job does not carry). Keyed per job (not a single slot) so a rapid re-run
  // cannot overwrite the entry a still-draining previous job is reading; the
  // entry is deleted once its outputs are imported.
  const runParametersByJobRef = useRef<Map<string, Record<string, unknown>>>(new Map());
  const jobGenerationByJobRef = useRef<Map<string, number>>(new Map());

  // Varargs (`*args`/`**kwargs`) params are dropped defensively; see
  // resolveSelectedTool.
  const selectedTool = useMemo(
    () => resolveSelectedTool(tools, selectedToolId),
    [selectedToolId, tools],
  );

  // Whether any GeoLibre-authored tools are present (WASM mode), gating the
  // source filter — pointless when every tool is from Whitebox.
  const hasGeolibreTools = useMemo(() => tools.some((tool) => tool.source === "geolibre"), [tools]);

  // The selected tool's vector inputs, which decide both the coordinate-units
  // note and where a field parameter's column names come from.
  const vectorInputParams = useMemo(
    () => (selectedTool?.params ?? []).filter((param) => parameterKind(param) === "vector_in"),
    [selectedTool],
  );

  // A tool that asks for its extent as four separate boundary numbers renders
  // them as one grouped control, in place of the first of the four, so the
  // "Use map extent" / "Draw on map" shortcuts sit with the whole box instead of
  // beside a lone longitude (GeoLibre#1541).
  const cornerExtentParams = useMemo(
    () => (selectedTool ? cornerExtentParameters(selectedTool) : []),
    [selectedTool],
  );
  const cornerExtentAnchor = useMemo(
    () =>
      selectedTool?.params?.find((param) => isCornerExtentParameter(selectedTool, param))?.name ??
      null,
    [selectedTool],
  );

  // Attribute-field names per layer, memoized on the layer set (and the dialog
  // being open) so it doesn't recompute on every keystroke. GeoJSON is
  // schemaless, so sample the first FIELD_SCAN_SAMPLE features rather than
  // scanning a whole large layer on the React commit path.
  const fieldsByLayer = useMemo(
    () => (open ? collectLayerFieldNames(layers) : new Map<string, string[]>()),
    [layers, open],
  );

  // The layers wired to the selected tool's vector inputs, when the tool's
  // coordinates are known to be WGS84 (GeoLibre#1540). Joined into a string so
  // the extent scan below keeps its memo across the keystrokes that rebuild
  // `values`; null when the units are unknown, which hides the unit picker.
  const distanceLayerKey = useMemo(
    () => wgs84ToolLayerIds(selectedTool, values)?.join("\n") ?? null,
    [selectedTool, values],
  );

  // Measured extents, keyed on the FeatureCollection itself so the scan below is
  // repeated only when a layer's data actually changes. The `layers` array is
  // replaced on any layer mutation in the app — a visibility toggle, a restyle,
  // an unrelated layer being added — and re-scanning a large collection on each
  // of those, on the React commit path, is exactly the cost this avoids.
  const layerBoundsCache = useRef(new WeakMap<FeatureCollection, LayerBounds>());

  // The latitude a distance parameter's metric entry converts at: the middle of
  // the combined extent of the layers the tool reads. With several inputs that is
  // the area the operation actually spans, where averaging each layer's own
  // centre would weight a city-sized input the same as a country-sized one and
  // land between the two. Only the one or two layers the tool reads are measured,
  // never every GeoJSON layer in the project.
  const distanceLatitude = useMemo(() => {
    if (!open || distanceLayerKey === null) return null;
    // A layer with no in-memory GeoJSON is passed as a path, in its own CRS, so
    // the tool's units stop being knowable; an extentless layer (an attribute
    // table) is skipped rather than disqualifying inputs that have an extent.
    return combinedMidLatitude(distanceLayerKey.split("\n"), layers, (layer) => {
      const cache = layerBoundsCache.current;
      let bounds = cache.get(layer.geojson);
      if (bounds === undefined) {
        bounds = getLayerBounds(layer);
        cache.set(layer.geojson, bounds);
      }
      return bounds;
    });
  }, [distanceLayerKey, layers, open]);

  // Whether this tool's distance fields carry a unit picker, which decides which
  // of the two coordinate-units notes the form shows above the parameters.
  const showDistanceNote =
    distanceLatitude !== null &&
    (selectedTool?.params ?? []).some((param) => isDistanceParameter(param));

  // Column names to offer for a `*_field` parameter (GeoLibre#1459): those of
  // the layer picked for the vector input the parameter names. With a single
  // vector input that is unambiguous; with several, an unmatched name falls back
  // to the union of every selected input's columns, so the right column is still
  // in the list even when the naming doesn't line up. Empty when the input is a
  // file path rather than a loaded layer — the field stays a plain text box.
  const fieldOptions = useCallback(
    (param: WhiteboxToolParameter): string[] =>
      fieldOptionsForParameter(param, vectorInputParams, values, fieldsByLayer),
    [fieldsByLayer, values, vectorInputParams],
  );

  // A shareable `?tool=` deep link for the selected tool: the tool id plus the
  // parameters the user changed from their defaults. Local file paths
  // (`*_in`/`*_out`) are excluded — they are machine-specific and either useless
  // or leaky to a recipient — while an HTTP `url` (a `string` param) is kept. The
  // web build links to its own origin; the desktop build, whose window origin is
  // a non-shareable `tauri://…`, links to the hosted web app.
  const shareUrl = useMemo(() => {
    if (!selectedTool) return "";
    return buildWhiteboxToolShareUrl(
      selectedTool.id,
      shareLinkParameters(selectedTool, values),
      whiteboxToolShareBase(desktop),
    );
  }, [selectedTool, values, desktop]);

  const handleCopyLink = useCallback(() => {
    if (!shareUrl) return;
    // The Clipboard API is absent in insecure contexts (HTTP over a LAN) or when
    // blocked; surface a failure message instead of silently doing nothing.
    if (!navigator.clipboard) {
      setError(t("processing.whitebox.copyLinkFailed"));
      return;
    }
    void navigator.clipboard
      .writeText(shareUrl)
      .then(() => {
        if (linkCopyTimer.current !== null) window.clearTimeout(linkCopyTimer.current);
        setLinkCopied(true);
        linkCopyTimer.current = window.setTimeout(() => setLinkCopied(false), 2000);
      })
      .catch(() => setError(t("processing.whitebox.copyLinkFailed")));
  }, [shareUrl, t]);

  useEffect(
    () => () => {
      if (linkCopyTimer.current !== null) window.clearTimeout(linkCopyTimer.current);
    },
    [],
  );

  // Ignore the source filter when no GeoLibre tools are present (e.g. sidecar
  // mode), so a stale "geolibre" selection can't empty the whole list.
  const matchesSource = useCallback(
    (tool: WhiteboxTool) => matchesToolSource(tool, source, hasGeolibreTools),
    [source, hasGeolibreTools],
  );

  // Total tool count per source, for the source-filter labels.
  const sourceCounts = useMemo(() => countToolSources(tools), [tools]);

  // Category options labelled with the number of tools in each (within the
  // active source filter), e.g. "Conversion (37)".
  const categories = useMemo(
    () => buildCategoryOptions(tools, matchesSource, t, i18n.language),
    [tools, matchesSource, t, i18n.language],
  );

  // Everything the category and source filters allow, before the search text.
  // Memoized apart from the search so the semantic lookup below sees a stable
  // list across keystrokes, and so it searches the same scope the list shows.
  const scopedTools = useMemo(
    () => scopeTools(tools, category, matchesSource),
    [category, matchesSource, tools],
  );

  const filteredTools = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return searchWhiteboxTools(scopedTools, normalizedQuery, (tool) => toolSearchFields(t, tool));
  }, [query, scopedTools, t]);

  // A second, optional search that understands a description of an operation
  // rather than a word from the catalog ("remove sinks so water drains off the
  // edge" -> fill_depressions). Off entirely unless the deployment configured a
  // System One endpoint, and never a substitute for the filter above: its hits
  // are shown as their own group in front of it, so the substring list someone
  // is already reading keeps its order. #2566
  const semantic = useWhiteboxSemanticSearch(query, scopedTools, filteredTools, !loadingTools);

  const semanticTools = useMemo(
    () => semanticMatchTools(scopedTools, semantic.matches),
    [semantic.matches, scopedTools],
  );

  // The substring hits the ranked group does not already show. Listing a tool
  // twice under two headings reads as two different tools.
  const keywordTools = useMemo(
    () => keywordOnlyTools(filteredTools, semanticTools),
    [filteredTools, semanticTools],
  );

  const loadWhitebox = useCallback(async () => {
    setLoadingTools(true);
    setError(null);
    // Reset the source filter so a stale "geolibre" selection from a previous
    // mode doesn't silently hide tools after a reload / mode switch.
    setSource("All");
    // Drop the in-memory snapshot so a fresh load reflects upstream catalog
    // changes; calls within this load still dedup once it is repopulated.
    services.clearRemoteWhiteboxCatalogSnapshotCache();

    const applyRemoteCatalogSnapshot = async (message: string, available: boolean) => {
      try {
        // Hide locked ("pro"-tier) tools: they cannot run, so omit them from the
        // catalog entirely rather than show them as disabled rows.
        const snapshotTools = (await services.fetchRemoteWhiteboxCatalogSnapshot()).filter(
          (tool) => !tool.locked,
        );
        setRuntimeAvailable(available);
        setRuntimeMessage(message);
        const availableTools = withGlobalDemTool(snapshotTools);
        setTools(availableTools);
        setSelectedToolId((current) => keepOrFirstToolId(availableTools, current));
      } catch (err) {
        setRuntimeAvailable(available);
        setRuntimeMessage(message);
        const availableTools = withGlobalDemTool([]);
        setTools(availableTools);
        setSelectedToolId(availableTools[0]?.id ?? "");
        setError(err instanceof Error ? err.message : t("processing.whitebox.errorLoadSnapshot"));
      }
    };

    // In WASM mode the tools run in-browser, so skip the Python sidecar probe
    // entirely (on the web build that request 404s to the SPA index.html, which
    // is the "Unexpected token '<'" JSON error). Load the catalog for the tool
    // list + display metadata, then let the WASM binary's own manifests be
    // authoritative for parameters: the local tools can expose a different
    // parameter set than the sidecar (e.g. reproject_vector validates `epsg`,
    // not the catalog's `dst_epsg`, #1047), and they add the GeoLibre-authored
    // tools (write_geoparquet, delineate_depressions, …) absent from the catalog.
    if (runLocal) {
      setRuntimeAvailable(false);
      setRuntimeMessage(t("processing.whitebox.runningLocally"));
      // The catalog snapshot (HTTP/bundled asset) and the WASM manifest
      // enumeration (loads + queries the WASM module) are independent, so fetch
      // them concurrently rather than serially.
      const [catalogResult, wasmResult] = await Promise.allSettled([
        services.fetchRemoteWhiteboxCatalogSnapshot(),
        services.listWasmToolManifests(),
      ]);
      // Hide locked ("pro"-tier) tools: they cannot run, so omit them from the
      // catalog entirely rather than show them as disabled rows.
      const catalogTools =
        catalogResult.status === "fulfilled"
          ? catalogResult.value.filter((tool) => !tool.locked)
          : [];
      const catalogError = catalogResult.status === "rejected" ? catalogResult.reason : null;
      // A snapshot that resolves to an empty list (malformed/empty JSON that
      // doesn't throw) silently drops the ~700 Whitebox tools. Detect it from
      // the raw result, not `catalogTools`, so a fetch that returned only locked
      // tools isn't mistaken for a load failure.
      const catalogEmpty = catalogResult.status === "fulfilled" && catalogResult.value.length === 0;
      const wasmTools = wasmResult.status === "fulfilled" ? wasmResult.value : [];
      const wasmError = wasmResult.status === "rejected" ? wasmResult.reason : null;
      if (wasmError) {
        console.warn("[GeoLibre] Could not enumerate WASM tool manifests:", wasmError);
      }
      if (catalogError) {
        console.warn("[GeoLibre] Could not load Whitebox catalog snapshot:", catalogError);
      }
      const nextTools = withGlobalDemTool(mergeWasmToolManifests(catalogTools, wasmTools));
      setTools(nextTools);
      setSelectedToolId((current) => keepOrFirstToolId(nextTools, current));
      // In local mode the WASM runner is what actually executes tools, so its
      // failure is the most important to report: without it every tool keeps the
      // catalog's parameter names and would fail on run (exactly #1047). Failing
      // that, surface a catalog-fetch failure even when the WASM manifests still
      // yielded a few GeoLibre-authored tools, so the user is not silently left
      // without the ~700 Whitebox catalog tools.
      const loadError = localCatalogLoadError(
        { wasmError, catalogError, catalogEmpty, toolCount: nextTools.length },
        t,
      );
      if (loadError) setError(loadError);
      setLoadingTools(false);
      return;
    }

    try {
      const status = await services.fetchWhiteboxStatus();
      setRuntimeAvailable(status.available);
      setRuntimeMessage(status.message);
      if (!status.available) {
        await applyRemoteCatalogSnapshot(
          `${status.message} ${t("processing.whitebox.showingSnapshotOnly")}`,
          false,
        );
        return;
      }
      let nextTools: WhiteboxTool[];
      try {
        nextTools = await services.fetchWhiteboxTools();
      } catch (err) {
        await applyRemoteCatalogSnapshot(
          `${
            err instanceof Error ? err.message : t("processing.whitebox.errorLoadLive")
          } ${t("processing.whitebox.showingSnapshotOnly")}`,
          true,
        );
        return;
      }
      if (nextTools.length === 0) {
        await applyRemoteCatalogSnapshot(t("processing.whitebox.liveCatalogEmpty"), true);
        return;
      }
      try {
        const snapshotTools = await services.fetchRemoteWhiteboxCatalogSnapshot();
        nextTools = mergeCatalogParameterFallbacks(nextTools, snapshotTools);
      } catch {
        // Keep the live catalog when the optional parameter fallback is unavailable.
      }
      // Hide locked ("pro"-tier) tools: they cannot run, so omit them entirely.
      const freeTools = withGlobalDemTool(nextTools.filter((tool) => !tool.locked));
      setTools(freeTools);
      setSelectedToolId((current) => keepOrFirstToolId(freeTools, current));
    } catch (err) {
      setRuntimeAvailable(false);
      await applyRemoteCatalogSnapshot(
        `${
          err instanceof Error ? err.message : t("processing.whitebox.errorConnect")
        } ${t("processing.whitebox.showingSnapshotOnly")}`,
        false,
      );
    } finally {
      setLoadingTools(false);
    }
  }, [runLocal, services, t]);

  useEffect(() => {
    if (!open) return;
    void loadWhitebox();
  }, [loadWhitebox, open]);

  // When the dialog is opened from a Processing-menu category submenu, the store
  // carries the chosen tool id. Stash it in a ref and clear the filters that
  // could hide it; the apply effect below selects it once the catalog is loaded.
  // We can't select eagerly here: the catalog loads async, and a GeoLibre WASM
  // tool is appended only after the Whitebox snapshot, whose loader resets the
  // selection to its first tool whenever the pending id is not (yet) present.
  useEffect(() => {
    if (!open || !processingInitialTool) return;
    pendingInitialToolRef.current = processingInitialTool;
    setProcessingInitialTool(null);
    setCategory("All");
    setSource("All");
    setQuery("");
  }, [open, processingInitialTool, setProcessingInitialTool]);

  // Apply the pending preselection once a catalog load completes (loadingTools
  // goes true -> false), when `tools` is final and includes the async GeoLibre
  // WASM tools. Keying on the transition avoids firing on the first render, when
  // loadingTools is still false only because the load has not started yet.
  useEffect(() => {
    if (loadingTools) {
      wasLoadingRef.current = true;
      return;
    }
    if (!wasLoadingRef.current) return;
    wasLoadingRef.current = false;
    const pending = pendingInitialToolRef.current;
    if (!pending) return;
    pendingInitialToolRef.current = null;
    if (tools.some((tool) => tool.id === pending)) {
      setSelectedToolId(pending);
    }
  }, [loadingTools, tools]);

  useEffect(() => {
    setValues(createDefaultValues(selectedTool));
    // Drop any browsed input bytes from the previous tool so they cannot be
    // silently reused by a same-named parameter on the new tool.
    browsedInputsRef.current.clear();
    setJob(null);
    importedJobIdRef.current = null;
  }, [selectedTool?.id]);

  // Pre-fill from a pending History re-run (#1292). If the requested tool is
  // not selected yet, select it once the catalog holds it (the initial-tool
  // stash above covers the not-yet-loaded case); once selected, overlay the
  // recorded values on the tool's defaults. Declared after the values-reset
  // effect above so the recorded values win when both fire in the same commit.
  useEffect(() => {
    if (!open || !rerun || rerun.kind !== "whitebox") return;
    if (selectedTool?.id !== rerun.toolId) {
      if (!loadingTools && tools.length > 0) {
        if (tools.some((tool) => tool.id === rerun.toolId)) {
          setSelectedToolId(rerun.toolId);
        } else {
          // A saved-project history entry can reference a tool the current
          // Whitebox catalog no longer ships (e.g. after a geolibre-wasm
          // rename); drop the request instead of leaving it pending forever.
          setError(t("processing.history.toolUnavailable", { toolId: rerun.toolId }));
          setProcessingRerun(null);
        }
      }
      return;
    }
    setValues({
      ...createDefaultValues(selectedTool),
      ...(rerun.parameters as ParameterValues),
    });
    // A restore must reset local field drafts even when its stored degrees
    // equal the last value pushed by a metric field at another latitude.
    setHistoryRestoreRevision((revision) => revision + 1);
    setProcessingRerun(null);
  }, [open, rerun, selectedTool, loadingTools, tools, setProcessingRerun, t]);

  // Drop an unconsumed whitebox re-run when the dialog closes (e.g. the
  // catalog failed to load, so the effect above never matched), so a stale
  // pre-fill cannot suddenly apply on a later open.
  useEffect(() => {
    if (open) return;
    if (useAppStore.getState().ui.processingRerun?.kind === "whitebox") {
      setProcessingRerun(null);
    }
  }, [open, setProcessingRerun]);

  useEffect(() => {
    if (!job || !isJobRunning(job)) return;
    let cancelled = false;
    let timer: number | undefined;
    let failures = 0;
    const poll = async () => {
      if (cancelled) return;
      try {
        const next = await services.fetchWhiteboxJob(job.id);
        if (cancelled) return;
        failures = 0;
        setJob(next);
        if (isJobRunning(next)) timer = window.setTimeout(poll, 1000);
      } catch (err) {
        if (cancelled) return;
        failures += 1;
        if (failures < 3) {
          timer = window.setTimeout(poll, 1000 * failures);
          return;
        }
        const message = err instanceof Error ? err.message : t("processing.whitebox.errorPoll");
        setError(message);
        setJob((prev) =>
          prev && prev.id === job.id ? { ...prev, status: "failed", error: message } : prev,
        );
      }
    };
    timer = window.setTimeout(poll, 1000);
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [job, services, t]);

  // Record a History entry once a job reaches a terminal status (#1292). WASM
  // jobs arrive terminal on dispatch; sidecar jobs get here via polling.
  // `finish` is idempotent, so re-renders with the same terminal job are no-ops.
  useEffect(() => {
    if (!job || isJobRunning(job)) return;
    historyTrackersRef.current
      .get(job.id)
      ?.finish(job.status === "succeeded" ? "success" : "error", job.error ?? undefined);
  }, [job]);

  const updateValue = (name: string, value: unknown) => {
    // Any manual change (typing a path, picking a layer) invalidates a
    // previously browsed file's bytes for this parameter.
    browsedInputsRef.current.delete(name);
    setValues((prev) => ({ ...prev, [name]: value }));
  };

  // Fill a subset extractor's `url` (and the companion fields it needs to run:
  // WMS layers/styles, XYZ tile_size/subdomains) from a loaded raster layer
  // (GeoLibre#1271), so a COG/WMS/XYZ added to the map can be subset without
  // retyping its url. A COG's local `input` is cleared in the same gesture since
  // the extractor takes exactly one source, and a url makes it a byte-range read
  // instead of a full download.
  const handlePopulateSubsetUrl = (layer: GeoLibreLayer) => {
    if (!selectedTool) return;
    const fields = subsetUrlFieldValues(selectedTool.id, layer);
    if (!fields) return;
    // Reset every companion field this populate can set back to the tool
    // default first, so a previously picked layer's optional values (a WMS
    // `styles`, an XYZ `subdomains`/`tile_size`) don't linger when the new layer
    // omits them and skew the extraction. `fields` is spread after, so the new
    // layer's present values win.
    const companionReset = subsetCompanionReset(
      subsetUrlToolKind(selectedTool.id),
      createDefaultValues(selectedTool),
    );
    const hasInput = selectedTool.params?.some((param) => param.name === "input");
    setValues((prev) => ({
      ...prev,
      ...(hasInput ? { input: "" } : {}),
      ...companionReset,
      ...fields,
    }));
    for (const name of Object.keys(companionReset)) {
      browsedInputsRef.current.delete(name);
    }
    for (const name of Object.keys(fields)) browsedInputsRef.current.delete(name);
    if (hasInput) browsedInputsRef.current.delete("input");
    setError(null);
  };

  // Fill the selected tool's extent fields from the current map view
  // (GeoLibre#1213) or from a box drawn on it (GeoLibre#1541). The map reads in
  // EPSG:4326, so the box is written as WGS84 `west,south,east,north` (into a
  // single `bbox` string or into the four boundary numbers, whichever the tool
  // takes) and its companion CRS is set to 4326 in the same gesture, which
  // is what `extentFieldValues` resolves (including the box validity check that
  // mirrors RasterSubsetPanel.parseBbox). Shared by "Use map extent" (current
  // view) and "Draw on map" (rubber-band).
  const applyMapExtent = (bounds: ExtentBounds | undefined): void => {
    setError(null);
    if (!bounds || !selectedTool) {
      setError(t("processing.whitebox.mapExtentUnavailable"));
      return;
    }
    const fields = extentFieldValues(selectedTool, bounds);
    if (!fields) {
      setError(t("processing.whitebox.mapExtentInvalid"));
      return;
    }
    for (const [name, value] of Object.entries(fields)) updateValue(name, value);
  };

  const handleUseMapExtent = () => {
    // Cancel any in-flight draw so its late-resolving box can't overwrite the
    // extent the user just asked for from the current view.
    drawAbortRef.current?.abort();
    applyMapExtent(mapControllerRef.current?.readView().bbox);
  };

  // Rubber-band a box on the map to fill the bbox (only workable because the
  // panel is now non-modal). Reuses the print-extent draw helper, which suspends
  // pan/zoom during the drag and handles Escape/blur. We draw our own SVG preview
  // (drawBox: false + onPreview) so the box sits above an interleaved deck.gl
  // raster instead of being occluded by it. Toggling the button (or closing the
  // panel) aborts an in-flight draw.
  const handleDrawBbox = async () => {
    const engine = mapControllerRef.current;
    if (!engine) {
      setError(t("processing.whitebox.mapExtentUnavailable"));
      return;
    }
    const map = engine.getMap();
    if (drawing) {
      drawAbortRef.current?.abort();
      return;
    }
    setError(null);
    const controller = new AbortController();
    drawAbortRef.current = controller;
    setDrawing(true);
    let enginePreview: (() => void) | undefined;
    // The engine keeps each draw's disposer until teardown, so release it on
    // every exit (done, cancel, abort), once.
    let engineDrawDispose: (() => void) | undefined;
    const disposeEngineDraw = () => {
      const dispose = engineDrawDispose;
      engineDrawDispose = undefined;
      dispose?.();
    };
    try {
      const extent = map
        ? await drawPrintExtent(map, {
            signal: controller.signal,
            drawBox: false,
            // Project the box corners to viewport space (map.project is canvas-
            // relative, so add the canvas offset). The map is pan/zoom-locked during
            // the draw, so corners only move as the box is dragged.
            onPreview: (box) => {
              if (!box) {
                setDrawPoints(null);
                return;
              }
              const rect = map.getCanvas().getBoundingClientRect();
              const [w, s, e, n] = box;
              const corners: [number, number][] = [
                [w, n],
                [e, n],
                [e, s],
                [w, s],
              ];
              setDrawPoints(
                corners.map(([lng, lat]) => {
                  const p = map.project([lng, lat]);
                  return { x: p.x + rect.left, y: p.y + rect.top };
                }),
              );
            },
          })
        : await new Promise<[number, number, number, number] | null>((resolve) => {
            let settled = false;
            const finish = (value: [number, number, number, number] | null) => {
              if (settled) return;
              settled = true;
              resolve(value);
            };
            engineDrawDispose = engine.drawExtent({
              onChange: (box) => {
                enginePreview?.();
                enginePreview = engine.showExtent(box);
              },
              onDone: (box) => finish(box),
              onCancel: () => finish(null),
            });
            controller.signal.addEventListener(
              "abort",
              () => {
                disposeEngineDraw();
                finish(null);
              },
              { once: true },
            );
          });
      if (controller.signal.aborted) return;
      if (extent) applyMapExtent(extent);
    } finally {
      disposeEngineDraw();
      if (map) clearPrintExtent(map);
      enginePreview?.();
      setDrawPoints(null);
      if (drawAbortRef.current === controller) {
        drawAbortRef.current = null;
        setDrawing(false);
      }
    }
  };

  // Abort an in-flight draw when the panel closes or the component unmounts, so
  // the map isn't left in draw mode after the panel is gone.
  useEffect(() => {
    if (open) return;
    drawAbortRef.current?.abort();
    globalDemAbortRef.current?.abort();
  }, [open]);
  useEffect(
    () => () => {
      drawAbortRef.current?.abort();
      globalDemAbortRef.current?.abort();
    },
    [],
  );
  // Abort an in-flight draw when the selected tool changes: `values` is reset to
  // the new tool's defaults on that change, so a box that resolves after the
  // switch would otherwise fill the wrong tool's bbox field.
  useEffect(() => {
    drawAbortRef.current?.abort();
    globalDemAbortRef.current?.abort();
  }, [selectedToolId]);

  const handleRunLocalChange = (nextRunLocal: boolean) => {
    setRunLocal(nextRunLocal);
    // A `vector_out` param holds an output-format string in WASM mode but a
    // free-text path in sidecar mode, and the form only resets on tool change.
    // Turning WASM mode off would otherwise leave a format like "geoparquet" as
    // the sidecar output path, so reset any such param to its default.
    if (nextRunLocal || !selectedTool) return;
    setValues((prev) => resetVectorOutputFormats(selectedTool, prev));
  };

  // Stash a browsed input file's bytes and show its name in the field. Used by
  // the path-browse button in the web build, where the WASM runner reads bytes
  // directly instead of a (non-existent in the browser) filesystem path.
  const handlePickInputFile = useCallback(
    (paramName: string, fileName: string, bytes: Uint8Array) => {
      browsedInputsRef.current.set(paramName, [parseBrowsedInput(fileName, bytes)]);
      setValues((prev) => ({ ...prev, [paramName]: fileName }));
    },
    [],
  );

  const handlePickInputFiles = useCallback(
    (paramName: string, files: Array<{ fileName: string; bytes: Uint8Array }>) => {
      const inputs = files.map(({ fileName, bytes }) => parseBrowsedInput(fileName, bytes));
      browsedInputsRef.current.set(paramName, inputs);
      setValues((prev) => ({
        ...prev,
        [paramName]: inputs.map((input) => input.name).join(", "),
      }));
    },
    [],
  );

  const importGeoJsonOutputs = useCallback(
    async (nextJob: WhiteboxJob) => {
      if (importedJobIdRef.current === nextJob.id) return;
      importedJobIdRef.current = nextJob.id;
      const startLoadCount = jobGenerationByJobRef.current.get(nextJob.id);
      if (startLoadCount === undefined) return;
      if (useAppStore.getState().projectLoadCount !== startLoadCount) {
        runParametersByJobRef.current.delete(nextJob.id);
        return;
      }
      const entries = geoJsonOutputEntries(nextJob.outputs);
      const jobTool = tools.find((item) => item.id === nextJob.tool_id);
      const jobToolLabel = jobTool ? toolLabel(t, jobTool) : humanize(nextJob.tool_id);
      const runParameters = runParametersByJobRef.current.get(nextJob.id) ?? {};
      runParametersByJobRef.current.delete(nextJob.id);
      for (const [name, value] of entries) {
        const path = isFeatureCollection(value) ? "" : (outputPath(value) ?? "");
        const data = isFeatureCollection(value)
          ? value
          : await services.fetchWhiteboxJsonOutput(path);
        if (useAppStore.getState().projectLoadCount !== startLoadCount) return;
        if (!isFeatureCollection(data)) continue;
        const layerName = uniqueLayerName(
          `${jobToolLabel} ${humanize(name)}`,
          useAppStore.getState().layers,
        );
        const layerId = addGeoJsonLayer(layerName, data, path || undefined);
        historyTrackersRef.current.get(nextJob.id)?.addOutputLayer(layerName);
        const layer = useAppStore.getState().layers.find((item) => item.id === layerId);
        if (layer && shouldZoomToNewLayers()) mapControllerRef.current?.fitLayer(layer);
      }

      for (const [name, value] of Object.entries(nextJob.outputs)) {
        if (useAppStore.getState().projectLoadCount !== startLoadCount) return;
        if (!(value instanceof Uint8Array)) continue;
        const param = jobTool?.params?.find((item) => item.name === name);
        const outKind = param ? parameterKind(param) : "";
        if (outKind === "lidar_out" && isLas(value) && onAddLidar) {
          const lidarName = `${jobToolLabel} ${humanize(name)}`;
          const fileName = `${outputBaseName(nextJob.tool_id, name)}.${lidarBytesExtension(value)}`;
          if (await onAddLidar(value, lidarName, fileName)) {
            if (useAppStore.getState().projectLoadCount !== startLoadCount) return;
            historyTrackersRef.current.get(nextJob.id)?.addOutputLayer(lidarName);
            continue;
          }
          if (useAppStore.getState().projectLoadCount !== startLoadCount) return;
        }
        const declaredFile =
          outKind === "file_out" || outKind === "vector_out" || outKind === "lidar_out";
        if (declaredFile && (!isTiff(value) || !onAddRaster)) {
          const label = `${jobToolLabel} ${humanize(name)}`.replace(/\s+/g, "_");
          const extension = binaryOutputExtension(value, outKind, param, runParameters[name]);
          services.downloadBytes(value, `${label}.${extension}`);
        } else if (onAddRaster) {
          const rasterName = `${jobToolLabel} ${humanize(name)}`;
          await onAddRaster(value, rasterName, `${outputBaseName(nextJob.tool_id, name)}.tif`);
          if (useAppStore.getState().projectLoadCount !== startLoadCount) return;
          historyTrackersRef.current.get(nextJob.id)?.addOutputLayer(rasterName);
        }
      }
    },
    [addGeoJsonLayer, mapControllerRef, onAddLidar, onAddRaster, services, t, tools],
  );

  useEffect(() => {
    if (job?.status !== "succeeded") return;
    void importGeoJsonOutputs(job).catch((err) => {
      setError(err instanceof Error ? err.message : t("processing.whitebox.importOutputFailed"));
    });
  }, [importGeoJsonOutputs, job]);

  const runSelectedTool = async () => {
    if (!selectedTool || selectedTool.locked) return;
    const dispatchLoadCount = useAppStore.getState().projectLoadCount;
    setError(null);
    // Flag "running" before any prep so the Run button shows its busy state
    // immediately (input fetching can take a moment, and the local WASM run then
    // blocks the main thread).
    setRunningLocal(true);

    if (selectedTool.id === DOWNLOAD_GLOBAL_DEM_TOOL_ID) {
      if (!String(values.bbox ?? "").trim()) {
        setError(
          t("processing.whitebox.missingRequiredParameter", {
            label: whiteboxParameterLabel(t, i18n.language, selectedTool.id, {
              name: "bbox",
            }),
          }),
        );
        setRunningLocal(false);
        return;
      }
      globalDemAbortRef.current?.abort();
      const controller = new AbortController();
      globalDemAbortRef.current = controller;
      const tracker = beginProcessingRun({
        kind: "whitebox",
        toolId: selectedTool.id,
        toolName: toolLabel(t, selectedTool),
        engine: "AWS Terrain Tiles",
        parameters: values,
      });
      try {
        const bytes = await services.downloadGlobalDem({
          bbox: String(values.bbox ?? ""),
          bboxCrs: Number(values.bbox_crs),
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        const now = new Date().toISOString();
        const id = `global-dem-${crypto.randomUUID()}`;
        jobGenerationByJobRef.current.set(id, dispatchLoadCount);
        historyTrackersRef.current.set(id, tracker);
        evictOldestEntries(historyTrackersRef.current, MAX_TRACKED_HISTORY_JOBS, (oldest) =>
          jobGenerationByJobRef.current.delete(oldest),
        );
        importedJobIdRef.current = null;
        setJob({
          id,
          status: "succeeded",
          tool_id: selectedTool.id,
          created_at: now,
          updated_at: now,
          messages: [t("processing.whitebox.jobStatus.succeeded")],
          outputs: { output: bytes },
          result: null,
          error: null,
        });
      } catch (err) {
        if (controller.signal.aborted) return;
        if (err instanceof GlobalDemError) {
          console.warn("Global DEM download failed:", err.message);
        }
        const message =
          err instanceof GlobalDemError
            ? err.message
            : err instanceof Error
              ? err.message
              : t("toolbar.rasterTool.runError");
        tracker.finish("error", message);
        setError(message);
      } finally {
        if (globalDemAbortRef.current === controller) {
          globalDemAbortRef.current = null;
          setRunningLocal(false);
        }
      }
      return;
    }

    let tracker: ProcessingRunTracker | undefined;
    try {
      const resolved = await resolveRunInputs({
        tool: selectedTool,
        values,
        layers,
        browsedInputs: new Map(browsedInputsRef.current),
        runLocal,
        t,
        parameterLabel: (param) => translateWhiteboxParameterLabel(t, selectedTool.id, param),
        fetchLayerBytes: services.fetchLayerBytes,
      });
      if (!resolved.ok) {
        setError(resolved.error);
        setRunningLocal(false);
        return;
      }
      const { parameters, layerInputs } = resolved;

      // In WASM mode a vector_out param carries the chosen output format (its value
      // is otherwise unused by the runner). A CRS-preserving format keeps a
      // reprojection's target CRS and comes back as a downloadable file.
      // Validated against the known formats: a stale sidecar-mode output path left
      // in the form state (the form only resets on tool change) would otherwise be
      // cast to a bogus format and produce a `..._output.undefined` filename.
      const vectorOutputFormat = runVectorOutputFormat(selectedTool, values, runLocal);

      // Track the run for the Processing History panel (#1292). The raw form
      // values (with `layer:` tokens) are recorded, not the resolved request
      // parameters, so Edit & re-run can restore the form exactly.
      tracker = beginProcessingRun({
        kind: "whitebox",
        toolId: selectedTool.id,
        toolName: toolLabel(t, selectedTool),
        engine: runLocal ? "wasm" : "sidecar",
        parameters: { ...values },
      });
      const request = {
        tool_id: selectedTool.id,
        parameters,
        tool: selectedTool,
        layer_inputs: layerInputs,
        include_pro: false,
        tier: "open",
        vector_output_format: vectorOutputFormat,
      };
      // The local WASM runner executes synchronously on the main thread, so yield
      // twice to the browser first: this lets React commit and paint the Run
      // button's busy state before the run blocks rendering.
      if (runLocal) {
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      }
      const nextJob = await (runLocal
        ? services.runWhiteboxToolWasm(request)
        : services.runWhiteboxTool(request));
      // Record this run's parameters against its job id so output-download naming
      // can later recover the output path the user typed (the job omits it). Only
      // the WASM runner returns inline binary outputs that need this; the sidecar
      // returns fetchable paths. `succeeded` is terminal for WASM, so a failed run
      // adds nothing to clean up.
      if (runLocal && nextJob.status === "succeeded") {
        runParametersByJobRef.current.set(nextJob.id, parameters);
      }
      jobGenerationByJobRef.current.set(nextJob.id, dispatchLoadCount);
      historyTrackersRef.current.set(nextJob.id, tracker);
      evictOldestEntries(historyTrackersRef.current, MAX_TRACKED_HISTORY_JOBS, (oldest) =>
        jobGenerationByJobRef.current.delete(oldest),
      );
      importedJobIdRef.current = null;
      setJob(nextJob);
    } catch (err) {
      const message = err instanceof Error ? err.message : t("processing.whitebox.errorStartTool");
      tracker?.finish("error", message);
      setError(message);
    } finally {
      setRunningLocal(false);
    }
  };

  const startServer = async () => {
    setStartingServer(true);
    setError(null);
    try {
      await services.startGeoLibreSidecar();
      await loadWhitebox();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("processing.whitebox.errorStartSidecar"));
    } finally {
      setStartingServer(false);
    }
  };

  const stopServer = async () => {
    setStoppingServer(true);
    setError(null);
    try {
      await services.stopGeoLibreSidecar();
      setRuntimeAvailable(false);
      setRuntimeMessage("GeoLibre sidecar is stopped. Showing GitHub catalog only.");
      setJob(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("processing.whitebox.errorStopSidecar"));
    } finally {
      setStoppingServer(false);
    }
  };

  const running = runningLocal || isJobRunning(job);
  // Only a sidecar job can be pending or running: WASM runs arrive terminal.
  // Cancelling kills the tool on the sidecar; polling then picks up the
  // job's `cancelled` state.
  const sidecarJobRunning = !runningLocal && isJobRunning(job);
  const { cancellingJob, cancelSidecarJob } = useSidecarJobCancellation(
    job,
    sidecarJobRunning,
    services.cancelWhiteboxJob,
    setJob,
    setError,
    t("processing.whitebox.errorCancel"),
  );
  const serverBusy = loadingTools || startingServer || stoppingServer;
  return {
    open,
    setProcessingOpen,
    layers,
    desktop,
    desktopServer,
    tools,
    selectedToolId,
    setSelectedToolId,
    selectedTool,
    values,
    historyRestoreRevision,
    query,
    setQuery,
    category,
    setCategory,
    source,
    setSource,
    loadingTools,
    runtimeMessage,
    runtimeAvailable,
    runLocal,
    setRunLocal,
    error,
    setError,
    startingServer,
    stoppingServer,
    job,
    linkCopied,
    drawing,
    drawPoints,
    hasGeolibreTools,
    vectorInputParams,
    cornerExtentParams,
    cornerExtentAnchor,
    distanceLatitude,
    showDistanceNote,
    fieldOptions,
    shareUrl,
    sourceCounts,
    categories,
    filteredTools,
    semantic,
    semanticTools,
    keywordTools,
    running,
    sidecarJobRunning,
    cancellingJob,
    serverBusy,
    loadWhitebox,
    handleCopyLink,
    updateValue,
    handlePopulateSubsetUrl,
    handleUseMapExtent,
    handleDrawBbox,
    handleRunLocalChange,
    handlePickInputFile,
    handlePickInputFiles,
    runSelectedTool,
    startServer,
    stopServer,
    cancelSidecarJob,
  };
}

/** The view-model {@link useWhiteboxToolboxController} returns. */
export type WhiteboxToolboxController = ReturnType<typeof useWhiteboxToolboxController>;
