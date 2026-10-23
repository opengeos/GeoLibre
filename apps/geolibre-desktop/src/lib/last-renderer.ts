import type { MapRendererKind } from "@geolibre/core";
import { LAST_RENDERER_STORAGE_KEY } from "./storage-keys";

function isMapRendererKind(value: string | null): value is MapRendererKind {
  return value === "maplibre" || value === "cesium" || value === "mapbox" || value === "arcgis";
}

/** Read the last selected rendering engine, ignoring stale or edited values. */
export function readLastRenderer(storage?: Storage): MapRendererKind | null {
  try {
    const target = storage ?? globalThis.localStorage;
    const renderer = target.getItem(LAST_RENDERER_STORAGE_KEY);
    return isMapRendererKind(renderer) ? renderer : null;
  } catch {
    return null;
  }
}

/** Persist the current rendering engine without making storage availability app-critical. */
export function writeLastRenderer(renderer: MapRendererKind, storage?: Storage): void {
  try {
    const target = storage ?? globalThis.localStorage;
    target.setItem(LAST_RENDERER_STORAGE_KEY, renderer);
  } catch {
    // Persistence is best-effort; storage can be disabled or full.
  }
}
