/** Current GeoLibre iframe protocol version. Version 1 requests remain supported by the app. */
export const EMBED_API_VERSION = 2 as const;
export const EMBED_API_SOURCE = "geolibre" as const;

export interface Viewport {
  bbox?: [number, number, number, number];
  center: [number, number];
  zoom: number;
  bearing: number;
  pitch: number;
}

export type ViewTarget =
  | { bbox: [number, number, number, number] }
  | {
      center?: [number, number];
      zoom?: number;
      bearing?: number;
      pitch?: number;
      duration?: number;
    };

export interface LayerSummary {
  id: string;
  name: string;
  type: string;
  visible: boolean;
  opacity: number;
}

export interface AddLayerSpec {
  id: string;
  name: string;
  type: string;
  source: Record<string, unknown>;
  visible?: boolean;
  opacity?: number;
  style?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  geojson?: unknown;
  beforeId?: string;
}

export type EmbedEventMap = {
  ready: { version: string };
  ack: { requestId: string; ok: boolean; error?: string; result?: unknown };
  projectLoaded: { url: string | null; name: string; layerIds: string[] };
  selectionChanged: { layerId: string | null; featureIds: string[] };
  viewChanged: Viewport;
  toolCompleted: Record<string, unknown>;
  serverFileWritten: { path: string; toolId: string };
};

type EventName = keyof EmbedEventMap;
type Listener<K extends EventName> = (payload: EmbedEventMap[K]) => void;

export interface ConnectOptions {
  /** Exact origin hosting the GeoLibre iframe. */
  origin: string;
  /** Time allowed for the initial ready event. Defaults to 15 seconds. */
  timeoutMs?: number;
}

export interface GeoLibreEmbedClient {
  loadProject(url: string): Promise<void>;
  setView(target: ViewTarget): Promise<void>;
  highlightFeature(payload: {
    layerId: string;
    featureId?: string | number;
    featureIds?: Array<string | number>;
    filter?: Record<string, unknown>;
    fit?: boolean;
  }): Promise<void>;
  openTool(id: string, params?: Record<string, string | number | boolean>): Promise<void>;
  setLayerVisibility(layerId: string, visible: boolean): Promise<void>;
  listLayers(): Promise<LayerSummary[]>;
  setFilter(layerId: string, expression: unknown[] | null): Promise<void>;
  getViewport(): Promise<Viewport>;
  addLayer(spec: AddLayerSpec): Promise<string>;
  exportImage(): Promise<string>;
  on<K extends EventName>(type: K, listener: Listener<K>): () => void;
  disconnect(): void;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
}

function validOrigin(value: string): string {
  const origin = new URL(value).origin;
  if (origin === "null") throw new Error("origin must be an http(s) origin");
  return origin;
}

/** Connect to a framed GeoLibre app and wait until its embed API is ready. */
export function connect(
  iframe: HTMLIFrameElement,
  options: ConnectOptions,
): Promise<GeoLibreEmbedClient> {
  const origin = validOrigin(options.origin);
  const target = iframe.contentWindow;
  if (!target) return Promise.reject(new Error("The iframe has no contentWindow"));

  let sequence = 0;
  let disconnected = false;
  const pending = new Map<string, Pending>();
  const listeners = new Map<EventName, Set<(payload: never) => void>>();

  const send = <T>(type: string, payload: Record<string, unknown> = {}): Promise<T> => {
    if (disconnected) return Promise.reject(new Error("The GeoLibre client is disconnected"));
    const requestId = `geolibre-${Date.now()}-${++sequence}`;
    target.postMessage({ v: EMBED_API_VERSION, type, payload, requestId }, origin);
    return new Promise<T>((resolve, reject) => {
      pending.set(requestId, { resolve: (value) => resolve(value as T), reject });
    });
  };

  let readyResolve: ((client: GeoLibreEmbedClient) => void) | null = null;
  let readyReject: ((error: Error) => void) | null = null;
  const ready = new Promise<GeoLibreEmbedClient>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });

  const client: GeoLibreEmbedClient = {
    loadProject: (url) => send("loadProject", { url }),
    setView: (target) => send("setView", target as unknown as Record<string, unknown>),
    highlightFeature: (payload) =>
      send("highlightFeature", payload as unknown as Record<string, unknown>),
    openTool: (id, params = {}) => send("openTool", { id, params }),
    setLayerVisibility: (layerId, visible) => send("setLayerVisibility", { layerId, visible }),
    listLayers: () => send<LayerSummary[]>("listLayers"),
    setFilter: (layerId, expression) => send("setFilter", { layerId, expression }),
    getViewport: () => send<Viewport>("getViewport"),
    addLayer: (spec) => send<string>("addLayer", { spec }),
    exportImage: () => send<string>("exportImage"),
    on: (type, listener) => {
      const set = listeners.get(type) ?? new Set();
      set.add(listener as (payload: never) => void);
      listeners.set(type, set);
      return () => set.delete(listener as (payload: never) => void);
    },
    disconnect: () => {
      if (disconnected) return;
      disconnected = true;
      window.removeEventListener("message", receive);
      for (const request of pending.values()) request.reject(new Error("Client disconnected"));
      pending.clear();
      listeners.clear();
    },
  };

  const receive = (event: MessageEvent) => {
    if (event.source !== target || event.origin !== origin) return;
    const data = event.data as Record<string, unknown> | null;
    if (!data || data.source !== EMBED_API_SOURCE || data.v !== EMBED_API_VERSION) return;
    const type = data.type as EventName;
    const payload = (data.payload ?? {}) as Record<string, unknown>;
    if (type === "ack") {
      const requestId = payload.requestId;
      if (typeof requestId !== "string") return;
      const request = pending.get(requestId);
      if (!request) return;
      pending.delete(requestId);
      if (payload.ok === true) request.resolve(payload.result);
      else request.reject(new Error(String(payload.error ?? "GeoLibre request failed")));
      return;
    }
    if (type === "ready") readyResolve?.(client);
    for (const listener of listeners.get(type) ?? []) listener(payload as never);
  };
  window.addEventListener("message", receive);

  const timer = window.setTimeout(() => {
    client.disconnect();
    readyReject?.(new Error("Timed out waiting for GeoLibre"));
  }, options.timeoutMs ?? 15_000);
  return ready.finally(() => window.clearTimeout(timer));
}
