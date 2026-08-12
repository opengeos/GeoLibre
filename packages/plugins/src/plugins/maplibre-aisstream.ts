import { useAppStore } from "@geolibre/core";
import type { GeoLibreAppAPI, GeoLibrePlugin } from "../types";
import {
  AISSTREAM_URL,
  aisFeatureCollection,
  buildAisStreamSubscription,
  parseAisStreamEvent,
  type AisBounds,
  type AisPositionFeature,
} from "./aisstream-api";
import { buildTimeBinding } from "./time-slider-binding";

export const AISSTREAM_PLUGIN_ID = "geolibre-aisstream";
const PANEL_ID = AISSTREAM_PLUGIN_ID;
const LAYER_NAME = "AISStream live positions";
const MAX_FEATURES = 20_000;
const FLUSH_MS = 1_000;

let socket: WebSocket | null = null;
let layerId: string | null = null;
let features: AisPositionFeature[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let unregisterPanel: (() => void) | null = null;

function disconnect(): void {
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = null;
  if (socket) {
    socket.onopen = null;
    socket.onmessage = null;
    socket.onerror = null;
    socket.onclose = null;
    socket.close();
  }
  socket = null;
}

function currentBounds(app: GeoLibreAppAPI): AisBounds {
  const bounds = app.getMap?.()?.getBounds();
  if (!bounds) throw new Error("The map is not ready yet.");
  return [
    Math.max(-180, bounds.getWest()),
    Math.max(-90, bounds.getSouth()),
    Math.min(180, bounds.getEast()),
    Math.min(90, bounds.getNorth()),
  ];
}

function flush(app: GeoLibreAppAPI, onCount: (count: number) => void): void {
  flushTimer = null;
  if (features.length > MAX_FEATURES) features = features.slice(-MAX_FEATURES);
  const geojson = aisFeatureCollection(features);
  if (!layerId || !useAppStore.getState().layers.some((layer) => layer.id === layerId)) {
    layerId = app.addGeoJsonLayer(LAYER_NAME, geojson);
  }
  const binding = buildTimeBinding(geojson, "observed_at", {
    unit: "hour",
    before: 1,
    after: 1,
  });
  // TimeWindow currently exposes hour as its finest public unit. A one-hour
  // window keeps live AIS useful today; finer minute stepping can be added to
  // the shared slider without changing this provider adapter.
  const safeBinding = binding ? { ...binding, granularity: "hour" as const } : undefined;
  useAppStore.getState().updateLayer(layerId, {
    geojson,
    metadata: {
      ...(useAppStore.getState().layers.find((layer) => layer.id === layerId)?.metadata ?? {}),
      sourceKind: AISSTREAM_PLUGIN_ID,
      provider: "AISStream",
      timestampProperty: "observed_at",
      ...(safeBinding ? { timeBinding: safeBinding } : {}),
    },
  });
  onCount(features.length);
}

function scheduleFlush(app: GeoLibreAppAPI, onCount: (count: number) => void): void {
  if (!flushTimer) flushTimer = setTimeout(() => flush(app, onCount), FLUSH_MS);
}

function connect(
  app: GeoLibreAppAPI,
  apiKey: string,
  onStatus: (message: string, error?: boolean) => void,
  onCount: (count: number) => void,
): void {
  disconnect();
  const subscription = buildAisStreamSubscription(apiKey, currentBounds(app));
  onStatus("Connecting…");
  const next = new WebSocket(AISSTREAM_URL);
  socket = next;
  next.onopen = () => {
    next.send(JSON.stringify(subscription));
    onStatus("Connected to the current map area.");
  };
  next.onmessage = (event) => {
    const feature = parseAisStreamEvent(event.data);
    if (!feature) return;
    features.push(feature);
    scheduleFlush(app, onCount);
  };
  next.onerror = () => onStatus("AISStream connection failed. Check the key and network.", true);
  next.onclose = () => {
    if (socket === next) socket = null;
    onStatus("Disconnected.");
  };
}

function renderPanel(app: GeoLibreAppAPI, container: HTMLElement): () => void {
  container.innerHTML = `
    <div style="display:flex;flex-direction:column;gap:10px;padding:12px;font-size:12px;color:hsl(var(--foreground))">
      <p style="margin:0;line-height:1.45">Stream free live AIS positions inside the current map view. Positions are automatically bound to <strong>observed_at</strong> for GeoLibre's Time Slider.</p>
      <label style="display:flex;flex-direction:column;gap:4px"><span>AISStream API key</span><input data-key type="password" autocomplete="off" placeholder="Paste key (not saved)" style="padding:7px;border:1px solid hsl(var(--border));border-radius:5px;background:hsl(var(--background));color:inherit" /></label>
      <div style="display:flex;gap:6px"><button data-connect style="padding:7px 10px;cursor:pointer">Connect to map view</button><button data-disconnect style="padding:7px 10px;cursor:pointer">Disconnect</button><button data-clear style="padding:7px 10px;cursor:pointer">Clear</button></div>
      <p data-status role="status" style="margin:0;color:hsl(var(--muted-foreground))">Disconnected.</p>
      <p data-count style="margin:0">0 positions buffered.</p>
      <p style="margin:0;color:hsl(var(--muted-foreground));line-height:1.4">Open the Time Slider plugin after positions arrive. Reconnect after panning to subscribe to the new view. Maximum retained points: ${MAX_FEATURES.toLocaleString()}.</p>
    </div>`;
  const key = container.querySelector<HTMLInputElement>("[data-key]")!;
  const status = container.querySelector<HTMLElement>("[data-status]")!;
  const count = container.querySelector<HTMLElement>("[data-count]")!;
  const setStatus = (message: string, error = false) => {
    status.textContent = message;
    status.style.color = error ? "hsl(var(--destructive))" : "hsl(var(--muted-foreground))";
  };
  const setCount = (value: number) => {
    count.textContent = `${value.toLocaleString()} positions buffered.`;
  };
  container.querySelector("[data-connect]")?.addEventListener("click", () => {
    try {
      connect(app, key.value, setStatus, setCount);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error), true);
    }
  });
  container.querySelector("[data-disconnect]")?.addEventListener("click", () => {
    disconnect();
    setStatus("Disconnected.");
  });
  container.querySelector("[data-clear]")?.addEventListener("click", () => {
    features = [];
    if (layerId) {
      const empty = aisFeatureCollection([]);
      const layer = useAppStore.getState().layers.find((candidate) => candidate.id === layerId);
      if (layer) {
        const { timeBinding: _timeBinding, ...metadata } = layer.metadata;
        useAppStore.getState().updateLayer(layerId, {
          geojson: empty,
          metadata,
          timeFilter: undefined,
        });
      }
    }
    setCount(0);
  });
  return disconnect;
}

export const maplibreAisStreamPlugin: GeoLibrePlugin = {
  id: AISSTREAM_PLUGIN_ID,
  name: "AISStream",
  version: "0.1.0",
  activate: (app) => {
    unregisterPanel = app.registerRightPanel?.({
      id: PANEL_ID,
      title: "AISStream",
      dock: "left-of-style",
      defaultWidth: 360,
      render: (container) => renderPanel(app, container),
    }) ?? null;
    if (!unregisterPanel) return false;
    app.openRightPanel?.(PANEL_ID);
  },
  deactivate: (app) => {
    disconnect();
    app.closeRightPanel?.(PANEL_ID);
    unregisterPanel?.();
    unregisterPanel = null;
  },
};
