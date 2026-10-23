import * as maplibregl from "maplibre-gl";

/**
 * The subset of MapLibre's `Marker` the Elements panel drives: pins, sticky
 * notes and image cards are DOM elements pinned to a coordinate.
 */
export interface AnnotationMarker {
  setLngLat(lngLat: [number, number]): AnnotationMarker;
  getElement(): HTMLElement;
  remove(): void;
}

export interface AnnotationMarkerOptions {
  element: HTMLElement;
  /** Where the element sits relative to the coordinate. Defaults to `center`. */
  anchor?: "bottom" | "center";
}

/**
 * Pin a DOM element to a coordinate on whichever 2D engine draws the map.
 *
 * On a MapLibre map this is MapLibre's own `Marker`. A MapLibre `Marker` cannot
 * be added to a mapbox-gl map: its `_update` reads `map._camera.transform`
 * (terrain occlusion, world-copy wrapping), which mapbox-gl does not have, so
 * `addTo` throws. Any other map gets a plain element in the canvas container
 * repositioned through `project()` on every camera move — the same placement
 * the two libraries' markers compute, without the engine-specific extras
 * (terrain occlusion, dragging) the Elements panel does not use.
 *
 * @param map - The primary map, MapLibre's or the Mapbox map through
 *   MapLibre's types (see `getStyleMap`).
 * @param options - The element to pin and its anchor.
 * @returns A marker; call `setLngLat` to place it and `remove` to tear it down.
 */
export function createAnnotationMarker(
  map: maplibregl.Map,
  options: AnnotationMarkerOptions,
): AnnotationMarker {
  if (map instanceof maplibregl.Map) {
    const marker = new maplibregl.Marker({ element: options.element, anchor: options.anchor });
    // MapLibre's marker projects its coordinate the moment it is added, so it
    // joins the map on the first `setLngLat`, never before.
    let added = false;
    const wrapper: AnnotationMarker = {
      setLngLat(lngLat) {
        marker.setLngLat(lngLat);
        if (!added) {
          marker.addTo(map);
          added = true;
        }
        return wrapper;
      },
      getElement: () => marker.getElement(),
      remove: () => marker.remove(),
    };
    return wrapper;
  }
  return new ProjectedMarker(map, options);
}

/** A DOM marker positioned by `project()`, for maps that are not MapLibre's. */
class ProjectedMarker implements AnnotationMarker {
  private lngLat: [number, number] | null = null;
  private readonly element: HTMLElement;
  private readonly anchor: "bottom" | "center";
  private removed = false;

  constructor(
    private readonly map: maplibregl.Map,
    options: AnnotationMarkerOptions,
  ) {
    this.element = options.element;
    this.anchor = options.anchor ?? "center";
    // Both libraries' marker stylesheets give these classes the absolute
    // placement and `will-change: transform`; set the essentials inline too so
    // the element is placed even where neither stylesheet is loaded.
    this.element.classList.add("maplibregl-marker", "mapboxgl-marker");
    this.element.style.position = "absolute";
    this.element.style.top = "0";
    this.element.style.left = "0";
    this.element.style.willChange = "transform";
    map.getCanvasContainer().appendChild(this.element);
    map.on("move", this.update);
    map.on("moveend", this.update);
    map.on("resize", this.update);
  }

  setLngLat(lngLat: [number, number]): AnnotationMarker {
    this.lngLat = lngLat;
    this.update();
    return this;
  }

  getElement(): HTMLElement {
    return this.element;
  }

  remove(): void {
    if (this.removed) return;
    this.removed = true;
    this.map.off("move", this.update);
    this.map.off("moveend", this.update);
    this.map.off("resize", this.update);
    this.element.remove();
  }

  private readonly update = (): void => {
    if (this.removed || !this.lngLat) return;
    const point = this.map.project(this.lngLat);
    const offset = this.anchor === "bottom" ? "translate(-50%, -100%)" : "translate(-50%, -50%)";
    this.element.style.transform = `${offset} translate(${point.x}px, ${point.y}px)`;
  };
}
