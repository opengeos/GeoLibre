import type { PMTilesLayerControl } from "maplibre-gl-components";
import { readRemotePMTilesInfo } from "@geolibre/map/pmtiles-layer";
import type { GeoLibreAppAPI } from "../types";

type State = ReturnType<PMTilesLayerControl["getState"]>;
// The upstream panel has no loader injection API. Keep its private seam here,
// covered by a contract test against the real control, rather than patching Map.
interface PanelLoader {
  _state: State;
  _pmtilesLayers: Map<string, State["layers"][number]>;
  _addLayer: () => Promise<void>;
  _render: () => void;
  _emit: (event: string, data: Record<string, unknown>) => void;
}

export function adaptMapboxPMTilesControl(
  control: PMTilesLayerControl,
  app: Pick<GeoLibreAppAPI, "fitBounds">,
  readArchive = readRemotePMTilesInfo,
): void {
  const panel = control as unknown as PanelLoader;
  if (!(panel._pmtilesLayers instanceof Map) || typeof panel._addLayer !== "function") {
    throw new Error("PMTiles panel loader contract has changed");
  }
  let disposed = false;
  const pending = new Set<AbortController>();
  const onRemove = control.onRemove.bind(control);
  control.onRemove = () => {
    disposed = true;
    for (const request of pending) request.abort();
    pending.clear();
    onRemove();
  };
  const addLayer = control.addLayer.bind(control);
  control.addLayer = (url) => {
    // Programmatic imports take the whole archive. A previous panel selection
    // must not leak into a different archive discovered through STAC, etc.
    if (url) panel._state.selectedSourceLayers = [];
    return addLayer(url);
  };
  // Keep the existing metadata/selection UI and layeradd event. Only the host
  // store creates map sources, so there is no duplicate unmanaged layer.
  //
  // The panel state is shared, so additions run one at a time. Inputs are read
  // when the request is made (the upstream addLayer sets `url` synchronously
  // before calling this), and the queue yields a macrotask between requests so
  // a caller that awaits addLayer reads its own `error` before the next request
  // clears it.
  let queue: Promise<void> = Promise.resolve();
  const addArchive = async (
    url: string,
    selection: string[],
    layerName: string,
    opacity: number,
    pickable: boolean,
  ): Promise<void> => {
    if (disposed) return;
    const request = new AbortController();
    pending.add(request);
    const state = panel._state;
    state.loading = true;
    state.error = null;
    panel._render();
    try {
      if (!/^https?:\/\//.test(url) || !new URL(url).pathname.endsWith(".pmtiles")) {
        throw new Error("Mapbox requires a remote vector .pmtiles URL");
      }
      const archive = await readArchive(url, request.signal);
      if (disposed) return;
      if (archive.tileType !== "vector") {
        throw new Error("Raster PMTiles archives are not supported by Mapbox yet");
      }
      const selected = selection.length
        ? archive.sourceLayers.filter((id) => selection.includes(id))
        : archive.sourceLayers;
      if (!selected.length) throw new Error("No vector source layers selected");
      const id = `pmtiles-source-${crypto.randomUUID()}`;
      const info: State["layers"][number] = {
        id,
        url,
        name: layerName || undefined,
        tileType: "vector",
        sourceLayers: archive.sourceLayers,
        layerIds: [],
        opacity,
        pickable,
      };
      panel._pmtilesLayers.set(id, info);
      Object.assign(state, {
        selectedSourceLayers: selected,
        layers: [...panel._pmtilesLayers.values()],
        hasLayer: true,
        layerCount: panel._pmtilesLayers.size,
        loading: false,
        status: "PMTiles layer added (vector).",
        layerName: "",
      });
      panel._render();
      panel._emit("layeradd", { url, layerId: id });
      app.fitBounds?.(archive.bounds);
    } catch (error) {
      if (disposed) return;
      state.loading = false;
      state.error = error instanceof Error ? error.message : String(error);
      panel._render();
      panel._emit("error", { error: state.error });
    } finally {
      pending.delete(request);
    }
  };
  panel._addLayer = () => {
    const { url, selectedSourceLayers, layerName, layerOpacity, pickable } = panel._state;
    const run = () =>
      addArchive(url, [...selectedSourceLayers], layerName.trim(), layerOpacity, pickable);
    const settled = queue.then(
      () => new Promise<void>((resolve) => setTimeout(resolve, 0)),
      () => undefined,
    );
    const next = settled.then(run);
    queue = next;
    return next;
  };
}
