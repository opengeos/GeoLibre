import type { Evented } from "maplibre-gl";
import type { IdentifiedFeature } from "./map-engine";

/**
 * Store features under a point that a plugin's native layer draws: the hits on
 * the store layer that mirrors `nativeLayerId` (by `nativeLayerIds`), or that
 * reads `sourceId`. On the ArcGIS renderer the store layer is what is drawn, so
 * a hit on it is a hit on the plugin's layer.
 */
export type NativeLayerPicker = (
  lngLat: [number, number],
  nativeLayerId: string,
  sourceId: string | undefined,
) => IdentifiedFeature[];

/** The `MapGeoJSONFeature` fields plugins read off a MapLibre pick. */
export interface PickedFeature {
  type: "Feature";
  id: string | number | undefined;
  properties: Record<string, unknown>;
  geometry: IdentifiedFeature["geometry"];
  layer: { id: string; source: string | undefined };
  source: string | undefined;
  state: Record<string, never>;
}

interface PointerEvent {
  point: { x: number; y: number };
  lngLat: { lng: number; lat: number };
  originalEvent?: unknown;
}

type Listener = (event: Record<string, unknown>) => void;

interface Registration {
  type: string;
  layerIds: string[];
  listener: Listener;
  /** The caller's own listener, which `off` names; differs from `listener` for a `once`. */
  original: Listener;
  inside: boolean;
}

interface LayerEventHost {
  facade: Evented & Record<string, unknown>;
  pick: NativeLayerPicker;
  /** The source a shadow-style layer reads, for mirrors keyed by source. */
  layerSource: (layerId: string) => string | undefined;
  /** Every shadow-style layer id, for a query that names no layers. */
  layerIds: () => string[];
  unproject: (point: { x: number; y: number }) => [number, number] | null;
}

type PointerSource = "click" | "mousemove" | "mousedown" | "mouseup";

/**
 * Which facade event feeds each layer-scoped event. Types the facade never
 * fires (`dblclick`, `contextmenu`, touch events) are accepted but never fire.
 */
const POINTER_SOURCE: Record<string, PointerSource> = {
  click: "click",
  mousedown: "mousedown",
  mouseup: "mouseup",
  mousemove: "mousemove",
  mouseenter: "mousemove",
  mouseleave: "mousemove",
  mouseover: "mousemove",
  mouseout: "mousemove",
};

/**
 * Give an ArcGIS control facade MapLibre's layer-scoped events and point
 * `queryRenderedFeatures`, answered from the store layers that mirror the
 * control's native layers.
 *
 * Without this, `map.on("click", "footprints", fn)` lands on `Evented.on`,
 * which takes the layer id for the listener, and a click then throws; and a
 * `queryRenderedFeatures` call is not a function. With it, a catalog plugin's
 * footprint click and hover work on ArcGIS as long as the footprints reach the
 * store (`registerExternalNativeLayer`), which is what ArcGIS draws. A box
 * query or one with no geometry answers empty: the engine picks by point only.
 */
export function installArcgisLayerEvents(host: LayerEventHost): void {
  const { facade } = host;
  const registrations: Registration[] = [];
  const baseOn = facade.on.bind(facade);
  const baseOff = facade.off.bind(facade);
  const baseOnce = facade.once.bind(facade);

  const pickAt = (lngLat: [number, number], layerIds: string[]): PickedFeature[] => {
    const features: PickedFeature[] = [];
    // A fill and its outline mirror the same store layer: report each store
    // feature once, under the first layer asked for, as MapLibre reports the
    // topmost rendered layer.
    const seen = new Set<string>();
    for (const layerId of layerIds) {
      const source = host.layerSource(layerId);
      for (const hit of host.pick(lngLat, layerId, source)) {
        const key = `${hit.layerId}\u0000${hit.featureId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const numeric = hit.featureId !== null && /^-?\d+$/.test(hit.featureId);
        features.push({
          type: "Feature",
          id: hit.featureId === null ? undefined : numeric ? Number(hit.featureId) : hit.featureId,
          properties: hit.properties,
          geometry: hit.geometry,
          layer: { id: layerId, source },
          source,
          state: {},
        });
      }
    }
    return features;
  };

  const dispatch = (sourceType: PointerSource) => (event: PointerEvent) => {
    const active = registrations.filter((entry) => POINTER_SOURCE[entry.type] === sourceType);
    if (!active.length) return;
    const lngLat: [number, number] = [event.lngLat.lng, event.lngLat.lat];
    for (const entry of active) {
      const features = pickAt(lngLat, entry.layerIds);
      const hit = features.length > 0;
      const payload = { ...event, target: facade, features };
      if (entry.type === sourceType) {
        if (hit) entry.listener({ ...payload, type: entry.type });
      } else if (entry.type === "mouseenter" || entry.type === "mouseover") {
        if (hit && !entry.inside) entry.listener({ ...payload, type: entry.type });
      } else if (!hit && entry.inside) {
        entry.listener({ ...event, target: facade, type: entry.type });
      }
      entry.inside = hit;
    }
  };
  for (const type of ["click", "mousemove", "mousedown", "mouseup"] as const)
    baseOn(type, dispatch(type) as never);

  const layerIdsOf = (value: unknown): string[] | null =>
    typeof value === "string" ? [value] : Array.isArray(value) ? value.map(String) : null;

  const register = (entry: Registration) => {
    registrations.push(entry);
    // MapLibre 6's `on` returns a Subscription.
    return {
      unsubscribe: () => {
        const index = registrations.indexOf(entry);
        if (index >= 0) registrations.splice(index, 1);
      },
    };
  };
  const on = (type: string, layerOrListener: unknown, maybeListener?: Listener) => {
    const layerIds = layerIdsOf(layerOrListener);
    if (!layerIds) return baseOn(type, layerOrListener as never);
    if (typeof maybeListener !== "function") return { unsubscribe: () => {} };
    return register({
      type,
      layerIds,
      listener: maybeListener,
      original: maybeListener,
      inside: false,
    });
  };
  const off = (type: string, layerOrListener: unknown, maybeListener?: Listener) => {
    const layerIds = layerIdsOf(layerOrListener);
    if (!layerIds) return baseOff(type, layerOrListener as never);
    const key = layerIds.join("\u0000");
    const index = registrations.findIndex(
      (entry) =>
        entry.type === type &&
        entry.original === maybeListener &&
        entry.layerIds.join("\u0000") === key,
    );
    if (index >= 0) registrations.splice(index, 1);
    return facade;
  };
  facade.on = on as never;
  facade.off = off as never;
  facade.once = ((type: string, layerOrListener: unknown, maybeListener?: Listener) => {
    const layerIds = layerIdsOf(layerOrListener);
    if (!layerIds) return baseOnce(type, layerOrListener as never);
    // Without a listener MapLibre returns a promise for the next event.
    let resolve: Listener = () => {};
    const next = maybeListener ? null : new Promise<Record<string, unknown>>((r) => (resolve = r));
    const original = maybeListener ?? resolve;
    const entry: Registration = {
      type,
      layerIds,
      original,
      inside: false,
      listener: (event) => {
        const index = registrations.indexOf(entry);
        if (index >= 0) registrations.splice(index, 1);
        original(event);
      },
    };
    registrations.push(entry);
    return next ?? facade;
  }) as never;

  facade.queryRenderedFeatures = (geometryOrOptions?: unknown, maybeOptions?: unknown) => {
    const isOptions =
      geometryOrOptions !== null &&
      typeof geometryOrOptions === "object" &&
      !Array.isArray(geometryOrOptions) &&
      !("x" in geometryOrOptions);
    const geometry = isOptions ? undefined : geometryOrOptions;
    const options = (isOptions ? geometryOrOptions : maybeOptions) as
      | { layers?: string[] }
      | undefined;
    const point = asPoint(geometry);
    if (!point) return [];
    const lngLat = host.unproject(point);
    if (!lngLat) return [];
    return pickAt(lngLat, options?.layers ?? host.layerIds());
  };
}

/** A pixel point in MapLibre's accepted forms; a box is not a point. */
function asPoint(value: unknown): { x: number; y: number } | null {
  if (Array.isArray(value) && value.length === 2 && value.every((v) => typeof v === "number"))
    return { x: value[0], y: value[1] };
  if (
    value !== null &&
    typeof value === "object" &&
    typeof (value as { x?: unknown }).x === "number" &&
    typeof (value as { y?: unknown }).y === "number"
  )
    return value as { x: number; y: number };
  return null;
}
