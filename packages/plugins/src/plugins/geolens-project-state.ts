import { normalizeBaseUrl } from "./geolens-api";

/**
 * What the GeoLens plugin keeps in a saved project: the server a map was
 * published to, the map's publish key and the publish key of each layer's
 * dataset. Publish keys are identifiers, not credentials; the API key typed
 * into the panel is never part of this state.
 *
 * Every sub-key is listed in `PUBLISHABLE_PLUGIN_SETTINGS`
 * (`packages/core/src/credentials.ts`, mirrored in
 * `python/src/geolibre/project.py`), so a field added here stays out of shared
 * and exported projects until it is listed there too.
 */
export interface GeoLensProjectState {
  serverUrl: string;
  mapKey: string | null;
  /** Layer id to the key of the dataset published from it. */
  layerKeys: Record<string, string>;
}

/** Sub-keys of the saved blob, as listed in `PUBLISHABLE_PLUGIN_SETTINGS`. */
export const GEOLENS_PROJECT_STATE_KEYS = ["serverUrl", "mapKey", "layerKeys"] as const;

// The shape the manifest schema accepts for a key.
const PUBLISH_KEY_RE = /^[a-z0-9][a-z0-9._-]{0,127}$/;

// A project has far fewer layers than this; the bounds keep a hand-edited file
// from filling the saved state.
const MAX_LAYER_KEYS = 500;
const MAX_LAYER_ID_LENGTH = 256;

function isLayerId(value: string): boolean {
  return value.length > 0 && value.length <= MAX_LAYER_ID_LENGTH;
}

let state: GeoLensProjectState = emptyState();

function emptyState(): GeoLensProjectState {
  return { serverUrl: "", mapKey: null, layerKeys: {} };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPublishKey(value: unknown): value is string {
  return typeof value === "string" && PUBLISH_KEY_RE.test(value);
}

/** A server URL that carries no userinfo, query or fragment, or "". */
function cleanServerUrl(value: unknown): string {
  if (typeof value !== "string") return "";
  const normalized = normalizeBaseUrl(value);
  if (!normalized) return "";
  try {
    const parsed = new URL(normalized);
    if (parsed.username || parsed.password || parsed.search || parsed.hash) return "";
  } catch {
    return "";
  }
  return normalized;
}

/**
 * Reduce an untrusted value (a project file, a caller) to the state shape.
 * Unknown fields and values that are not well-formed keys are dropped, so
 * nothing else a project file carries under this plugin id survives a load.
 */
export function normalizeGeoLensProjectState(value: unknown): GeoLensProjectState {
  if (!isRecord(value)) return emptyState();
  // fromEntries defines own properties, so a layer id such as "__proto__" is
  // kept as data instead of setting the prototype.
  const layerKeys: Record<string, string> = isRecord(value.layerKeys)
    ? Object.fromEntries(
        Object.entries(value.layerKeys)
          .filter(([layerId, key]) => isLayerId(layerId) && isPublishKey(key))
          .slice(0, MAX_LAYER_KEYS) as [string, string][],
      )
    : {};
  // Publish keys belong to one server, so without a valid URL there is nothing
  // to remember.
  const serverUrl = cleanServerUrl(value.serverUrl);
  if (!serverUrl) return emptyState();
  return {
    serverUrl,
    mapKey: isPublishKey(value.mapKey) ? value.mapKey : null,
    layerKeys,
  };
}

export function getGeoLensProjectState(): GeoLensProjectState {
  return { ...state, layerKeys: { ...state.layerKeys } };
}

export function setGeoLensProjectState(next: unknown): void {
  state = normalizeGeoLensProjectState(next);
}

/** The blob to save, or undefined when there is nothing to remember. */
export function snapshotGeoLensProjectState(): GeoLensProjectState | undefined {
  if (!state.serverUrl && state.mapKey === null && Object.keys(state.layerKeys).length === 0) {
    return undefined;
  }
  return getGeoLensProjectState();
}
