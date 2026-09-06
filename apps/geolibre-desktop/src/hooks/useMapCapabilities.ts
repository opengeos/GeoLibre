import { useAppStore } from "@geolibre/core";
import {
  CESIUM_CAPABILITIES,
  MAPLIBRE_CAPABILITIES,
  type MapEngineCapabilities,
} from "@geolibre/map";
import type { MapControllerRef } from "../components/layout/toolbar/constants";

/**
 * What the live map engine can do, for UI that needs to gate on it (issue #2260).
 *
 * Menus and panels used to ask `primaryRenderer === "cesium"` and disable
 * accordingly. That got it wrong in both directions: it hid camera work,
 * terrain, and framing that the globe does natively, and it would stop
 * describing reality the moment a third engine appeared. This is the one place
 * the question is asked, so every consumer gates on a capability instead.
 *
 * Reading `ref.current` is not reactive on its own, which is why the store's
 * `primaryRenderer` is subscribed to: swapping engines is exactly when
 * capabilities change, and between swaps they are constant. The renderer is
 * also the fallback for the window before a canvas has published its engine —
 * the only place the engine's *name* is still consulted, and it answers with
 * that engine's own frozen capability object rather than a hand-written guess.
 *
 * The ref is optional because some menus never receive it. They get the same
 * answer through the fallback, which is why this hook — not each call site — is
 * where the renderer-to-capability mapping lives.
 */
export function useMapCapabilities(mapControllerRef?: MapControllerRef): MapEngineCapabilities {
  const primaryRenderer = useAppStore((s) => s.primaryRenderer);
  const fallback = primaryRenderer === "cesium" ? CESIUM_CAPABILITIES : MAPLIBRE_CAPABILITIES;
  const engine = mapControllerRef?.current;
  // Trust the ref only while it agrees with the store about which renderer is
  // live. The store flips `primaryRenderer` during render; the canvases publish
  // and clear the ref from passive effects, which run after — so for the render
  // in between, the ref still holds the *outgoing* engine and would report the
  // capabilities of a renderer that is already gone (#2268 review). `kind` is
  // read here as an identity check on the ref, not to infer behaviour: what is
  // returned is still the engine's own capability object.
  return engine && engine.kind === primaryRenderer ? engine.capabilities : fallback;
}
