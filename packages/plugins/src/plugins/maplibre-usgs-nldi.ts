import type { Feature, FeatureCollection, Geometry, Point } from "geojson";
import {
  Popup,
  type Map as MapLibreMap,
  type MapLayerMouseEvent,
  type MapMouseEvent,
} from "maplibre-gl";
import type { GeoLibreAppAPI, GeoLibrePlugin } from "../types";

export const USGS_NLDI_PLUGIN_ID = "maplibre-usgs-nldi";
export const NLDI_API = "https://api.water.usgs.gov/nldi";
const FLOWTRACE_SOURCE = "usgs-nldi-flowtrace-source";
const FLOWTRACE_LAYER = "usgs-nldi-flowtrace";
const RAINDROP_SOURCE = "usgs-nldi-raindrop-source";
const RAINDROP_LAYER = "usgs-nldi-raindrop";
const BASIN_SOURCE = "usgs-nldi-basin-source";
const BASIN_FILL = "usgs-nldi-basin-fill";
const BASIN_LINE = "usgs-nldi-basin-line";
const POINT_SOURCE = "usgs-nldi-point-source";
const POINT_LAYER = "usgs-nldi-point";
const PANEL = "usgs-nldi-panel";
const REQUEST_TIMEOUT_MS = 30_000;

export type NldiDirection = "none" | "up" | "down";

/**
 * User-facing strings for the panel. This package is framework-agnostic and
 * cannot reach react-i18next, so the desktop app pushes translated values in
 * via {@link setUsgsNldiLabels} (see `TopToolbar.tsx`).
 */
export interface UsgsNldiLabels {
  panelTitle: string;
  title: string;
  hint: string;
  directionComplete: string;
  directionUp: string;
  directionDown: string;
  basinButton: string;
  navigationPlaceholder: string;
  navigationUpstreamMain: string;
  navigationUpstreamTributaries: string;
  navigationDownstreamMain: string;
  navigationDownstreamDiversions: string;
  sourcePlaceholder: string;
  distancePlaceholder: string;
  navigationButton: string;
  navigationButtonAgain: string;
  exportButton: string;
  addLayersButton: string;
  clearButton: string;
  noComid: string;
  requestingBasin: string;
  basinRendered: (comid: string) => string;
  basinFailed: string;
  selectNavigation: string;
  invalidDistance: string;
  discoveringSources: string;
  navigationUnavailable: string;
  noPlottableSource: string;
  navigationEmpty: (source: string) => string;
  navigationAdded: (source: string, navigation: string, comid: string, km: number) => string;
  navigationFailed: string;
  tracing: string;
  flowlineRendered: (comid: string | undefined, usedFallback: boolean) => string;
  requestFailed: string;
  nothingToAdd: string;
  layersAdded: (count: number) => string;
  layerGroupName: string;
  layerFlowline: string;
  layerRaindrop: string;
  layerSelectedPoint: string;
  layerBasin: string;
  layerNavigation: (index: number) => string;
  resultCleared: string;
  directionalUnavailable: string;
  noFlowlineNearby: string;
  httpError: (status: number, detail: string) => string;
  noAttributes: string;
  /** Display names for NLDI's navigation catalogs, keyed by lowercase source id. */
  catalogNames: Record<string, string>;
}

export const DEFAULT_USGS_NLDI_LABELS: UsgsNldiLabels = {
  panelTitle: "USGS NLDI",
  title: "USGS NLDI network tools",
  hint: "First choose a flowline direction and click the map. Then choose a navigation direction, press the highlighted button to load available catalogs, select a catalog such as streamgages or wells, and press it again to plot that catalog.",
  directionComplete: "Complete flowline — returns the full NHD reach",
  directionUp: "Upstream only — returns the reach above the point",
  directionDown: "Downstream only — returns the reach below the point",
  basinButton: "Basin from hydrolocation",
  navigationPlaceholder: "Select direction — required before plotting",
  navigationUpstreamMain: "Upstream main — follow the primary channel",
  navigationUpstreamTributaries: "Upstream tributaries — find contributing branches",
  navigationDownstreamMain: "Downstream main — follow the primary channel",
  navigationDownstreamDiversions: "Downstream diversions — follow split-flow paths",
  sourcePlaceholder: "Press \u2018Load sources & plot\u2019 first",
  distancePlaceholder: "Distance (km)",
  navigationButton: "1. Load sources & plot navigation",
  navigationButtonAgain: "Plot another navigation layer",
  exportButton: "Export rendered results to GeoJSON",
  addLayersButton: "Add rendered results to GeoLibre Layers",
  clearButton: "Clear NLDI result",
  noComid: "No COMID was returned for this point.",
  requestingBasin: "Requesting upstream basin\u2026",
  basinRendered: (comid) => `Upstream basin rendered for COMID ${comid}.`,
  basinFailed: "Basin request failed.",
  selectNavigation: "Select a navigation method after tracing a point.",
  invalidDistance: "Distance must be between 1 and 9999 km.",
  discoveringSources: "Discovering NLDI navigation sources\u2026",
  navigationUnavailable: "That navigation method is not available for this COMID.",
  noPlottableSource: "NLDI returned no plottable navigation source.",
  navigationEmpty: (source) => `${source} returned no mappable features for this navigation.`,
  navigationAdded: (source, navigation, comid, km) =>
    `Added ${source} via ${navigation} for COMID ${comid} (${km} km). Existing navigation layers remain on the map.`,
  navigationFailed: "Navigation request failed.",
  tracing: "Tracing to the nearest NHD flowline\u2026",
  flowlineRendered: (comid, usedFallback) =>
    `${usedFallback ? "Flowline rendered using NLDI hydrolocation fallback" : "Flowline rendered"}${
      comid ? `; COMID ${comid} is ready for basin workflows.` : "."
    }`,
  requestFailed: "NLDI request failed.",
  nothingToAdd: "There are no rendered NLDI features to add.",
  layersAdded: (count) =>
    `Added ${count} NLDI ${count === 1 ? "layer" : "layers"} to one \u201cUSGS NLDI results\u201d group.`,
  layerGroupName: "USGS NLDI results",
  layerFlowline: "NLDI flowline",
  layerRaindrop: "NLDI raindrop path",
  layerSelectedPoint: "NLDI selected point",
  layerBasin: "NLDI upstream basin",
  layerNavigation: (index) => `NLDI navigation ${index}`,
  resultCleared: "NLDI result cleared.",
  directionalUnavailable:
    "Directional flowtrace is unavailable while the USGS process is offline. Choose Complete flowline or try again later.",
  noFlowlineNearby: "NLDI could not find a flowline near this point.",
  httpError: (status, detail) => `USGS NLDI returned HTTP ${status}${detail ? `: ${detail}` : ""}`,
  noAttributes: "No attributes returned by NLDI.",
  catalogNames: {
    ca_gages: "California streamgages (ca_gages)",
    nwissite: "NWIS surface-water sites (streamgages)",
    nwisgw: "NWIS groundwater wells",
    gfv11_pois: "USGS Geospatial Fabric points",
    huc12pp: "HUC12 pour points",
    "nmwdi-st": "New Mexico water sites",
    flowlines: "NHDPlus flowlines",
  },
};

let labels: UsgsNldiLabels = { ...DEFAULT_USGS_NLDI_LABELS };

/** Re-applies the current labels to the live panel, when one is mounted. */
let applyLabels: (() => void) | null = null;

export function setUsgsNldiLabels(next: Partial<UsgsNldiLabels>): void {
  labels = { ...labels, ...next };
  applyLabels?.();
}

export interface NldiTraceResult {
  flowline: FeatureCollection;
  raindropPath: FeatureCollection;
  comid?: string;
}

export function buildHydrolocationUrl(lon: number, lat: number): string {
  const url = new URL(`${NLDI_API}/linked-data/hydrolocation`);
  url.searchParams.set("f", "json");
  url.searchParams.set("coords", `POINT(${lon} ${lat})`);
  return url.toString();
}

export function buildBasinUrl(
  featureSource: string,
  featureId: string,
  options: { simplified?: boolean } = {},
): string {
  const url = new URL(
    `${NLDI_API}/linked-data/${encodeURIComponent(featureSource)}/${encodeURIComponent(featureId)}/basin`,
  );
  url.searchParams.set("f", "json");
  url.searchParams.set("simplified", String(options.simplified ?? true));
  return url.toString();
}

export function buildNavigationUrl(comid: string): string {
  return `${NLDI_API}/linked-data/comid/${encodeURIComponent(comid)}/navigation?f=json`;
}

export function buildNavigationSourceUrl(
  url: string,
  options: {
    distance?: number;
    trimStart?: boolean;
    stopComid?: string;
    trimTolerance?: number;
  } = {},
): string {
  const target = new URL(url);
  target.searchParams.set("distance", String(options.distance ?? 500));
  if (options.trimStart) target.searchParams.set("trimStart", "true");
  if (options.stopComid) target.searchParams.set("stopComid", options.stopComid);
  if (options.trimTolerance !== undefined)
    target.searchParams.set("trimTolerance", String(options.trimTolerance));
  return target.toString();
}

export function buildFlowtraceBody(
  lon: number,
  lat: number,
  direction: NldiDirection = "none",
): string {
  return JSON.stringify({ inputs: { lat, lon, direction } });
}

function emptyCollection(): FeatureCollection {
  return { type: "FeatureCollection", features: [] };
}

function asCollection(value: unknown): FeatureCollection {
  if (
    value &&
    typeof value === "object" &&
    (value as { type?: string }).type === "FeatureCollection"
  ) {
    return value as FeatureCollection;
  }
  if (value && typeof value === "object" && (value as { type?: string }).type === "Feature") {
    return { type: "FeatureCollection", features: [value as Feature] };
  }
  if (value && typeof value === "object" && typeof (value as { type?: string }).type === "string") {
    return {
      type: "FeatureCollection",
      features: [{ type: "Feature", geometry: value as Geometry, properties: {} }],
    };
  }
  return emptyCollection();
}

function findValue(value: unknown, names: string[]): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const object = value as Record<string, unknown>;
  for (const name of names) {
    const found = object[name] ?? object[name.toLowerCase()];
    if (found !== undefined && found !== null && found !== "") return String(found);
  }
  return undefined;
}

export function parseFlowtraceResponse(data: unknown): NldiTraceResult {
  const object = (data && typeof data === "object" ? data : {}) as Record<string, unknown>;
  const flowlineValue = object.flowline ?? object.flowLine ?? (object.features ? data : object);
  const flowline = asCollection(flowlineValue);
  const raindropPath = asCollection(object.raindropPath ?? object.raindrop_path ?? object.raindrop);
  const firstProperties = flowline.features[0]?.properties;
  const comid =
    findValue(firstProperties, ["comid", "COMID"]) ?? findValue(object, ["comid", "COMID"]);
  return { flowline, raindropPath, comid };
}

function parseNavigationSources(data: unknown): Record<string, string> {
  const sources: Record<string, string> = {};
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!value || typeof value !== "object") return;
    const object = value as Record<string, unknown>;
    const source = findValue(object, ["source"]);
    const features = findValue(object, ["features"]);
    if (source && features?.startsWith("http")) sources[source] = features;
    Object.values(object).forEach((child) => {
      if (typeof child === "object") visit(child);
    });
  };
  visit(data);
  return sources;
}

async function fetchJson(url: string, init?: RequestInit): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const inheritedSignal = init?.signal;
  const abort = () => controller.abort();
  // A signal that is already aborted never fires "abort" again, so subscribing
  // alone would let a superseded request keep running.
  if (inheritedSignal?.aborted) controller.abort();
  else inheritedSignal?.addEventListener("abort", abort, { once: true });
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    if (!response.ok) {
      let detail = "";
      try {
        // NLDI's linked-data endpoints answer with `description`; the
        // pygeoapi process executions use OGC API Processes' `detail`.
        const body = (await response.json()) as { description?: unknown; detail?: unknown };
        detail = String(body.description ?? body.detail ?? "");
      } catch {
        /* non-JSON error */
      }
      throw new Error(labels.httpError(response.status, detail));
    }
    return response.json();
  } finally {
    clearTimeout(timer);
    inheritedSignal?.removeEventListener("abort", abort);
  }
}

function pointFromHydrolocation(data: unknown): { point?: Point; comid?: string } {
  const features =
    (data && typeof data === "object" ? (data as { features?: Feature[] }).features : undefined) ??
    [];
  const networkFeature = features.find(
    (feature) => feature.properties && findValue(feature.properties, ["comid", "COMID"]),
  );
  const pointFeature = features.find(
    (feature) =>
      feature.geometry?.type === "Point" &&
      findValue(feature.properties, ["type"]) === "hydrolocation",
  );
  return {
    point: pointFeature?.geometry?.type === "Point" ? pointFeature.geometry : undefined,
    comid: findValue(networkFeature?.properties, ["comid", "COMID"]),
  };
}

async function fallbackTrace(
  lon: number,
  lat: number,
  direction: NldiDirection,
  signal?: AbortSignal,
): Promise<{ trace: NldiTraceResult; usedFallback: boolean }> {
  if (direction !== "none") throw new Error(labels.directionalUnavailable);
  const hydrolocation = await fetchJson(buildHydrolocationUrl(lon, lat), { signal });
  const resolved = pointFromHydrolocation(hydrolocation);
  if (!resolved.comid) throw new Error(labels.noFlowlineNearby);
  const flowline = asCollection(
    await fetchJson(`${NLDI_API}/linked-data/comid/${encodeURIComponent(resolved.comid)}?f=json`, {
      signal,
    }),
  );
  const raindropPath = resolved.point
    ? ({
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            geometry: { type: "LineString", coordinates: [[lon, lat], resolved.point.coordinates] },
            properties: {},
          },
        ],
      } as FeatureCollection)
    : emptyCollection();
  return { trace: { flowline, raindropPath, comid: resolved.comid }, usedFallback: true };
}

function setSource(map: MapLibreMap, id: string, data: FeatureCollection): void {
  const source = map.getSource(id) as { setData?: (next: FeatureCollection) => void } | undefined;
  if (source?.setData) source.setData(data);
  else map.addSource(id, { type: "geojson", data });
}

function addLayers(map: MapLibreMap): void {
  if (!map.getLayer(FLOWTRACE_LAYER))
    map.addLayer({
      id: FLOWTRACE_LAYER,
      type: "line",
      source: FLOWTRACE_SOURCE,
      paint: { "line-color": "#1677c8", "line-width": 4 },
    });
  if (!map.getLayer(RAINDROP_LAYER))
    map.addLayer({
      id: RAINDROP_LAYER,
      type: "line",
      source: RAINDROP_SOURCE,
      paint: { "line-color": "#f59e0b", "line-width": 3, "line-dasharray": [2, 2] },
    });
  if (!map.getLayer(BASIN_FILL))
    map.addLayer({
      id: BASIN_FILL,
      type: "fill",
      source: BASIN_SOURCE,
      paint: { "fill-color": "#38bdf8", "fill-opacity": 0.18 },
    });
  if (!map.getLayer(BASIN_LINE))
    map.addLayer({
      id: BASIN_LINE,
      type: "line",
      source: BASIN_SOURCE,
      paint: { "line-color": "#0284c7", "line-width": 2 },
    });
  if (!map.getLayer(POINT_LAYER))
    map.addLayer({
      id: POINT_LAYER,
      type: "circle",
      source: POINT_SOURCE,
      paint: {
        "circle-radius": 6,
        "circle-color": "#dc2626",
        "circle-stroke-color": "#fff",
        "circle-stroke-width": 2,
      },
    });
}

function clearResult(map: MapLibreMap): void {
  for (const layer of [POINT_LAYER, BASIN_LINE, BASIN_FILL, RAINDROP_LAYER, FLOWTRACE_LAYER])
    if (map.getLayer(layer)) map.removeLayer(layer);
  for (const source of [POINT_SOURCE, BASIN_SOURCE, RAINDROP_SOURCE, FLOWTRACE_SOURCE])
    if (map.getSource(source)) map.removeSource(source);
}

function render(map: MapLibreMap, point: Point, trace: NldiTraceResult): void {
  setSource(map, FLOWTRACE_SOURCE, trace.flowline);
  setSource(map, RAINDROP_SOURCE, trace.raindropPath);
  // addLayers() adds the basin layers unconditionally, and clearResult() drops
  // BASIN_SOURCE on every new click, so seed an empty one first: a layer whose
  // source is missing fails style validation and floods the app diagnostics.
  if (!map.getSource(BASIN_SOURCE)) setSource(map, BASIN_SOURCE, emptyCollection());
  setSource(map, POINT_SOURCE, {
    type: "FeatureCollection",
    features: [{ type: "Feature", geometry: point, properties: {} }],
  });
  addLayers(map);
}

function renderBasin(map: MapLibreMap, basin: FeatureCollection): void {
  setSource(map, BASIN_SOURCE, basin);
  addLayers(map);
}

function addLayerTag(data: FeatureCollection, layer: string): FeatureCollection {
  return {
    ...data,
    features: data.features.map((feature) => ({
      ...feature,
      properties: { ...feature.properties, _nldiLayer: layer },
    })),
  };
}

function exportCollection(parts: Array<[string, FeatureCollection]>): FeatureCollection {
  return {
    type: "FeatureCollection",
    features: parts.flatMap(([layer, collection]) => addLayerTag(collection, layer).features),
  };
}

interface PlottedNavigationLayer {
  sourceId: string;
  layerIds: string[];
  data: FeatureCollection;
  removeHover: () => void;
}

function addNavigationLayer(
  map: MapLibreMap,
  data: FeatureCollection,
  label: string,
  index: number,
): PlottedNavigationLayer {
  const sourceId = `usgs-nldi-navigation-source-${index}`;
  const lineId = `usgs-nldi-navigation-line-${index}`;
  const pointId = `usgs-nldi-navigation-point-${index}`;
  map.addSource(sourceId, { type: "geojson", data });
  const hasLines = data.features.some(
    (feature) =>
      feature.geometry?.type === "LineString" || feature.geometry?.type === "MultiLineString",
  );
  const hasPoints = data.features.some(
    (feature) => feature.geometry?.type === "Point" || feature.geometry?.type === "MultiPoint",
  );
  const layerIds: string[] = [];
  if (hasLines) {
    map.addLayer({
      id: lineId,
      type: "line",
      source: sourceId,
      filter: ["match", ["geometry-type"], ["LineString", "MultiLineString"], true, false],
      paint: { "line-color": "#7c3aed", "line-width": 2.5, "line-opacity": 0.8 },
    });
    layerIds.push(lineId);
  }
  if (hasPoints) {
    map.addLayer({
      id: pointId,
      type: "circle",
      source: sourceId,
      filter: ["match", ["geometry-type"], ["Point", "MultiPoint"], true, false],
      paint: {
        "circle-radius": 4,
        "circle-color": "#7c3aed",
        "circle-stroke-color": "#fff",
        "circle-stroke-width": 1.25,
      },
    });
    layerIds.push(pointId);
  }
  const popup = new Popup({ closeButton: false, closeOnClick: false, offset: 8 });
  const enter = (event: MapLayerMouseEvent) => {
    const feature = event.features?.[0];
    map.getCanvas().style.cursor = "pointer";
    popup
      .setLngLat(event.lngLat)
      .setText(`${label}\n${popupText(feature?.properties as Record<string, unknown> | undefined)}`)
      .addTo(map);
  };
  const move = (event: MapLayerMouseEvent) => {
    if (popup.isOpen()) popup.setLngLat(event.lngLat);
  };
  const leave = () => {
    // Back to the panel's click-to-trace cursor, not the default: the map is
    // still in trace mode for as long as these layers exist.
    map.getCanvas().style.cursor = "crosshair";
    popup.remove();
  };
  for (const layerId of layerIds) {
    map.on("mouseenter", layerId, enter);
    map.on("mousemove", layerId, move);
    map.on("mouseleave", layerId, leave);
  }
  return {
    sourceId,
    layerIds,
    data,
    removeHover: () => {
      for (const layerId of layerIds) {
        map.off("mouseenter", layerId, enter);
        map.off("mousemove", layerId, move);
        map.off("mouseleave", layerId, leave);
      }
      popup.remove();
    },
  };
}

function button(label: string): HTMLButtonElement {
  const element = document.createElement("button");
  element.type = "button";
  element.textContent = label;
  element.style.cssText =
    "padding:6px 8px;border:1px solid hsl(var(--border));border-radius:5px;background:transparent;color:inherit;cursor:pointer;";
  return element;
}

function styleThemedSelect(select: HTMLSelectElement): void {
  select.style.cssText =
    "padding:6px;border:1px solid hsl(var(--border));border-radius:5px;background:hsl(var(--background));";
  select.style.setProperty("color", "hsl(var(--foreground))", "important");
}

function sourceLabel(name: string): string {
  return labels.catalogNames[name.toLowerCase()] ?? name;
}

function popupText(properties: Record<string, unknown> | null | undefined): string {
  if (!properties) return labels.noAttributes;
  const entries = Object.entries(properties)
    .filter(([key, value]) => !key.startsWith("_") && value !== null && value !== "")
    .slice(0, 8);
  return entries.length
    ? entries.map(([key, value]) => `${key}: ${String(value)}`).join("\n")
    : labels.noAttributes;
}

/** Teardown closure published by `activate` for `deactivate` to call. */
let teardown: (() => void) | null = null;

export const maplibreUsgsNldiPlugin: GeoLibrePlugin = {
  id: USGS_NLDI_PLUGIN_ID,
  name: "USGS NLDI",
  version: "1.0.0",
  activate(app: GeoLibreAppAPI) {
    const map = app.getMap?.();
    if (!map) return false;
    let selected: { point: Point; comid?: string } | null = null;
    let traceResult: NldiTraceResult | null = null;
    let basinResult: FeatureCollection | null = null;
    const plottedNavigation: PlottedNavigationLayer[] = [];
    let disposed = false;
    let requestId = 0;
    let activeAbortController: AbortController | null = null;
    const direction = document.createElement("select");
    direction.append(
      new Option(labels.directionComplete, "none"),
      new Option(labels.directionUp, "up"),
      new Option(labels.directionDown, "down"),
    );
    styleThemedSelect(direction);
    const status = document.createElement("div");
    status.style.cssText = "line-height:1.4;color:hsl(var(--muted-foreground));";
    const basinButton = button(labels.basinButton);
    basinButton.disabled = true;
    const navigation = document.createElement("select");
    navigation.append(
      new Option(labels.navigationPlaceholder, ""),
      new Option(labels.navigationUpstreamMain, "upstreamMain"),
      new Option(labels.navigationUpstreamTributaries, "upstreamTributaries"),
      new Option(labels.navigationDownstreamMain, "downstreamMain"),
      new Option(labels.navigationDownstreamDiversions, "downstreamDiversions"),
    );
    styleThemedSelect(navigation);
    const source = document.createElement("select");
    source.append(new Option(labels.sourcePlaceholder, ""));
    source.disabled = true;
    styleThemedSelect(source);
    const distance = document.createElement("input");
    distance.type = "number";
    distance.min = "1";
    distance.max = "9999";
    distance.step = "1";
    distance.value = "500";
    distance.placeholder = labels.distancePlaceholder;
    distance.style.cssText =
      "padding:6px;border:1px solid hsl(var(--border));border-radius:5px;background:transparent;color:inherit;";
    const navigationButton = button(labels.navigationButton);
    navigationButton.disabled = true;
    navigationButton.style.cssText +=
      "font-weight:700;background:hsl(var(--primary));color:hsl(var(--primary-foreground));min-height:36px;";
    const exportButton = button(labels.exportButton);
    exportButton.disabled = true;
    const addLayersButton = button(labels.addLayersButton);
    addLayersButton.disabled = true;
    const clearButton = button(labels.clearButton);
    let navigationSources: Record<string, string> = {};
    let loadedNavigation = "";
    // The button reads "load sources & plot" until something has been plotted
    // for the current selection, then "plot another". Tracked explicitly so a
    // locale switch can re-render whichever state is showing.
    let navigationPlotted = false;
    // "Add rendered results" is re-enabled after every basin/navigation request,
    // so remember what already went into the Layers panel: re-adding everything
    // would duplicate the flowline/point/basin under a second group.
    const addedParts = new Set<string>();
    let resultGroupId: string | null = null;
    const setNavigationButtonLabel = (plotted: boolean) => {
      navigationPlotted = plotted;
      navigationButton.textContent = plotted
        ? labels.navigationButtonAgain
        : labels.navigationButton;
    };
    const clearPlottedNavigation = () => {
      plottedNavigation.splice(0).forEach((plotted) => {
        plotted.removeHover();
        plotted.layerIds.forEach((id) => {
          if (map.getLayer(id)) map.removeLayer(id);
        });
        if (map.getSource(plotted.sourceId)) map.removeSource(plotted.sourceId);
      });
    };
    const resetResultState = () => {
      clearPlottedNavigation();
      clearResult(map);
      selected = null;
      traceResult = null;
      basinResult = null;
      navigationSources = {};
      loadedNavigation = "";
      addedParts.clear();
      resultGroupId = null;
      source.replaceChildren(new Option(labels.sourcePlaceholder, ""));
      basinButton.disabled = true;
      navigationButton.disabled = true;
      source.disabled = true;
      exportButton.disabled = true;
      addLayersButton.disabled = true;
      setNavigationButtonLabel(false);
    };
    const beginRequest = (): AbortSignal => {
      activeAbortController?.abort();
      activeAbortController = new AbortController();
      return activeAbortController.signal;
    };
    const isCurrent = (generation: number, comid: string): boolean =>
      !disposed && generation === requestId && selected?.comid === comid;
    const containerRender = (container: HTMLElement) => {
      container.replaceChildren();
      container.classList.add("geolibre-usgs-nldi-panel");
      container.style.cssText =
        "display:flex;flex-direction:column;gap:8px;padding:10px;box-sizing:border-box;height:100%;overflow:auto;font-size:12px;color:hsl(var(--foreground));";
      const title = document.createElement("strong");
      title.textContent = labels.title;
      const hint = document.createElement("div");
      hint.textContent = labels.hint;
      hint.style.lineHeight = "1.4";
      // Re-label the static text in place when the locale changes.
      applyLabels = () => {
        title.textContent = labels.title;
        hint.textContent = labels.hint;
        basinButton.textContent = labels.basinButton;
        exportButton.textContent = labels.exportButton;
        addLayersButton.textContent = labels.addLayersButton;
        clearButton.textContent = labels.clearButton;
        distance.placeholder = labels.distancePlaceholder;
        setNavigationButtonLabel(navigationPlotted);
        const relabel = (select: HTMLSelectElement, texts: Record<string, string>) => {
          for (const option of Array.from(select.options))
            if (texts[option.value] !== undefined) option.textContent = texts[option.value];
        };
        relabel(direction, {
          none: labels.directionComplete,
          up: labels.directionUp,
          down: labels.directionDown,
        });
        relabel(navigation, {
          "": labels.navigationPlaceholder,
          upstreamMain: labels.navigationUpstreamMain,
          upstreamTributaries: labels.navigationUpstreamTributaries,
          downstreamMain: labels.navigationDownstreamMain,
          downstreamDiversions: labels.navigationDownstreamDiversions,
        });
        // The source select holds either the placeholder or catalog names, and
        // both come from the label set.
        for (const option of Array.from(source.options))
          option.textContent = option.value ? sourceLabel(option.value) : labels.sourcePlaceholder;
      };
      container.append(
        title,
        hint,
        direction,
        basinButton,
        navigation,
        source,
        distance,
        navigationButton,
        addLayersButton,
        exportButton,
        clearButton,
        status,
      );
      return () => {
        applyLabels = null;
      };
    };
    const setStatus = (message: string) => {
      status.textContent = message;
    };
    const lookupBasin = async () => {
      if (!selected?.comid) {
        setStatus(labels.noComid);
        return;
      }
      // Claim a new generation so a still-pending basin or navigation request
      // cannot resolve over this one.
      const generation = ++requestId;
      const comid = selected.comid;
      const signal = beginRequest();
      basinButton.disabled = true;
      setStatus(labels.requestingBasin);
      try {
        const basin = asCollection(await fetchJson(buildBasinUrl("comid", comid), { signal }));
        if (!isCurrent(generation, comid)) return;
        basinResult = basin;
        renderBasin(map, basin);
        exportButton.disabled = false;
        addLayersButton.disabled = false;
        setStatus(labels.basinRendered(comid));
      } catch (error) {
        if (!isCurrent(generation, comid)) return;
        setStatus(error instanceof Error ? error.message : labels.basinFailed);
      } finally {
        // Keyed on the current selection, not on `generation`: the two buttons
        // share one request token, so a navigation request superseding this one
        // would otherwise leave the basin button stuck disabled. A COMID is only
        // set once a trace has resolved, so this stays disabled during a fresh
        // trace and after Clear.
        if (!disposed && selected?.comid) basinButton.disabled = false;
      }
    };
    const plotNavigation = async () => {
      if (!selected?.comid || !navigation.value) {
        setStatus(labels.selectNavigation);
        return;
      }
      const km = Number(distance.value);
      if (!Number.isFinite(km) || km < 1 || km > 9999) {
        setStatus(labels.invalidDistance);
        return;
      }
      // Claim a new generation so an earlier in-flight request cannot render or
      // report over this one.
      const generation = ++requestId;
      const comid = selected.comid;
      // Snapshot the selects: both are still editable while the fetches run, and
      // labelling the response with a value the user changed mid-request would
      // describe a different catalog than the one actually plotted.
      const navigationMethod = navigation.value;
      // The catalog list depends on the search radius too: a source that only
      // appears within a larger distance must not be hidden by a cache keyed on
      // the method alone.
      const navigationKey = `${navigationMethod}|${km}`;
      const signal = beginRequest();
      navigationButton.disabled = true;
      setStatus(labels.discoveringSources);
      try {
        if (loadedNavigation !== navigationKey) {
          const links = await fetchJson(buildNavigationUrl(comid), { signal });
          if (!isCurrent(generation, comid) || navigation.value !== navigationMethod) return;
          const navigationUrl = (links as Record<string, unknown>)[navigationMethod];
          if (typeof navigationUrl !== "string") throw new Error(labels.navigationUnavailable);
          const discovered = parseNavigationSources(
            await fetchJson(buildNavigationSourceUrl(navigationUrl, { distance: km }), { signal }),
          );
          // The "change" listener resets the source list when the method
          // changes, so a superseded discovery must not repopulate it.
          if (!isCurrent(generation, comid) || navigation.value !== navigationMethod) return;
          navigationSources = discovered;
          source.replaceChildren(
            ...Object.keys(navigationSources)
              .sort((a, b) =>
                a.toLowerCase() === "flowlines"
                  ? -1
                  : b.toLowerCase() === "flowlines"
                    ? 1
                    : a.localeCompare(b),
              )
              .map((name) => new Option(sourceLabel(name), name)),
          );
          source.disabled = false;
          source.value =
            Object.keys(navigationSources).find((name) => name.toLowerCase() === "flowlines") ??
            Object.keys(navigationSources)[0] ??
            "";
          loadedNavigation = navigationKey;
        }
        const selectedSource = source.value;
        const sourceUrl = navigationSources[selectedSource];
        if (!sourceUrl) throw new Error(labels.noPlottableSource);
        const result = asCollection(
          await fetchJson(buildNavigationSourceUrl(sourceUrl, { distance: km }), { signal }),
        );
        if (!isCurrent(generation, comid)) return;
        // isCurrent() only tracks the request token and the COMID, so check the
        // selects the response was built from as well.
        if (source.value !== selectedSource || navigation.value !== navigationMethod) return;
        const plotted = addNavigationLayer(
          map,
          result,
          `${sourceLabel(selectedSource)} · ${navigationMethod}`,
          plottedNavigation.length + 1,
        );
        // A response with no point/line geometry renders no layers, so say so
        // rather than reporting a plot the user cannot see.
        if (!plotted.layerIds.length) {
          plotted.removeHover();
          if (map.getSource(plotted.sourceId)) map.removeSource(plotted.sourceId);
          setStatus(labels.navigationEmpty(sourceLabel(selectedSource)));
          return;
        }
        plottedNavigation.push(plotted);
        exportButton.disabled = false;
        addLayersButton.disabled = false;
        setNavigationButtonLabel(true);
        setStatus(labels.navigationAdded(sourceLabel(selectedSource), navigationMethod, comid, km));
      } catch (error) {
        if (!isCurrent(generation, comid)) return;
        setStatus(error instanceof Error ? error.message : labels.navigationFailed);
      } finally {
        // Same reasoning as lookupBasin's finally.
        if (!disposed && selected?.comid) navigationButton.disabled = false;
      }
    };
    const onClick = async (event: MapMouseEvent) => {
      const currentRequest = ++requestId;
      const signal = beginRequest();
      const point: Point = { type: "Point", coordinates: [event.lngLat.lng, event.lngLat.lat] };
      selected = { point };
      basinButton.disabled = true;
      navigationButton.disabled = true;
      source.disabled = true;
      loadedNavigation = "";
      navigationSources = {};
      source.replaceChildren(new Option(labels.sourcePlaceholder, ""));
      setNavigationButtonLabel(false);
      addedParts.clear();
      resultGroupId = null;
      traceResult = null;
      basinResult = null;
      // Drop the previous point's navigation layers too, otherwise they linger
      // on the map and get mixed into the next export / "Add to Layers".
      clearPlottedNavigation();
      clearResult(map);
      exportButton.disabled = true;
      addLayersButton.disabled = true;
      setStatus(labels.tracing);
      try {
        let trace: NldiTraceResult;
        let usedFallback = false;
        try {
          trace = parseFlowtraceResponse(
            await fetchJson(`${NLDI_API}/pygeoapi/processes/nldi-flowtrace/execution?f=json`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: buildFlowtraceBody(
                event.lngLat.lng,
                event.lngLat.lat,
                direction.value as NldiDirection,
              ),
              signal,
            }),
          );
        } catch (processError) {
          const fallback = await fallbackTrace(
            event.lngLat.lng,
            event.lngLat.lat,
            direction.value as NldiDirection,
            signal,
          );
          trace = fallback.trace;
          usedFallback = fallback.usedFallback;
          console.warn(
            "USGS NLDI flowtrace process was unavailable; used hydrolocation fallback.",
            processError,
          );
        }
        if (disposed || currentRequest !== requestId) return;
        selected = { point, comid: trace.comid };
        traceResult = trace;
        basinResult = null;
        addLayersButton.disabled = false;
        exportButton.disabled = false;
        render(map, point, trace);
        // Only worth a second round-trip when the trace itself yielded no COMID:
        // the fallback path already resolved one from this same endpoint. Its
        // failure must not undo a flowline that has already rendered, so it gets
        // its own catch rather than falling into the outer one.
        if (!trace.comid) {
          try {
            const hydro = await fetchJson(
              buildHydrolocationUrl(event.lngLat.lng, event.lngLat.lat),
              { signal },
            );
            if (disposed || currentRequest !== requestId) return;
            const hydroObject = (hydro && typeof hydro === "object" ? hydro : {}) as Record<
              string,
              unknown
            >;
            selected.comid =
              findValue(hydroObject, ["comid", "COMID"]) ??
              findValue((hydroObject.features as Feature[] | undefined)?.[0]?.properties, [
                "comid",
                "COMID",
              ]);
          } catch (hydroError) {
            if (disposed || currentRequest !== requestId) return;
            console.warn("USGS NLDI hydrolocation lookup failed after the trace.", hydroError);
          }
        }
        basinButton.disabled = !selected.comid;
        navigationButton.disabled = !selected.comid;
        source.disabled = !selected.comid;
        setStatus(labels.flowlineRendered(selected.comid, usedFallback));
      } catch (error) {
        if (disposed || currentRequest !== requestId) return;
        setStatus(error instanceof Error ? error.message : labels.requestFailed);
      }
    };
    // MapLibre does not await event-listener promises. Keep an explicit catch
    // at the event boundary so a synchronous UI/rendering failure cannot become
    // a browser-level unhandled promise rejection.
    const clickListener = (event: MapMouseEvent) => {
      void onClick(event).catch((error: unknown) => {
        if (!disposed) setStatus(error instanceof Error ? error.message : labels.requestFailed);
      });
    };
    let resourcesBound = false;
    const cleanupResources = () => {
      if (resourcesBound) {
        resourcesBound = false;
        map.off("click", clickListener);
        map.getCanvas().style.cursor = "";
      }
      activeAbortController?.abort();
      activeAbortController = null;
      ++requestId;
      resetResultState();
    };
    const bindResources = () => {
      if (disposed || resourcesBound) return;
      resourcesBound = true;
      map.on("click", clickListener);
      map.getCanvas().style.cursor = "crosshair";
    };
    const unregister = app.registerRightPanel?.({
      id: PANEL,
      title: labels.panelTitle,
      dock: "replace-style",
      defaultWidth: 330,
      // The panel is the whole UI, so closing it from the header must also
      // mark the plugin inactive in the Plugins menu.
      deactivatePluginOnClose: true,
      render: containerRender,
      onClose: cleanupResources,
      onOpen: bindResources,
    });
    basinButton.addEventListener("click", () => void lookupBasin());
    navigationButton.addEventListener("click", () => void plotNavigation());
    exportButton.addEventListener("click", () => {
      if (!selected || !traceResult) return;
      const parts: Array<[string, FeatureCollection]> = [
        ["flowline", traceResult.flowline],
        ["raindropPath", traceResult.raindropPath],
        [
          "selectedPoint",
          {
            type: "FeatureCollection",
            features: [
              {
                type: "Feature",
                geometry: selected.point,
                properties: { comid: selected.comid ?? "" },
              },
            ],
          },
        ],
      ];
      if (basinResult) parts.push(["basin", basinResult]);
      for (const [index, plotted] of plottedNavigation.entries())
        parts.push([`navigation-${index + 1}`, plotted.data]);
      app.exportTextFile?.(
        `nldi-${selected.comid ?? "result"}.geojson`,
        JSON.stringify(exportCollection(parts), null, 2),
        { description: "GeoJSON", extensions: ["geojson"] },
      );
    });
    addLayersButton.addEventListener("click", () => {
      if (!selected || !traceResult || !app.addGeoJsonLayer || !app.addLayerGroup) return;
      const layers: Array<[string, string, FeatureCollection]> = [
        ["flowline", labels.layerFlowline, traceResult.flowline],
        ["raindrop", labels.layerRaindrop, traceResult.raindropPath],
        [
          "point",
          labels.layerSelectedPoint,
          {
            type: "FeatureCollection",
            features: [
              {
                type: "Feature",
                geometry: selected.point,
                properties: { comid: selected.comid ?? "" },
              },
            ],
          },
        ],
      ];
      if (basinResult) layers.push(["basin", labels.layerBasin, basinResult]);
      plottedNavigation.forEach((plotted, index) =>
        layers.push([`navigation-${index + 1}`, labels.layerNavigation(index + 1), plotted.data]),
      );
      const pending = layers.filter(
        ([key, , data]) => data.features.length > 0 && !addedParts.has(key),
      );
      if (!pending.length) {
        setStatus(labels.nothingToAdd);
        return;
      }
      const layerIds = pending.map(([key, name, data]) => {
        addedParts.add(key);
        return app.addGeoJsonLayer(name, data);
      });
      // Append to the group from the first click when we still can, so the
      // results stay in one "USGS NLDI results" group as the docs describe.
      if (resultGroupId && app.moveLayersToGroup) app.moveLayersToGroup(layerIds, resultGroupId);
      else resultGroupId = app.addLayerGroup(labels.layerGroupName, layerIds);
      addLayersButton.disabled = true;
      setStatus(labels.layersAdded(layerIds.length));
    });
    navigation.addEventListener("change", () => {
      loadedNavigation = "";
      navigationSources = {};
      source.replaceChildren(new Option(labels.sourcePlaceholder, ""));
      source.disabled = true;
      // The next press reloads the catalog list, so drop the "plot another" label.
      setNavigationButtonLabel(false);
    });
    clearButton.addEventListener("click", () => {
      activeAbortController?.abort();
      activeAbortController = null;
      ++requestId;
      resetResultState();
      setStatus(labels.resultCleared);
    });
    bindResources();
    app.openRightPanel?.(PANEL);
    teardown = () => {
      disposed = true;
      ++requestId;
      cleanupResources();
      unregister?.();
      app.closeRightPanel?.(PANEL);
      teardown = null;
    };
  },
  deactivate() {
    teardown?.();
  },
};

export default maplibreUsgsNldiPlugin;
