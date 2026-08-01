// The wire protocol for the embed API: the versioned `postMessage` conversation
// a host page (a portal, an ERP, a dashboard) has with a framed GeoLibre at
// runtime, instead of encoding everything in the initial URL (issue #1462).
//
// This module is deliberately pure — no window, no store, no map — so the
// envelope, the origin allowlist, and every verb payload are unit-testable. The
// runtime wiring lives in `hooks/useEmbedApi.ts`.
//
// Relationship to the other bridges: `useEmbedBridge`/`useCommandBridge` speak an
// unversioned, fully-trusted protocol with the GeoLibre Jupyter widget, which
// owns the page it embeds. The embed API is the opposite situation — a host that
// GeoLibre does not control — so it is off unless the deployment names the
// origins it trusts, and every message is checked against that list.

import type { Feature, Geometry } from "geojson";
import { LAYER_TYPES, hasRestorableLayerSource, validateMapExpression } from "@geolibre/core";
import type { GeoLibreLayer } from "@geolibre/core";
import { EMBED_API_SOURCE, EMBED_API_VERSION, type AddLayerSpec } from "@geolibre/embed";

export { EMBED_API_SOURCE, EMBED_API_VERSION };
/** Versions understood by the app. V1 remains accepted for existing hosts. */
export const SUPPORTED_EMBED_API_VERSIONS = [1, EMBED_API_VERSION] as const;

/**
 * Deployment variable naming the origins allowed to drive a framed app.
 * Comma- or whitespace-separated, e.g. `https://erp.example.com,https://portal.example.com`.
 * A single `*` allows any origin and is only appropriate on a private network.
 */
export const EMBED_ORIGINS_ENV = "VITE_GEOLIBRE_EMBED_ORIGINS";

/** Any-origin wildcard accepted in the allowlist. */
export const EMBED_ORIGIN_WILDCARD = "*";

type EnvRecord = Record<string, string | undefined> | undefined;

/**
 * Normalize an allowlist value into a list of origins.
 *
 * Entries may be written as bare origins (`https://erp.example.com`) or as any
 * URL on that origin (`https://erp.example.com/app/`); both normalize to the
 * origin. Entries that are not parseable as an origin are dropped rather than
 * silently widening the list.
 *
 * @param raw - The configured value, typically a comma-separated string.
 * @returns Deduplicated origins, possibly containing {@link EMBED_ORIGIN_WILDCARD}.
 */
export function parseEmbedOrigins(raw: unknown): string[] {
  if (typeof raw !== "string") return [];
  const origins: string[] = [];
  for (const entry of raw.split(/[\s,]+/)) {
    const value = entry.trim();
    if (!value) continue;
    if (value === EMBED_ORIGIN_WILDCARD) {
      if (!origins.includes(EMBED_ORIGIN_WILDCARD)) origins.push(EMBED_ORIGIN_WILDCARD);
      continue;
    }
    let origin: string;
    try {
      origin = new URL(value).origin;
    } catch {
      continue;
    }
    // `new URL("mailto:a@b").origin` is the string "null"; reject those rather
    // than storing a value that can never match a real host.
    if (!origin || origin === "null") continue;
    if (!origins.includes(origin)) origins.push(origin);
  }
  return origins;
}

/**
 * Read the configured embed-API origin allowlist.
 *
 * Checks the Docker entrypoint's runtime config (`__GEOLIBRE_DEPLOYMENT_ENV__`,
 * so an operator can set it with `-e GEOLIBRE_EMBED_ORIGINS=...` without
 * rebuilding) before the build-time Vite env.
 *
 * @param viteEnv - Build-time env; defaults to `import.meta.env`.
 * @param deploymentEnv - Runtime env; defaults to the value the Docker image
 *   writes onto `window`.
 * @returns The allowed origins, empty when the API is not enabled.
 */
export function readEmbedOrigins(viteEnv?: EnvRecord, deploymentEnv?: EnvRecord): string[] {
  const runtime =
    deploymentEnv ??
    (typeof window === "undefined"
      ? undefined
      : (window as unknown as { __GEOLIBRE_DEPLOYMENT_ENV__?: EnvRecord })
          .__GEOLIBRE_DEPLOYMENT_ENV__);
  const fromRuntime = parseEmbedOrigins(runtime?.[EMBED_ORIGINS_ENV]);
  if (fromRuntime.length > 0) return fromRuntime;
  const build = viteEnv ?? (import.meta.env as EnvRecord);
  return parseEmbedOrigins(build?.[EMBED_ORIGINS_ENV]);
}

/**
 * Whether `origin` may talk to the embed API.
 *
 * @param origin - `MessageEvent.origin` of an inbound message.
 * @param allowed - The configured allowlist.
 * @returns True when the origin is listed (or the list is the wildcard).
 */
export function isEmbedOriginAllowed(
  origin: string | null | undefined,
  allowed: string[],
): boolean {
  if (allowed.length === 0) return false;
  if (allowed.includes(EMBED_ORIGIN_WILDCARD)) return true;
  if (!origin) return false;
  return allowed.includes(origin);
}

/** Camera target for {@link EmbedCommand} `setView`. */
export type EmbedViewTarget =
  | { kind: "bbox"; bbox: [number, number, number, number] }
  | {
      kind: "camera";
      center?: [number, number];
      zoom?: number;
      bearing?: number;
      pitch?: number;
      duration?: number;
    };

/** Which features `highlightFeature` should mark. */
export interface EmbedHighlightTarget {
  layerId: string;
  featureIds: string[];
  /** Property equality pairs; a feature matches when every pair matches. */
  filter: Record<string, unknown> | null;
  /** Zoom the map to the highlighted features. */
  fit: boolean;
}

/** A validated host → app command. */
export type EmbedCommand =
  | { type: "loadProject"; url: string }
  | { type: "setView"; target: EmbedViewTarget }
  | { type: "highlightFeature"; target: EmbedHighlightTarget }
  | { type: "openTool"; id: string; params: Record<string, string> }
  | { type: "setLayerVisibility"; layerId: string; visible: boolean }
  | { type: "listLayers" }
  | { type: "setFilter"; layerId: string; expression: unknown[] | null }
  | { type: "getViewport" }
  | { type: "addLayer"; spec: AddLayerSpec }
  | { type: "exportImage" };

/** A parsed inbound message: the command plus the host's correlation id. */
export interface EmbedRequest {
  command: EmbedCommand;
  /** Echoed back in the `ack` event when the host supplied one. */
  requestId: string | null;
}

/** App → host event names. */
export type EmbedEventType =
  | "ready"
  | "ack"
  | "projectLoaded"
  | "selectionChanged"
  | "viewChanged"
  | "toolCompleted"
  | "serverFileWritten";

/** An app → host message, ready to hand to `postMessage`. */
export interface EmbedEvent {
  v: number;
  source: typeof EMBED_API_SOURCE;
  type: EmbedEventType;
  payload: Record<string, unknown>;
}

/**
 * Build an app → host message envelope.
 *
 * @param type - The event name.
 * @param payload - Event data; must be structured-clone-safe.
 */
export function buildEmbedEvent(
  type: EmbedEventType,
  payload: Record<string, unknown>,
  version: 1 | 2 = EMBED_API_VERSION,
): EmbedEvent {
  return { v: version, source: EMBED_API_SOURCE, type, payload };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function coordinatePair(value: unknown): [number, number] | null {
  if (!Array.isArray(value) || value.length !== 2) return null;
  const lng = finiteNumber(value[0]);
  const lat = finiteNumber(value[1]);
  return lng === null || lat === null ? null : [lng, lat];
}

function boundingBox(value: unknown): [number, number, number, number] | null {
  if (!Array.isArray(value) || value.length !== 4) return null;
  const numbers = value.map(finiteNumber);
  if (numbers.some((entry) => entry === null)) return null;
  return numbers as [number, number, number, number];
}

/**
 * Whether a URL is safe to fetch a project from: an absolute http(s) URL or a
 * path on the app's own origin. Blocks `javascript:`, `data:`, and friends, the
 * same rule the scripting API applies to basemap URLs.
 */
function isFetchableUrl(value: unknown): value is string {
  return typeof value === "string" && (/^https?:\/\//i.test(value) || value.startsWith("/"));
}

/** Normalize a feature id the host may send as a string or a number. */
function featureIdString(value: unknown): string | null {
  if (typeof value === "string" && value) return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function parseSetView(payload: Record<string, unknown>): EmbedViewTarget | null {
  const bbox = boundingBox(payload.bbox ?? payload.bounds);
  if (bbox) return { kind: "bbox", bbox };
  const center = coordinatePair(payload.center);
  const zoom = finiteNumber(payload.zoom);
  const bearing = finiteNumber(payload.bearing);
  const pitch = finiteNumber(payload.pitch);
  const duration = finiteNumber(payload.duration);
  // At least one camera property is required; an empty payload is a no-op the
  // host almost certainly did not mean, so it is reported as an error instead.
  if (!center && zoom === null && bearing === null && pitch === null) return null;
  return {
    kind: "camera",
    ...(center ? { center } : {}),
    ...(zoom === null ? {} : { zoom }),
    ...(bearing === null ? {} : { bearing }),
    ...(pitch === null ? {} : { pitch }),
    ...(duration === null ? {} : { duration }),
  };
}

function parseHighlight(payload: Record<string, unknown>): EmbedHighlightTarget | null {
  const layerId = typeof payload.layerId === "string" ? payload.layerId : "";
  if (!layerId) return null;
  const ids: string[] = [];
  const single = featureIdString(payload.featureId);
  if (single !== null) ids.push(single);
  if (Array.isArray(payload.featureIds)) {
    for (const entry of payload.featureIds) {
      const id = featureIdString(entry);
      if (id !== null && !ids.includes(id)) ids.push(id);
    }
  }
  const filter = isRecord(payload.filter) ? payload.filter : null;
  // Clearing the highlight is expressed as `{layerId}` with neither ids nor a
  // filter, so an empty target is valid here (unlike setView).
  return { layerId, featureIds: ids, filter, fit: payload.fit === true };
}

function parseToolParams(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  const params: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    // Tool forms are string-valued (the same shape `?tool=` prefill produces),
    // so numbers and booleans are stringified and anything else is dropped.
    if (typeof entry === "string") params[key] = entry;
    else if (typeof entry === "number" && Number.isFinite(entry)) params[key] = String(entry);
    else if (typeof entry === "boolean") params[key] = String(entry);
  }
  return params;
}

/**
 * Compile a host-sent `setFilter` expression through the MapLibre style spec —
 * the same check the Expression Builder runs — and describe the problem, or
 * null when it is a usable filter.
 *
 * `setFilter` stores its expression as `layer.embedFilter`, which `layer-sync`
 * merges into every render layer's filter (`["all", <geometry>, …]`). A
 * malformed one cannot be reported from there: the store write always succeeds,
 * so the host would get `ok: true` and the failure would surface later, on a
 * `setFilter` call the host is no longer waiting on — or not at all. Compiling
 * here keeps the ack honest ("ok" means the map now filters on this).
 *
 * @param expression - The array the host sent.
 * @returns The compile problem, or null when the expression is usable.
 */
function filterExpressionProblem(expression: unknown[]): string | null {
  let source: string;
  try {
    source = JSON.stringify(expression);
  } catch {
    // Structured clone preserves cycles, so an array that cannot be serialized
    // can genuinely arrive here.
    return "the expression is not serializable";
  }
  const validation = validateMapExpression(source, { expectedType: "boolean" });
  if (validation.ok) return null;
  return validation.errors.join("; ") || "not a MapLibre filter expression";
}

/**
 * Whether an `addLayer` spec carries anything the map could actually render:
 * a re-fetchable source (`url`, `data`, `tiles[]`, `metadata.originalUrl` — the
 * same predicate the Layer Library uses) or inline features, either on the spec
 * or as a `data` object on the source.
 *
 * Without this a spec whose `source` does not match its `type` (say `xyz` with
 * no `tiles`) would be acked as a success, pushed into the store, listed by
 * `listLayers`, and then quietly render nothing — `layer-sync` has no fallback
 * for a source it cannot read. Rejecting it here turns that into an error the
 * host sees on the call it made.
 */
function hasRenderableEmbedSource(spec: Record<string, unknown>): boolean {
  if (isRecord(spec.geojson)) return true;
  const source = isRecord(spec.source) ? spec.source : {};
  // Inline GeoJSON is an object on `source.data`, which the string-valued
  // `hasRestorableLayerSource` check below does not count.
  if (isRecord(source.data)) return true;
  return hasRestorableLayerSource({
    source,
    metadata: isRecord(spec.metadata) ? spec.metadata : {},
  });
}

/**
 * Validate an inbound `postMessage` payload as an embed-API request.
 *
 * A message must carry the protocol version and a known verb; anything else
 * (including the app's own outbound events, which carry `source`) is ignored so
 * the API can share a window with unrelated postMessage traffic.
 *
 * @param data - `MessageEvent.data`.
 * @returns The parsed request, `{command: null}` shaped as an error when the
 *   verb is known but its payload is invalid, or null when the message is not
 *   addressed to this API at all.
 */
export function parseEmbedRequest(
  data: unknown,
): EmbedRequest | { error: string; requestId: string | null } | null {
  if (!isRecord(data)) return null;
  if (!(SUPPORTED_EMBED_API_VERSIONS as readonly unknown[]).includes(data.v)) return null;
  if (typeof data.type !== "string") return null;
  // Our own events echo back when the host relays them; never treat one as a
  // command.
  if (data.source === EMBED_API_SOURCE) return null;
  const requestId = typeof data.requestId === "string" ? data.requestId : null;
  const payload = isRecord(data.payload) ? data.payload : {};
  const fail = (error: string) => ({ error, requestId });

  switch (data.type) {
    case "loadProject": {
      if (!isFetchableUrl(payload.url)) {
        return fail("loadProject: url must be an http(s) or root-relative URL");
      }
      return { command: { type: "loadProject", url: payload.url }, requestId };
    }
    case "setView": {
      const target = parseSetView(payload);
      if (!target) return fail("setView: expected a bbox or a center/zoom camera");
      return { command: { type: "setView", target }, requestId };
    }
    case "highlightFeature": {
      const target = parseHighlight(payload);
      if (!target) return fail("highlightFeature: layerId must be a non-empty string");
      return { command: { type: "highlightFeature", target }, requestId };
    }
    case "openTool": {
      const id = typeof payload.id === "string" ? payload.id : "";
      if (!id) return fail("openTool: id must be a non-empty string");
      return {
        command: { type: "openTool", id, params: parseToolParams(payload.params) },
        requestId,
      };
    }
    case "setLayerVisibility": {
      const layerId = typeof payload.layerId === "string" ? payload.layerId : "";
      if (!layerId || typeof payload.visible !== "boolean") {
        return fail("setLayerVisibility: expected layerId and boolean visible");
      }
      return {
        command: { type: "setLayerVisibility", layerId, visible: payload.visible },
        requestId,
      };
    }
    case "listLayers":
      return { command: { type: "listLayers" }, requestId };
    case "setFilter": {
      const layerId = typeof payload.layerId === "string" ? payload.layerId : "";
      const expression = payload.expression;
      if (!layerId || (expression !== null && !Array.isArray(expression))) {
        return fail("setFilter: expected layerId and a MapLibre expression array or null");
      }
      if (expression !== null) {
        const problem = filterExpressionProblem(expression);
        if (problem) return fail(`setFilter: ${problem}`);
      }
      return {
        command: { type: "setFilter", layerId, expression },
        requestId,
      };
    }
    case "getViewport":
      return { command: { type: "getViewport" }, requestId };
    case "addLayer": {
      const spec = payload.spec;
      if (
        !isRecord(spec) ||
        typeof spec.id !== "string" ||
        !spec.id ||
        typeof spec.name !== "string" ||
        !spec.name ||
        typeof spec.type !== "string" ||
        !LAYER_TYPES.includes(spec.type as (typeof LAYER_TYPES)[number]) ||
        !isRecord(spec.source) ||
        (spec.visible !== undefined && typeof spec.visible !== "boolean") ||
        (spec.opacity !== undefined &&
          (typeof spec.opacity !== "number" ||
            !Number.isFinite(spec.opacity) ||
            spec.opacity < 0 ||
            spec.opacity > 1)) ||
        (spec.style !== undefined && !isRecord(spec.style)) ||
        (spec.metadata !== undefined && !isRecord(spec.metadata)) ||
        (spec.geojson !== undefined && !isRecord(spec.geojson)) ||
        (spec.beforeId !== undefined && typeof spec.beforeId !== "string")
      ) {
        return fail("addLayer: invalid project layer specification");
      }
      if (!hasRenderableEmbedSource(spec)) {
        return fail(
          `addLayer: a "${spec.type}" layer needs a source with a url, tiles, or inline data`,
        );
      }
      return {
        command: { type: "addLayer", spec: spec as unknown as AddLayerSpec },
        requestId,
      };
    }
    case "exportImage":
      return { command: { type: "exportImage" }, requestId };
    default:
      return null;
  }
}

/**
 * Resolve the feature ids a highlight target names within a layer's features.
 *
 * Ids are resolved against the layer, not taken on trust: an explicit id is kept
 * only when a feature carries it under the same `String(feature.id ?? index)`
 * convention the map controller uses, and a `filter` selects every feature whose
 * properties equal all of the filter's pairs. An id that names nothing is
 * dropped here so the caller can tell a real match from a typo (or from a layer
 * whose features are not readable at all) rather than selecting a phantom.
 *
 * @param features - The layer's features, in map order. Only ids and properties
 *   are read, so a null-geometry feature (an attribute-only table) is accepted.
 * @param target - The parsed highlight target.
 * @returns Feature ids to highlight, in feature order for filter matches.
 */
export function resolveHighlightIds(
  features: Feature<Geometry | null>[],
  target: EmbedHighlightTarget,
): string[] {
  const known = new Set(features.map((feature, index) => String(feature.id ?? index)));
  const ids = target.featureIds.filter((id) => known.has(id));
  if (!target.filter) return ids;
  const pairs = Object.entries(target.filter);
  features.forEach((feature, index) => {
    const properties = (feature.properties ?? {}) as Record<string, unknown>;
    // Compare stringified values so a host that reads its ids from JSON (where
    // "42" and 42 are both plausible) still matches.
    const matches = pairs.every(([key, value]) => {
      const actual = properties[key];
      return (
        actual === value || (actual != null && value != null && String(actual) === String(value))
      );
    });
    if (!matches) return;
    const id = String(feature.id ?? index);
    if (!ids.includes(id)) ids.push(id);
  });
  return ids;
}

/**
 * Resolve the layer a command names, or throw the message the host receives in
 * its `ack`. Shared by `setLayerVisibility`, `setFilter`, and `highlightFeature`
 * so a stale layer id fails the same way for all three.
 *
 * @param layers - The store's layers.
 * @param layerId - The id the host sent.
 */
export function requireEmbedLayer(layers: GeoLibreLayer[], layerId: string): GeoLibreLayer {
  const layer = layers.find((item) => item.id === layerId);
  if (!layer) throw new Error(`No layer with id "${layerId}"`);
  return layer;
}

/** One entry of the `listLayers` result. */
export interface EmbedLayerSummary {
  id: string;
  name: string;
  type: string;
  visible: boolean;
  opacity: number;
}

/**
 * Project the store's layers down to the fields `listLayers` returns. Kept
 * narrow deliberately: the full layer record carries styles, features, and
 * local file paths that a host has no business reading.
 *
 * @param layers - The store's layers, in map order.
 */
export function embedLayerSummaries(layers: GeoLibreLayer[]): EmbedLayerSummary[] {
  return layers.map(({ id, name, type, visible, opacity }) => ({
    id,
    name,
    type,
    visible,
    opacity,
  }));
}

/**
 * Build the store layer an `addLayer` spec describes.
 *
 * The spec was already validated by {@link parseEmbedRequest}; the checks
 * repeated here are the ones that need the current store — a duplicate id — plus
 * the layer-type gate, which stays as a second line of defence because the cast
 * below is what puts the value in front of every renderer.
 *
 * @param spec - The validated spec from the host.
 * @param layers - The store's current layers, checked for an id collision.
 * @throws When the id is taken or the type is not a known layer type.
 */
export function buildEmbedLayer(spec: AddLayerSpec, layers: GeoLibreLayer[]): GeoLibreLayer {
  if (layers.some((layer) => layer.id === spec.id)) {
    throw new Error(`A layer with id "${spec.id}" already exists`);
  }
  if (!(LAYER_TYPES as readonly string[]).includes(spec.type)) {
    throw new Error(`Unsupported layer type "${spec.type}"`);
  }
  return {
    id: spec.id,
    name: spec.name,
    type: spec.type as GeoLibreLayer["type"],
    source: spec.source,
    visible: spec.visible ?? true,
    opacity: spec.opacity ?? 1,
    style: (spec.style ?? {}) as unknown as GeoLibreLayer["style"],
    metadata: spec.metadata ?? {},
    ...(spec.geojson ? { geojson: spec.geojson as GeoLibreLayer["geojson"] } : {}),
    ...(spec.beforeId ? { beforeId: spec.beforeId } : {}),
  };
}
