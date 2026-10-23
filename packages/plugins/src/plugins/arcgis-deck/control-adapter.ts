import type { Map as MapLibreMap } from "maplibre-gl";
import type { Deck, DeckProps } from "@deck.gl/core";
import { MapboxOverlay } from "@deck.gl/mapbox";
import { MapLibreOverlay } from "@deck.gl/maplibre";
import { setArcgisControlAdapter } from "@geolibre/map/arcgis-control-adapters";
import type { GeoLibreAppAPI } from "../../types";
import { ArcgisDeckOverlay } from "./overlay";

/** Adapt only deck.gl's known overlay controls; arbitrary custom layers still fail. */
export function installArcgisDeckControls(app: GeoLibreAppAPI): boolean {
  const view = app.getArcgisView?.();
  if (!view || (view.type === "3d" && view.viewingMode !== "local")) return false;
  setArcgisControlAdapter(view, (control, map) => {
    if (!(control instanceof MapboxOverlay) && !(control instanceof MapLibreOverlay)) return null;
    return bridgeArcgisDeckControl(control, new ArcgisDeckOverlay(view, {}), map);
  });
  return true;
}

/** `_props` is deck.gl 9.4's initial-props contract, covered by a regression test. */
export function bridgeArcgisDeckControl(
  control: MapboxOverlay | MapLibreOverlay,
  native: ArcgisDeckOverlay,
  map: MapLibreMap,
): () => void {
  const internals = control as unknown as { _props: DeckProps };
  const originals = {
    setProps: control.setProps,
    finalize: control.finalize,
    pickObject: control.pickObject,
    pickObjects: control.pickObjects,
    pickMultipleObjects: control.pickMultipleObjects,
    getCanvas: control.getCanvas,
  };
  let disposed = false;
  control.setProps = (props) => {
    if (disposed) return;
    internals._props = { ...internals._props, ...props };
    native.setProps(props);
  };
  control.pickObject = (options: Parameters<Deck["pickObject"]>[0]) =>
    native.getDeck()?.pickObject(options) ?? null;
  control.pickObjects = (options: Parameters<Deck["pickObjects"]>[0]) =>
    native.getDeck()?.pickObjects(options) ?? [];
  control.pickMultipleObjects = (options: Parameters<Deck["pickMultipleObjects"]>[0]) =>
    native.getDeck()?.pickMultipleObjects(options) ?? [];
  control.getCanvas = () => native.getDeck()?.getCanvas() ?? null;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    // Plugin wrappers use onRemove to clear mounted flags and subscriptions,
    // even though their deck instance is owned by the native ArcGIS overlay.
    try {
      control.onRemove(map);
    } catch (error) {
      console.warn("[ArcGIS] Could not remove plugin deck control", error);
    } finally {
      native.finalize();
      Object.assign(control, originals);
    }
  };
  control.finalize = dispose;
  native.setProps(internals._props);
  void native.mount().catch((error) => {
    dispose();
    console.error("[ArcGIS] Could not mount plugin deck overlay", error);
  });
  return dispose;
}
