import { registerEqualEarthCapture } from "./map-capture";
import { geoGraticule10, geoPath } from "d3-geo";
import type { FeatureCollection, Geometry } from "geojson";
import type { Map as MapLibreMap } from "maplibre-gl";
import {
  compileFeatureExpression,
  compileLayerFilters,
  ruleBasedVisibilityFilter,
  vectorColorExpression,
  type GeoLibreLayer,
} from "@geolibre/core";
import { EQUAL_EARTH_MAX_ZOOM, overviewProjection, sphericalGeoJSON } from "./equal-earth-geometry";
import countries from "./data/equal-earth-countries.json";

export interface EqualEarthLabels {
  hint: string;
  omitted: string;
  detail: string;
}
export const DEFAULT_EQUAL_EARTH_LABELS: EqualEarthLabels = {
  hint: "Equal Earth overview · Pan or zoom to explore. Editing and detailed styles are available at zoom 3.",
  omitted: "Some layers are only available in the detailed map.",
  detail: "Open detailed map",
};
const world = sphericalGeoJSON(countries as FeatureCollection);
const normalized = new WeakMap<FeatureCollection, FeatureCollection>();

/** An isolated overview: MapLibre and every plugin retain geographic source data. */
export class EqualEarthOverview {
  private root = document.createElement("div");
  private canvas = document.createElement("canvas");
  private notice = document.createElement("div");
  private hint = document.createElement("span");
  private omitted = document.createElement("span");
  private detail = document.createElement("button");
  private frame = 0;
  private generation = 0;
  private layers: { layer: GeoLibreLayer; data: FeatureCollection }[] = [];
  private missing = false;
  private basemapVisible = true;
  private basemapOpacity = 1;
  private labels = DEFAULT_EQUAL_EARTH_LABELS;
  private observer: MutationObserver;
  private drag: { id: number; x: number; y: number } | null = null;

  constructor(private map: MapLibreMap) {
    this.root.className = "geolibre-equal-earth-overview";
    this.root.dataset.testid = "equal-earth-overview";
    Object.assign(this.root.style, {
      position: "absolute",
      inset: "0",
      zIndex: "1",
      touchAction: "none",
    });
    Object.assign(this.canvas.style, {
      width: "100%",
      height: "100%",
      display: "block",
      cursor: "grab",
    });
    this.canvas.tabIndex = 0;
    this.canvas.setAttribute("role", "img");
    this.canvas.setAttribute("aria-label", "Equal Earth");
    Object.assign(this.notice.style, {
      position: "absolute",
      bottom: "36px",
      insetInlineStart: "12px",
      maxWidth: "min(480px, calc(100% - 70px))",
      padding: "8px 12px",
      borderRadius: "6px",
      font: "12px/1.5 sans-serif",
      boxShadow: "0 1px 5px #0004",
    });
    this.detail.type = "button";
    Object.assign(this.detail.style, {
      display: "block",
      textDecoration: "underline",
      cursor: "pointer",
    });
    this.detail.onclick = () =>
      this.map.setZoom(Math.min(this.map.getMaxZoom(), EQUAL_EARTH_MAX_ZOOM));
    this.notice.append(this.hint, document.createElement("br"), this.omitted, this.detail);
    const credit = document.createElement("a");
    credit.href = "https://www.naturalearthdata.com/";
    credit.target = "_blank";
    credit.rel = "noopener noreferrer";
    credit.textContent = "Natural Earth";
    Object.assign(credit.style, {
      position: "absolute",
      bottom: "4px",
      insetInlineStart: "12px",
      font: "11px sans-serif",
      background: "#fff",
      color: "#222",
      padding: "2px 4px",
    });
    this.root.append(this.canvas, this.notice, credit);
    // Do not deliver overview pixels to MapLibre's Mercator picking/drawing tools.
    for (const name of [
      "mousedown",
      "mouseup",
      "mousemove",
      "click",
      "dblclick",
      "contextmenu",
      "touchstart",
      "touchmove",
      "touchend",
    ]) {
      this.root.addEventListener(name, (event) => event.stopPropagation());
    }
    this.canvas.oncontextmenu = (event) => event.preventDefault();
    this.canvas.addEventListener(
      "wheel",
      (event) => {
        event.preventDefault();
        event.stopPropagation();
        const delta =
          event.deltaY *
          (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? this.canvas.clientHeight : 1);
        this.map.setZoom(
          Math.max(
            this.map.getMinZoom(),
            Math.min(
              this.map.getMaxZoom(),
              this.map.getZoom() - Math.max(-0.5, Math.min(0.5, delta / 300)),
            ),
          ),
        );
      },
      { passive: false },
    );
    this.canvas.onpointerdown = (event) => {
      if (event.button !== 0) return;
      this.canvas.focus();
      this.canvas.setPointerCapture(event.pointerId);
      this.drag = { id: event.pointerId, x: event.clientX, y: event.clientY };
    };
    this.canvas.onpointermove = (event) => {
      if (!this.drag || this.drag.id !== event.pointerId) return;
      this.pan(event.clientX - this.drag.x, event.clientY - this.drag.y);
      this.drag = { id: event.pointerId, x: event.clientX, y: event.clientY };
    };
    this.canvas.onpointerup = this.canvas.onpointercancel = () => {
      this.drag = null;
    };
    this.canvas.ondblclick = (event) => {
      const bounds = this.canvas.getBoundingClientRect();
      const center = this.projection().invert?.([
        event.clientX - bounds.left,
        event.clientY - bounds.top,
      ]);
      if (center && center.every(Number.isFinite))
        this.map.jumpTo({ center, zoom: Math.min(this.map.getMaxZoom(), this.map.getZoom() + 1) });
    };
    this.canvas.onkeydown = (event) => {
      event.stopPropagation();
      const offset: Record<string, [number, number]> = {
        ArrowLeft: [60, 0],
        ArrowRight: [-60, 0],
        ArrowUp: [0, 60],
        ArrowDown: [0, -60],
      };
      if (offset[event.key]) {
        event.preventDefault();
        this.pan(...offset[event.key]);
      }
      if (["+", "=", "-"].includes(event.key)) {
        event.preventDefault();
        this.map.setZoom(
          Math.max(
            this.map.getMinZoom(),
            Math.min(this.map.getMaxZoom(), this.map.getZoom() + (event.key === "-" ? -0.5 : 0.5)),
          ),
        );
      }
    };
    this.map.getContainer().append(this.root);
    registerEqualEarthCapture(this.map.getContainer(), {
      redraw: () => this.draw(),
      unproject: (point) => {
        const coordinate = this.projection().invert?.(point);
        if (!coordinate || !coordinate.every(Number.isFinite))
          throw new Error("Position is outside the Equal Earth map");
        return { lng: coordinate[0], lat: coordinate[1] };
      },
    });
    this.map.on("move", this.schedule);
    this.map.on("resize", this.schedule);
    this.observer = new MutationObserver(this.schedule);
    this.observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });
    this.schedule();
  }

  setLabels(labels: EqualEarthLabels): void {
    this.labels = labels;
    this.schedule();
  }

  async setLayers(
    layers: GeoLibreLayer[],
    read: (id: string) => Promise<FeatureCollection | null>,
  ): Promise<void> {
    const generation = ++this.generation;
    const entries = await Promise.all(
      layers
        .filter((l) => l.visible)
        .map(async (layer) => {
          const data = layer.geojson ?? (await read(layer.id).catch(() => null));
          if (!data) return null;
          let spherical = normalized.get(data);
          if (!spherical) {
            spherical = sphericalGeoJSON(data);
            normalized.set(data, spherical);
          }
          return { layer, data: spherical };
        }),
    );
    if (generation !== this.generation) return;
    this.layers = entries.filter((entry): entry is NonNullable<typeof entry> => entry !== null);
    this.missing = entries.some((entry) => entry === null);
    this.schedule();
  }

  setBasemap(visible: boolean, opacity: number): void {
    this.basemapVisible = visible;
    this.basemapOpacity = opacity;
    this.schedule();
  }

  destroy(): void {
    ++this.generation;
    cancelAnimationFrame(this.frame);
    this.observer.disconnect();
    this.map.off("move", this.schedule);
    this.map.off("resize", this.schedule);
    this.map.getContainer().classList.remove("geolibre-equal-earth-active");
    registerEqualEarthCapture(this.map.getContainer(), null);
    this.root.remove();
  }

  private projection() {
    const c = this.map.getCenter();
    return overviewProjection(this.root.clientWidth, this.root.clientHeight, this.map.getZoom(), [
      c.wrap().lng,
      c.lat,
    ]);
  }

  private pan(dx: number, dy: number) {
    const center = this.projection().invert?.([
      this.root.clientWidth / 2 - dx,
      this.root.clientHeight / 2 - dy,
    ]);
    if (
      center &&
      center.every(Number.isFinite) &&
      Math.abs(center[0]) <= 180 &&
      Math.abs(center[1]) <= 85
    )
      this.map.setCenter(center);
  }

  private schedule = () => {
    if (!this.frame)
      this.frame = requestAnimationFrame(() => {
        this.frame = 0;
        this.draw();
      });
  };

  private draw() {
    const active = this.map.getZoom() < EQUAL_EARTH_MAX_ZOOM;
    this.root.hidden = !active;
    this.map.getContainer().classList.toggle("geolibre-equal-earth-active", active);
    if (!active) return;
    const width = this.root.clientWidth,
      height = this.root.clientHeight;
    const ratio = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(width * ratio);
    this.canvas.height = Math.round(height * ratio);
    const ctx = this.canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(ratio, ratio);
    const dark = document.documentElement.classList.contains("dark");
    ctx.fillStyle = dark ? "#101923" : "#eef2f5";
    ctx.fillRect(0, 0, width, height);
    this.notice.style.background = dark ? "#202c39" : "#fff";
    this.notice.style.color = dark ? "#e2e8f0" : "#263442";
    this.hint.textContent = this.labels.hint;
    this.omitted.textContent = this.missing ? this.labels.omitted : "";
    this.detail.textContent = this.labels.detail;
    this.detail.disabled = this.map.getMaxZoom() < EQUAL_EARTH_MAX_ZOOM;
    const path = geoPath(this.projection(), ctx);
    ctx.beginPath();
    path({ type: "Sphere" });
    ctx.fillStyle = dark ? "#172e42" : "#dceef6";
    ctx.fill();
    ctx.save();
    ctx.clip();
    if (this.basemapVisible) {
      ctx.globalAlpha = this.basemapOpacity;
      ctx.beginPath();
      path(world);
      ctx.fillStyle = dark ? "#384b51" : "#f4f0e5";
      ctx.fill();
      ctx.strokeStyle = dark ? "#8a9c9e" : "#84969a";
      ctx.lineWidth = 0.5;
      ctx.stroke();
      ctx.beginPath();
      path(geoGraticule10());
      ctx.strokeStyle = dark ? "#69899e" : "#789baa";
      ctx.globalAlpha *= 0.3;
      ctx.stroke();
    }
    for (const { layer, data } of this.layers) {
      const zoom = this.map.getZoom();
      if (zoom < layer.style.minZoom || zoom >= layer.style.maxZoom) continue;
      const filters = [
        compileLayerFilters(layer),
        layer.timeFilter,
        layer.embedFilter,
        ruleBasedVisibilityFilter(layer.style),
      ].filter(Boolean);
      const filter = filters.length
        ? compileFeatureExpression(JSON.stringify(["all", ...filters]), {
            zoom,
            expectedType: "boolean",
          })
        : null;
      const color = vectorColorExpression(layer.style, layer.style.fillColor);
      const expression = Array.isArray(color)
        ? compileFeatureExpression(JSON.stringify(color), { zoom, expectedType: "color" })
        : null;
      path.pointRadius(layer.style.circleRadius);
      for (const feature of data.features) {
        try {
          if (filter && (!filter.ok || !filter.evaluate?.(feature))) continue;

          const value = expression?.ok ? expression.evaluate?.(feature) : color;
          ctx.fillStyle =
            typeof value === "string" ? value : (value?.toString() ?? layer.style.fillColor);
          const fill = ctx.fillStyle;
          const drawGeometry = (geometry: Geometry | null): void => {
            if (!geometry) return;
            if (geometry.type === "GeometryCollection") {
              geometry.geometries.forEach(drawGeometry);
              return;
            }
            const line = geometry.type.includes("Line");
            ctx.beginPath();
            path(geometry);
            ctx.globalAlpha = layer.opacity * layer.style.fillOpacity;
            if (!line) ctx.fill("evenodd");
            ctx.globalAlpha = layer.opacity;
            ctx.strokeStyle = line ? fill : layer.style.strokeColor;
            if (layer.style.strokeWidth > 0) {
              ctx.lineWidth = layer.style.strokeWidth;
              ctx.stroke();
            }
          };
          drawGeometry(feature.geometry);
        } catch {
          /* A malformed feature must not prevent the rest of the overview. */
        }
      }
    }
    ctx.restore();
  }
}
