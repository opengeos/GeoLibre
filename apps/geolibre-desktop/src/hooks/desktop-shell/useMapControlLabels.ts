import type { MapEngine } from "@geolibre/map";
import type { TFunction } from "i18next";
import { useEffect, type RefObject } from "react";

/**
 * Keeps the tooltips of the map's native (non-React) controls translated.
 *
 * @param mapControllerRef - The primary map engine.
 * @param mapReadyGeneration - Bumped whenever the engine (re)initialises.
 * @param t - The shell's translation function.
 */
export function useMapControlLabels(
  mapControllerRef: RefObject<MapEngine | null>,
  mapReadyGeneration: number,
  t: TFunction,
): void {
  // Keep the on-map compass (reset pitch/bearing) control's tooltip translated.
  // Re-runs when the controller (re)initialises (mapReadyGeneration) and on
  // language change (t identity changes), since that native control lives
  // outside React.
  useEffect(() => {
    mapControllerRef.current?.setCompassLabel(t("toolbar.item.resetPitchBearing"));
  }, [t, mapReadyGeneration, mapControllerRef]);

  // Keep the on-map terrain control's tooltip translated (it lives outside
  // React). Re-runs on controller (re)init and language change.
  useEffect(() => {
    mapControllerRef.current?.setTerrainLabel(t("terrainSettings.controlLabel"));
  }, [t, mapReadyGeneration, mapControllerRef]);

  // Keep the Layer Swipe panel's grouped base-layer label translated. That
  // panel lives outside React and reads labels from the controller bridge, so
  // re-push on language change (t identity) and controller (re)init.
  useEffect(() => {
    mapControllerRef.current?.setBackgroundLabel(t("layers.background"));
  }, [t, mapReadyGeneration, mapControllerRef]);
}
