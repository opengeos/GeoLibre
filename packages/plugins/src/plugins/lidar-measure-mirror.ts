/**
 * Draws the Measure tool's geometry above a LiDAR point cloud.
 *
 * `maplibre-gl-lidar` renders point clouds into its own *overlaid* deck.gl
 * canvas, which sits above MapLibre's. The Measure tool draws into MapLibre's
 * canvas, so wherever the cloud has points the measured line or polygon is
 * hidden (issue #2533 — #2532 fixed the same occlusion for the control panels
 * and the tool's DOM vertex handles, which are ordinary DOM). Two canvases
 * cannot interleave, and moving the point cloud *into* MapLibre's canvas does
 * not help either: MapLibre draws translucent 2D layers with a per-layer depth
 * range pinned near the far plane while deck writes the points' real depths,
 * so the line loses the depth test wherever there are points, whatever the
 * layer order.
 *
 * What does work is drawing the geometry into the point cloud's *own* deck
 * overlay with `depthTest: false` — exactly how the plugin's own cross-section
 * line manages to sit above the points. The MapLibre measure layers are left
 * alone: outside the cloud both copies draw the same geometry in the same
 * colour, and inside it the deck copy is the one that shows. If anything here
 * fails to find what it needs, the tool simply keeps its pre-#2533 behaviour.
 */

import type { Layer } from "@deck.gl/core";
import { GeoJsonLayer } from "@deck.gl/layers";
import type { MeasureControl, MeasureEvent } from "maplibre-gl-components";
import { measureSourceId } from "./terrain-measure";

/**
 * The slice of a map the mirror needs, so it works on either 2D engine (the
 * LiDAR panel runs on MapLibre and on Mapbox) without casting one library's
 * `Map` to the other's.
 */
export interface MeasureMirrorMap {
  getSource(id: string): unknown;
  on(event: "sourcedata" | "render", listener: (event: { sourceId?: string }) => void): unknown;
  off(event: "sourcedata" | "render", listener: (event: { sourceId?: string }) => void): unknown;
}

/** The slice of maplibre-gl-lidar's `DeckOverlay` the mirror draws into. */
export interface MeasureMirrorOverlay {
  hasLayer(id: string): boolean;
  addLayer(id: string, layer: Layer): void;
  removeLayer(id: string): void;
  getLayers(): Layer[];
}

/** Id of the mirrored deck.gl layer inside the LiDAR overlay. */
const MIRROR_LAYER_ID = "geolibre-measure-above-points";

/**
 * Measure paint, given to both renderers from one place so the mirror cannot
 * drift from the line it is covering: the string forms go to the upstream
 * control (MapLibre paint properties), the RGBA forms to deck.gl. The pairs
 * describe the same colours — `tests/lidar-measure-mirror.test.ts` asserts it.
 */
export const MEASURE_LINE_COLOR = "#3b82f6";
export const MEASURE_FILL_COLOR = "rgba(59, 130, 246, 0.2)";
export const MEASURE_LINE_WIDTH = 3;
export const MEASURE_LINE_RGBA: [number, number, number, number] = [59, 130, 246, 255];
export const MEASURE_FILL_RGBA: [number, number, number, number] = [59, 130, 246, 51];

/** Control events after which the measure source holds different geometry. */
const MEASURE_GEOMETRY_EVENTS: MeasureEvent[] = [
  "drawstart",
  "drawupdate",
  "drawend",
  "clear",
  "measurementadd",
  "measurementremove",
];

interface Attachment {
  map: MeasureMirrorMap;
  overlay: MeasureMirrorOverlay;
  control: MeasureControl;
  sourceId: string;
  /** The layer currently in the overlay, kept so it can be re-appended. */
  layer: Layer | null;
  /** Whether the unreadable-source warning has already been issued. */
  warnedShape: boolean;
  detach: () => void;
}

let attachment: Attachment | null = null;

/**
 * Point the mirror at the current Measure control and LiDAR deck overlay, or
 * tear it down when either is gone. Idempotent, so every call site that can
 * change one of the three inputs (a control mounting, unmounting, or being
 * rebuilt for another renderer) can just call this.
 *
 * @param deps The live map, the LiDAR control's deck overlay
 *   (`LidarControl.getDeckOverlay()`), and the Measure control.
 */
export function syncLidarMeasureMirror(deps: {
  map: MeasureMirrorMap | null | undefined;
  overlay: MeasureMirrorOverlay | null | undefined;
  control: MeasureControl | null | undefined;
}): void {
  const { map, overlay, control } = deps;

  if (
    attachment &&
    (attachment.map !== map || attachment.overlay !== overlay || attachment.control !== control)
  ) {
    attachment.detach();
    attachment = null;
  }
  if (!map || !overlay || !control) return;

  if (!attachment) {
    const sourceId = measureSourceId(control);
    if (!sourceId) return;
    attachment = attach(map, overlay, control, sourceId);
  }
  redraw(attachment);
}

function attach(
  map: MeasureMirrorMap,
  overlay: MeasureMirrorOverlay,
  control: MeasureControl,
  sourceId: string,
): Attachment {
  const self: Attachment = {
    map,
    overlay,
    control,
    sourceId,
    layer: null,
    warnedShape: false,
    detach: () => {},
  };
  const onGeometry = () => redraw(self);
  // The rubber-band segment that follows the cursor while drawing is pushed
  // straight into the source without a control event, so the source's own data
  // event is what keeps the mirror in step with it.
  const onSourceData = (event: { sourceId?: string }) => {
    if (event.sourceId === sourceId) redraw(self);
  };
  // Deck paints its layers in array order and the mirror runs with the depth
  // test off, so it only wins against the point-cloud layers that were added
  // before it — and streaming adds a chunk layer whenever the viewport pulls
  // in new nodes, which would leave the line buried again. Rather than
  // enumerate every path that can add one (chunks, a second cloud, the
  // plugin's cross-section), check on each frame that the mirror is still the
  // last layer and put it back on top when it is not. Both sides are cheap:
  // the check is one array read, and the re-append only runs when the order
  // actually broke.
  const onRender = () => keepOnTop(self);

  for (const event of MEASURE_GEOMETRY_EVENTS) control.on(event, onGeometry);
  map.on("sourcedata", onSourceData);
  map.on("render", onRender);

  self.detach = () => {
    for (const event of MEASURE_GEOMETRY_EVENTS) control.off(event, onGeometry);
    map.off("sourcedata", onSourceData);
    map.off("render", onRender);
    removeMirror(overlay);
    self.layer = null;
  };
  return self;
}

/** Re-append the mirror when something has been drawn on top of it. */
function keepOnTop(current: Attachment): void {
  const layer = current.layer;
  if (!layer) return;
  const layers = current.overlay.getLayers();
  if (layers[layers.length - 1]?.id === MIRROR_LAYER_ID) return;
  place(current, layer);
}

/**
 * Put `layer` at the end of the overlay's layer list. `addLayer` on an id the
 * overlay already holds would keep its old position (it writes to a `Map`), so
 * this drops it first.
 */
function place(current: Attachment, layer: Layer): void {
  try {
    removeMirror(current.overlay);
    current.overlay.addLayer(MIRROR_LAYER_ID, layer);
    current.layer = layer;
  } catch {
    // A destroyed overlay (LiDAR panel torn down between the event and here)
    // has nothing left to draw into.
    current.layer = null;
  }
}

function redraw(current: Attachment): void {
  const data = readMeasureGeometry(current);
  if (!data || data.features.length === 0) {
    removeMirror(current.overlay);
    current.layer = null;
    return;
  }
  place(current, measureMirrorLayer(data));
}

/** The deck.gl layer that redraws `data` above the points. */
export function measureMirrorLayer(data: GeoJSON.FeatureCollection): Layer {
  return new GeoJsonLayer({
    id: MIRROR_LAYER_ID,
    data,
    stroked: true,
    filled: true,
    pickable: false,
    getLineColor: MEASURE_LINE_RGBA,
    getFillColor: MEASURE_FILL_RGBA,
    getLineWidth: MEASURE_LINE_WIDTH,
    lineWidthUnits: "pixels",
    lineJointRounded: true,
    lineCapRounded: true,
    // The whole point of the mirror: ignore the point cloud's depth buffer so
    // the line is drawn over the points rather than losing to them.
    parameters: { depthTest: false },
  });
}

/** A `geojson` source as far as reading back what was last set on it goes. */
interface GeoJsonSourceInternals {
  /** mapbox-gl holds the value itself; maplibre-gl v6 wraps it. */
  _data?: GeoJSON.GeoJSON | string | { geojson?: GeoJSON.GeoJSON };
}

/**
 * The value behind either shape. `geojson` is optional on maplibre's wrapper,
 * so an `in` check cannot narrow the raw shape out of the union for the
 * compiler; the casts say what the runtime check has already established.
 */
function unwrapSourceData(
  held: GeoJsonSourceInternals["_data"],
): GeoJSON.GeoJSON | string | undefined {
  if (held && typeof held === "object" && "geojson" in held) {
    return (held as { geojson?: GeoJSON.GeoJSON }).geojson;
  }
  return held as GeoJSON.GeoJSON | string | undefined;
}

/**
 * The geometry the Measure control last pushed to its GeoJSON source.
 *
 * Neither library exposes a public reader for a `geojson` source's data, so
 * this reads the `_data` field both declare — and they declare it
 * *differently*: mapbox-gl stores the value handed to `setData` directly,
 * maplibre-gl v6 stores `{ geojson }`. Reading only one shape would leave the
 * mirror silently dead on the other engine, which is indistinguishable from
 * "nothing has been measured yet", so both are accepted and anything else
 * warns (once per attachment) the way `measureSourceId` does for its own
 * private field.
 */
function readMeasureGeometry(current: Attachment): GeoJSON.FeatureCollection | null {
  const source = current.map.getSource(current.sourceId) as GeoJsonSourceInternals | undefined;
  // Before the control's own `_setupMapSources` has run there is no source to
  // read, which is ordinary rather than a broken assumption.
  if (!source) return null;

  const data = unwrapSourceData(source._data);
  if (data && typeof data === "object" && data.type === "FeatureCollection") return data;

  if (!current.warnedShape) {
    current.warnedShape = true;
    console.warn(
      "MeasureControl: could not read its geojson source; measured geometry " +
        "will stay hidden inside LiDAR point clouds. Check the map library's " +
        "GeoJSONSource._data shape.",
    );
  }
  return null;
}

function removeMirror(overlay: MeasureMirrorOverlay): void {
  try {
    if (overlay.hasLayer(MIRROR_LAYER_ID)) overlay.removeLayer(MIRROR_LAYER_ID);
  } catch {
    // See redraw(): the overlay may already be destroyed.
  }
}
