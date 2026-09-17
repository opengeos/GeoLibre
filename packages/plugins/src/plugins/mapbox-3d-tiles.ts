import { onArcgisViewDestroy } from "@geolibre/map/arcgis-control-adapters";
import { applyTilesetAltitudeOffset, type PositionedTileset } from "./tiles-altitude-offset";
import { useAppStore, type GeoLibreLayer, resolveThreeDTilesRequestHeaders } from "@geolibre/core";
import type { Layer } from "@deck.gl/core";
import type { GeoLibreAppAPI } from "../types";
import { ensureSharedDeckOverlay, setSharedDeckLayers } from "./shared-deck-overlay";
import {
  acquireMercatorProjectionLock,
  releaseMercatorProjectionLock,
} from "./map-projection-utils";
import { THREE_D_TILES_DECK_LOAD_OPTIONS } from "./arcgis-i3s-tiles";

/** Fly panel actions and initial loads through the active native renderer. */
export function flyToDeckTilesLocation(
  app: GeoLibreAppAPI,
  center: [number, number],
  zoom: number,
): void {
  const view = app.getArcgisView?.();
  if (view)
    void view
      .goTo({ center, zoom, ...(view.type === "3d" ? { tilt: 60 } : {}) })
      .catch((error: unknown) => {
        if (!(error instanceof DOMException && error.name === "AbortError"))
          console.warn("[3d-tiles] Could not navigate to the tileset", error);
      });
  else app.getMapboxMap?.()?.flyTo({ center, zoom, pitch: 60 });
}

const SOURCE = "mapbox-3d-tiles";
let unsubscribe: (() => void) | undefined;
let boundMap: unknown;
let generation = 0;
const flyToRequests = new Set<string>();
// Revision bookkeeping outlives a single restore call: the panel re-runs
// restoreMapboxTiles for every added tileset, and a fresh map here would renumber
// already-loaded layers, which deck.gl treats as new layers and reloads.
let signature = "";
let revisionCounter = 0;
const versions = new Map<string, { source: string; revision: number }>();

export function isMapboxTilesLayer(layer: GeoLibreLayer): boolean {
  return layer.type === "3d-tiles" && layer.metadata.sourceKind === "3d-tiles-url";
}

/** Bind persisted tilesets to the current engine without storing renderer objects. */
export async function restoreMapboxTiles(app: GeoLibreAppAPI, flyToId?: string): Promise<void> {
  const arcgisView = app.getArcgisView?.();
  if (arcgisView?.type === "3d" && arcgisView.viewingMode !== "local") return;
  const getMap = () => app.getMapboxMap?.() ?? app.getArcgisView?.();
  const map = getMap();
  if (!map || !app.getDeckGL) return;
  if (flyToId) flyToRequests.add(flyToId);
  const currentGeneration = ++generation;
  const deck = await app.getDeckGL();
  if (currentGeneration !== generation || getMap() !== map) return;
  await ensureSharedDeckOverlay(app);
  if (currentGeneration !== generation || getMap() !== map) return;
  unsubscribe?.();
  const newlyBound = boundMap !== map;
  boundMap = map;
  if (newlyBound) {
    signature = "";
    versions.clear();
  }
  const render = () => {
    if (boundMap !== map) return;
    const layers = useAppStore.getState().layers.filter(isMapboxTilesLayer);
    const next = JSON.stringify(
      layers.map(({ id, source, visible, opacity }) => ({ id, source, visible, opacity })),
    );
    if (next === signature) return;
    signature = next;
    if (layers.length) acquireMercatorProjectionLock(SOURCE, app);
    else releaseMercatorProjectionLock(SOURCE, app);
    for (const id of flyToRequests)
      if (!layers.some((layer) => layer.id === id)) flyToRequests.delete(id);
    const Tile3DLayer = deck.geoLayers.Tile3DLayer as unknown as new (
      props: Record<string, unknown>,
    ) => Layer;
    for (const id of versions.keys())
      if (!layers.some((layer) => layer.id === id)) versions.delete(id);
    // Revisions are unique across the session, so a removed and re-added layer
    // (or a re-sourced one) never shares a token with a superseded instance.
    const revision = (layer: GeoLibreLayer) => {
      const source = JSON.stringify(layer.source);
      const previous = versions.get(layer.id);
      if (previous?.source === source) return previous.revision;
      const revision = ++revisionCounter;
      versions.set(layer.id, { source, revision });
      return revision;
    };
    // deck.gl finalizes a replaced Tile3DLayer but still fires its pending
    // callbacks; only the live revision may touch the store or the camera.
    const isLive = (layer: GeoLibreLayer, token: number) =>
      boundMap === map && versions.get(layer.id)?.revision === token;
    setSharedDeckLayers(
      SOURCE,
      [...layers].reverse().map((layer) => {
        const token = revision(layer);
        return new Tile3DLayer({
          id: `${layer.id}-${token}-mapbox-tiles`,
          data: layer.source.url,
          altitudeOffset: layer.source.altitudeOffset,
          visible: layer.visible,
          opacity: layer.opacity,
          pickable: false,
          loadOptions: {
            ...THREE_D_TILES_DECK_LOAD_OPTIONS,
            fetch: {
              headers: resolveThreeDTilesRequestHeaders(
                String(layer.source.url),
                layer.source.requestHeaders as Record<string, string> | undefined,
              ),
            },
          },
          onTilesetLoad: (tileset: PositionedTileset & { zoom?: number }) => {
            applyTilesetAltitudeOffset(tileset, Number(layer.source.altitudeOffset ?? 0));
            const current = useAppStore.getState().layers.find(({ id }) => id === layer.id);
            if (!current || !isLive(layer, token)) return;
            const center = tileset.cartographicCenter;
            useAppStore.getState().updateLayer(layer.id, {
              metadata: {
                ...current.metadata,
                status: "loaded",
                error: undefined,
                ...(center
                  ? {
                      center: Array.from(center).slice(0, 2),
                      altitude: center[2],
                      zoom: tileset.zoom,
                    }
                  : {}),
              },
            });
            if (center && flyToRequests.delete(layer.id)) {
              flyToDeckTilesLocation(
                app,
                [center[0], center[1]],
                Math.max(0, (tileset.zoom ?? 16) - 1),
              );
            }
          },
          onError: (error: Error) => {
            const current = useAppStore.getState().layers.find(({ id }) => id === layer.id);
            if (current && isLive(layer, token))
              useAppStore.getState().updateLayer(layer.id, {
                metadata: { ...current.metadata, status: "error", error: error.message },
              });
            return true;
          },
          onTileError: (_tile: unknown, message: string) => {
            const current = useAppStore.getState().layers.find(({ id }) => id === layer.id);
            if (current && isLive(layer, token))
              useAppStore.getState().updateLayer(layer.id, {
                metadata: { ...current.metadata, status: "error", error: message },
              });
          },
        }) as unknown as Layer;
      }),
    );
  };
  unsubscribe = useAppStore.subscribe((state, previous) => {
    if (state.layers !== previous.layers) render();
  });
  if (newlyBound) {
    const cleanup = () => {
      if (boundMap !== map) return;
      generation++;
      unsubscribe?.();
      unsubscribe = undefined;
      boundMap = null;
      signature = "";
      versions.clear();
      setSharedDeckLayers(SOURCE, []);
      releaseMercatorProjectionLock(SOURCE, app);
    };
    if (arcgisView) onArcgisViewDestroy(arcgisView, cleanup);
    else app.getMapboxMap?.()?.once("remove", cleanup);
  }
  render();
}
