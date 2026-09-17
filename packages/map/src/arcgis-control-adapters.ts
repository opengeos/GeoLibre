import type { IdentifiedFeature } from "./map-engine";
import type { IControl } from "maplibre-gl";
import type { ArcgisView } from "./arcgis-sdk";

type Picker = (point: { x: number; y: number }, layerId?: string) => IdentifiedFeature[];
const pickers = new WeakMap<ArcgisView, Picker>();
/** One host-owned picker per view; a replacement supersedes the previous registration. */
export function setArcgisControlPicker(view: ArcgisView, picker: Picker): void {
  pickers.set(view, picker);
}
export function identifyArcgisControls(
  view: ArcgisView,
  point: { x: number; y: number },
  layerId?: string,
): IdentifiedFeature[] {
  return pickers.get(view)?.(point, layerId) ?? [];
}

type Adapter = (control: IControl) => (() => void) | null;
const adapters = new WeakMap<ArcgisView, Adapter>();
const cleanups = new WeakMap<ArcgisView, Set<() => void>>();
/** One host-owned adapter per view; compose multiple control types inside that adapter. */
export function setArcgisControlAdapter(view: ArcgisView, adapter: Adapter): void {
  adapters.set(view, adapter);
}
export function adaptArcgisControl(view: ArcgisView, control: IControl): (() => void) | null {
  return adapters.get(view)?.(control) ?? null;
}
export function onArcgisViewDestroy(view: ArcgisView, cleanup: () => void): () => void {
  let listeners = cleanups.get(view);
  if (!listeners) {
    listeners = new Set();
    cleanups.set(view, listeners);
  }
  listeners.add(cleanup);
  return () => listeners?.delete(cleanup);
}
export function disposeArcgisControlAdapters(view: ArcgisView): void {
  const listeners = cleanups.get(view);
  cleanups.delete(view);
  adapters.delete(view);
  pickers.delete(view);
  for (const cleanup of listeners ?? [])
    try {
      cleanup();
    } catch (error) {
      console.warn("[ArcGIS] View cleanup failed", error);
    }
}
