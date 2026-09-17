import type { FeatureCollection } from "geojson";
import type { GeoLibreAppAPI, GeoLibrePlugin } from "../types";
import {
  downloadOsmGeoJson,
  type OsmDownloadFilter,
  type OsmDownloadPreset,
} from "./osm-downloader-api";

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
  actions: "display:flex;gap:7px;flex-wrap:wrap;",
  status:
    "padding:8px;border-radius:6px;background:hsl(var(--muted));" +
    "color:hsl(var(--muted-foreground));line-height:1.45;min-height:18px;",
};

function tr(
  app: GeoLibreAppAPI,
  key: string,
  fallback: string,
  params?: Record<string, string | number>,
) {
  return app.translate?.(`plugin.${OSM_DOWNLOADER_PLUGIN_ID}.${key}`, fallback, params) ?? fallback;
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

function resultName(app: GeoLibreAppAPI, preset: OsmDownloadPreset): string {
  const labels: Record<OsmDownloadPreset, string> = {
    all: tr(app, "presetAll", "all features"),
    buildings: tr(app, "presetBuildings", "buildings"),
    roads: tr(app, "presetRoads", "roads"),
    amenities: tr(app, "presetAmenities", "amenities"),
    waterways: tr(app, "presetWaterways", "waterways"),
    landuse: tr(app, "presetLanduse", "land use"),
    custom: tr(app, "presetCustom", "custom tags"),
  };
  return `OSM ${labels[preset]}`;
}

function buildPanel(container: HTMLElement, app: GeoLibreAppAPI): () => void {
  container.replaceChildren();
  const root = element("div", CSS.panel);
  const hint = element("p", CSS.hint);
  hint.textContent = tr(
    app,
    "hint",
    "Download OpenStreetMap features from the current map area with the public Overpass API.",
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
  keyInput.placeholder = tr(app, "tagKeyPlaceholder", "e.g. shop");
  const valueInput = element("input", CSS.input);
  valueInput.placeholder = tr(app, "tagValuePlaceholder", "optional, e.g. bakery");
  const keyField = field(tr(app, "tagKey", "Tag key"), keyInput);
  const valueField = field(tr(app, "tagValue", "Tag value"), valueInput);
  customGrid.append(keyField, valueField);
  customGrid.hidden = true;

  const coordGrid = element("div", CSS.grid);
  const coordInputs = ["west", "south", "east", "north"].map((name) => {
    const input = element("input", CSS.input);
    input.type = "number";
    input.step = "any";
    input.setAttribute("aria-label", name);
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
  const downloadButton = element("button", CSS.primary);
  downloadButton.type = "button";
  downloadButton.textContent = tr(app, "download", "Download OSM data");
  const queryActions = element("div", CSS.actions);
  queryActions.append(useView, downloadButton);

  const status = element("div", CSS.status);
  status.setAttribute("role", "status");
  status.textContent = tr(app, "ready", "Choose an area and feature type.");

  const addButton = element("button", CSS.button);
  addButton.type = "button";
  addButton.textContent = tr(app, "addToMap", "Add to map");
  addButton.disabled = true;
  const exportButton = element("button", CSS.button);
  exportButton.type = "button";
  exportButton.textContent = tr(app, "exportGeoJson", "Save GeoJSON");
  exportButton.disabled = true;
  const resultActions = element("div", CSS.actions);
  resultActions.append(addButton, exportButton);

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
  let resultPreset: OsmDownloadPreset | null = null;
  let added = false;
  let disposed = false;

  const refreshLabels = () => {
    hint.textContent = tr(
      app,
      "hint",
      "Download OpenStreetMap features from the current map area with the public Overpass API.",
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
    downloadButton.textContent = tr(app, "download", "Download OSM data");
    addButton.textContent = tr(app, "addToMap", "Add to map");
    exportButton.textContent = tr(app, "exportGeoJson", "Save GeoJSON");
  };
  refreshPanelLabels = refreshLabels;

  const applyViewBounds = () => {
    const bounds = app.getViewBounds?.();
    if (!bounds) {
      status.textContent = tr(app, "mapUnavailable", "The map extent is not available yet.");
      return;
    }
    bounds.forEach((value, index) => {
      coordInputs[index].value = formatNumber(value);
    });
    status.textContent = tr(app, "extentApplied", "Map extent applied.");
  };

  preset.addEventListener("change", () => {
    customGrid.hidden = preset.value !== "custom";
  });
  useView.addEventListener("click", applyViewBounds);
  applyViewBounds();

  downloadButton.addEventListener("click", async () => {
    const bbox = coordInputs.map((input) => Number(input.value)) as [
      number,
      number,
      number,
      number,
    ];
    const selectedPreset = preset.value as OsmDownloadPreset;
    const filter: OsmDownloadFilter = {
      preset: selectedPreset,
      key: keyInput.value,
      value: valueInput.value,
    };
    controller?.abort();
    const requestController = new AbortController();
    controller = requestController;
    result = null;
    resultPreset = null;
    added = false;
    addButton.disabled = true;
    exportButton.disabled = true;
    downloadButton.disabled = true;
    status.textContent = tr(app, "downloading", "Downloading from OpenStreetMap…");
    try {
      result = await downloadOsmGeoJson(bbox, filter, { signal: requestController.signal });
      if (disposed) return;
      resultPreset = selectedPreset;
      const count = result.features.length;
      status.textContent = count
        ? tr(app, "downloaded", "Downloaded {{count}} features.", { count })
        : tr(app, "noFeatures", "No matching features were found in this area.");
      addButton.disabled = count === 0;
      exportButton.disabled = count === 0;
    } catch (error) {
      if (disposed || (error instanceof DOMException && error.name === "AbortError")) return;
      const message = error instanceof Error ? error.message : String(error);
      status.textContent = tr(app, "error", "Could not download OSM data: {{message}}", {
        message,
      });
    } finally {
      if (!disposed && controller === requestController) {
        controller = null;
        downloadButton.disabled = false;
      }
    }
  });

  addButton.addEventListener("click", () => {
    if (!result || !resultPreset || added) return;
    const name = resultName(app, resultPreset);
    app.addGeoJsonLayer(name, result);
    added = true;
    addButton.disabled = true;
    status.textContent = tr(app, "added", "Added {{count}} features to the map.", {
      count: result.features.length,
    });
  });

  exportButton.addEventListener("click", () => {
    if (!result || !resultPreset) return;
    const suffix = new Date().toISOString().slice(0, 10);
    app.exportTextFile?.(`osm-${resultPreset}-${suffix}.geojson`, JSON.stringify(result, null, 2), {
      description: "GeoJSON",
      extensions: ["geojson"],
    });
  });

  return () => {
    disposed = true;
    controller?.abort();
    if (refreshPanelLabels === refreshLabels) refreshPanelLabels = null;
    container.replaceChildren();
  };
}

function mountPanel(container: HTMLElement, app: GeoLibreAppAPI): void {
  disposePanel?.();
  panelContainer = container;
  disposePanel = buildPanel(container, app);
}

/** Download OpenStreetMap vector features from Overpass into GeoLibre or GeoJSON. */
export const maplibreOsmDownloaderPlugin: GeoLibrePlugin = {
  id: OSM_DOWNLOADER_PLUGIN_ID,
  name: "OSM Downloader",
  version: "0.1.0",
  engines: ["maplibre", "mapbox", "cesium"],
  activate: (app) => {
    unregisterPanel =
      app.registerRightPanel?.({
        id: PANEL_ID,
        title: () => tr(app, "title", "OSM Downloader"),
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
