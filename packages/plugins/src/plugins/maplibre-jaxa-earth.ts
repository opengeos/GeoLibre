import { useAppStore } from "@geolibre/core";
import type { RasterTileSource } from "maplibre-gl";
import { createPluginTranslator } from "../plugin-i18n";
import type { GeoLibreAppAPI, GeoLibrePlugin } from "../types";
import {
  JAXA_COLORMAP_NAMES,
  JAXA_EARTH_ATTRIBUTION,
  JAXA_EARTH_HOME_URL,
  JAXA_EARTH_TERMS_URL,
  JAXA_EARTH_TILE_SIZE,
  type JaxaCatalog,
  type JaxaDataset,
  type JaxaTileSpec,
  defaultJaxaColormap,
  fetchJaxaCatalog,
  FETCH_TIMEOUT_MS,
  getJaxaImageCollection,
  isJaxaDatasetMappable,
  jaxaColorsFor,
  jaxaDatasetPageUrl,
  jaxaMaxZoom,
  jaxaTileUrl,
  loadJaxaEarthModule,
  percentileRange,
  searchJaxaDatasets,
} from "./jaxa-earth-api";
import { getStyleMap } from "./style-map";

export const JAXA_EARTH_PLUGIN_ID = "geolibre-jaxa-earth";
const PANEL_ID = JAXA_EARTH_PLUGIN_ID;

/** Layer metadata keys recording what a JAXA Earth layer draws. */
const DATASET_METADATA_KEY = "jaxaEarthDataset";
const BAND_METADATA_KEY = "jaxaEarthBand";
const DATE_METADATA_KEY = "jaxaEarthDate";

/** Pixels on the long side of the sample read for an automatic range. */
const SAMPLE_SIZE = 360;
/** Delay between a keystroke and re-filtering the dataset list. */
const SEARCH_DEBOUNCE_MS = 150;

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
  card:
    "display:flex;flex-direction:column;gap:6px;padding:8px;border-radius:6px;" +
    "border:1px solid hsl(var(--border));",
  cardTitle: "font-weight:600;line-height:1.35;overflow-wrap:anywhere;",
  cardMeta: "color:hsl(var(--muted-foreground));font-size:11px;line-height:1.4;",
  cardDescription:
    "margin:0;color:hsl(var(--muted-foreground));font-size:11px;line-height:1.4;" +
    "display:-webkit-box;-webkit-line-clamp:4;-webkit-box-orient:vertical;overflow:hidden;",
  editor: "display:flex;flex-direction:column;gap:10px;",
  row: "display:flex;gap:6px;align-items:center;",
  grow: "flex:1;min-width:0;",
  dateLabel:
    "flex:1;min-width:0;text-align:center;font-weight:600;font-variant-numeric:tabular-nums;",
  step:
    "padding:4px 8px;border:1px solid hsl(var(--border));border-radius:6px;" +
    "background:hsl(var(--background));color:hsl(var(--foreground));cursor:pointer;",
  primary:
    "padding:7px 10px;border:none;border-radius:6px;cursor:pointer;font-weight:600;" +
    "background:hsl(var(--primary));color:hsl(var(--primary-foreground));",
  secondary:
    "padding:6px 10px;border:1px solid hsl(var(--border));border-radius:6px;" +
    "background:hsl(var(--background));color:hsl(var(--foreground));cursor:pointer;",
  colorbar:
    "width:100%;height:12px;border-radius:3px;border:1px solid hsl(var(--border));display:block;",
  colorbarLabels:
    "display:flex;justify-content:space-between;font-size:11px;" +
    "color:hsl(var(--muted-foreground));font-variant-numeric:tabular-nums;",
  status:
    "box-sizing:border-box;width:100%;padding:8px;border-radius:6px;background:hsl(var(--muted));" +
    "color:hsl(var(--muted-foreground));line-height:1.45;",
  statusError:
    "box-sizing:border-box;width:100%;padding:8px;border-radius:6px;" +
    "background:hsl(var(--destructive) / 0.12);color:hsl(var(--destructive));line-height:1.45;",
  attribution: "margin:0;font-size:10px;color:hsl(var(--muted-foreground));line-height:1.4;",
} as const;

/**
 * Panel state. Kept at module scope so a rebuild (a language change) keeps
 * the selection; reset when the plugin deactivates.
 */
interface PanelState {
  query: string;
  datasetId: string | null;
  band: string | null;
  /** The chosen observation date (ISO 8601), snapped to an available one. */
  date: string | null;
  /** JAXA's label for {@link date} ("2024/05", "2024/05/03", "05" for a climatology). */
  dateLabel: string;
  colormap: string;
  min: number | null;
  max: number | null;
  resampling: "nearest" | "bilinear";
  /** The unit of the band's values, read from a sample ("" when dimensionless). */
  unit: string;
  /** False when the band carries its own colors (RGB or classes), so no color map applies. */
  colorMapped: boolean;
  /** The layer the panel last added; date and style changes re-draw it in place. */
  activeLayerId: string | null;
  status: { text: string; error: boolean } | null;
  busy: boolean;
  infoExpanded: boolean;
}

function initialState(): PanelState {
  return {
    query: "",
    datasetId: null,
    band: null,
    date: null,
    dateLabel: "",
    colormap: "viridis",
    min: null,
    max: null,
    resampling: "nearest",
    unit: "",
    colorMapped: true,
    activeLayerId: null,
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
/** The catalog, fetched once per session. */
let catalogPromise: Promise<JaxaCatalog> | null = null;

/** Resolves a plugin-namespaced translation key, falling back to English text. */
const tr = createPluginTranslator(() => appRef, JAXA_EARTH_PLUGIN_ID);

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
  if (title) {
    node.title = title;
    node.setAttribute("aria-label", title);
  }
  node.addEventListener("click", onClick);
  return node;
}

function link(text: string, href: string): HTMLAnchorElement {
  const anchor = element("a", CSS.link, text);
  anchor.href = href;
  anchor.target = "_blank";
  anchor.rel = "noopener";
  return anchor;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function loadCatalog(): Promise<JaxaCatalog> {
  catalogPromise ??= fetchJaxaCatalog(fetch, AbortSignal.timeout(FETCH_TIMEOUT_MS)).catch(
    (error: unknown) => {
      catalogPromise = null;
      throw error;
    },
  );
  return catalogPromise;
}

/** Formats a number for the panel in the host locale. */
function formatNumber(value: number): string {
  return value.toLocaleString(appRef?.getLocale?.() ?? undefined, { maximumFractionDigits: 3 });
}

/** The tile spec the panel's current choices describe, or null when incomplete. */
function currentSpec(): JaxaTileSpec | null {
  if (!state.datasetId || !state.band || !state.date) return null;
  if (state.min === null || state.max === null || !(state.max > state.min)) return null;
  return {
    datasetId: state.datasetId,
    band: state.band,
    date: state.date,
    min: state.min,
    max: state.max,
    colormap: state.colormap,
    // Classes and RGB colors cannot be interpolated; the control is disabled for them.
    resampling: state.colorMapped ? state.resampling : "nearest",
  };
}

function layerName(dataset: JaxaDataset): string {
  const parts = [dataset.title];
  if (state.band && dataset.bands.length > 1) parts.push(state.band);
  if (state.dateLabel) parts.push(`(${state.dateLabel})`);
  return parts.join(" ");
}

/** The live raster source id the map assigns to a store layer. */
function rasterSourceId(layerId: string): string {
  return `source-${layerId}`;
}

/**
 * Points the panel's active layer at the current choices: the store record
 * (so a saved project reopens on them) and, on MapLibre, the live source,
 * whose tiles the layer sync never re-reads.
 */
function updateActiveLayer(dataset: JaxaDataset | undefined): void {
  const spec = currentSpec();
  const id = state.activeLayerId;
  if (!spec || !id || !dataset) return;
  const store = useAppStore.getState();
  const layer = store.layers.find((candidate) => candidate.id === id);
  if (!layer) {
    state.activeLayerId = null;
    return;
  }
  const url = jaxaTileUrl(spec);
  const current = Array.isArray(layer.source.tiles) ? layer.source.tiles[0] : undefined;
  if (current === url) return;
  store.updateLayer(id, {
    name: layerName(dataset),
    source: { ...layer.source, tiles: [url] },
    metadata: {
      ...layer.metadata,
      [DATASET_METADATA_KEY]: spec.datasetId,
      [BAND_METADATA_KEY]: spec.band,
      [DATE_METADATA_KEY]: spec.date,
    },
  });
  // The globe has no style map; it redraws from the store write above.
  // The layer sync never re-reads a raster source's tiles (only vector
  // sources'), so the store write alone would not redraw on MapLibre; set
  // them on the live source, as weather-layer.ts does for its frames.
  const map = getStyleMap(appRef);
  const source = map?.getSource(rasterSourceId(id)) as RasterTileSource | undefined;
  source?.setTiles?.([url]);
}

/** Adds the current choices as a new tile layer. */
function addLayer(dataset: JaxaDataset): string | null {
  const spec = currentSpec();
  const app = appRef;
  if (!spec || !app?.addTileLayer) return null;
  const global =
    !dataset.bbox ||
    (dataset.bbox[0] <= -180 &&
      dataset.bbox[1] <= -85 &&
      dataset.bbox[2] >= 180 &&
      dataset.bbox[3] >= 85);
  const bounds = global ? undefined : dataset.bbox!;
  const id = app.addTileLayer(layerName(dataset), jaxaTileUrl(spec), {
    tileSize: JAXA_EARTH_TILE_SIZE,
    maxzoom: jaxaMaxZoom(dataset.resolutionKm),
    attribution: JAXA_EARTH_ATTRIBUTION,
    ...(bounds ? { bounds } : {}),
    metadata: {
      [DATASET_METADATA_KEY]: spec.datasetId,
      [BAND_METADATA_KEY]: spec.band,
      [DATE_METADATA_KEY]: spec.date,
    },
  });
  if (bounds) app.fitBounds?.(bounds);
  return id;
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

function aboutCard(): HTMLElement {
  const box = element("details", CSS.info);
  box.open = state.infoExpanded;
  box.addEventListener("toggle", () => {
    state.infoExpanded = box.open;
  });
  box.append(
    element("summary", CSS.infoSummary, tr("aboutSummary", "About the JAXA Earth API")),
    element(
      "p",
      CSS.infoText,
      tr(
        "aboutText",
        "The JAXA Earth API publishes Earth observation datasets from JAXA and partner agencies as cloud-optimized GeoTIFFs: ALOS elevation and forest maps, GSMaP precipitation, GCOM-C and MODIS land and sea surface temperature, vegetation, aerosols, soil moisture and more. No account or API key is needed.",
      ),
    ),
    element(
      "p",
      CSS.infoText,
      tr(
        "aboutAccess",
        "GeoLibre draws the tiles in the browser with JAXA's JavaScript API, reading only the resolution and area the map shows.",
      ),
    ),
  );
  const links = element("div", CSS.links);
  links.append(
    link(tr("home", "JAXA Earth API"), JAXA_EARTH_HOME_URL),
    link(tr("terms", "Terms of use"), JAXA_EARTH_TERMS_URL),
  );
  box.append(
    links,
    element(
      "p",
      CSS.attribution,
      tr(
        "attribution",
        "Data courtesy of JAXA. Some datasets come from other agencies and keep their own terms; check the dataset's page before reuse.",
      ),
    ),
  );
  return box;
}

function buildPanel(container: HTMLElement): () => void {
  container.replaceChildren();
  container.style.cssText = CSS.panel;
  let disposed = false;
  let catalog: JaxaCatalog | null = null;
  let searchTimer: ReturnType<typeof setTimeout> | null = null;
  /** Bumped whenever the dataset or band changes, so a stale async result is dropped. */
  let selection = 0;
  /** The editor control that last had focus, so a rebuild can hand focus back. */
  let focusKey: string | null = null;
  const keyed = <T extends HTMLElement>(node: T, key: string): T => {
    node.dataset.focusKey = key;
    return node;
  };

  const statusBox = element("div");
  const datasetSelect = element("select", CSS.input);
  const card = element("div", CSS.card);
  const editor = element("div", CSS.editor);
  editor.addEventListener("focusin", (event) => {
    focusKey = (event.target as HTMLElement).dataset.focusKey ?? null;
  });

  const datasetById = (id: string | null): JaxaDataset | undefined =>
    id ? catalog?.datasets.find((dataset) => dataset.id === id) : undefined;

  const setStatus = (text: string | null, error = false): void => {
    state.status = text === null ? null : { text, error };
    renderStatus();
  };

  const renderStatus = (): void => {
    statusBox.replaceChildren();
    if (!state.status) {
      statusBox.style.cssText = "";
      return;
    }
    statusBox.style.cssText = state.status.error ? CSS.statusError : CSS.status;
    statusBox.textContent = state.status.text;
  };

  // --- Dataset list ---------------------------------------------------------

  const datasetLabel = (dataset: JaxaDataset): string =>
    isJaxaDatasetMappable(dataset)
      ? dataset.title
      : tr("projectionLabel", "{{title}} (projection not supported)", { title: dataset.title });

  const renderDatasetOptions = (): void => {
    const placeholder = element(
      "option",
      undefined,
      catalog ? tr("chooseDataset", "Choose a dataset…") : tr("loading", "Loading the catalog…"),
    );
    placeholder.value = "";
    datasetSelect.replaceChildren(placeholder);
    if (!catalog) {
      datasetSelect.disabled = true;
      return;
    }
    datasetSelect.disabled = false;
    const matches = new Set(searchJaxaDatasets(catalog.datasets, state.query).map((d) => d.id));
    const option = (dataset: JaxaDataset): HTMLOptionElement => {
      const node = element("option", undefined, datasetLabel(dataset));
      node.value = dataset.id;
      node.disabled = !isJaxaDatasetMappable(dataset);
      node.title = dataset.id;
      return node;
    };
    const listed = new Set<string>();
    for (const group of catalog.recommended) {
      const ids = group.ids.filter((id) => matches.has(id));
      if (ids.length === 0) continue;
      const optgroup = element("optgroup");
      optgroup.label = tr("recommendedGroup", "Recommended: {{group}}", { group: group.title });
      for (const id of ids) {
        const dataset = datasetById(id);
        if (!dataset) continue;
        optgroup.append(option(dataset));
        listed.add(id);
      }
      datasetSelect.append(optgroup);
    }
    const rest = catalog.datasets
      .filter((dataset) => matches.has(dataset.id) && !listed.has(dataset.id))
      .sort((a, b) => a.title.localeCompare(b.title));
    if (rest.length > 0) {
      const optgroup = element("optgroup");
      optgroup.label = tr("allGroup", "All datasets");
      for (const dataset of rest) optgroup.append(option(dataset));
      datasetSelect.append(optgroup);
    }
    // The chosen dataset stays listed even when the search hides it.
    const chosen = datasetById(state.datasetId);
    if (chosen && !matches.has(chosen.id)) datasetSelect.append(option(chosen));
    datasetSelect.value = state.datasetId ?? "";
  };

  // --- Dataset card ---------------------------------------------------------

  const renderCard = (): void => {
    card.replaceChildren();
    const dataset = datasetById(state.datasetId);
    if (!dataset) {
      card.style.display = "none";
      return;
    }
    card.style.cssText = CSS.card;
    card.append(element("div", CSS.cardTitle, dataset.title));
    const meta: string[] = [];
    if (dataset.provider) meta.push(dataset.provider);
    if (dataset.resolutionKm !== null) {
      meta.push(
        dataset.resolutionKm < 1
          ? tr("resolutionM", "~{{value}} m", { value: formatNumber(dataset.resolutionKm * 1000) })
          : tr("resolutionKm", "~{{value}} km", { value: formatNumber(dataset.resolutionKm) }),
      );
    }
    if (dataset.temporalResolution && dataset.temporalResolution !== "none") {
      meta.push(dataset.temporalResolution);
    }
    if (dataset.startDate) {
      meta.push(
        tr("timeRange", "{{start}} to {{end}}", {
          start: dataset.startDate.slice(0, 10),
          end: dataset.endDate ? dataset.endDate.slice(0, 10) : tr("present", "present"),
        }),
      );
    }
    if (dataset.normal) meta.push(tr("climatology", "climatology"));
    card.append(element("div", CSS.cardMeta, meta.join(" · ")));
    if (dataset.description) {
      const description = element("p", CSS.cardDescription, dataset.description);
      description.title = dataset.description;
      card.append(description);
    }
    const links = element("div", CSS.links);
    links.append(link(tr("datasetPage", "Dataset details"), jaxaDatasetPageUrl(dataset.id)));
    card.append(links);
  };

  // --- Editor ---------------------------------------------------------------

  const renderColorbar = async (target: HTMLElement): Promise<void> => {
    target.replaceChildren();
    const spec = currentSpec();
    if (!spec || !state.colorMapped) return;
    try {
      const je = await loadJaxaEarthModule();
      if (disposed || currentSpec() === null) return;
      const canvas = new je.image.ColorMap({
        min: spec.min,
        max: spec.max,
        colors: jaxaColorsFor(spec.colormap),
      }).createColorBarCanvas(256, 12);
      canvas.style.cssText = CSS.colorbar;
      const labels = element("div", CSS.colorbarLabels);
      const unit = state.unit ? ` ${state.unit}` : "";
      labels.append(
        element("span", undefined, `${formatNumber(spec.min)}${unit}`),
        element("span", undefined, `${formatNumber(spec.max)}${unit}`),
      );
      target.replaceChildren(canvas, labels);
    } catch {
      // The color bar is decoration; the status line reports load failures.
    }
  };

  /** Re-draws the active layer and the color bar after a change. */
  const applyChange = (): void => {
    updateActiveLayer(datasetById(state.datasetId));
    renderEditor();
  };

  const stepDate = async (direction: "first" | "prev" | "next" | "last"): Promise<void> => {
    const id = state.datasetId;
    // One date request at a time: overlapping steps would race, and the
    // controls (Auto included) stay disabled until this one lands.
    if (!id || !state.date || state.busy) return;
    const token = selection;
    state.busy = true;
    renderEditor();
    try {
      const collection = await getJaxaImageCollection(id);
      const current = new Date(state.date);
      let next: Date;
      if (direction === "first") next = collection.first();
      else if (direction === "last") next = collection.last();
      else if (direction === "prev") next = await collection.prev(current);
      else next = await collection.next(current);
      if (disposed || token !== selection) return;
      state.busy = false;
      if (!Number.isNaN(next.getTime())) {
        state.date = next.toISOString();
        state.dateLabel = collection.formatDate(next);
      }
      setStatus(null);
      applyChange();
    } catch (error) {
      if (disposed || token !== selection) return;
      state.busy = false;
      renderEditor();
      setStatus(
        tr("dateFailed", "Could not change the date: {{message}}", {
          message: errorMessage(error),
        }),
        true,
      );
    }
  };

  const jumpToDate = async (value: string): Promise<void> => {
    const id = state.datasetId;
    if (!id || !state.band || !value || state.busy) return;
    const token = selection;
    state.busy = true;
    renderEditor();
    try {
      const collection = await getJaxaImageCollection(id);
      const requested = new Date(`${value}T23:59:59Z`);
      // JAXA rounds a date down to the latest one it has data for.
      const image = await collection.getImage({ date: requested, band: state.band });
      if (disposed || token !== selection) return;
      state.busy = false;
      state.date = image.getDate().toISOString();
      state.dateLabel = image.getFormattedDate();
      setStatus(null);
      applyChange();
    } catch (error) {
      if (disposed || token !== selection) return;
      state.busy = false;
      renderEditor();
      setStatus(
        tr("dateFailed", "Could not change the date: {{message}}", {
          message: errorMessage(error),
        }),
        true,
      );
    }
  };

  /**
   * Reads a coarse sample of the band at the chosen date over the dataset's
   * extent, to learn its unit, whether it carries its own colors, and (when
   * asked) a display range.
   */
  const sampleBand = async (): Promise<void> => {
    const dataset = datasetById(state.datasetId);
    if (!dataset || !state.band || !state.date) return;
    const token = selection;
    const date = state.date;
    state.busy = true;
    setStatus(tr("sampling", "Reading a sample to set the color range…"));
    renderEditor();
    try {
      const collection = await getJaxaImageCollection(dataset.id);
      const image = await collection.getImage({ date: new Date(date), band: state.band });
      const bbox: [number, number, number, number] = dataset.bbox ?? [-180, -90, 180, 90];
      const aspect = Math.max(0.1, (bbox[3] - bbox[1]) / Math.max(1e-9, bbox[2] - bbox[0]));
      const width = aspect <= 1 ? SAMPLE_SIZE : Math.max(16, Math.round(SAMPLE_SIZE / aspect));
      const height = aspect <= 1 ? Math.max(16, Math.round(SAMPLE_SIZE * aspect)) : SAMPLE_SIZE;
      const sample = await image.getDataObject({ bbox, width, height });
      if (disposed || token !== selection) return;
      if (state.date !== date) {
        // The date moved on while the sample was read; its range would be stale.
        state.busy = false;
        setStatus(null);
        renderEditor();
        return;
      }
      state.unit = sample.unit ?? "";
      state.colorMapped = sample.photometricInterpretation === 1;
      const range = state.colorMapped ? percentileRange(sample.data) : null;
      // A band with its own colors ignores the range; any valid one will do.
      [state.min, state.max] = range ?? [0, 1];
      state.busy = false;
      setStatus(
        range || !state.colorMapped
          ? null
          : tr("noValues", "The sample holds no values; set Min and Max by hand."),
      );
      applyChange();
    } catch (error) {
      if (disposed || token !== selection) return;
      state.busy = false;
      if (state.min === null || state.max === null) [state.min, state.max] = [0, 1];
      setStatus(
        tr("sampleFailed", "Could not read a sample of {{name}}: {{message}}", {
          name: dataset.title,
          message: errorMessage(error),
        }),
        true,
      );
      renderEditor();
    }
  };

  /** Opens a dataset (or switches band): loads its dates, then samples a range. */
  const openSelection = async (): Promise<void> => {
    const dataset = datasetById(state.datasetId);
    if (!dataset || !state.band) return;
    selection += 1;
    const token = selection;
    state.busy = true;
    state.min = null;
    state.max = null;
    state.unit = "";
    state.colorMapped = true;
    setStatus(tr("opening", "Opening {{name}}…", { name: dataset.title }));
    renderEditor();
    try {
      const collection = await getJaxaImageCollection(dataset.id);
      if (disposed || token !== selection) return;
      if (!state.date) {
        const last = collection.last();
        state.date = last.toISOString();
        state.dateLabel = collection.formatDate(last);
      }
      await sampleBand();
    } catch (error) {
      if (disposed || token !== selection) return;
      state.busy = false;
      setStatus(
        tr("openFailed", "Could not open {{name}}: {{message}}", {
          name: dataset.title,
          message: errorMessage(error),
        }),
        true,
      );
      renderEditor();
    }
  };

  const renderEditor = (): void => {
    // Rebuilding drops the focused control; remember it to restore below.
    const hadFocus = editor.contains(document.activeElement);
    editor.replaceChildren();
    buildEditor();
    if (!focusKey) return;
    const lost = hadFocus || !document.activeElement || document.activeElement === document.body;
    const target = editor.querySelector<HTMLElement>(`[data-focus-key="${focusKey}"]`);
    if (lost && target && !(target as HTMLButtonElement).disabled) target.focus();
  };

  const buildEditor = (): void => {
    const dataset = datasetById(state.datasetId);
    if (!dataset) {
      editor.style.display = "none";
      return;
    }
    editor.style.cssText = CSS.editor;

    // Band
    if (dataset.bands.length > 1) {
      const bandSelect = element("select", CSS.input);
      for (const band of dataset.bands) {
        const option = element("option", undefined, band);
        option.value = band;
        bandSelect.append(option);
      }
      bandSelect.value = state.band ?? dataset.bands[0];
      keyed(bandSelect, "band");
      bandSelect.disabled = state.busy;
      bandSelect.addEventListener("change", () => {
        state.band = bandSelect.value;
        state.colormap = defaultJaxaColormap(dataset.id, state.band);
        void openSelection();
      });
      const bandLabel = element("label", CSS.label, tr("band", "Band"));
      bandLabel.append(bandSelect);
      editor.append(bandLabel);
    }

    // Date
    if (state.date) {
      const dateBox = element("div", CSS.label);
      dateBox.append(element("span", undefined, tr("date", "Date (UTC)")));
      const stepper = element("div", CSS.row);
      const disabled = state.busy;
      const step = (text: string, title: string, direction: Parameters<typeof stepDate>[0]) => {
        const node = keyed(
          button(text, CSS.step, () => void stepDate(direction), title),
          `date-${direction}`,
        );
        node.disabled = disabled;
        return node;
      };
      stepper.append(
        step("«", tr("firstDate", "First date"), "first"),
        step("‹", tr("previousDate", "Previous date"), "prev"),
        element("span", CSS.dateLabel, state.dateLabel),
        step("›", tr("nextDate", "Next date"), "next"),
        step("»", tr("latestDate", "Latest date"), "last"),
      );
      dateBox.append(stepper);
      if (!dataset.normal && dataset.temporalResolution !== "none") {
        const dateInput = element("input", CSS.input);
        dateInput.type = "date";
        keyed(dateInput, "date");
        dateInput.value = state.date.slice(0, 10);
        dateInput.disabled = disabled;
        dateInput.setAttribute("aria-label", tr("pickDate", "Go to date"));
        dateInput.addEventListener("change", () => void jumpToDate(dateInput.value));
        dateBox.append(dateInput);
      }
      editor.append(dateBox);
    }

    // Color map
    if (state.colorMapped) {
      const colormapSelect = element("select", CSS.input);
      for (const name of JAXA_COLORMAP_NAMES) {
        const option = element("option", undefined, name);
        option.value = name;
        colormapSelect.append(option);
      }
      colormapSelect.value = state.colormap;
      keyed(colormapSelect, "colormap");
      colormapSelect.addEventListener("change", () => {
        state.colormap = colormapSelect.value;
        applyChange();
      });
      const colormapLabel = element("label", CSS.label, tr("colormap", "Colormap"));
      colormapLabel.append(colormapSelect);

      const colorbar = element("div", "display:flex;flex-direction:column;gap:2px;");
      const rangeInput = (key: "min" | "max", label: string): HTMLElement => {
        const input = element("input", CSS.input);
        input.type = "number";
        keyed(input, key);
        input.step = "any";
        input.value = state[key] === null ? "" : String(state[key]);
        input.disabled = state.busy;
        input.addEventListener("change", () => {
          const value = Number(input.value);
          if (input.value.trim() === "" || !Number.isFinite(value)) {
            input.value = state[key] === null ? "" : String(state[key]);
            return;
          }
          const other = key === "min" ? state.max : state.min;
          if (other !== null && (key === "min" ? value >= other : value <= other)) {
            setStatus(tr("rangeInvalid", "Min must be less than Max."), true);
            input.value = state[key] === null ? "" : String(state[key]);
            return;
          }
          state[key] = value;
          setStatus(null);
          // No editor rebuild here: the change fires as Tab leaves the field,
          // and a rebuild would hold focus on it instead of moving on.
          updateActiveLayer(datasetById(state.datasetId));
          void renderColorbar(colorbar);
        });
        const wrapper = element("label", `${CSS.label}${CSS.grow}`, label);
        wrapper.append(input);
        return wrapper;
      };
      const rangeRow = element("div", `${CSS.row}align-items:flex-end;`);
      const auto = keyed(
        button(tr("auto", "Auto"), CSS.secondary, () => void sampleBand()),
        "auto",
      );
      auto.title = tr("autoTitle", "Set Min and Max from the data at this date");
      auto.disabled = state.busy;
      rangeRow.append(
        rangeInput("min", tr("min", "Min")),
        rangeInput("max", tr("max", "Max")),
        auto,
      );

      void renderColorbar(colorbar);
      editor.append(colormapLabel, rangeRow, colorbar);
    } else if (!state.busy) {
      editor.append(
        element(
          "p",
          CSS.hint,
          tr("ownColors", "This band carries its own colors, so no color map applies."),
        ),
      );
    }

    // Resampling
    const resamplingSelect = element("select", CSS.input);
    for (const [value, label] of [
      ["nearest", tr("nearest", "Nearest neighbor")],
      ["bilinear", tr("bilinear", "Bilinear")],
    ] as const) {
      const option = element("option", undefined, label);
      option.value = value;
      resamplingSelect.append(option);
    }
    resamplingSelect.value = state.resampling;
    keyed(resamplingSelect, "resampling");
    // Classes and RGB colors cannot be interpolated.
    resamplingSelect.disabled = !state.colorMapped;
    resamplingSelect.addEventListener("change", () => {
      state.resampling = resamplingSelect.value === "bilinear" ? "bilinear" : "nearest";
      applyChange();
    });
    const resamplingLabel = element("label", CSS.label, tr("resampling", "Resampling"));
    resamplingLabel.append(resamplingSelect);
    editor.append(resamplingLabel);

    const add = keyed(
      button(tr("addToMap", "Add to map"), CSS.primary, () => {
        const id = addLayer(dataset);
        if (!id) {
          setStatus(tr("addUnavailable", "This map cannot add tile layers."), true);
          return;
        }
        state.activeLayerId = id;
        setStatus(
          tr(
            "added",
            "Added {{name}}. Changing the date or colors now updates that layer; add again to keep another copy.",
            { name: layerName(dataset) },
          ),
        );
      }),
      "add",
    );
    add.disabled = state.busy || currentSpec() === null;
    editor.append(add);
  };

  // --- Controls -------------------------------------------------------------

  const searchInput = element("input", CSS.input);
  searchInput.type = "search";
  searchInput.value = state.query;
  searchInput.placeholder = tr("searchPlaceholder", "Search titles, satellites, keywords…");
  searchInput.setAttribute("aria-label", tr("search", "Search"));
  searchInput.addEventListener("input", () => {
    state.query = searchInput.value;
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      searchTimer = null;
      if (!disposed) renderDatasetOptions();
    }, SEARCH_DEBOUNCE_MS);
  });

  datasetSelect.setAttribute("aria-label", tr("dataset", "Dataset"));
  datasetSelect.addEventListener("change", () => {
    const dataset = datasetById(datasetSelect.value || null);
    selection += 1;
    state.datasetId = dataset?.id ?? null;
    state.band = dataset?.bands[0] ?? null;
    state.date = null;
    state.dateLabel = "";
    state.colormap = dataset ? defaultJaxaColormap(dataset.id, dataset.bands[0]) : "viridis";
    // A new dataset starts a new layer rather than repainting the last one.
    state.activeLayerId = null;
    setStatus(null);
    renderCard();
    renderEditor();
    if (dataset) void openSelection();
  });

  const searchLabel = element("label", CSS.label, tr("search", "Search"));
  searchLabel.append(searchInput);
  const datasetLabelNode = element("label", CSS.label, tr("dataset", "Dataset"));
  datasetLabelNode.append(datasetSelect);

  container.append(
    element(
      "p",
      CSS.hint,
      tr(
        "hint",
        "Browse JAXA's Earth observation datasets and add them to the map. Pick a dataset, a band and a date, then adjust the colors.",
      ),
    ),
    aboutCard(),
    searchLabel,
    datasetLabelNode,
    card,
    editor,
    statusBox,
  );
  renderDatasetOptions();
  renderCard();
  renderEditor();
  renderStatus();

  const retry = (): void => {
    setStatus(null);
    load();
  };
  const load = (): void => {
    loadCatalog()
      .then((loaded) => {
        if (disposed) return;
        catalog = loaded;
        renderDatasetOptions();
        renderCard();
        renderEditor();
        // A panel rebuilt mid-load (a language change) resumes the selection.
        if (state.datasetId && state.min === null && !state.busy) void openSelection();
      })
      .catch((error: unknown) => {
        if (disposed) return;
        setStatus(
          tr("catalogFailed", "Could not load the JAXA Earth catalog: {{message}}", {
            message: errorMessage(error),
          }),
          true,
        );
        statusBox.append(element("br"), button(tr("retry", "Retry"), CSS.secondary, retry));
      });
  };
  load();

  return () => {
    disposed = true;
    if (searchTimer) clearTimeout(searchTimer);
    // An interrupted read belonged to this panel; the next panel starts idle.
    state.busy = false;
    container.replaceChildren();
  };
}

function mountPanel(container: HTMLElement): void {
  disposePanel?.();
  panelContainer = container;
  disposePanel = buildPanel(container);
}

/**
 * JAXA Earth API plugin: browses JAXA's Earth observation datasets (from its
 * published catalog) and adds a band at a date as a color-mapped tile layer
 * drawn in the browser by JAXA's JavaScript API.
 */
export const maplibreJaxaEarthPlugin: GeoLibrePlugin = {
  id: JAXA_EARTH_PLUGIN_ID,
  name: "JAXA Earth",
  version: "0.1.0",
  // Layers are XYZ templates of the `jaxa-earth://` MapLibre protocol, which
  // the globe reads through the shared protocol registry. mapbox-gl has no
  // protocol registry. ArcGIS reads protocol tiles too but has not been checked
  // with JAXA layers yet, so it is left out until it is.
  engines: ["maplibre", "cesium"],
  activate: (app) => {
    appRef = app;
    unregisterPanel =
      app.registerRightPanel?.({
        id: PANEL_ID,
        title: () => tr("title", "JAXA Earth"),
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

export default maplibreJaxaEarthPlugin;
