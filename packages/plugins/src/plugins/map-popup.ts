import * as maplibregl from "maplibre-gl";

/**
 * The subset of MapLibre's `Popup` the plugins drive: a box of text or DOM
 * pinned to a coordinate, with an optional close button.
 */
export interface MapPopup {
  setLngLat(lngLat: [number, number] | { lng: number; lat: number }): MapPopup;
  setText(text: string): MapPopup;
  setDOMContent(content: Node): MapPopup;
  addTo(map: maplibregl.Map): MapPopup;
  isOpen(): boolean;
  remove(): MapPopup;
}

export interface MapPopupOptions {
  /** Show an "×" button that closes the popup. Defaults to `false`. */
  closeButton?: boolean;
  /**
   * Accessible name of the close button. The plugins cannot call `t()`, so a
   * caller passes its translated label; defaults to MapLibre's English one.
   */
  closeButtonLabel?: string;
  /** Extra class names for the popup root. */
  className?: string;
  /** Pixels between the coordinate and the popup's tip. Defaults to 0. */
  offset?: number;
}

/**
 * A popup on whichever engine hosts the map a plugin was handed.
 *
 * On a MapLibre map this is MapLibre's own `Popup`. Any other map — the Mapbox
 * map through MapLibre's types, or the ArcGIS and Cesium control maps — cannot
 * take one: `Popup` reads the map's transform (`map._camera.transform` for
 * terrain occlusion and world copies), which none of them has, so `addTo`
 * throws or the popup never moves. Those get {@link ProjectedPopup}, the same
 * markup placed through `project()` on every frame, as `createAnnotationMarker`
 * does for markers.
 *
 * Popups always open above the coordinate and stay open on map clicks, which
 * is how every caller configures MapLibre's popup today.
 *
 * @param map - The map the popup will be added to, read only to pick the kind.
 * @param options - Close button, class names and tip offset.
 * @returns A popup; call `setLngLat`, set its content and `addTo` the map.
 */
export function createMapPopup(map: maplibregl.Map, options: MapPopupOptions = {}): MapPopup {
  if (map instanceof maplibregl.Map) {
    const popup = new maplibregl.Popup({
      closeButton: options.closeButton ?? false,
      closeOnClick: false,
      className: options.className,
      offset: options.offset,
    });
    const label = options.closeButtonLabel;
    // MapLibre names the button from the map's locale; the caller's label wins.
    if (label)
      popup.on("open", () =>
        popup
          .getElement()
          ?.querySelector(".maplibregl-popup-close-button")
          ?.setAttribute("aria-label", label),
      );
    return popup;
  }
  return new ProjectedPopup(options);
}

const POPUP_CLASSES = ["popup", "popup-anchor-bottom"] as const;

/** The camera and frame events the popup follows (MapLibre fires `render` per frame). */
const FOLLOW_EVENTS = ["move", "moveend", "resize", "render"] as const;

/** Class names in both libraries' spellings, so either stylesheet styles it. */
function classes(...names: string[]): string[] {
  return names.flatMap((name) => [`maplibregl-${name}`, `mapboxgl-${name}`]);
}

/** A popup for maps that are not MapLibre's, positioned by `project()`. */
class ProjectedPopup implements MapPopup {
  private readonly root: HTMLElement;
  private readonly content: HTMLElement;
  private readonly body: HTMLElement;
  private readonly offset: number;
  private lngLat: [number, number] | null = null;
  private map: maplibregl.Map | null = null;

  constructor(options: MapPopupOptions) {
    this.offset = options.offset ?? 0;
    const doc = globalThis.document;
    this.root = doc.createElement("div");
    this.root.classList.add(...classes(...POPUP_CLASSES));
    if (options.className)
      this.root.classList.add(...options.className.split(/\s+/).filter(Boolean));
    // The stylesheets give `.maplibregl-popup` this placement; set it inline
    // too so the popup is placed even where neither stylesheet is loaded.
    // MapLibre's popup sets the same 240px cap inline, and takes its font
    // from the `.maplibregl-map` container, which the ArcGIS and Cesium
    // canvases do not sit in.
    Object.assign(this.root.style, {
      position: "absolute",
      top: "0",
      left: "0",
      willChange: "transform",
      pointerEvents: "none",
      maxWidth: "240px",
      font: "12px/20px 'Helvetica Neue', Arial, Helvetica, sans-serif",
    });
    const tip = doc.createElement("div");
    tip.classList.add(...classes("popup-tip"));
    this.content = doc.createElement("div");
    this.content.classList.add(...classes("popup-content"));
    this.content.style.pointerEvents = "auto";
    this.body = doc.createElement("div");
    this.content.appendChild(this.body);
    if (options.closeButton) {
      const close = doc.createElement("button");
      close.type = "button";
      close.classList.add(...classes("popup-close-button"));
      close.setAttribute("aria-label", options.closeButtonLabel ?? "Close popup");
      close.textContent = "×";
      close.addEventListener("click", () => this.remove());
      this.content.appendChild(close);
    }
    this.root.append(tip, this.content);
  }

  setLngLat(lngLat: [number, number] | { lng: number; lat: number }): MapPopup {
    this.lngLat = Array.isArray(lngLat) ? [lngLat[0], lngLat[1]] : [lngLat.lng, lngLat.lat];
    this.update();
    return this;
  }

  setText(text: string): MapPopup {
    this.body.replaceChildren(globalThis.document.createTextNode(text));
    this.update();
    return this;
  }

  setDOMContent(content: Node): MapPopup {
    this.body.replaceChildren(content);
    this.update();
    return this;
  }

  addTo(map: maplibregl.Map): MapPopup {
    if (this.map === map) return this;
    this.remove();
    this.map = map;
    map.getCanvasContainer().appendChild(this.root);
    for (const type of FOLLOW_EVENTS) map.on(type, this.update);
    this.update();
    return this;
  }

  isOpen(): boolean {
    return this.map !== null;
  }

  remove(): MapPopup {
    const map = this.map;
    if (!map) return this;
    this.map = null;
    for (const type of FOLLOW_EVENTS) map.off(type, this.update);
    this.root.remove();
    return this;
  }

  private readonly update = (): void => {
    const map = this.map;
    if (!map || !this.lngLat) return;
    const point = map.project(this.lngLat);
    const container = map.getCanvasContainer();
    const width = container.clientWidth;
    const height = container.clientHeight;
    // Off the canvas (or a point the engine cannot place, which the globe
    // answers far off screen): hide rather than float at the edge.
    const visible =
      Number.isFinite(point.x) &&
      Number.isFinite(point.y) &&
      (!width || (point.x >= 0 && point.x <= width)) &&
      (!height || (point.y >= 0 && point.y <= height));
    this.root.style.display = visible ? "" : "none";
    if (!visible) return;
    this.root.style.transform = `translate(-50%, -100%) translate(${point.x}px, ${point.y - this.offset}px)`;
  };
}
