/**
 * Pre-flight readiness check for a shared project.
 *
 * A `.geolibre.json` is mostly references. The publish path embeds local vector
 * data so that much of a shared project is self-contained, but every tile
 * template, COG, PMTiles endpoint, OGC service, and hosted feature service
 * stays a URL. So a project can upload cleanly and still render empty for every
 * recipient: the service wanted a token the author holds and the upload strips,
 * the host sends no cross-origin headers so it works in the desktop app and
 * fails in the browser viewer, or the reference never left the author's machine
 * at all.
 *
 * This module answers "will this load for someone else?" before the upload, and
 * only informs: an author sharing an intranet map with intranet colleagues is
 * doing the right thing and must not have to fight a warning.
 *
 * Two halves, kept separate so the classification is pure and testable:
 *
 * 1. {@link collectShareSources} walks the layers the way the publish path does
 *    and buckets every reference it finds.
 * 2. {@link probeShareSources} resolves the ones that can only be settled over
 *    the network, with the author's credentials deliberately withheld.
 *
 * The probes run through the *browser's* `fetch`, never the desktop app's
 * native HTTP bypass, precisely so a cross-origin rejection surfaces as one
 * rather than being masked by a request that is not subject to CORS. That is
 * also what the recipient's browser will do.
 */

import {
  isAbsoluteFilesystemPath,
  isCredentialFieldName,
  isGooglePhotorealisticTilesetUrl,
  MAX_REDACT_DEPTH,
  redactUrlCredentials,
  type GeoLibreLayer,
} from "@geolibre/core";
import { classifyFetchFailure } from "./fetch-error";

/** How a reference will behave for a recipient. */
export type ShareSourceStatus =
  /** Answered anonymously; a recipient's browser can fetch it. */
  | "reachable"
  /** Needs a credential the recipient will not have. */
  | "credentialed"
  /** Not fetchable from a browser: no cross-origin headers, or host unreachable. */
  | "blocked"
  /** Answered "not found": an expired, moved, or mistyped reference. */
  | "missing"
  /** A filesystem path or a private-network address. */
  | "local"
  /** Not settled: timed out, or past the probe budget. */
  | "unchecked";

/** Why a reference got its status, so the UI can pick its own wording. */
export type ShareSourceReason =
  | "ok"
  /** The URL or a layer field carries a credential the upload removes. */
  | "credential-stripped"
  /** The service itself answered 401/403 without the author's credentials. */
  | "auth-required"
  | "cors"
  | "not-found"
  | "local-file"
  | "private-host"
  /** The layer has no reference a recipient could resolve at all. */
  | "no-source"
  | "timeout"
  /** The caller cancelled, e.g. the dialog closed mid-check. */
  | "aborted"
  /** Never requested: past the probe cap, or no `fetch` to request with. */
  | "probe-budget";

/** One reference found in the project, before or after probing. */
export interface ShareSourceRef {
  /** Owning layer id, or null for a project-level reference. */
  layerId: string | null;
  /**
   * The layer's name, or empty for a project-level reference, whose label the
   * UI derives from {@link ShareSourceRef.field}. Keeping the localized strings
   * out of here is what lets the check run without depending on the translation
   * function, so switching language never re-issues the probes.
   */
  label: string;
  /** Where in the project the reference sits, e.g. `source.tiles[0]`. */
  field: string;
  /** The reference as written in the project. */
  url: string;
  /**
   * What a probe should request, or null when the verdict is already settled
   * without the network. Tile templates resolve to their origin (see
   * {@link probeTargetFor}).
   */
  probeUrl: string | null;
  status: ShareSourceStatus;
  reason: ShareSourceReason;
}

/** One row in the dialog: a layer (or project field) and its worst verdict. */
export interface ShareReadinessItem {
  layerId: string | null;
  /** Empty for a project-level row; see {@link ShareSourceRef.label}. */
  label: string;
  /** Where the reference sits, so the UI can label a project-level row. */
  field: string;
  status: ShareSourceStatus;
  reason: ShareSourceReason;
  /** The reference that produced the verdict, for the detail line. */
  url: string;
}

export interface ShareReadinessReport {
  /** One entry per layer or project field that holds a checkable reference. */
  items: ShareReadinessItem[];
  /** Entries whose status is anything but `reachable`, worst first. */
  problems: ShareReadinessItem[];
  /** Distinct targets actually requested. */
  probeCount: number;
  /** True when the probe budget cut the check short. */
  truncated: boolean;
}

/** What the check needs from the app: the layers plus project-level URLs. */
export interface ShareReadinessInput {
  layers: readonly GeoLibreLayer[];
  basemapStyleUrl?: string | null;
  pluginManifestUrls?: readonly string[];
  /**
   * Layers whose data the publish path embeds, so their local origin is not a
   * problem for a recipient. Supplied by the caller from the same predicate the
   * publish path uses, rather than re-derived here.
   *
   * Known limitation: the predicate says the layer *can* be embedded, not that
   * the upload's `materializeEmbeddableVectorLayers` will succeed in reading it
   * back. Data it cannot read (a streamed GeoParquet, or a control that has not
   * been created yet) is dropped from the upload, and such a layer would ship
   * with neither a URL nor features while this check has already cleared it.
   * Settling that would mean exporting every local vector layer through DuckDB
   * on dialog open, which is the cost the check is designed to avoid, so the
   * narrow unreadable-local-data case is accepted as a false negative.
   */
  embeddedLayerIds?: ReadonlySet<string>;
}

export interface ShareProbeOptions {
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  /** Per-request budget. Kept short: the dialog must not hang on a slow host. */
  timeoutMs?: number;
  /** Cap on distinct targets requested. */
  maxProbes?: number;
}

/**
 * Short enough that a whole check finishes while the author is still reading
 * the title field, and short enough that one dead host cannot stall the rest.
 */
export const SHARE_PROBE_TIMEOUT_MS = 6000;

/**
 * Distinct targets to request. Templates collapse to their origin and every
 * target is de-duplicated, so a large project usually stays well under this;
 * the cap only bites on a project that genuinely spans many hosts, where the
 * remainder is reported as unchecked rather than silently dropped.
 */
export const SHARE_MAX_PROBES = 16;

/** Worst first. Drives both the aggregate verdict and the report ordering. */
const STATUS_SEVERITY: Record<ShareSourceStatus, number> = {
  local: 5,
  credentialed: 4,
  missing: 3,
  blocked: 2,
  unchecked: 1,
  reachable: 0,
};

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Whether a credential-named field actually holds something. */
function isPopulated(value: unknown): boolean {
  if (typeof value === "string") return value.trim() !== "";
  if (Array.isArray(value)) return value.length > 0;
  if (isPlainObject(value)) return Object.keys(value).length > 0;
  return value !== null && value !== undefined;
}

/**
 * Whether a layer's configuration carries a populated credential field. Those
 * fields are removed by `redactProjectCredentials` on the way out, so whatever
 * they unlock is unavailable to the recipient even though the URL survives
 * intact. An empty `headers: {}` is skipped: redaction drops it too, but it
 * unlocks nothing, and warning about it would be noise.
 */
function hasCredentialField(value: unknown, depth = 0): boolean {
  // Exactly as deep as the redaction pass descends, so a credential nested
  // deeply enough to escape this scan but not that one cannot exist.
  if (depth >= MAX_REDACT_DEPTH) return false;
  if (Array.isArray(value)) return value.some((item) => hasCredentialField(item, depth + 1));
  if (!isPlainObject(value)) return false;
  for (const [key, nested] of Object.entries(value)) {
    if (isCredentialFieldName(key) && isPopulated(nested)) return true;
    if (hasCredentialField(nested, depth + 1)) return true;
  }
  return false;
}

/**
 * Whether a hostname only resolves on the author's machine or network.
 *
 * Covers loopback, the RFC 1918 and link-local ranges, the RFC 6598
 * carrier-grade NAT range that some corporate networks use for internal
 * addressing, IPv6 unique-local and link-local literals, the reserved intranet
 * suffixes, and a bare single-label hostname (`gis-server`), which by
 * definition needs the author's search domain to resolve.
 */
export function isPrivateHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  if (host === "") return false;
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host === "::1" || host === "0.0.0.0") return true;
  if (
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host.endsWith(".intranet") ||
    host.endsWith(".home.arpa")
  ) {
    return true;
  }
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (ipv4) {
    const first = Number(ipv4[1]);
    const second = Number(ipv4[2]);
    if (first === 10 || first === 127) return true;
    if (first === 172 && second >= 16 && second <= 31) return true;
    if (first === 192 && second === 168) return true;
    if (first === 169 && second === 254) return true;
    // RFC 6598, 100.64.0.0/10.
    if (first === 100 && second >= 64 && second <= 127) return true;
    return false;
  }
  // Only an IPv6 literal can carry these prefixes; a registered domain may
  // legitimately start with "fd" or "fe80".
  if (host.includes(":")) {
    return /^f[cd][0-9a-f]{0,2}:/.test(host) || host.startsWith("fe80:");
  }
  // A single-label name has no public DNS answer.
  return !host.includes(".");
}

/** Whether a URL still holds a tile/service placeholder such as `{z}`. */
function isTemplateUrl(url: string): boolean {
  return /\{[a-z0-9_-]+\}/i.test(url);
}

/**
 * What to actually request for a reference.
 *
 * A tile template cannot be fetched literally, and substituting a nominal
 * `0/0/0` tile would 404 on any service whose data starts deeper, reporting a
 * healthy basemap as missing. The origin answers the questions this check
 * actually asks anyway: is the host up, does it send cross-origin headers, does
 * it demand a credential. Collapsing to the origin is also what makes the probe
 * budget hold for a project with dozens of tile layers on one host.
 */
export function probeTargetFor(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  return isTemplateUrl(url) ? parsed.origin : parsed.toString();
}

interface Classification {
  status: ShareSourceStatus;
  reason: ShareSourceReason;
  probeUrl: string | null;
}

/**
 * Settle what can be settled from the reference alone. Returns null for a
 * reference that carries no information for a recipient (an inline `data:`
 * payload, an app-relative path), which the caller drops rather than reports.
 */
function classifyReference(url: string): Classification | null {
  const value = url.trim();
  if (value === "") return null;
  // Inline payloads travel inside the project file; nothing to check.
  if (value.startsWith("data:")) return null;
  // A blob URL is this session's copy of a file the recipient does not have.
  if (value.startsWith("blob:")) {
    return { status: "local", reason: "local-file", probeUrl: null };
  }
  if (value.startsWith("file://") || isAbsoluteFilesystemPath(value)) {
    return { status: "local", reason: "local-file", probeUrl: null };
  }
  if (!/^https?:\/\//i.test(value)) {
    // A relative reference resolves against wherever the project is opened, so
    // it is neither obviously broken nor checkable. Say nothing about it.
    return null;
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (isPrivateHostname(parsed.hostname)) {
    return { status: "local", reason: "private-host", probeUrl: null };
  }
  // The upload strips these, so the recipient gets the URL without the secret.
  // Probing would only confirm what the redaction rules already guarantee.
  if (redactUrlCredentials(value) !== value) {
    return { status: "credentialed", reason: "credential-stripped", probeUrl: null };
  }
  if (isGooglePhotorealisticTilesetUrl(value)) {
    // The key rides in a request header that is stripped before persisting, so
    // the tileset is authored-working and recipient-broken by design.
    return { status: "credentialed", reason: "credential-stripped", probeUrl: null };
  }
  return { status: "unchecked", reason: "ok", probeUrl: probeTargetFor(value) };
}

/** Every place a layer can hide a reference a renderer will actually fetch. */
function layerReferences(layer: GeoLibreLayer): { field: string; url: string }[] {
  const source = layer.source ?? {};
  const metadata = layer.metadata ?? {};
  const found: { field: string; url: string }[] = [];
  const push = (field: string, value: unknown) => {
    if (nonEmptyString(value)) found.push({ field, url: value.trim() });
  };

  push("source.url", source.url);
  // `data` is either a URL or an inline FeatureCollection; only the former is a
  // reference, and the latter is already excluded by the string check.
  push("source.data", source.data);
  push("source.baseUrl", source.baseUrl);
  push("source.arcgisQueryUrl", source.arcgisQueryUrl);
  if (Array.isArray(source.tiles)) {
    source.tiles.forEach((tile, index) => push(`source.tiles[${index}]`, tile));
  }
  if (Array.isArray(source.urls)) {
    source.urls.forEach((entry, index) => push(`source.urls[${index}]`, entry));
  }
  // The pre-resolution template, and the source of truth on reopen for an XYZ
  // layer whose `source.url` was rewritten this session.
  push("metadata.originalUrl", metadata.originalUrl);
  push("metadata.tileUrl", metadata.tileUrl);
  push("metadata.localFilePath", metadata.localFilePath);
  push("metadata.localBytesUrl", metadata.localBytesUrl);
  push("layer.sourcePath", layer.sourcePath);

  // De-duplicate: an XYZ layer commonly repeats one template across `source.url`,
  // `source.tiles[0]`, and `metadata.originalUrl`, and reporting it three times
  // would bury the layers that actually differ.
  const seen = new Set<string>();
  return found.filter((entry) => {
    if (seen.has(entry.url)) return false;
    seen.add(entry.url);
    return true;
  });
}

/** Whether the layer's features travel inside the project file. */
function carriesOwnData(layer: GeoLibreLayer, embeddedLayerIds?: ReadonlySet<string>): boolean {
  if (embeddedLayerIds?.has(layer.id)) return true;
  if (layer.geojson) return true;
  const metadata = layer.metadata ?? {};
  if (metadata.embeddedGeoJSON) return true;
  const data = (layer.source ?? {}).data;
  // An object is an inline GeoJSON payload; an array is the row set a
  // non-GeoJSON deck.gl visualization (arc, heatmap, hexagon built from a CSV)
  // keeps in `source.data`. Both travel inside the project file. Only a *string*
  // `data` is a URL, and that is a reference like any other.
  return isPlainObject(data) || Array.isArray(data);
}

/**
 * Walk the project and bucket every reference, settling everything that does
 * not need the network. References left `unchecked` with a non-null `probeUrl`
 * are what {@link probeShareSources} resolves.
 */
export function collectShareSources(input: ShareReadinessInput): ShareSourceRef[] {
  const refs: ShareSourceRef[] = [];

  for (const layer of input.layers) {
    const embedded = carriesOwnData(layer, input.embeddedLayerIds);
    const references = layerReferences(layer);
    if (embedded) {
      // Its data ships with the project, so whatever it also points at is not
      // what a recipient will render.
      continue;
    }
    if (references.length === 0) {
      // A query-backed layer (PostGIS, a DuckDB SQL layer, a sidecar result)
      // that neither embeds data nor names a URL resolves only where it was
      // authored.
      refs.push({
        layerId: layer.id,
        label: layer.name,
        field: "source",
        url: "",
        probeUrl: null,
        status: "local",
        reason: "no-source",
      });
      continue;
    }
    const credentialField = hasCredentialField(layer.source) || hasCredentialField(layer.metadata);
    for (const reference of references) {
      const classified = classifyReference(reference.url);
      if (!classified) continue;
      refs.push({
        layerId: layer.id,
        label: layer.name,
        field: reference.field,
        url: reference.url,
        ...(credentialField && classified.status === "unchecked"
          ? {
              probeUrl: null,
              status: "credentialed" as const,
              reason: "credential-stripped" as const,
            }
          : classified),
      });
    }
  }

  if (nonEmptyString(input.basemapStyleUrl)) {
    const classified = classifyReference(input.basemapStyleUrl);
    if (classified) {
      refs.push({
        layerId: null,
        label: "",
        field: "basemapStyleUrl",
        url: input.basemapStyleUrl.trim(),
        ...classified,
      });
    }
  }

  for (const [index, manifestUrl] of (input.pluginManifestUrls ?? []).entries()) {
    // Only absolute references: a bundled drop-in is served from the app itself
    // and resolves wherever the project is opened.
    if (!nonEmptyString(manifestUrl) || !/^https?:\/\//i.test(manifestUrl)) continue;
    const classified = classifyReference(manifestUrl);
    if (!classified) continue;
    refs.push({
      layerId: null,
      label: "",
      field: `plugins.manifestUrls[${index}]`,
      url: manifestUrl.trim(),
      ...classified,
    });
  }

  return refs;
}

type ProbeOutcome = Pick<ShareSourceRef, "status" | "reason">;

/** Statuses a HEAD may reject on while the resource itself is fine over GET. */
const RETRY_WITH_RANGED_GET = new Set([400, 403, 405, 501]);

function outcomeForStatus(status: number): ProbeOutcome {
  if (status === 401 || status === 403 || status === 407) {
    return { status: "credentialed", reason: "auth-required" };
  }
  if (status === 404 || status === 410) {
    return { status: "missing", reason: "not-found" };
  }
  if (status >= 500 || status === 429) {
    // Reachable, cross-origin headers present, but the service is unwell right
    // now. That is not a property of the shared project, so do not accuse it.
    return { status: "unchecked", reason: "ok" };
  }
  // Everything else — including a 400 from a service endpoint asked for its
  // bare URL — means the host answered and the browser was allowed to read it.
  return { status: "reachable", reason: "ok" };
}

async function probeTarget(
  target: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<ProbeOutcome> {
  // One deadline for the whole target rather than one per attempt, so a slow
  // host that refuses HEAD cannot spend the budget twice over.
  const timeout = AbortSignal.timeout(timeoutMs);
  const deadline = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const request = async (method: "HEAD" | "GET"): Promise<Response> =>
    fetchImpl(target, {
      method,
      // Withhold the author's ambient authority: the check must see what a
      // recipient sees, not what the author's cookies unlock.
      credentials: "omit",
      cache: "no-store",
      redirect: "follow",
      // One byte is enough to learn the status. Without the range, a
      // HEAD-refusing host would have a whole multi-gigabyte COG pulled down.
      ...(method === "GET" ? { headers: { Range: "bytes=0-0" } } : {}),
      signal: deadline,
    });

  try {
    const head = await request("HEAD");
    if (!RETRY_WITH_RANGED_GET.has(head.status)) return outcomeForStatus(head.status);
    // Plenty of object stores and CDNs refuse HEAD while serving GET happily,
    // so a one-byte ranged GET decides it rather than a false "needs a login".
    try {
      const ranged = await request("GET");
      return outcomeForStatus(ranged.status);
    } catch (error) {
      const failure = classifyFetchFailure(error);
      if (failure.kind === "abort") return { status: "unchecked", reason: "aborted" };
      if (failure.kind === "timeout") return { status: "unchecked", reason: "timeout" };
      // The HEAD already proved the host answers and lets this origin read the
      // response, so a rejection here is about the ranged request rather than
      // the host. `Range` is CORS-safelisted only for a simple byte range, and
      // an older webview may preflight it and get no matching
      // `Access-Control-Allow-Headers` back, even though the plain GET a
      // renderer issues would succeed. Fall back to what HEAD said instead of
      // reporting a working host as unreachable.
      return outcomeForStatus(head.status);
    }
  } catch (error) {
    const failure = classifyFetchFailure(error);
    if (failure.kind === "abort") return { status: "unchecked", reason: "aborted" };
    if (failure.kind === "timeout") return { status: "unchecked", reason: "timeout" };
    // The browser collapses a cross-origin rejection, a TLS failure, and an
    // unreachable host into one opaque error. All three mean the recipient's
    // browser cannot read this, which is the verdict that matters here.
    if (failure.kind === "network") return { status: "blocked", reason: "cors" };
    return { status: "unchecked", reason: "ok" };
  }
}

/**
 * Resolve the references {@link collectShareSources} left open, one request per
 * distinct target, in parallel and capped. Never throws: a check that fails is
 * reported as unchecked rather than blocking the share.
 */
export async function probeShareSources(
  refs: readonly ShareSourceRef[],
  options: ShareProbeOptions = {},
): Promise<{ refs: ShareSourceRef[]; probeCount: number; truncated: boolean }> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? SHARE_PROBE_TIMEOUT_MS;
  const maxProbes = options.maxProbes ?? SHARE_MAX_PROBES;

  // Insertion-ordered so the budget, when it bites, keeps the sources the
  // author sees first in the layer list rather than an arbitrary subset.
  const targets = new Set<string>();
  for (const ref of refs) {
    if (ref.status !== "unchecked" || !ref.probeUrl) continue;
    targets.add(ref.probeUrl);
  }
  const probed = [...targets].slice(0, maxProbes);
  const truncated = targets.size > probed.length;

  const outcomes = new Map<string, ProbeOutcome>();
  if (typeof fetchImpl === "function") {
    const results = await Promise.all(
      probed.map((target) => probeTarget(target, fetchImpl, timeoutMs, options.signal)),
    );
    probed.forEach((target, index) => outcomes.set(target, results[index]));
  }

  return {
    refs: refs.map((ref) => {
      if (ref.status !== "unchecked" || !ref.probeUrl) return ref;
      const outcome = outcomes.get(ref.probeUrl);
      if (!outcome) return { ...ref, reason: "probe-budget" };
      return { ...ref, ...outcome };
    }),
    probeCount: outcomes.size,
    truncated,
  };
}

/**
 * Fold the per-reference verdicts into one row per layer (or project field),
 * keeping the worst. A layer with three tile mirrors is one line in the dialog,
 * not three.
 */
export function summarizeShareSources(refs: readonly ShareSourceRef[]): ShareReadinessItem[] {
  const byOwner = new Map<string, ShareReadinessItem>();
  for (const ref of refs) {
    const key = ref.layerId ?? `${ref.field}:${ref.url}`;
    const existing = byOwner.get(key);
    const candidate: ShareReadinessItem = {
      layerId: ref.layerId,
      label: ref.label,
      field: ref.field,
      status: ref.status,
      reason: ref.reason,
      url: ref.url,
    };
    if (!existing || STATUS_SEVERITY[candidate.status] > STATUS_SEVERITY[existing.status]) {
      byOwner.set(key, candidate);
    }
  }
  return [...byOwner.values()];
}

/** Collect, probe, and summarize. What the Share dialog calls. */
export async function checkShareReadiness(
  input: ShareReadinessInput,
  options: ShareProbeOptions = {},
): Promise<ShareReadinessReport> {
  const collected = collectShareSources(input);
  const { refs, probeCount, truncated } = await probeShareSources(collected, options);
  const items = summarizeShareSources(refs);
  const problems = items
    .filter((item) => item.status !== "reachable")
    .sort((a, b) => STATUS_SEVERITY[b.status] - STATUS_SEVERITY[a.status]);
  return { items, problems, probeCount, truncated };
}
