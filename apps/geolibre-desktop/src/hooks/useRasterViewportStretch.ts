import { useAppStore, type GeoLibreLayer } from "@geolibre/core";
import type { MapEngine } from "@geolibre/map";
import { RASTER_SOURCE_KIND, readRasterWindow, savedRasterSymbology } from "@geolibre/plugins";
import { useEffect, useRef } from "react";
import type { RefObject } from "react";
import {
  normalizeStretchMethod,
  stretchSamples,
  viewportRange,
  wantsAutoStretch,
} from "../lib/viewport-stretch";

export function useRasterViewportStretch(
  mapControllerRef: RefObject<MapEngine | null>,
  mapReadyGeneration: number,
): void {
  const requests = useRef(new Map<string, AbortController>());

  useEffect(() => {
    const run = async (): Promise<void> => {
      const bounds = mapControllerRef.current?.getViewBounds?.();
      if (!bounds) return;
      const layers = useAppStore.getState().layers.filter(isAutoStretchLayer);
      await Promise.all(layers.map((layer) => stretchLayer(layer.id, bounds, requests.current)));
    };

    const stop = mapControllerRef.current?.onCameraIdle(() => {
      void run();
    });
    void run();
    // zustand has no selector here, so this runs on every store mutation,
    // including setPointerCoords on each mousemove. Every action that could
    // change a stretch setting replaces the layers array, so an identity check
    // skips the O(n*m) scan for the mutations that cannot matter, the same
    // guard store.ts uses for its ellipsoid subscription.
    const unsubscribe = useAppStore.subscribe((state, previous) => {
      if (state.layers === previous.layers) return;
      const changed = state.layers.some((layer) => {
        const before = previous.layers.find((item) => item.id === layer.id);
        return viewportStretchSettings(layer) !== viewportStretchSettings(before);
      });
      if (changed) void run();
    });

    return () => {
      stop?.();
      unsubscribe();
      for (const controller of requests.current.values()) controller.abort();
      requests.current.clear();
    };
  }, [mapControllerRef, mapReadyGeneration]);
}

/** Whether the auto stretch should drive this layer. See `wantsAutoStretch`. */
function isAutoStretchLayer(layer: GeoLibreLayer): boolean {
  if (layer.metadata.sourceKind !== RASTER_SOURCE_KIND) return false;
  return wantsAutoStretch(
    layer.metadata.rasterState,
    savedRasterSymbology(layer)?.classified === true,
  );
}

/**
 * Fingerprint of everything that changes what the auto stretch should compute:
 * whether it is on, which method it uses, and which band it reads. The store
 * subscription re-runs when this changes, and an in-flight read discards its
 * result when it no longer matches, so switching band re-reads immediately
 * instead of leaving the old band's range applied until the next camera move.
 */
function viewportStretchSettings(layer: { metadata: Record<string, unknown> } | undefined): string {
  const state = layer?.metadata.rasterState;
  if (!state || typeof state !== "object" || Array.isArray(state)) return "";
  const value = state as Record<string, unknown>;
  return [
    value.viewportStretchAuto === true,
    String(value.viewportStretchMethod ?? "minmax"),
    readBand(value),
  ].join(":");
}

/** The band the raster state selects, defaulting to the first. */
function readBand(state: Record<string, unknown>): number {
  return Array.isArray(state.bands) && typeof state.bands[0] === "number" ? state.bands[0] : 1;
}

async function stretchLayer(
  layerId: string,
  bounds: [number, number, number, number],
  requests: Map<string, AbortController>,
): Promise<void> {
  requests.get(layerId)?.abort();
  const controller = new AbortController();
  requests.set(layerId, controller);
  try {
    const layer = useAppStore.getState().layers.find((item) => item.id === layerId);
    const state = layer?.metadata.rasterState;
    if (!state || typeof state !== "object" || Array.isArray(state)) return;
    const raw = state as Record<string, unknown>;
    const band = readBand(raw);
    const method = normalizeStretchMethod(raw.viewportStretchMethod);
    const reading = await readRasterWindow(layerId, {
      bounds,
      band,
      width: 32,
      height: 32,
      signal: controller.signal,
    });
    if (controller.signal.aborted || !reading) return;
    const values = stretchSamples(reading);
    if (values.length === 0) return;
    const range = viewportRange(values, method);
    if (range[0] >= range[1]) return;
    const current = useAppStore.getState().layers.find((item) => item.id === layerId);
    if (!current || viewportStretchSettings(current) !== viewportStretchSettings(layer)) return;
    // The settings fingerprint does not cover mode or classification, so a
    // switch to RGB or classified while this read was in flight would otherwise
    // land a single-entry rescale on a layer that no longer wants one.
    if (!isAutoStretchLayer(current)) return;
    const currentState =
      (current.metadata.rasterState as Record<string, unknown> | undefined) ?? {};
    // Panning over uniform ground recomputes the same range on every camera
    // idle. Writing it back anyway would mark the project dirty and push an
    // undo entry per idle, so only commit a range that actually moved.
    if (sameRange(currentState.rescale, range)) return;
    useAppStore.getState().updateLayer(layerId, {
      metadata: {
        ...current.metadata,
        rasterState: {
          ...currentState,
          rescale: [range],
        },
      },
    });
  } catch (error) {
    // The manual "Apply" button reports a failed read in the panel. This path
    // has no such surface and runs on every camera idle, so it stays quiet
    // rather than letting the rejection escape `void run()` and reach the
    // diagnostics layer as a visible runtime error on each pan.
    // A superseded read may reject rather than resolve, so check the signal
    // itself instead of trusting any one error shape.
    if (controller.signal.aborted) return;
    console.warn(`Viewport stretch failed for layer ${layerId}`, error);
  } finally {
    if (requests.get(layerId) === controller) requests.delete(layerId);
  }
}

/** Whether the stored rescale already holds exactly the computed range. */
function sameRange(stored: unknown, range: [number, number]): boolean {
  if (!Array.isArray(stored) || stored.length !== 1) return false;
  const first = stored[0];
  return Array.isArray(first) && first[0] === range[0] && first[1] === range[1];
}
