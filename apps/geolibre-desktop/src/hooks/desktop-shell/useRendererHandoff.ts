import { useAppStore, type GeoLibreLayer } from "@geolibre/core";
import { type Dispatch, type SetStateAction, useEffect } from "react";

interface RendererHandoffOptions {
  primaryRenderer: string;
  setMapReadyGeneration: Dispatch<SetStateAction<number>>;
  setRasterSubsetLayer: Dispatch<SetStateAction<GeoLibreLayer | null>>;
  setBasemapExtractOpen: Dispatch<SetStateAction<boolean>>;
}

/**
 * Hands the shell off to a non-MapLibre renderer: bumps the readiness
 * generation and closes the MapLibre-only panels.
 *
 * @param options - The active renderer and the shell state the hand-off resets.
 */
export function useRendererHandoff({
  primaryRenderer,
  setMapReadyGeneration,
  setRasterSubsetLayer,
  setBasemapExtractOpen,
}: RendererHandoffOptions): void {
  const setObjectDetectionOpen = useAppStore((s) => s.setObjectDetectionOpen);
  const setSegmentEverythingOpen = useAppStore((s) => s.setSegmentEverythingOpen);
  // Switching engines swaps which engine the shared ref points at: MapCanvas
  // unmounts and clears it, then PrimaryCesiumCanvas publishes its CesiumEngine
  // (and the reverse on the way back). The ref is no longer nulled wholesale
  // here — that was necessary while only MapLibre implemented the surface, and
  // it is what left every menu, panel, and shortcut pointing at nothing on the
  // globe (#2260). Each canvas owns clearing its own engine on unmount, so the
  // ref is never left aimed at a destroyed map.
  //
  // The MapLibre-only panels below still unmount with the 2D map, so any that
  // were open are closed here. Without this their open flags survive on the
  // globe and the panel springs back the moment the user returns to 2D, long
  // after they meant to dismiss it (#2217 review).
  useEffect(() => {
    if (primaryRenderer === "maplibre") return;
    // Bump the readiness generation on the hand-off. It is no longer *reset*
    // (that is what left every consumer pointing at nothing on the globe), but
    // the reset did do one useful thing: it forced the generation-gated effects
    // — viewport history, the embed/notebook/command bridges — to re-run and
    // detach their listeners from the outgoing MapLibre map. Without a bump
    // they would not re-run until a new engine published, so a globe that never
    // becomes ready would leave those closures holding a destroyed map for the
    // session (#2268 review). Incrementing keeps that cleanup timing while the
    // ref itself stays live.
    setMapReadyGeneration((generation) => generation + 1);
    setRasterSubsetLayer(null);
    setBasemapExtractOpen(false);
    setObjectDetectionOpen(false);
    setSegmentEverythingOpen(false);
  }, [
    primaryRenderer,
    setObjectDetectionOpen,
    setSegmentEverythingOpen,
    setMapReadyGeneration,
    setRasterSubsetLayer,
    setBasemapExtractOpen,
  ]);
}
