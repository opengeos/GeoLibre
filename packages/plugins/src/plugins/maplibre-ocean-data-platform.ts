import { DEFAULT_LAYER_STYLE, useAppStore, type GeoLibreLayer } from "@geolibre/core";
import type { Feature, FeatureCollection } from "geojson";
import { createLayerId } from "../layer-ids";
import type { GeoLibreAppAPI, GeoLibrePlugin } from "../types";
import { isTauriRuntime } from "./earth-engine-auth";
import {
  ODP_CATALOG_URL,
  ODP_DOCS_URL,
  ODP_FEATURES_MAX_LIMIT,
  ODP_SOURCE_LAYER,
  ODP_TERMS_URL,
  ODP_TILE_MAX_ZOOM,
  type OdpBbox,
  type OdpCollection,
  type OdpDataset,
  fetchOdpCatalog,
  odpFeaturesUrl,
  odpGeometryKind,
  odpTileUrlTemplate,
  odpTimeRange,
  searchOdpDatasets,
} from "./ocean-data-platform-api";
import { getControlMap } from "./style-map";

export const OCEAN_DATA_PLATFORM_PLUGIN_ID = "geolibre-ocean-data-platform";
const PANEL_ID = OCEAN_DATA_PLATFORM_PLUGIN_ID;

/** `metadata.sourceKind` of the vector tile layers this plugin adds. */
const TILES_SOURCE_KIND = "ocean-data-platform-vector-tiles";
/** `metadata.sourceKind` of the GeoJSON layers this plugin adds. */
const FEATURES_SOURCE_KIND = "ocean-data-platform-features";
/** Layer metadata key holding the ODP dataset UUID. */
const DATASET_METADATA_KEY = "odpDatasetId";

/** Most results rendered at once; the rest wait for a narrower search. */
const MAX_RESULTS_SHOWN = 100;
/** Delay between a keystroke and re-filtering the results. */
const SEARCH_DEBOUNCE_MS = 150;
const ATTRIBUTION = "HUB Ocean Ocean Data Platform";

/**
 * Saves a generated file. The plugins package cannot reach the app's Tauri
 * file dialogs, so the host injects a saver (a native dialog on desktop, a
 * browser download on the web); without one the panel falls back to a plain
 * anchor download.
 */
export type OceanDataPlatformFileSaver = (
  blob: Blob,
  options: { defaultName: string; extension: string; mimeType: string; description: string },
) => Promise<unknown>;

let fileSaver: OceanDataPlatformFileSaver | null = null;

/** Injects the host's file saver (see {@link OceanDataPlatformFileSaver}). */
export function setOceanDataPlatformFileSaver(saver: OceanDataPlatformFileSaver | null): void {
  fileSaver = saver;
}

const CSS = {
  panel:
    "display:flex;flex-direction:column;gap:10px;padding:10px;height:100%;" +
    "box-sizing:border-box;overflow-y:auto;color:hsl(var(--foreground));font-size:12px;",
  hint: "margin:0;color:hsl(var(--muted-foreground));line-height:1.45;",
  label: "display:flex;flex-direction:column;gap:4px;font-size:11px;font-weight:600;",
  input:
    "width:100%;box-sizing:border-box;padding:6px 8px;border:1px solid hsl(var(--border));" +
    "border-radius:6px;background:hsl(var(--background));color:hsl(var(--foreground));",
  info:
    "display:flex;flex-direction:column;gap:6px;padding:8px;border-radius:6px;" +
    "border:1px solid hsl(var(--border));background:hsl(var(--muted));",
  infoSummary: "font-weight:600;cursor:pointer;",
  infoText: "margin:0;font-size:11px;line-height:1.45;",
  links: "display:flex;gap:12px;flex-wrap:wrap;font-size:11px;",
  link: "color:hsl(var(--primary));text-decoration:underline;",
  checkbox: "display:flex;align-items:center;gap:6px;font-size:11px;",
  secondary:
    "padding:6px 10px;border:1px solid hsl(var(--border));border-radius:6px;" +
    "background:hsl(var(--background));color:hsl(var(--foreground));cursor:pointer;",
  status:
    "box-sizing:border-box;width:100%;padding:8px;border-radius:6px;background:hsl(var(--muted));" +
    "color:hsl(var(--muted-foreground));line-height:1.45;",
  statusError:
    "box-sizing:border-box;width:100%;padding:8px;border-radius:6px;" +
    "background:hsl(var(--destructive) / 0.12);color:hsl(var(--destructive));line-height:1.45;",
  count: "font-size:11px;color:hsl(var(--muted-foreground));",
  list: "display:flex;flex-direction:column;gap:6px;",
  row:
    "box-sizing:border-box;width:100%;display:flex;flex-direction:column;gap:4px;" +
    "padding:6px 8px;border:1px solid hsl(var(--border));border-radius:6px;",
  rowTitle: "font-weight:600;line-height:1.35;overflow-wrap:anywhere;",
  rowSubtitle: "color:hsl(var(--muted-foreground));font-size:11px;overflow-wrap:anywhere;",
  rowDescription:
    "margin:0;color:hsl(var(--muted-foreground));font-size:11px;line-height:1.4;" +
    "display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;",
  rowActions: "display:flex;gap:4px;flex-wrap:wrap;align-items:center;",
  action:
    "padding:2px 8px;font-size:11px;border-radius:4px;cursor:pointer;" +
    "border:1px solid hsl(var(--border));background:hsl(var(--background));" +
    "color:hsl(var(--foreground));",
  actionLink: "padding:2px 4px;font-size:11px;color:hsl(var(--primary));text-decoration:underline;",
  attribution: "margin:0;font-size:10px;color:hsl(var(--muted-foreground));line-height:1.4;",
} as const;

/**
 * Panel state. Kept at module scope so a rebuild (a language change) restores
 * the search instead of wiping it; reset when the plugin deactivates.
 */
interface PanelState {
  query: string;
  collectionId: string | null;
  /** Keep only datasets whose extent intersects the map view. */
  inView: boolean;
  status: { text: string; error: boolean } | null;
  busy: boolean;
  infoExpanded: boolean;
}

function initialState(): PanelState {
  return {
    query: "",
    collectionId: null,
    inView: false,
    status: null,
    busy: false,
    infoExpanded: false,
  };
}

let state: PanelState = initialState();
let appRef: GeoLibreAppAPI | null = null;
let unregisterPanel: (() => void) | null = null;
let unsubscribeLocale: (() => void) | null = null;
let panelContainer: HTMLElement | null = null;
let disposePanel: (() => void) | null = null;
/** The public catalog, fetched once per session. */
let catalogPromise: Promise<{ collections: OdpCollection[]; datasets: OdpDataset[] }> | null = null;

/** Resolves a plugin-namespaced translation key, falling back to English text. */
function tr(key: string, fallback: string, params?: Record<string, string | number>): string {
  return (
    appRef?.translate?.(`plugin.${OCEAN_DATA_PLATFORM_PLUGIN_ID}.${key}`, fallback, params) ??
    fallback.replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(params?.[name] ?? ""))
  );
}

/** Creates an element with inline CSS. */
function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  style?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (style) node.style.cssText = style;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(
  text: string,
  style: string,
  onClick: () => void,
  title?: string,
): HTMLButtonElement {
  const node = element("button", style, text);
  node.type = "button";
  if (title) node.title = title;
  node.addEventListener("click", onClick);
  return node;
}

function link(text: string, href: string, style: string = CSS.link): HTMLAnchorElement {
  const anchor = element("a", style, text);
  anchor.href = href;
  anchor.target = "_blank";
  anchor.rel = "noopener";
  return anchor;
}

function formatCount(count: number): string {
  return count.toLocaleString(appRef?.getLocale?.() ?? undefined);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

/** Normalizes a longitude into [-180, 180]. */
function normalizeLon(lon: number): number {
  return ((((lon + 180) % 360) + 360) % 360) - 180;
}

/**
 * The current map view as a [w, s, e, n] box. A view crossing the
 * antimeridian keeps west > east; a view wider than the world becomes the
 * whole longitude range.
 */
function viewBbox(): OdpBbox | null {
  const map = getControlMap(appRef);
  if (!map) return null;
  const bounds = map.getBounds();
  const clampLat = (value: number): number => Math.max(-90, Math.min(90, value));
  let west = normalizeLon(bounds.getWest());
  let east = normalizeLon(bounds.getEast());
  if (bounds.getEast() - bounds.getWest() >= 360) {
    west = -180;
    east = 180;
  }
  return [west, clampLat(bounds.getSouth()), east, clampLat(bounds.getNorth())];
}

/** Loads (once) the public catalog; a failed load is retried next time. */
function loadCatalog(): Promise<{ collections: OdpCollection[]; datasets: OdpDataset[] }> {
  catalogPromise ??= fetchOdpCatalog().catch((error: unknown) => {
    catalogPromise = null;
    throw error;
  });
  return catalogPromise;
}

/**
 * Saves a generated blob through the host saver, or an anchor download.
 *
 * @returns False when the user cancelled the save dialog (the host saver
 *   resolves to null then).
 */
async function saveBlob(
  blob: Blob,
  options: { defaultName: string; extension: string; mimeType: string; description: string },
): Promise<boolean> {
  if (fileSaver) {
    return (await fileSaver(blob, options)) !== null;
  }
  const url = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = options.defaultName;
    anchor.click();
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return true;
}

/** A filesystem-safe file name stem for a dataset. */
function fileStem(dataset: OdpDataset): string {
  const stem = dataset.title
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "_")
    .slice(0, 80);
  return stem || dataset.id;
}

/**
 * Reads one page of a dataset's features. The desktop app reads ODP directly
 * over native HTTP; browsers go through the Worker, which adds CORS.
 *
 * @param dataset - The dataset to read.
 * @param bbox - Keep only features intersecting this box, when set.
 * @param limit - Most features to read.
 * @param signal - Aborts the read (browser path only; native reads run on).
 */
async function fetchFeatures(
  dataset: OdpDataset,
  bbox: OdpBbox | null,
  limit: number,
  signal?: AbortSignal,
): Promise<FeatureCollection> {
  let text: string;
  const fetchArrayBuffer = appRef?.fetchArrayBuffer;
  if (isTauriRuntime() && fetchArrayBuffer) {
    const bytes = await fetchArrayBuffer(
      odpFeaturesUrl(dataset.id, { bbox, limit, via: "direct" }),
    );
    signal?.throwIfAborted();
    text = new TextDecoder().decode(bytes);
  } else {
    const url = odpFeaturesUrl(dataset.id, { bbox, limit, via: "proxy" });
    const response = await fetch(url, { signal, headers: { accept: "application/geo+json" } });
    if (!response.ok) {
      throw new Error(
        response.status === 401 || response.status === 403
          ? tr("notPublic", "This dataset is not publicly available.")
          : `HTTP ${response.status}`,
      );
    }
    text = await response.text();
  }
  const json = JSON.parse(text) as Partial<FeatureCollection>;
  const features = Array.isArray(json.features) ? (json.features as Feature[]) : [];
  return { type: "FeatureCollection", features };
}

/** The attribute names found on a sample of features, in first-seen order. */
function fieldNames(features: readonly Feature[]): string[] {
  const names = new Set<string>();
  for (const feature of features) {
    for (const key of Object.keys(feature.properties ?? {})) names.add(key);
  }
  return [...names];
}

/** The look of an ODP layer: ocean blue, light enough for points and areas. */
function odpStyle(): GeoLibreLayer["style"] {
  return {
    ...DEFAULT_LAYER_STYLE,
    fillColor: "#0284c7",
    strokeColor: "#075985",
    fillOpacity: 0.45,
    strokeWidth: 1,
    circleRadius: 4,
  };
}

/** An ODP layer of the given kind already on the map for a dataset, if any. */
function existingLayer(dataset: OdpDataset, sourceKind: string): GeoLibreLayer | undefined {
  return useAppStore
    .getState()
    .layers.find(
      (layer) =>
        layer.metadata?.sourceKind === sourceKind &&
        layer.metadata?.[DATASET_METADATA_KEY] === dataset.id,
    );
}

/**
 * Adds a dataset as a vector tile layer. The tiles carry every attribute, but
 * a vector tile layer has no local features for the Style panel to inspect, so
 * one feature is read afterwards to fill in the field names and geometry type.
 */
function addTilesLayer(dataset: OdpDataset, setStatus: (text: string, error?: boolean) => void) {
  const existing = existingLayer(dataset, TILES_SOURCE_KIND);
  if (existing) {
    setStatus(tr("alreadyAdded", "{{name}} is already on the map.", { name: existing.name }));
    return;
  }
  const layer: GeoLibreLayer = {
    id: createLayerId(),
    name: dataset.title,
    type: "vector-tiles",
    source: {
      type: "vector",
      tiles: [odpTileUrlTemplate(dataset.id)],
      sourceLayer: ODP_SOURCE_LAYER,
      sourceLayers: [ODP_SOURCE_LAYER],
      minzoom: 0,
      maxzoom: ODP_TILE_MAX_ZOOM,
      ...(dataset.bbox ? { bounds: dataset.bbox } : {}),
    },
    visible: true,
    opacity: 1,
    style: odpStyle(),
    metadata: {
      sourceKind: TILES_SOURCE_KIND,
      [DATASET_METADATA_KEY]: dataset.id,
      sourceLayers: [ODP_SOURCE_LAYER],
      attribution: ATTRIBUTION,
      catalogUrl: dataset.catalogUrl,
      ...(dataset.license ? { license: dataset.license } : {}),
    },
    sourcePath: dataset.catalogUrl,
  };
  useAppStore.getState().addLayer(layer);
  if (dataset.bbox) appRef?.fitBounds?.(dataset.bbox);
  setStatus(
    tr("tilesAdded", "Added {{name}}. Tiles can take a few seconds to load the first time.", {
      name: dataset.title,
    }),
  );
  // Best-effort: the layer renders without these hints.
  void fetchFeatures(dataset, null, 1)
    .then((sample) => {
      const store = useAppStore.getState();
      const current = store.layers.find((entry) => entry.id === layer.id);
      if (!current) return;
      const geometryType = odpGeometryKind(sample.features[0]?.geometry?.type);
      store.updateLayer(layer.id, {
        metadata: {
          ...current.metadata,
          fields: fieldNames(sample.features),
          ...(geometryType ? { geometryType } : {}),
        },
      });
    })
    .catch(() => undefined);
}

/**
 * Reads the features of a dataset in the map view (or its whole extent when
 * the map is not available) and reports whether the read was cut off.
 */
async function readFeaturesInView(
  dataset: OdpDataset,
  setStatus: (text: string, error?: boolean) => void,
  signal: AbortSignal,
): Promise<{ collection: FeatureCollection; truncated: boolean } | null> {
  setStatus(tr("readingFeatures", "Reading features of {{name}}…", { name: dataset.title }));
  const collection = await fetchFeatures(dataset, viewBbox(), ODP_FEATURES_MAX_LIMIT, signal);
  if (collection.features.length === 0) {
    setStatus(
      tr("noFeaturesInView", "No features of {{name}} in the map view.", { name: dataset.title }),
    );
    return null;
  }
  return { collection, truncated: collection.features.length >= ODP_FEATURES_MAX_LIMIT };
}

/** Adds a dataset's features in the map view as an editable GeoJSON layer. */
async function addFeaturesLayer(
  dataset: OdpDataset,
  setStatus: (text: string, error?: boolean) => void,
  signal: AbortSignal,
): Promise<void> {
  const result = await readFeaturesInView(dataset, setStatus, signal);
  if (!result || signal.aborted) return;
  const app = appRef;
  if (!app) return;
  const layerId = app.addGeoJsonLayer(
    tr("featuresLayerName", "{{name}} (features)", { name: dataset.title }),
    result.collection,
  );
  const store = useAppStore.getState();
  const layer = store.layers.find((entry) => entry.id === layerId);
  if (layer) {
    store.updateLayer(layerId, {
      style: { ...layer.style, ...odpStyle() },
      metadata: {
        ...layer.metadata,
        sourceKind: FEATURES_SOURCE_KIND,
        [DATASET_METADATA_KEY]: dataset.id,
        attribution: ATTRIBUTION,
        catalogUrl: dataset.catalogUrl,
        ...(dataset.license ? { license: dataset.license } : {}),
      },
    });
  }
  const count = formatCount(result.collection.features.length);
  setStatus(
    result.truncated
      ? tr(
          "featuresAddedTruncated",
          "Added the first {{count}} features in the map view. Zoom in, or use Add to map for the whole dataset as vector tiles.",
          { count },
        )
      : tr("featuresAdded", "Added {{count}} features.", { count }),
  );
}

/** Saves a dataset's features in the map view as a GeoJSON file. */
async function downloadGeoJson(
  dataset: OdpDataset,
  setStatus: (text: string, error?: boolean) => void,
  signal: AbortSignal,
): Promise<void> {
  const result = await readFeaturesInView(dataset, setStatus, signal);
  if (!result || signal.aborted) return;
  // One string per feature, so a large file never exceeds V8's string limit.
  const parts: string[] = ['{"type":"FeatureCollection","features":['];
  result.collection.features.forEach((feature, index) => {
    parts.push(index === 0 ? JSON.stringify(feature) : `,${JSON.stringify(feature)}`);
  });
  parts.push("]}");
  const blob = new Blob(parts, { type: "application/geo+json" });
  const name = `${fileStem(dataset)}.geojson`;
  const saved = await saveBlob(blob, {
    defaultName: name,
    extension: "geojson",
    mimeType: "application/geo+json",
    description: "GeoJSON",
  });
  if (!saved) {
    setStatus(tr("saveCancelled", "Save cancelled."));
    return;
  }
  const count = formatCount(result.collection.features.length);
  setStatus(
    result.truncated
      ? tr(
          "savedTruncated",
          "Saved {{name}} with the first {{count}} features in the map view. Zoom in to save the rest.",
          { name, count },
        )
      : tr("saved", "Saved {{name}} ({{count}} features).", { name, count }),
  );
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

/** What ODP is, as a collapsible card (collapsed by default). */
function platformInfo(): HTMLElement {
  const box = element("details", CSS.info);
  box.open = state.infoExpanded;
  box.addEventListener("toggle", () => {
    state.infoExpanded = box.open;
  });
  box.append(
    element("summary", CSS.infoSummary, tr("infoSummary", "About the Ocean Data Platform")),
    element(
      "p",
      CSS.infoText,
      tr(
        "infoText",
        "HUB Ocean's Ocean Data Platform shares ocean datasets from research institutions, governments and industry: habitats, protected areas, fisheries, observations and more.",
      ),
    ),
    element(
      "p",
      CSS.infoText,
      tr(
        "infoAccess",
        "This panel lists the publicly shared datasets. Add to map streams a dataset as vector tiles; Features in view and GeoJSON read up to {{limit}} features in the map view.",
        { limit: formatCount(ODP_FEATURES_MAX_LIMIT) },
      ),
    ),
  );
  const links = element("div", CSS.links);
  links.append(
    link(tr("catalog", "Catalog"), ODP_CATALOG_URL),
    link(tr("docs", "Documentation"), ODP_DOCS_URL),
    link(tr("terms", "Terms of use"), ODP_TERMS_URL),
  );
  box.append(
    links,
    element(
      "p",
      CSS.attribution,
      tr(
        "attribution",
        "Data via HUB Ocean. Each dataset keeps its provider's license; check it before reuse.",
      ),
    ),
  );
  return box;
}

function buildPanel(container: HTMLElement): () => void {
  container.replaceChildren();
  container.style.cssText = CSS.panel;
  let disposed = false;
  let controller: AbortController | null = null;
  let searchTimer: ReturnType<typeof setTimeout> | null = null;
  let catalog: { collections: OdpCollection[]; datasets: OdpDataset[] } | null = null;
  let catalogError: string | null = null;
  const taskButtons: HTMLButtonElement[] = [];

  const statusBox = element("div");
  const countLine = element("div", CSS.count);
  const list = element("div", CSS.list);

  const renderStatus = (): void => {
    if (!state.status) {
      statusBox.style.display = "none";
      return;
    }
    statusBox.style.cssText = state.status.error ? CSS.statusError : CSS.status;
    statusBox.textContent = state.status.text;
  };
  const setStatus = (text: string, error = false): void => {
    if (disposed) return;
    state.status = { text, error };
    renderStatus();
  };
  const setBusy = (busy: boolean): void => {
    state.busy = busy;
    for (const node of taskButtons) node.disabled = busy;
  };

  /** A row action that runs one abortable task at a time. */
  const taskButton = (
    text: string,
    run: (signal: AbortSignal) => Promise<void>,
    title: string,
  ): HTMLButtonElement => {
    const node = button(
      text,
      CSS.action,
      () => {
        if (state.busy) return;
        controller = new AbortController();
        const { signal } = controller;
        setBusy(true);
        run(signal)
          .catch((error: unknown) => {
            if (!isAbort(error) && !signal.aborted) {
              setStatus(
                tr("taskFailed", "Failed: {{message}}", { message: errorMessage(error) }),
                true,
              );
            }
          })
          .finally(() => {
            if (controller?.signal === signal) controller = null;
            if (!disposed) setBusy(false);
          });
      },
      title,
    );
    node.disabled = state.busy;
    taskButtons.push(node);
    return node;
  };

  const renderResults = (): void => {
    taskButtons.length = 0;
    list.replaceChildren();
    if (!catalog) {
      countLine.textContent = catalogError ? "" : tr("loadingCatalog", "Loading the catalog…");
      return;
    }
    const results = searchOdpDatasets(catalog.datasets, {
      query: state.query,
      collectionId: state.collectionId,
      bbox: state.inView ? viewBbox() : null,
    });
    countLine.textContent =
      results.length > MAX_RESULTS_SHOWN
        ? tr(
            "countLimited",
            "Showing {{shown}} of {{count}} datasets. Refine the search to see the rest.",
            {
              shown: formatCount(MAX_RESULTS_SHOWN),
              count: formatCount(results.length),
            },
          )
        : tr("count", "{{count}} of {{total}} datasets", {
            count: formatCount(results.length),
            total: formatCount(catalog.datasets.length),
          });
    for (const dataset of results.slice(0, MAX_RESULTS_SHOWN)) {
      list.append(resultRow(dataset));
    }
  };

  const resultRow = (dataset: OdpDataset): HTMLElement => {
    const row = element("div", CSS.row);
    row.append(element("div", CSS.rowTitle, dataset.title));
    const subtitle = [dataset.collectionTitle, odpTimeRange(dataset), dataset.license ?? ""]
      .filter(Boolean)
      .join(" · ");
    if (subtitle) row.append(element("div", CSS.rowSubtitle, subtitle));
    if (dataset.description) {
      const description = element("p", CSS.rowDescription, dataset.description);
      description.title = dataset.description;
      row.append(description);
    }
    const actions = element("div", CSS.rowActions);
    actions.append(
      button(
        tr("addToMap", "Add to map"),
        CSS.action,
        () => addTilesLayer(dataset, setStatus),
        tr("addToMapTitle", "Stream the whole dataset onto the map as vector tiles"),
      ),
      taskButton(
        tr("featuresInView", "Features in view"),
        (signal) => addFeaturesLayer(dataset, setStatus, signal),
        tr(
          "featuresInViewTitle",
          "Add the features in the map view as an editable GeoJSON layer (up to {{limit}})",
          { limit: formatCount(ODP_FEATURES_MAX_LIMIT) },
        ),
      ),
      taskButton(
        tr("downloadGeoJson", "GeoJSON"),
        (signal) => downloadGeoJson(dataset, setStatus, signal),
        tr(
          "downloadGeoJsonTitle",
          "Save the features in the map view as GeoJSON (up to {{limit}})",
          {
            limit: formatCount(ODP_FEATURES_MAX_LIMIT),
          },
        ),
      ),
    );
    const bbox = dataset.bbox;
    if (bbox) {
      actions.append(button(tr("zoom", "Zoom"), CSS.action, () => appRef?.fitBounds?.(bbox)));
    }
    actions.append(link(tr("details", "Details"), dataset.catalogUrl, CSS.actionLink));
    row.append(actions);
    return row;
  };

  const scheduleResults = (): void => {
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      searchTimer = null;
      renderResults();
    }, SEARCH_DEBOUNCE_MS);
  };

  // --- Controls -------------------------------------------------------------
  container.append(
    element(
      "p",
      CSS.hint,
      tr(
        "hint",
        "Search the public ocean datasets on HUB Ocean's Ocean Data Platform and add them to the map.",
      ),
    ),
    platformInfo(),
  );

  const searchInput = element("input", CSS.input);
  searchInput.type = "search";
  searchInput.value = state.query;
  searchInput.placeholder = tr("searchPlaceholder", "Search titles, descriptions, keywords…");
  searchInput.setAttribute("aria-label", tr("search", "Search"));
  searchInput.addEventListener("input", () => {
    state.query = searchInput.value;
    scheduleResults();
  });

  const collectionSelect = element("select", CSS.input);
  collectionSelect.setAttribute("aria-label", tr("collection", "Collection"));
  collectionSelect.addEventListener("change", () => {
    state.collectionId = collectionSelect.value || null;
    renderResults();
  });
  const renderCollections = (): void => {
    const all = element("option", undefined, tr("allCollections", "All collections"));
    all.value = "";
    collectionSelect.replaceChildren(all);
    for (const collection of catalog?.collections ?? []) {
      const option = element("option", undefined, collection.title);
      option.value = collection.id;
      collectionSelect.append(option);
    }
    collectionSelect.value = state.collectionId ?? "";
    // A remembered collection that no longer exists falls back to all.
    if (collectionSelect.value !== (state.collectionId ?? "")) {
      state.collectionId = null;
      collectionSelect.value = "";
    }
  };
  renderCollections();

  const inViewInput = element("input");
  inViewInput.type = "checkbox";
  inViewInput.checked = state.inView;
  inViewInput.addEventListener("change", () => {
    state.inView = inViewInput.checked;
    renderResults();
  });
  const inViewLabel = element("label", CSS.checkbox);
  inViewLabel.append(inViewInput, tr("inView", "Only datasets in the map view"));

  const searchLabel = element("label", CSS.label, tr("search", "Search"));
  searchLabel.append(searchInput);
  const collectionLabel = element("label", CSS.label, tr("collection", "Collection"));
  collectionLabel.append(collectionSelect);
  container.append(searchLabel, collectionLabel, inViewLabel, statusBox, countLine, list);
  renderStatus();
  renderResults();

  // Re-filter "in the map view" results as the map moves.
  const map = getControlMap(appRef);
  const onMoveEnd = (): void => {
    if (state.inView) renderResults();
  };
  map?.on("moveend", onMoveEnd);

  const retryButton = (): HTMLButtonElement =>
    button(tr("retry", "Retry"), CSS.secondary, () => {
      catalogError = null;
      state.status = null;
      renderStatus();
      list.replaceChildren();
      load();
    });

  const load = (): void => {
    renderResults();
    loadCatalog()
      .then((loaded) => {
        if (disposed) return;
        catalog = loaded;
        renderCollections();
        renderResults();
      })
      .catch((error: unknown) => {
        if (disposed) return;
        catalogError = errorMessage(error);
        setStatus(
          tr("catalogFailed", "Could not load the Ocean Data Platform catalog: {{message}}", {
            message: catalogError,
          }),
          true,
        );
        renderResults();
        list.replaceChildren(retryButton());
      });
  };
  load();

  return () => {
    disposed = true;
    controller?.abort();
    controller = null;
    // The aborted task belonged to this panel; the next panel starts idle.
    state.busy = false;
    if (searchTimer) clearTimeout(searchTimer);
    map?.off("moveend", onMoveEnd);
    container.replaceChildren();
  };
}

function mountPanel(container: HTMLElement): void {
  disposePanel?.();
  panelContainer = container;
  disposePanel = buildPanel(container);
}

/**
 * Ocean Data Platform plugin: searches the public datasets of HUB Ocean's
 * Ocean Data Platform (from its STAC catalog) and adds them to the map as
 * vector tiles, or reads the features in the map view as a GeoJSON layer or
 * file through OGC API Features.
 */
export const maplibreOceanDataPlatformPlugin: GeoLibrePlugin = {
  id: OCEAN_DATA_PLATFORM_PLUGIN_ID,
  name: "Ocean Data Platform",
  version: "0.1.0",
  // Everything it adds is a vector-tiles or GeoJSON store layer, which every
  // 2D engine hosts.
  engines: ["maplibre", "mapbox", "arcgis"],
  activate: (app) => {
    appRef = app;
    unregisterPanel =
      app.registerRightPanel?.({
        id: PANEL_ID,
        title: () => tr("title", "Ocean Data Platform"),
        dock: "replace-style",
        defaultWidth: 360,
        render: (container) => {
          mountPanel(container);
          return () => {
            disposePanel?.();
            disposePanel = null;
            if (panelContainer === container) panelContainer = null;
          };
        },
      }) ?? null;
    unsubscribeLocale =
      app.onLocaleChange?.(() => {
        if (panelContainer) mountPanel(panelContainer);
      }) ?? null;
    app.openRightPanel?.(PANEL_ID);
  },
  deactivate: (app) => {
    app.closeRightPanel?.(PANEL_ID);
    unsubscribeLocale?.();
    unsubscribeLocale = null;
    unregisterPanel?.();
    unregisterPanel = null;
    disposePanel?.();
    disposePanel = null;
    panelContainer = null;
    state = initialState();
    appRef = null;
  },
};

export default maplibreOceanDataPlatformPlugin;
