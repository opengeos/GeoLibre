import type { IControl, Map as MapLibreMap, MapMouseEvent, GeoJSONSource } from "maplibre-gl";
import type { Feature, FeatureCollection, LineString, Point } from "geojson";

import type { LngLat, ProfileStats } from "../elevation/geometry";
import { resampleLine, computeStats } from "../elevation/geometry";
import { fetchElevations, MAX_POINTS_PER_REQUEST, ElevationFetchError } from "../elevation/client";
import { buildChartGeometry, type ProfilePoint } from "../chart/profileChart";
import { profileToCsv } from "../export/csv";
import {
  formatDistance,
  formatElevation,
  unitSystemLabel,
  UNIT_SYSTEMS,
  type UnitSystem,
} from "../elevation/format";
import type { DeepLinkConsumer } from "../utils/deep-link";
import type {
  ControlPosition,
  ElevationProfileControlOptions,
  ElevationProfileState,
  ExportFileOptions,
  ExportTextFile,
} from "./types";

const SVG_NS = "http://www.w3.org/2000/svg";

const SOURCE_LINE = "geolibre-elevation-profile-line";
const SOURCE_VERTICES = "geolibre-elevation-profile-vertices";
const SOURCE_HOVER = "geolibre-elevation-profile-hover";
const LAYER_LINE = "geolibre-elevation-profile-line-layer";
const LAYER_VERTICES = "geolibre-elevation-profile-vertices-layer";
const LAYER_HOVER = "geolibre-elevation-profile-hover-layer";

const LINE_COLOR = "#f97316";
const HOVER_COLOR = "#ef4444";

const CHART_HEIGHT = 132;

const DEFAULT_OPTIONS: Required<Omit<ElevationProfileControlOptions, "exportTextFile">> = {
  collapsed: true,
  title: "Elevation Profile",
  panelWidth: 320,
  unitSystem: "metric",
  className: "",
  maxSamples: MAX_POINTS_PER_REQUEST,
};

const emptyFeatureCollection = (): FeatureCollection => ({
  type: "FeatureCollection",
  features: [],
});

const lineFeature = (coords: LngLat[]): Feature<LineString> => ({
  type: "Feature",
  geometry: { type: "LineString", coordinates: coords },
  properties: {},
});

const pointFeature = (coord: LngLat): Feature<Point> => ({
  type: "Feature",
  geometry: { type: "Point", coordinates: coord },
  properties: {},
});

const pointCollection = (coords: LngLat[]): FeatureCollection<Point> => ({
  type: "FeatureCollection",
  features: coords.map(pointFeature),
});

/**
 * A MapLibre control that draws a line on the map and charts the elevation
 * profile along it, sampling elevations from the Open-Meteo API.
 *
 * Implements {@link DeepLinkConsumer} so GeoLibre can restore a shared line from
 * a URL parameter, and exposes {@link getState}/{@link setState} for project
 * persistence.
 */
export class ElevationProfileControl implements IControl, DeepLinkConsumer {
  private _options: Required<Omit<ElevationProfileControlOptions, "exportTextFile">>;
  private _exportTextFile?: ExportTextFile;
  private _state: ElevationProfileState;

  private _map?: MapLibreMap;
  private _mapContainer?: HTMLElement;
  private _container?: HTMLElement;
  private _panel?: HTMLElement;
  private _statusEl?: HTMLElement;
  private _statsEl?: HTMLElement;
  private _chartEl?: HTMLElement;
  private _drawButton?: HTMLButtonElement;
  private _clearButton?: HTMLButtonElement;
  private _unitButton?: HTMLButtonElement;
  private _readoutEl?: HTMLElement;
  private _exportEl?: HTMLElement;
  private _svgEl?: SVGSVGElement;
  private _chartResizeObserver?: ResizeObserver;
  private _chartRenderQueued = false;
  private _styleReadyQueued = false;

  // Drawing / profiling runtime state (not serialized).
  private _drawing = false;
  private _drawVertices: LngLat[] = [];
  private _profilePoints: ProfilePoint[] = [];
  private _sampledCoords: LngLat[] = [];
  private _stats: ProfileStats | null = null;
  private _requestToken = 0;

  // Bound handlers retained so they can be detached.
  private _onMapClick = (e: MapMouseEvent): void => this._handleMapClick(e);
  private _onMapDblClick = (e: MapMouseEvent): void => this._handleMapDblClick(e);
  private _onKeyDown = (e: KeyboardEvent): void => this._handleKeyDown(e);
  private _resizeHandler: (() => void) | null = null;
  private _mapResizeHandler: (() => void) | null = null;
  private _clickOutsideHandler: ((e: MouseEvent) => void) | null = null;

  /**
   * @param options - Optional configuration overrides
   */
  constructor(options?: Partial<ElevationProfileControlOptions>) {
    const { exportTextFile, ...visual } = options ?? {};
    this._exportTextFile = exportTextFile;
    this._options = { ...DEFAULT_OPTIONS, ...visual };
    this._options.maxSamples = Math.min(
      MAX_POINTS_PER_REQUEST,
      Math.max(2, Math.floor(this._options.maxSamples)),
    );
    this._state = {
      collapsed: this._options.collapsed,
      unitSystem: this._options.unitSystem,
      line: null,
    };
  }

  // --- IControl ----------------------------------------------------------

  /** @inheritdoc */
  onAdd(map: MapLibreMap): HTMLElement {
    this._map = map;
    this._mapContainer = map.getContainer();
    this._container = this._createContainer();
    this._panel = this._createPanel();
    this._mapContainer.appendChild(this._panel);
    this._setupPanelListeners();

    if (!this._state.collapsed) {
      this._panel.classList.add("expanded");
      requestAnimationFrame(() => this._updatePanelPosition());
    }

    // Restore a previously saved or deep-linked line, if any.
    if (this._state.line && this._state.line.length >= 2) {
      if (this._profilePoints.length >= 2) {
        // The control was re-mounted (e.g. repositioned via
        // setMapControlPosition) with its profile still in memory — only the
        // map's GeoJSON line/vertex layers were torn down in onRemove. Redraw
        // them without re-hitting Open-Meteo; _createPanel already re-rendered
        // the cached stats/chart.
        this._renderLineGeometry(this._state.line);
      } else {
        void this._profileLine(this._state.line, { fit: false });
      }
    }

    return this._container;
  }

  /** @inheritdoc */
  onRemove(): void {
    this._exitDrawing();
    this._removeMapLayers();
    // Any pending style-ready retry becomes a no-op (its callback guards on
    // this._map), but clear the flag so a later re-add can queue a fresh one.
    this._styleReadyQueued = false;
    this._chartResizeObserver?.disconnect();
    this._chartResizeObserver = undefined;

    if (this._resizeHandler) {
      window.removeEventListener("resize", this._resizeHandler);
      this._resizeHandler = null;
    }
    if (this._mapResizeHandler && this._map) {
      this._map.off("resize", this._mapResizeHandler);
      this._mapResizeHandler = null;
    }
    if (this._clickOutsideHandler) {
      document.removeEventListener("click", this._clickOutsideHandler);
      this._clickOutsideHandler = null;
    }

    this._panel?.parentNode?.removeChild(this._panel);
    this._container?.parentNode?.removeChild(this._container);

    this._map = undefined;
    this._mapContainer = undefined;
    this._container = undefined;
    this._panel = undefined;
    this._statusEl = undefined;
    this._statsEl = undefined;
    this._chartEl = undefined;
    this._exportEl = undefined;
    this._svgEl = undefined;
  }

  // --- State -------------------------------------------------------------

  /** Returns a copy of the serializable control state. */
  getState(): ElevationProfileState {
    return {
      collapsed: this._state.collapsed,
      unitSystem: this._state.unitSystem,
      line: this._state.line ? this._state.line.map((c) => [...c] as LngLat) : null,
    };
  }

  /**
   * Merge new state and reflect it in the UI and map. Used by GeoLibre to
   * restore project state.
   *
   * @param newState - Partial state to apply
   */
  setState(newState: Partial<ElevationProfileState>): void {
    const lineChanged = "line" in newState && newState.line !== this._state.line;
    this._state = { ...this._state, ...newState };

    if (newState.unitSystem) this._syncUnitButton();
    if (this._panel) {
      this._panel.classList.toggle("expanded", !this._state.collapsed);
    }

    if (lineChanged && this._map) {
      if (this._state.line && this._state.line.length >= 2) {
        void this._profileLine(this._state.line, { fit: false });
      } else {
        this._clearProfile();
      }
    } else if (newState.unitSystem) {
      this._renderProfile();
    }
  }

  // --- DeepLinkConsumer --------------------------------------------------

  /**
   * Load and profile a line provided via a deep link, fitting the map to it.
   *
   * @param coords - The line vertices as `[lng, lat]`
   */
  async loadLine(coords: LngLat[]): Promise<void> {
    if (coords.length < 2) return;
    this.expand();
    await this._profileLine(coords, { fit: true });
  }

  // --- Panel collapse / expand ------------------------------------------

  /** Toggle the panel open or closed. */
  toggle(): void {
    if (this._state.collapsed) this.expand();
    else this.collapse();
  }

  /** Open the panel. */
  expand(): void {
    this._state.collapsed = false;
    this._panel?.classList.add("expanded");
    this._updatePanelPosition();
  }

  /** Close the panel (drawing, if active, is cancelled). */
  collapse(): void {
    this._state.collapsed = true;
    this._panel?.classList.remove("expanded");
    if (this._drawing) this._exitDrawing();
  }

  // --- Drawing -----------------------------------------------------------

  private _startDrawing(): void {
    if (!this._map) return;
    this._clearProfile();
    this._drawing = true;
    this._drawVertices = [];
    this._map.getCanvas().style.cursor = "crosshair";
    this._map.doubleClickZoom.disable();
    this._map.on("click", this._onMapClick);
    this._map.on("dblclick", this._onMapDblClick);
    document.addEventListener("keydown", this._onKeyDown);
    this._setStatus("Click on the map to add points. Double-click or press Enter to finish.");
    this._syncButtons();
  }

  private _exitDrawing(): void {
    if (!this._map) {
      this._drawing = false;
      return;
    }
    this._drawing = false;
    this._map.getCanvas().style.cursor = "";
    this._map.doubleClickZoom.enable();
    this._map.off("click", this._onMapClick);
    this._map.off("dblclick", this._onMapDblClick);
    document.removeEventListener("keydown", this._onKeyDown);
    this._syncButtons();
  }

  private _handleMapClick(e: MapMouseEvent): void {
    this._drawVertices.push([e.lngLat.lng, e.lngLat.lat]);
    this._renderDrawGeometry();
  }

  private _handleMapDblClick(e: MapMouseEvent): void {
    e.preventDefault();
    // A double-click fires two clicks first; drop the duplicate tail vertex.
    this._dedupeTailVertex();
    this._finishDrawing();
  }

  private _handleKeyDown(e: KeyboardEvent): void {
    if (!this._drawing) return;
    if (e.key === "Enter") {
      e.preventDefault();
      this._finishDrawing();
    } else if (e.key === "Escape") {
      e.preventDefault();
      this._cancelDrawing();
    }
  }

  private _dedupeTailVertex(): void {
    const n = this._drawVertices.length;
    if (n < 2) return;
    const a = this._drawVertices[n - 1];
    const b = this._drawVertices[n - 2];
    if (Math.abs(a[0] - b[0]) < 1e-7 && Math.abs(a[1] - b[1]) < 1e-7) {
      this._drawVertices.pop();
    }
  }

  private _cancelDrawing(): void {
    this._exitDrawing();
    this._clearProfile();
    this._setStatus("Drawing cancelled.");
  }

  private _finishDrawing(): void {
    const vertices = this._drawVertices;
    this._exitDrawing();
    if (vertices.length < 2) {
      this._clearProfile();
      this._setStatus("Need at least two points to build a profile.");
      return;
    }
    void this._profileLine(vertices, { fit: false });
  }

  // --- Profiling ---------------------------------------------------------

  private async _profileLine(coords: LngLat[], opts: { fit: boolean }): Promise<void> {
    if (!this._map) return;
    this._state.line = coords.map((c) => [...c] as LngLat);
    this._renderLineGeometry(coords);
    if (opts.fit) this._fitToLine(coords);

    const token = ++this._requestToken;
    this._setStatus("Sampling elevation…");
    this._setBusy(true);

    const sampled = resampleLine(coords, this._options.maxSamples);
    try {
      const elevations = await fetchElevations(sampled.coords);
      if (token !== this._requestToken) return; // superseded by a newer request

      this._sampledCoords = sampled.coords;
      this._profilePoints = sampled.distances.map((distance, i) => ({
        distance,
        elevation: elevations[i],
      }));
      this._stats = computeStats(elevations, sampled.distances);
      this._setStatus("");
      this._renderProfile();
    } catch (error) {
      if (token !== this._requestToken) return;
      const message =
        error instanceof ElevationFetchError ? error.message : "Could not load elevation data.";
      this._stats = null;
      this._profilePoints = [];
      this._setStatus(message);
      this._renderProfile();
    } finally {
      if (token === this._requestToken) this._setBusy(false);
    }
    this._syncButtons();
  }

  private _clearProfile(): void {
    this._requestToken += 1;
    this._state.line = null;
    this._drawVertices = [];
    this._profilePoints = [];
    this._sampledCoords = [];
    this._stats = null;
    this._renderLineGeometry([]);
    this._clearHover();
    this._setStatus("");
    this._renderProfile();
    // Clearing mid-fetch (the draw button is disabled by _setBusy(true) while a
    // profile is loading) bumps _requestToken above, so the in-flight
    // _profileLine's finally block no longer owns the token and won't re-enable
    // the draw button. Re-enable it unconditionally here so Clear never leaves
    // it stuck disabled.
    this._setBusy(false);
    this._syncButtons();
  }

  // --- Map layers --------------------------------------------------------

  private _ensureMapLayers(): boolean {
    const map = this._map;
    if (!map) return false;
    if (!map.isStyleLoaded()) {
      // The style is still loading (e.g. onAdd profiling a restored/deep-linked
      // line before the basemap is ready). Drop this draw but retry once the
      // style settles so the line/vertices are not lost — mirrors
      // maplibre-graticule's whenStyleReady idle retry.
      if (!this._styleReadyQueued) {
        this._styleReadyQueued = true;
        map.once("idle", () => {
          this._styleReadyQueued = false;
          if (!this._map) return; // control was removed while waiting
          if (this._drawing) this._renderDrawGeometry();
          else if (this._state.line) this._renderLineGeometry(this._state.line);
        });
      }
      return false;
    }
    if (!map.getSource(SOURCE_LINE)) {
      map.addSource(SOURCE_LINE, { type: "geojson", data: emptyFeatureCollection() });
      map.addLayer({
        id: LAYER_LINE,
        type: "line",
        source: SOURCE_LINE,
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": LINE_COLOR, "line-width": 3 },
      });
    }
    if (!map.getSource(SOURCE_VERTICES)) {
      map.addSource(SOURCE_VERTICES, { type: "geojson", data: emptyFeatureCollection() });
      map.addLayer({
        id: LAYER_VERTICES,
        type: "circle",
        source: SOURCE_VERTICES,
        paint: {
          "circle-radius": 4,
          "circle-color": "#ffffff",
          "circle-stroke-color": LINE_COLOR,
          "circle-stroke-width": 2,
        },
      });
    }
    if (!map.getSource(SOURCE_HOVER)) {
      map.addSource(SOURCE_HOVER, { type: "geojson", data: emptyFeatureCollection() });
      map.addLayer({
        id: LAYER_HOVER,
        type: "circle",
        source: SOURCE_HOVER,
        paint: {
          "circle-radius": 6,
          "circle-color": HOVER_COLOR,
          "circle-stroke-color": "#ffffff",
          "circle-stroke-width": 2,
        },
      });
    }
    return true;
  }

  private _removeMapLayers(): void {
    const map = this._map;
    if (!map) return;
    for (const layer of [LAYER_HOVER, LAYER_VERTICES, LAYER_LINE]) {
      if (map.getLayer(layer)) map.removeLayer(layer);
    }
    for (const source of [SOURCE_HOVER, SOURCE_VERTICES, SOURCE_LINE]) {
      if (map.getSource(source)) map.removeSource(source);
    }
  }

  private _setLineData(coords: LngLat[]): void {
    const map = this._map;
    if (!map) return;
    const lineSource = map.getSource(SOURCE_LINE) as GeoJSONSource | undefined;
    const vertexSource = map.getSource(SOURCE_VERTICES) as GeoJSONSource | undefined;
    if (lineSource) lineSource.setData(lineFeature(coords));
    if (vertexSource) vertexSource.setData(pointCollection(coords));
  }

  /** Render in-progress drawing vertices (line through the clicked points). */
  private _renderDrawGeometry(): void {
    if (!this._ensureMapLayers()) return;
    this._setLineData(this._drawVertices);
  }

  /** Render a finished/restored line. */
  private _renderLineGeometry(coords: LngLat[]): void {
    if (!this._ensureMapLayers()) return;
    this._setLineData(coords);
  }

  private _setHoverPoint(coord: LngLat | null): void {
    const map = this._map;
    if (!map) return;
    const source = map.getSource(SOURCE_HOVER) as GeoJSONSource | undefined;
    if (!source) return;
    source.setData(coord ? pointFeature(coord) : emptyFeatureCollection());
  }

  private _fitToLine(coords: LngLat[]): void {
    if (!this._map || coords.length === 0) return;
    // Unwrap longitudes so a line crossing the antimeridian (e.g. Bering Strait)
    // yields a tight box around the line rather than one spanning the globe.
    // Each point is brought into the same 360° window as the previous, matching
    // maplibre-graticule's unwrappedLongitudeRange handling.
    let prevLng = coords[0][0];
    let minLng = coords[0][0];
    let maxLng = coords[0][0];
    let minLat = coords[0][1];
    let maxLat = coords[0][1];
    for (const [lng, lat] of coords) {
      let unwrapped = lng;
      while (unwrapped - prevLng > 180) unwrapped -= 360;
      while (unwrapped - prevLng < -180) unwrapped += 360;
      prevLng = unwrapped;
      minLng = Math.min(minLng, unwrapped);
      maxLng = Math.max(maxLng, unwrapped);
      minLat = Math.min(minLat, lat);
      maxLat = Math.max(maxLat, lat);
    }
    this._map.fitBounds(
      [
        [minLng, minLat],
        [maxLng, maxLat],
      ],
      { padding: 60, duration: 600, maxZoom: 14 },
    );
  }

  // --- DOM: container & panel -------------------------------------------

  private _createContainer(): HTMLElement {
    const container = document.createElement("div");
    container.className = `maplibregl-ctrl maplibregl-ctrl-group elevation-profile${
      this._options.className ? ` ${this._options.className}` : ""
    }`;

    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "elevation-profile-toggle";
    toggle.setAttribute("aria-label", this._options.title);
    toggle.title = this._options.title;
    toggle.appendChild(this._createMountainIcon());
    toggle.addEventListener("click", () => this.toggle());

    container.appendChild(toggle);
    return container;
  }

  private _createMountainIcon(): SVGElement {
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("width", "20");
    svg.setAttribute("height", "20");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "2");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    svg.setAttribute("aria-hidden", "true");
    const path = document.createElementNS(SVG_NS, "path");
    // Lucide "mountain": symmetric within the 24x24 viewBox so it sits centered
    // in the toggle button.
    path.setAttribute("d", "m8 3 4 8 5-5 5 15H2L8 3z");
    svg.appendChild(path);
    return svg;
  }

  private _createPanel(): HTMLElement {
    const panel = document.createElement("div");
    panel.className = "elevation-profile-panel";
    panel.style.width = `${this._options.panelWidth}px`;

    // Header
    const header = document.createElement("div");
    header.className = "elevation-profile-header";
    const title = document.createElement("span");
    title.className = "elevation-profile-title";
    title.textContent = this._options.title;
    const close = document.createElement("button");
    close.type = "button";
    close.className = "elevation-profile-close";
    close.setAttribute("aria-label", "Close panel");
    close.innerHTML = "&times;";
    close.addEventListener("click", () => this.collapse());
    header.append(title, close);

    // Actions
    const actions = document.createElement("div");
    actions.className = "elevation-profile-actions";

    const draw = document.createElement("button");
    draw.type = "button";
    draw.className = "elevation-profile-button elevation-profile-primary";
    draw.textContent = "Draw line";
    draw.addEventListener("click", () => {
      if (this._drawing) this._finishDrawing();
      else this._startDrawing();
    });
    this._drawButton = draw;

    const clear = document.createElement("button");
    clear.type = "button";
    clear.className = "elevation-profile-button";
    clear.textContent = "Clear";
    clear.addEventListener("click", () => this._clearProfile());
    this._clearButton = clear;

    const unit = document.createElement("button");
    unit.type = "button";
    unit.className = "elevation-profile-button elevation-profile-unit";
    unit.addEventListener("click", () => this._cycleUnits());
    this._unitButton = unit;

    actions.append(draw, clear, unit);

    // Status
    const status = document.createElement("div");
    status.className = "elevation-profile-status";
    this._statusEl = status;

    // Stats grid
    const stats = document.createElement("div");
    stats.className = "elevation-profile-stats";
    this._statsEl = stats;

    // Chart (flex-grows so a taller panel yields a taller chart)
    const chart = document.createElement("div");
    chart.className = "elevation-profile-chart";
    this._chartEl = chart;

    // Hover readout
    const readout = document.createElement("div");
    readout.className = "elevation-profile-readout";
    this._readoutEl = readout;

    // Export row (shown only when a profile exists)
    const exportRow = document.createElement("div");
    exportRow.className = "elevation-profile-export";
    const exportLabel = document.createElement("span");
    exportLabel.className = "elevation-profile-export-label";
    exportLabel.textContent = "Export:";
    const csvButton = document.createElement("button");
    csvButton.type = "button";
    csvButton.className = "elevation-profile-button elevation-profile-button-sm";
    csvButton.textContent = "CSV";
    csvButton.title = "Download the profile as CSV";
    csvButton.addEventListener("click", () => this._exportCsv());
    const svgButton = document.createElement("button");
    svgButton.type = "button";
    svgButton.className = "elevation-profile-button elevation-profile-button-sm";
    svgButton.textContent = "SVG";
    svgButton.title = "Save the chart as an SVG image";
    svgButton.addEventListener("click", () => this._exportSvg());
    exportRow.append(exportLabel, csvButton, svgButton);
    this._exportEl = exportRow;

    panel.append(header, actions, status, stats, chart, readout, exportRow);

    // Re-render the chart at the new pixel size whenever the panel is resized.
    if (typeof ResizeObserver !== "undefined") {
      this._chartResizeObserver = new ResizeObserver(() => this._scheduleChartRender());
      this._chartResizeObserver.observe(chart);
    }

    this._syncUnitButton();
    this._syncButtons();
    this._renderProfile();
    return panel;
  }

  // --- Rendering: stats, chart, readout ---------------------------------

  private _renderProfile(): void {
    this._renderStats();
    this._renderChart();
    this._syncExport();
  }

  private _scheduleChartRender(): void {
    if (this._chartRenderQueued) return;
    this._chartRenderQueued = true;
    requestAnimationFrame(() => {
      this._chartRenderQueued = false;
      this._renderChart();
    });
  }

  private _renderStats(): void {
    if (!this._statsEl) return;
    this._statsEl.textContent = "";
    if (!this._stats) {
      this._statsEl.classList.remove("has-data");
      return;
    }
    this._statsEl.classList.add("has-data");
    const system = this._state.unitSystem;
    const items: Array<[string, string]> = [
      ["Distance", formatDistance(this._stats.totalDistance, system)],
      ["Min", formatElevation(this._stats.min, system)],
      ["Max", formatElevation(this._stats.max, system)],
      ["Ascent ↑", formatElevation(this._stats.gain, system)],
      ["Descent ↓", formatElevation(this._stats.loss, system)],
    ];
    for (const [label, value] of items) {
      const cell = document.createElement("div");
      cell.className = "elevation-profile-stat";
      const valueEl = document.createElement("span");
      valueEl.className = "elevation-profile-stat-value";
      valueEl.textContent = value;
      const labelEl = document.createElement("span");
      labelEl.className = "elevation-profile-stat-label";
      labelEl.textContent = label;
      cell.append(valueEl, labelEl);
      this._statsEl.appendChild(cell);
    }
  }

  private _renderChart(): void {
    const host = this._chartEl;
    if (!host) return;
    this._svgEl = undefined;
    if (this._readoutEl) this._readoutEl.textContent = "";

    if (this._profilePoints.length < 2) {
      host.textContent = "";
      host.style.display = "none"; // hide so it does not reserve empty space
      return;
    }

    // Show the host before measuring so it has a layout width (it is hidden
    // when there is no profile). Size the chart to the host's current pixels so
    // it follows panel resizing crisply rather than letting the SVG stretch and
    // distort the axis text.
    host.style.display = "";
    host.textContent = "";
    const fallbackWidth = this._panel
      ? this._panel.clientWidth - 20
      : this._options.panelWidth - 24;
    const width = Math.max(160, Math.round(host.clientWidth) || fallbackWidth);
    const height = Math.max(120, Math.round(host.clientHeight) || CHART_HEIGHT);
    const geometry = buildChartGeometry(this._profilePoints, width, height);
    const system = this._state.unitSystem;

    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("class", "elevation-profile-svg");
    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    svg.setAttribute("width", "100%");
    svg.setAttribute("height", "100%");
    svg.setAttribute("preserveAspectRatio", "none");
    this._svgEl = svg;

    const area = document.createElementNS(SVG_NS, "path");
    area.setAttribute("class", "elevation-profile-area");
    area.setAttribute("d", geometry.areaPath);

    const line = document.createElementNS(SVG_NS, "path");
    line.setAttribute("class", "elevation-profile-line");
    line.setAttribute("d", geometry.linePath);

    // Min / max elevation axis labels.
    const maxLabel = this._axisLabel(
      formatElevation(geometry.maxElevation, system),
      geometry.padding.left - 4,
      geometry.yScale(geometry.maxElevation) + 3,
      "end",
    );
    const minLabel = this._axisLabel(
      formatElevation(geometry.minElevation, system),
      geometry.padding.left - 4,
      geometry.yScale(geometry.minElevation),
      "end",
    );

    // Hover marker group (hidden until pointer enters).
    const hoverGroup = document.createElementNS(SVG_NS, "g");
    hoverGroup.setAttribute("class", "elevation-profile-hover");
    hoverGroup.style.display = "none";
    const hoverLine = document.createElementNS(SVG_NS, "line");
    hoverLine.setAttribute("class", "elevation-profile-hover-line");
    hoverLine.setAttribute("y1", `${geometry.padding.top}`);
    hoverLine.setAttribute("y2", `${height - geometry.padding.bottom}`);
    const hoverDot = document.createElementNS(SVG_NS, "circle");
    hoverDot.setAttribute("class", "elevation-profile-hover-dot");
    hoverDot.setAttribute("r", "3.5");
    hoverGroup.append(hoverLine, hoverDot);

    svg.append(area, line, maxLabel, minLabel, hoverGroup);
    host.appendChild(svg);

    const onMove = (event: MouseEvent): void => {
      const rect = svg.getBoundingClientRect();
      const px = ((event.clientX - rect.left) / rect.width) * width;
      const index = geometry.indexForX(px);
      if (index < 0) return;
      const point = this._profilePoints[index];
      const x = geometry.xScale(point.distance);
      const y = geometry.yScale(point.elevation);
      hoverGroup.style.display = "";
      hoverLine.setAttribute("x1", `${x}`);
      hoverLine.setAttribute("x2", `${x}`);
      hoverDot.setAttribute("cx", `${x}`);
      hoverDot.setAttribute("cy", `${y}`);
      this._setHoverPoint(this._sampledCoords[index] ?? null);
      if (this._readoutEl) {
        this._readoutEl.textContent = `${formatDistance(point.distance, system)} · ${formatElevation(point.elevation, system)}`;
      }
    };
    const onLeave = (): void => {
      hoverGroup.style.display = "none";
      this._clearHover();
      if (this._readoutEl) this._readoutEl.textContent = "";
    };
    svg.addEventListener("mousemove", onMove);
    svg.addEventListener("mouseleave", onLeave);
  }

  private _axisLabel(
    text: string,
    x: number,
    y: number,
    anchor: "start" | "middle" | "end",
  ): SVGTextElement {
    const label = document.createElementNS(SVG_NS, "text");
    label.setAttribute("class", "elevation-profile-axis");
    label.setAttribute("x", `${x}`);
    label.setAttribute("y", `${y}`);
    label.setAttribute("text-anchor", anchor);
    label.textContent = text;
    return label;
  }

  private _clearHover(): void {
    this._setHoverPoint(null);
  }

  // --- Export ------------------------------------------------------------

  private _exportCsv(): void {
    if (this._profilePoints.length < 2) return;
    const csv = profileToCsv(this._profilePoints, this._sampledCoords);
    this._saveFile("elevation-profile.csv", csv, {
      description: "CSV",
      extensions: ["csv"],
      mimeType: "text/csv",
      // Prompt for a name on browsers without a native save picker so repeated
      // exports don't silently overwrite the fixed filename.
      promptName: true,
    });
  }

  private _exportSvg(): void {
    const svg = this._buildExportSvg();
    if (!svg) return;
    this._saveFile("elevation-profile.svg", svg, {
      description: "SVG image",
      extensions: ["svg"],
      mimeType: "image/svg+xml",
      promptName: true,
    });
  }

  /**
   * Serialize the rendered chart into a standalone SVG string with the
   * presentation styles inlined (external CSS does not travel with the file) and
   * a solid background. Returns null when there is no chart to export.
   */
  private _buildExportSvg(): string | null {
    const svg = this._svgEl;
    if (!svg || this._profilePoints.length < 2) return null;
    const viewBox = svg.getAttribute("viewBox")?.split(" ").map(Number);
    if (!viewBox || viewBox.length < 4) return null;
    const width = viewBox[2];
    const height = viewBox[3];

    const clone = svg.cloneNode(true) as SVGSVGElement;
    clone.setAttribute("xmlns", SVG_NS);
    clone.setAttribute("width", `${width}`);
    clone.setAttribute("height", `${height}`);
    clone.querySelector(".elevation-profile-hover")?.remove();

    const inline = (selector: string, props: string[]): void => {
      const live = svg.querySelectorAll(selector);
      const cloned = clone.querySelectorAll(selector);
      live.forEach((el, i) => {
        const target = cloned[i] as SVGElement | undefined;
        if (!target) return;
        const cs = getComputedStyle(el);
        for (const prop of props) {
          target.style.setProperty(prop, cs.getPropertyValue(prop));
        }
      });
    };
    inline(".elevation-profile-area", ["fill", "stroke"]);
    inline(".elevation-profile-line", ["fill", "stroke", "stroke-width"]);
    inline(".elevation-profile-axis", ["fill", "font-size", "font-family"]);

    const background = getComputedStyle(svg).backgroundColor;
    const rect = document.createElementNS(SVG_NS, "rect");
    rect.setAttribute("width", `${width}`);
    rect.setAttribute("height", `${height}`);
    rect.setAttribute(
      "fill",
      background && background !== "rgba(0, 0, 0, 0)" ? background : "#ffffff",
    );
    clone.insertBefore(rect, clone.firstChild);

    return `<?xml version="1.0" encoding="UTF-8"?>\n${new XMLSerializer().serializeToString(clone)}`;
  }

  /**
   * Save text content. Prefers the host's file save (a native dialog under Tauri,
   * a browser download on the web); falls back to a browser download when the
   * plugin runs standalone without a host.
   */
  private _saveFile(filename: string, content: string, options: ExportFileOptions): void {
    if (this._exportTextFile) {
      this._exportTextFile(filename, content, options);
      return;
    }
    const blob = new Blob([content], {
      type: options.mimeType ?? "text/plain;charset=utf-8",
    });
    this._downloadBlob(blob, filename);
  }

  private _downloadBlob(blob: Blob, filename: string): void {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  private _syncExport(): void {
    if (this._exportEl) {
      this._exportEl.style.display =
        this._stats && this._profilePoints.length >= 2 ? "flex" : "none";
    }
  }

  // --- UI sync helpers ---------------------------------------------------

  private _cycleUnits(): void {
    const current = UNIT_SYSTEMS.indexOf(this._state.unitSystem);
    const next = UNIT_SYSTEMS[(current + 1) % UNIT_SYSTEMS.length] as UnitSystem;
    this._state.unitSystem = next;
    this._syncUnitButton();
    this._renderProfile();
  }

  private _syncUnitButton(): void {
    if (this._unitButton) {
      this._unitButton.textContent = unitSystemLabel(this._state.unitSystem);
      this._unitButton.title = `Units: ${unitSystemLabel(this._state.unitSystem)}`;
    }
  }

  private _syncButtons(): void {
    if (this._drawButton) {
      this._drawButton.textContent = this._drawing ? "Finish" : "Draw line";
      this._drawButton.classList.toggle("is-active", this._drawing);
    }
    if (this._clearButton) {
      this._clearButton.disabled = !this._state.line && !this._drawing;
    }
  }

  private _setBusy(busy: boolean): void {
    if (this._drawButton) this._drawButton.disabled = busy;
  }

  private _setStatus(message: string): void {
    if (this._statusEl) this._statusEl.textContent = message;
  }

  // --- Panel positioning (floating dropdown) ----------------------------

  private _setupPanelListeners(): void {
    this._clickOutsideHandler = (e: MouseEvent) => {
      if (this._state.collapsed || this._drawing) return;
      const target = e.target as Node;
      if (
        this._container &&
        this._panel &&
        !this._container.contains(target) &&
        !this._panel.contains(target)
      ) {
        this.collapse();
      }
    };
    document.addEventListener("click", this._clickOutsideHandler);

    this._resizeHandler = () => {
      if (!this._state.collapsed) this._updatePanelPosition();
    };
    window.addEventListener("resize", this._resizeHandler);

    this._mapResizeHandler = () => {
      if (!this._state.collapsed) this._updatePanelPosition();
    };
    this._map?.on("resize", this._mapResizeHandler);
  }

  private _getControlPosition(): ControlPosition {
    const parent = this._container?.parentElement;
    if (!parent) return "top-right";
    if (parent.classList.contains("maplibregl-ctrl-top-left")) return "top-left";
    if (parent.classList.contains("maplibregl-ctrl-bottom-left")) return "bottom-left";
    if (parent.classList.contains("maplibregl-ctrl-bottom-right")) return "bottom-right";
    return "top-right";
  }

  /**
   * Anchor the panel to the same corner as the control button so the CSS resize
   * grip lands on the inward corner. Right docks are anchored by their right edge
   * and flagged `--anchor-right`, which flips the grip to the bottom-left (via
   * `direction: rtl`) so dragging grows the panel toward the map interior rather
   * than off the edge. Left docks keep the default bottom-right grip.
   */
  private _updatePanelPosition(): void {
    if (!this._container || !this._panel || !this._mapContainer) return;
    const button = this._container.querySelector(".elevation-profile-toggle");
    if (!button) return;

    const buttonRect = button.getBoundingClientRect();
    const mapRect = this._mapContainer.getBoundingClientRect();
    const position = this._getControlPosition();
    const gap = 5;

    const isRight = position === "top-right" || position === "bottom-right";
    const isBottom = position === "bottom-left" || position === "bottom-right";

    this._panel.style.top = "";
    this._panel.style.bottom = "";
    this._panel.style.left = "";
    this._panel.style.right = "";

    // Horizontal anchor on the button's matching edge.
    if (isRight) {
      this._panel.style.right = `${mapRect.right - buttonRect.right}px`;
    } else {
      this._panel.style.left = `${buttonRect.left - mapRect.left}px`;
    }

    // Vertical: top docks open below the button, bottom docks open above it.
    if (isBottom) {
      this._panel.style.bottom = `${mapRect.bottom - buttonRect.top + gap}px`;
    } else {
      this._panel.style.top = `${buttonRect.bottom - mapRect.top + gap}px`;
    }

    this._panel.classList.toggle("elevation-profile-panel--anchor-right", isRight);
  }
}
