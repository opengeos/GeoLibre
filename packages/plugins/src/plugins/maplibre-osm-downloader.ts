import type { FeatureCollection } from "geojson";
import type { GeoLibreAppAPI, GeoLibrePlugin } from "../types";
import {
  canDownloadOsmBounds,
  downloadOsmGeoJson,
  OSM_CUSTOM_TAG_MAX_LENGTH,
  osmDownloadAreaLimit,
  osmDownloadBoundsArea,
  type OsmDownloadFilter,
  type OsmDownloadPreset,
} from "./osm-downloader-api";
import { createPluginTranslator } from "../plugin-i18n";
import { getControlMap } from "./style-map";

export const OSM_DOWNLOADER_PLUGIN_ID = "geolibre-osm-downloader";
const PANEL_ID = OSM_DOWNLOADER_PLUGIN_ID;

let unregisterPanel: (() => void) | null = null;
let unsubscribeLocale: (() => void) | null = null;
let panelContainer: HTMLElement | null = null;
let disposePanel: (() => void) | null = null;
let refreshPanelLabels: (() => void) | null = null;

const CSS = {
  panel:
    "display:flex;flex-direction:column;gap:10px;padding:10px;height:100%;" +
    "box-sizing:border-box;overflow-y:auto;color:hsl(var(--foreground));font-size:12px;",
  hint: "margin:0;color:hsl(var(--muted-foreground));line-height:1.45;",
  field: "display:flex;flex-direction:column;gap:4px;",
  label: "display:flex;flex-direction:column;gap:4px;font-size:11px;font-weight:600;",
  select:
    "width:100%;box-sizing:border-box;padding:6px 8px;border:1px solid hsl(var(--border));" +
    "border-radius:6px;background:hsl(var(--background));color:hsl(var(--foreground));",
  grid: "display:grid;grid-template-columns:1fr 1fr;gap:7px;",
  input:
    "width:100%;box-sizing:border-box;padding:6px 8px;border:1px solid hsl(var(--border));" +
    "border-radius:6px;background:hsl(var(--background));color:hsl(var(--foreground));",
  button:
    "padding:7px 10px;border:1px solid hsl(var(--border));border-radius:6px;" +
    "background:hsl(var(--background));color:hsl(var(--foreground));cursor:pointer;",
  primary:
    "padding:7px 10px;border:1px solid hsl(var(--primary));border-radius:6px;" +
    "background:hsl(var(--primary));color:hsl(var(--primary-foreground));cursor:pointer;font-weight:600;",
  disabled:
    "padding:7px 10px;border:1px solid hsl(var(--border));border-radius:6px;" +
    "background:hsl(var(--muted));color:hsl(var(--muted-foreground));" +
    "cursor:not-allowed;opacity:0.65;font-weight:600;",
  actions: "display:flex;gap:7px;flex-wrap:wrap;",
  status:
    "padding:8px;border-radius:6px;background:hsl(var(--muted));" +
    "color:hsl(var(--muted-foreground));line-height:1.45;min-height:18px;",
};

/** Resolves a plugin-namespaced translation key, falling back to English text. */
function tr(
  app: GeoLibreAppAPI,
  key: string,
  fallback: string,
  params?: Record<string, string | number>,
): string {
  return createPluginTranslator(app, OSM_DOWNLOADER_PLUGIN_ID)(key, fallback, params);
}

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  style?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (style) node.style.cssText = style;
  return node;
}

function field(labelText: string, control: HTMLElement): HTMLDivElement {
  const wrapper = element("div", CSS.field);
  const label = element("label", CSS.label);
  label.textContent = labelText;
  label.append(control);
  wrapper.append(label);
  return wrapper;
}

function setFieldLabel(wrapper: HTMLDivElement, labelText: string): void {
  const text = wrapper.querySelector("label")?.firstChild;
  if (text) text.nodeValue = labelText;
}

function formatNumber(value: number): string {
  return Number(value.toFixed(6)).toString();
}

function resultName(app: GeoLibreAppAPI, filter: OsmDownloadFilter): string {
  if (filter.preset === "custom") {
    const key = filter.key?.trim();
    const value = filter.value?.trim();
    if (key) return `OSM ${key}${value ? `=${value}` : ""}`;
  }
  const labels: Record<OsmDownloadPreset, string> = {
    all: tr(app, "presetAll", "all features"),
    buildings: tr(app, "presetBuildings", "buildings"),
    roads: tr(app, "presetRoads", "roads"),
    amenities: tr(app, "presetAmenities", "amenities"),
    waterways: tr(app, "presetWaterways", "waterways"),
    landuse: tr(app, "presetLanduse", "land use"),
    custom: tr(app, "presetCustom", "custom tags"),
  };
  return `OSM ${labels[filter.preset]}`;
}

function buildPanel(container: HTMLElement, app: GeoLibreAppAPI): () => void {
  container.replaceChildren();
  const root = element("div", CSS.panel);
  const hint = element("p", CSS.hint);
  hint.textContent = tr(
    app,
    "hint",
    "Preview OpenStreetMap features from the current map area before adding or saving them.",
  );
  const attribution = element("p", CSS.hint);
  attribution.textContent = tr(
    app,
    "attribution",
    "Data © OpenStreetMap contributors, available under the ODbL.",
  );

  const preset = element("select", CSS.select);
  const presets: Array<[OsmDownloadPreset, string]> = [
    ["buildings", tr(app, "presetBuildings", "Buildings")],
    ["roads", tr(app, "presetRoads", "Roads")],
    ["amenities", tr(app, "presetAmenities", "Amenities")],
    ["waterways", tr(app, "presetWaterways", "Waterways")],
    ["landuse", tr(app, "presetLanduse", "Land use")],
    ["custom", tr(app, "presetCustom", "Custom tag")],
    ["all", tr(app, "presetAll", "All tagged features")],
  ];
  for (const [value, label] of presets) preset.append(new Option(label, value));

  const customGrid = element("div", CSS.grid);
  const keyInput = element("input", CSS.input);
  keyInput.maxLength = OSM_CUSTOM_TAG_MAX_LENGTH;
  keyInput.placeholder = tr(app, "tagKeyPlaceholder", "e.g. shop");
  const valueInput = element("input", CSS.input);
  valueInput.maxLength = OSM_CUSTOM_TAG_MAX_LENGTH;
  valueInput.placeholder = tr(app, "tagValuePlaceholder", "optional, e.g. bakery");
  const keyField = field(tr(app, "tagKey", "Tag key"), keyInput);
  const valueField = field(tr(app, "tagValue", "Tag value"), valueInput);
  customGrid.append(keyField, valueField);
  customGrid.hidden = true;

  const coordGrid = element("div", CSS.grid);
  const coordInputs = ["west", "south", "east", "north"].map(() => {
    const input = element("input", CSS.input);
    input.type = "number";
    input.step = "any";
    return input;
  });
  const coordLabels = [
    tr(app, "west", "West"),
    tr(app, "south", "South"),
    tr(app, "east", "East"),
    tr(app, "north", "North"),
  ];
  const coordFields = coordInputs.map((input, index) => field(coordLabels[index], input));
  coordGrid.append(...coordFields);

  const useView = element("button", CSS.button);
  useView.type = "button";
  useView.textContent = tr(app, "useMapExtent", "Use map extent");
  const previewButton = element("button", CSS.primary);
  previewButton.type = "button";
  previewButton.textContent = tr(app, "preview", "Preview OSM data");
  const queryActions = element("div", CSS.actions);
  queryActions.append(useView, previewButton);

  const status = element("div", CSS.status);
  status.setAttribute("role", "status");
  status.textContent = tr(app, "ready", "Choose an area and feature type.");

  const addButton = element("button", CSS.primary);
  addButton.type = "button";
  addButton.textContent = tr(app, "addToMap", "Add to map");
  addButton.disabled = true;
  addButton.style.cssText = CSS.disabled;
  const exportButton = element("button", CSS.button);
  exportButton.type = "button";
  exportButton.textContent = tr(app, "exportGeoJson", "Save GeoJSON");
  exportButton.disabled = true;
  const exportParquetButton = element("button", CSS.button);
  exportParquetButton.type = "button";
  exportParquetButton.textContent = tr(app, "exportGeoParquet", "Save GeoParquet");
  exportParquetButton.disabled = true;
  exportParquetButton.hidden = !app.exportGeoParquetFile;
  const exportButtons = [exportButton, exportParquetButton];
  const resultActions = element("div", CSS.actions);
  resultActions.append(addButton, ...exportButtons);

  const presetField = field(tr(app, "featureType", "Feature type"), preset);
  root.append(
    hint,
    attribution,
    presetField,
    customGrid,
    coordGrid,
    queryActions,
    status,
    resultActions,
  );
  container.append(root);

  let controller: AbortController | null = null;
  let result: FeatureCollection | null = null;
  let resultFilter: OsmDownloadFilter | null = null;
  let previewLayerId: string | null = null;
  let disposed = false;

  const readBounds = (): [number, number, number, number] =>
    coordInputs.map((input) => (input.value.trim() === "" ? Number.NaN : Number(input.value))) as [
      number,
      number,
      number,
      number,
    ];

  const updateActionAvailability = (announce = false) => {
    const bbox = readBounds();
    const selectedPreset = preset.value as OsmDownloadPreset;
    const area = osmDownloadBoundsArea(bbox);
    const limit = osmDownloadAreaLimit(selectedPreset);
    const eligible = canDownloadOsmBounds(bbox, selectedPreset);
    const pending = controller !== null;
    previewButton.disabled = pending || !eligible;
    previewButton.style.cssText = !pending && eligible ? CSS.primary : CSS.disabled;
    for (const button of exportButtons) {
      button.disabled = pending || !eligible;
      button.style.cssText = !pending && eligible ? CSS.button : CSS.disabled;
    }
    if (eligible) {
      previewButton.removeAttribute("title");
      for (const button of exportButtons) button.removeAttribute("title");
      if (announce) status.textContent = tr(app, "extentApplied", "Map extent applied.");
      return;
    }
    const message =
      area === null
        ? tr(app, "invalidExtent", "Enter a valid bounding box.")
        : tr(app, "zoomIn", "Zoom in until the map area is {{limit}} square degrees or less.", {
            limit,
          });
    previewButton.title = message;
    for (const button of exportButtons) button.title = message;
    if (announce && !pending) status.textContent = message;
  };

  const clearPreview = (announce = false) => {
    controller?.abort();
    controller = null;
    if (previewLayerId) app.removeLayer?.(previewLayerId);
    previewLayerId = null;
    result = null;
    resultFilter = null;
    addButton.disabled = true;
    addButton.style.cssText = CSS.disabled;
    updateActionAvailability(false);
    if (announce) status.textContent = tr(app, "ready", "Choose an area and feature type.");
  };

  const previewSummary = (data: FeatureCollection) => {
    let points = 0;
    let lines = 0;
    let polygons = 0;
    for (const feature of data.features) {
      const type = feature.geometry?.type ?? "";
      if (type === "Point" || type === "MultiPoint") points += 1;
      else if (type === "LineString" || type === "MultiLineString") lines += 1;
      else if (type === "Polygon" || type === "MultiPolygon") polygons += 1;
    }
    return { points, lines, polygons };
  };

  const refreshLabels = () => {
    hint.textContent = tr(
      app,
      "hint",
      "Preview OpenStreetMap features from the current map area before adding or saving them.",
    );
    attribution.textContent = tr(
      app,
      "attribution",
      "Data © OpenStreetMap contributors, available under the ODbL.",
    );
    const translatedPresets = [
      tr(app, "presetBuildings", "Buildings"),
      tr(app, "presetRoads", "Roads"),
      tr(app, "presetAmenities", "Amenities"),
      tr(app, "presetWaterways", "Waterways"),
      tr(app, "presetLanduse", "Land use"),
      tr(app, "presetCustom", "Custom tag"),
      tr(app, "presetAll", "All tagged features"),
    ];
    Array.from(preset.options).forEach((option, index) => {
      option.textContent = translatedPresets[index];
    });
    setFieldLabel(presetField, tr(app, "featureType", "Feature type"));
    setFieldLabel(keyField, tr(app, "tagKey", "Tag key"));
    setFieldLabel(valueField, tr(app, "tagValue", "Tag value"));
    const translatedCoords = [
      tr(app, "west", "West"),
      tr(app, "south", "South"),
      tr(app, "east", "East"),
      tr(app, "north", "North"),
    ];
    coordFields.forEach((wrapper, index) => setFieldLabel(wrapper, translatedCoords[index]));
    keyInput.placeholder = tr(app, "tagKeyPlaceholder", "e.g. shop");
    valueInput.placeholder = tr(app, "tagValuePlaceholder", "optional, e.g. bakery");
    useView.textContent = tr(app, "useMapExtent", "Use map extent");
    previewButton.textContent = tr(app, "preview", "Preview OSM data");
    addButton.textContent = tr(app, "addToMap", "Add to map");
    exportButton.textContent = tr(app, "exportGeoJson", "Save GeoJSON");
    exportParquetButton.textContent = tr(app, "exportGeoParquet", "Save GeoParquet");
    updateActionAvailability(false);
  };
  refreshPanelLabels = refreshLabels;

  const applyViewBounds = ({
    preservePreview = false,
    announce = true,
  }: { preservePreview?: boolean; announce?: boolean } = {}) => {
    const bounds = app.getViewBounds?.();
    if (!bounds) {
      updateActionAvailability(false);
      status.textContent = tr(app, "mapUnavailable", "The map extent is not available yet.");
      return;
    }
    bounds.forEach((value, index) => {
      coordInputs[index].value = formatNumber(value);
    });
    if (!preservePreview) clearPreview(false);
    updateActionAvailability(announce);
  };

  preset.addEventListener("change", () => {
    customGrid.hidden = preset.value !== "custom";
    clearPreview(true);
    updateActionAvailability(false);
  });
  coordInputs.forEach((input) =>
    input.addEventListener("input", () => {
      clearPreview(true);
      updateActionAvailability(false);
    }),
  );
  for (const input of [keyInput, valueInput]) {
    input.addEventListener("input", () => clearPreview(true));
  }
  useView.addEventListener("click", () => applyViewBounds());
  const map = getControlMap(app);
  const onMoveEnd = () => applyViewBounds({ preservePreview: true, announce: false });
  map?.on("moveend", onMoveEnd);
  applyViewBounds();

  previewButton.addEventListener("click", async () => {
    const bbox = readBounds();
    const selectedPreset = preset.value as OsmDownloadPreset;
    const filter: OsmDownloadFilter = {
      preset: selectedPreset,
      key: keyInput.value,
      value: valueInput.value,
    };
    clearPreview(false);
    const requestController = new AbortController();
    controller = requestController;
    updateActionAvailability(false);
    status.textContent = tr(app, "previewing", "Loading OSM preview…");
    try {
      result = await downloadOsmGeoJson(bbox, filter, {
        signal: requestController.signal,
      });
      if (disposed || controller !== requestController) return;
      resultFilter = { ...filter };
      const count = result.features.length;
      if (count) {
        const name = resultName(app, filter);
        previewLayerId = app.addGeoJsonLayer(
          tr(app, "previewLayerName", "Preview — {{name}}", { name }),
          result,
        );
        const summary = previewSummary(result);
        status.textContent = tr(
          app,
          "previewed",
          "Previewing {{count}} features: {{points}} points, {{lines}} lines, {{polygons}} polygons.",
          {
            count,
            ...summary,
          },
        );
        addButton.disabled = false;
        addButton.style.cssText = CSS.primary;
        for (const button of exportButtons) button.disabled = false;
      } else {
        status.textContent = tr(app, "noFeatures", "No matching features were found in this area.");
      }
    } catch (error) {
      if (disposed || (error instanceof DOMException && error.name === "AbortError")) return;
      const message = error instanceof Error ? error.message : String(error);
      status.textContent = tr(app, "error", "Could not download OSM data: {{message}}", {
        message,
      });
    } finally {
      if (!disposed && controller === requestController) {
        controller = null;
        updateActionAvailability(false);
      }
    }
  });

  addButton.addEventListener("click", () => {
    if (!result || !resultFilter || !result.features.length) return;
    if (previewLayerId) app.removeLayer?.(previewLayerId);
    previewLayerId = null;
    const count = result.features.length;
    app.addGeoJsonLayer(resultName(app, resultFilter), result);
    addButton.disabled = true;
    addButton.style.cssText = CSS.disabled;
    status.textContent = tr(app, "added", "Added {{count}} features to the map.", {
      count,
    });
  });

  const exportGeoJson = (data: FeatureCollection, filter: OsmDownloadFilter) => {
    const suffix = new Date().toISOString().slice(0, 10);
    app.exportTextFile?.(`osm-${filter.preset}-${suffix}.geojson`, JSON.stringify(data, null, 2), {
      description: "GeoJSON",
      extensions: ["geojson"],
      mimeType: "application/geo+json",
      promptName: true,
    });
  };

  const exportCurrentData = async (format: "GeoJSON" | "GeoParquet") => {
    if (controller) return;
    const exportGeoParquetFile = app.exportGeoParquetFile;
    if (format === "GeoParquet" && !exportGeoParquetFile) return;
    const requestController = new AbortController();
    controller = requestController;
    updateActionAvailability(false);
    const cached =
      result?.features.length && resultFilter ? { data: result, filter: resultFilter } : null;
    status.textContent = cached
      ? tr(app, "preparingExport", "Preparing {{format}} export…", { format })
      : tr(app, "downloading", "Downloading from OpenStreetMap…");
    let exporting = false;
    try {
      const filter: OsmDownloadFilter = cached?.filter ?? {
        preset: preset.value as OsmDownloadPreset,
        key: keyInput.value,
        value: valueInput.value,
      };
      const data =
        cached?.data ??
        (await downloadOsmGeoJson(readBounds(), filter, {
          signal: requestController.signal,
        }));
      if (disposed || controller !== requestController) return;
      const count = data.features.length;
      if (!count) {
        status.textContent = tr(app, "noFeatures", "No matching features were found in this area.");
        return;
      }
      exporting = true;
      if (format === "GeoJSON") {
        exportGeoJson(data, filter);
      } else {
        if (!exportGeoParquetFile) return;
        const suffix = new Date().toISOString().slice(0, 10);
        const saved = await exportGeoParquetFile(`osm-${filter.preset}-${suffix}`, data);
        if (saved === null) {
          if (!disposed && controller === requestController) {
            status.textContent = tr(app, "exportCancelled", "Export cancelled.");
          }
          return;
        }
      }
      if (disposed || controller !== requestController) return;
      status.textContent = tr(
        app,
        "exported",
        "Prepared {{count}} features for {{format}} export.",
        {
          count,
          format,
        },
      );
    } catch (error) {
      if (disposed || (error instanceof DOMException && error.name === "AbortError")) return;
      const message = error instanceof Error ? error.message : String(error);
      status.textContent = exporting
        ? tr(app, "exportError", "Could not export {{format}}: {{message}}", { format, message })
        : tr(app, "error", "Could not download OSM data: {{message}}", { message });
    } finally {
      if (!disposed && controller === requestController) {
        controller = null;
        updateActionAvailability(false);
      }
    }
  };

  exportButton.addEventListener("click", () => void exportCurrentData("GeoJSON"));
  exportParquetButton.addEventListener("click", () => void exportCurrentData("GeoParquet"));

  return () => {
    disposed = true;
    controller?.abort();
    if (previewLayerId) app.removeLayer?.(previewLayerId);
    map?.off("moveend", onMoveEnd);
    if (refreshPanelLabels === refreshLabels) refreshPanelLabels = null;
    container.replaceChildren();
  };
}

function mountPanel(container: HTMLElement, app: GeoLibreAppAPI): void {
  disposePanel?.();
  panelContainer = container;
  disposePanel = buildPanel(container, app);
}

/** Preview and add OpenStreetMap vector features from Overpass or the OSM map API. */
export const maplibreOsmDownloaderPlugin: GeoLibrePlugin = {
  id: OSM_DOWNLOADER_PLUGIN_ID,
  name: "OSM Downloader",
  version: "0.1.0",
  engines: ["maplibre", "mapbox", "cesium", "arcgis"],
  activate: (app) => {
    unregisterPanel =
      app.registerRightPanel?.({
        id: PANEL_ID,
        title: () => tr(app, "title", "OSM downloader"),
        dock: "replace-style",
        defaultWidth: 340,
        render: (container) => {
          mountPanel(container, app);
          return () => {
            disposePanel?.();
            disposePanel = null;
            if (panelContainer === container) panelContainer = null;
          };
        },
      }) ?? null;
    unsubscribeLocale =
      app.onLocaleChange?.(() => {
        refreshPanelLabels?.();
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
    refreshPanelLabels = null;
    panelContainer = null;
  },
};

export default maplibreOsmDownloaderPlugin;
