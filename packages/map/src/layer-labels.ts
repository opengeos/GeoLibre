import type { GeoLibreLayer } from "@geolibre/core";

/**
 * The window key both 2D engines publish friendly layer names on.
 *
 * Some upstream controls list **style** layers — the Layer Swipe panel drives
 * its two sides by style layer id — and a style layer id is not something to
 * show a user: a GeoJSON layer named "Counties" compiles to
 * `layer-<uuid>-fill` on MapLibre and `geolibre-mapbox-<uuid>-geojson-fill` on
 * Mapbox. The app rewrites those rows from this map
 * (`apps/geolibre-desktop/src/lib/swipe-style.ts`), so what the panel shows
 * matches the Layers panel.
 *
 * A window global rather than an option because the control has no hook for it
 * and the rewrite happens in the DOM, outside the engine that knows the names.
 */
export interface GeoLibreLayerLabelWindow extends Window {
  __GEOLIBRE_LAYER_LABELS__?: Record<string, string>;
}

/** The synthetic row the swipe panel groups every basemap layer under. */
export const BASEMAP_LABEL_KEY = "__basemap__";

/**
 * What each style layer a store layer compiles to is called, by the suffix its
 * id ends in.
 *
 * Shared by both engines so a layer reads the same whichever is drawing it,
 * even though they name the style layers themselves differently. Geometry
 * words rather than Style Spec ones — a user knows "Polygons", not "fill".
 */
const SUFFIX_LABELS: Record<string, string> = {
  extrusion: "Extrusions",
  fill: "Polygons",
  line: "Lines",
  circle: "Points",
  labels: "Labels",
  heatmap: "Heatmap",
  clusters: "Clusters",
  markers: "Markers",
  text: "Text",
};

/**
 * The display name for one style layer of a store layer.
 *
 * @param layer - The store layer it belongs to.
 * @param suffix - The style layer id's trailing kind (`fill`, `line`, …), or
 *   nothing when the layer draws through a single style layer.
 * @param siblings - How many style layers this store layer currently draws
 *   through. One needs no qualifier: "Counties", not "Counties Polygons".
 */
export function styleLayerLabel(
  layer: Pick<GeoLibreLayer, "name">,
  suffix: string | undefined,
  siblings: number,
): string {
  if (siblings <= 1 || !suffix) return layer.name;
  const qualifier = SUFFIX_LABELS[suffix];
  // An unmapped suffix is still better shown than dropped: a vector-tile source
  // layer's own name lands here, and it is what distinguishes the rows.
  return `${layer.name} ${qualifier ?? suffix}`;
}

/**
 * Publish the style-layer-id to display-name map, replacing whatever was there.
 *
 * @param entries - Every pair to publish, including the basemap row.
 */
export function publishLayerLabels(entries: Iterable<readonly [string, string]>): void {
  if (typeof window === "undefined") return;
  (window as GeoLibreLayerLabelWindow).__GEOLIBRE_LAYER_LABELS__ = Object.fromEntries(entries);
  try {
    window.dispatchEvent(new CustomEvent("geolibre-layer-labels-change"));
  } catch {
    // The names are on the window either way, and the app re-reads them on its
    // own panel mutations. A DOM that cannot dispatch — the headless one the
    // engine tests run against — must not take a layer sync down with it.
  }
}

/** Drop every published name, so a torn-down engine leaves no stale labels. */
export function clearLayerLabels(): void {
  publishLayerLabels([]);
}
