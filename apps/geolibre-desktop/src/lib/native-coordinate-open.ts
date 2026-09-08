import { useAppStore } from "@geolibre/core";
import { coordinateTargetFromGeoUri, type CoordinateTarget } from "./coordinate-url";
import { isTauri } from "./is-tauri";

let initialTarget: CoordinateTarget | null = null;
let startup = true;

export function initialNativeCoordinateTarget(): CoordinateTarget | null {
  return initialTarget;
}

/** Subscribe for the app lifetime before reading the cold-launch URI. */
export async function initializeNativeCoordinateOpen(): Promise<void> {
  if (!isTauri()) return;
  try {
    const { getCurrent, onOpenUrl } = await import("@tauri-apps/plugin-deep-link");
    let receivedEvent = false;
    const accept = (urls: string[]) => {
      const location = urls.map(coordinateTargetFromGeoUri).find((value) => value !== null);
      if (!location) return;
      if (startup) initialTarget = location;
      else useAppStore.getState().setMapView(location);
    };
    await onOpenUrl((urls) => {
      receivedEvent = true;
      accept(urls);
    });
    const urls = await getCurrent();
    if (!receivedEvent && urls) accept(urls);
  } catch (error) {
    console.error("[GeoLibre] Could not initialize coordinate links", error);
  }
}

/** Called after startup has seeded the map, so subsequent intents move the live map. */
export function finishNativeCoordinateStartup(): void {
  startup = false;
}
