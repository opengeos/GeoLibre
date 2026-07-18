// Plugin marketplace registry: fetches a curated index of installable external
// plugins and normalizes each entry. Installing an entry means recording its
// (absolute) manifest URL in the plugin manifest URL list, which the existing
// external-plugin loader then fetches and registers - the registry adds no new
// trust path. See docs/plugin-api.md and docs/roadmap.md.

import { isAllowedPluginManifestUrl } from "@geolibre/core";

/** A single curated plugin in the marketplace registry. */
export interface PluginRegistryEntry {
  id: string;
  name: string;
  version: string;
  /** Absolute manifest URL (resolved against the registry URL on load). */
  manifestUrl: string;
  description?: string;
  author?: string;
  homepage?: string;
  categories?: string[];
  /** Minimum GeoLibre app version this plugin supports, e.g. "1.0.0". */
  minGeoLibreVersion?: string;
}

export interface PluginRegistry {
  entries: PluginRegistryEntry[];
  /** Absolute URL the registry was fetched from. */
  registryUrl: string;
}

// The curated registry is hosted at plugins.geolibre.app (the geolibre-plugins
// repo, deployed to GitHub Pages). Override per build via env for forks or
// local testing.
const DEFAULT_REGISTRY_URL = "https://plugins.geolibre.app/plugin-registry.json";

/**
 * Resolve the registry URL. Honors VITE_GEOLIBRE_PLUGIN_REGISTRY_URL (resolved
 * against the app origin so a relative value works) and otherwise falls back to
 * the hosted default registry.
 */
export function resolveRegistryUrl(): string {
  const configured = import.meta.env.VITE_GEOLIBRE_PLUGIN_REGISTRY_URL;
  // Resolving a configured value needs window.location as its base; outside a
  // browser (tests, SSR, Node scripts) fall back to the absolute default, the
  // same way bundledPluginManifestUrls guards window access.
  if (configured && configured.trim() && typeof window !== "undefined") {
    return new URL(configured.trim(), window.location.href).href;
  }
  return DEFAULT_REGISTRY_URL;
}

// 5 MB ceiling on the registry payload. The Content-Length check is only a
// fast path; the streaming reader below is the real enforcement for chunked or
// compressed responses that omit the header.
const MAX_REGISTRY_BYTES = 5 * 1024 * 1024;

/**
 * Fetch and normalize the plugin registry. Entry manifest URLs are resolved to
 * absolute URLs against the registry location; malformed entries are dropped.
 * Throws on a failed fetch or non-array payload so the UI can surface the error.
 * Pass `signal` to cancel the request when the caller unmounts.
 */
export async function fetchPluginRegistry(
  registryUrl: string = resolveRegistryUrl(),
  signal?: AbortSignal,
): Promise<PluginRegistry> {
  // Bound the request so a slow or stalled registry endpoint cannot leave the
  // UI stuck in its loading state indefinitely. The timeout stays armed until
  // the body is consumed so a trickled response can't outlive the deadline.
  // An external signal (caller unmount) aborts the same controller.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  const onExternalAbort = () => controller.abort();
  signal?.addEventListener("abort", onExternalAbort, { once: true });
  if (signal?.aborted) controller.abort();
  try {
    const response = await fetch(registryUrl, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`Could not fetch plugin registry: HTTP ${response.status}`);
    }
    const text = await readBodyWithCap(response, MAX_REGISTRY_BYTES);
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      // A captive portal or misconfigured proxy can return an HTML body with a
      // 200 status; surface a clear message instead of a raw JSON SyntaxError.
      throw new Error("Could not fetch plugin registry: the response was not valid JSON.");
    }
    const rawEntries = extractEntries(payload);
    const entries = rawEntries
      .map((entry) => normalizeEntry(entry, registryUrl))
      .filter((entry): entry is PluginRegistryEntry => entry !== null);
    return { entries, registryUrl };
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", onExternalAbort);
  }
}

/**
 * Read a response body as text, enforcing a hard byte ceiling. The
 * Content-Length header is a fast-fail; the streaming reader is the real
 * enforcement for responses that omit it (chunked/compressed). Mirrors the
 * cap in fetchPluginText for plugin assets.
 */
async function readBodyWithCap(response: Response, maxBytes: number): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new Error("Could not fetch plugin registry: response exceeds the 5 MB size limit.");
  }
  const reader = response.body?.getReader();
  if (!reader) {
    // No stream available (some environments/test mocks). arrayBuffer() lets us
    // measure the byte length before decoding, so an oversized body is rejected
    // without first building the full string.
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > maxBytes) {
      throw new Error("Could not fetch plugin registry: response exceeds the 5 MB size limit.");
    }
    return new TextDecoder().decode(buffer);
  }
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        throw new Error("Could not fetch plugin registry: response exceeds the 5 MB size limit.");
      }
      chunks.push(value);
    }
  } catch (error) {
    // Release the stream lock on a mid-stream read failure (or the size abort
    // above) so the connection can be reused or collected.
    await reader.cancel().catch(() => {});
    throw error;
  }
  const merged = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

/** Accept either a bare array or `{ plugins: [...] }` / `{ entries: [...] }`. */
function extractEntries(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === "object") {
    const record = payload as Record<string, unknown>;
    if (Array.isArray(record.plugins)) return record.plugins;
    if (Array.isArray(record.entries)) return record.entries;
  }
  throw new Error(
    "Plugin registry must be an array or an object with a 'plugins' or 'entries' array.",
  );
}

function normalizeEntry(value: unknown, registryUrl: string): PluginRegistryEntry | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  // Bound every field so a compromised or malicious registry can't distort the
  // UI or saturate memory with pathologically long strings. The registry is
  // curated today, but the caps are cheap insurance.
  const id = trimmedString(record.id, 128);
  const name = trimmedString(record.name, 128);
  const version = trimmedString(record.version, 64);
  const rawManifestUrl = trimmedString(record.manifestUrl, 2048);
  if (!id || !name || !version || !rawManifestUrl) return null;

  let manifestUrl: string;
  try {
    manifestUrl = new URL(rawManifestUrl, registryUrl).href;
  } catch {
    return null;
  }
  // Only accept manifest URLs that survive the scheme allow-list applied when
  // settings are read back on the next launch (https, or http on loopback).
  // This drops e.g. a relative entry that resolves to tauri://localhost on the
  // desktop build, which would install for the session but vanish on restart.
  if (!isAllowedPluginManifestUrl(manifestUrl)) return null;

  return {
    id,
    name,
    version,
    manifestUrl,
    description: trimmedString(record.description, 1024) || undefined,
    author: trimmedString(record.author, 128) || undefined,
    homepage: httpUrlOrUndefined(trimmedString(record.homepage, 2048)),
    categories: stringArray(record.categories),
    minGeoLibreVersion: trimmedString(record.minGeoLibreVersion, 64) || undefined,
  };
}

// Trim and, when a cap is given, bound the length so untrusted registry data
// cannot grow without limit.
function trimmedString(value: unknown, maxLength?: number): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  return maxLength === undefined ? trimmed : trimmed.slice(0, maxLength);
}

// Only http(s) homepages are kept so a registry cannot inject a javascript: or
// data: URL that would execute when rendered as an anchor href.
function httpUrlOrUndefined(url: string): string | undefined {
  if (!url) return undefined;
  try {
    const { protocol } = new URL(url);
    return protocol === "https:" || protocol === "http:" ? url : undefined;
  } catch {
    return undefined;
  }
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value
    .map((item) => trimmedString(item, 64))
    .filter((item) => item.length > 0)
    .slice(0, 16);
  return items.length ? items : undefined;
}

/**
 * Compare dotted numeric versions. Returns true when `current` is greater than
 * or equal to `required`. Pre-release and build suffixes (e.g. `-rc.1`, `+sha`)
 * are stripped before comparison, which is the right behaviour for the
 * `minGeoLibreVersion` install gate: a coarse numeric floor. Non-numeric or
 * missing requirements are treated as satisfied so a malformed
 * `minGeoLibreVersion` never blocks installation. For detecting an available
 * upgrade (which must order `1.0.0-rc.1` below `1.0.0`), use isNewerVersion.
 */
export function satisfiesMinVersion(current: string, required?: string): boolean {
  if (!required) return true;
  const currentParts = parseVersion(current);
  const requiredParts = parseVersion(required);
  // An unparseable requirement never blocks installation. An unparseable
  // current version (e.g. a "dev"/local build) is treated as unknown and
  // allowed to pass rather than blocking every plugin.
  if (!currentParts || !requiredParts) return true;
  const length = Math.max(currentParts.length, requiredParts.length);
  for (let index = 0; index < length; index += 1) {
    const a = currentParts[index] ?? 0;
    const b = requiredParts[index] ?? 0;
    if (a !== b) return a > b;
  }
  return true;
}

/**
 * Returns true when `candidate` is a strictly newer version than `current`,
 * for driving the marketplace's "update available" badge. Numeric cores are
 * compared first; when they tie, a pre-release `current` with a stable
 * `candidate` counts as an upgrade (e.g. `1.0.0-rc.1` -> `1.0.0`) so a user on
 * a release candidate is offered the final release. This stays coarse: it does
 * not order pre-release identifiers against each other (`rc.1` vs `rc.2`).
 * Unparseable versions return false so a malformed string never shows a
 * spurious update.
 */
export function isNewerVersion(candidate: string, current: string): boolean {
  const candidateParts = parseVersion(candidate);
  const currentParts = parseVersion(current);
  if (!candidateParts || !currentParts) return false;
  const length = Math.max(candidateParts.length, currentParts.length);
  for (let index = 0; index < length; index += 1) {
    const a = candidateParts[index] ?? 0;
    const b = currentParts[index] ?? 0;
    if (a !== b) return a > b;
  }
  // Equal numeric cores: only a pre-release -> stable transition is an upgrade.
  return hasPreRelease(current) && !hasPreRelease(candidate);
}

// A version carries a pre-release suffix when a `-` segment precedes any `+`
// build metadata, e.g. `1.0.0-rc.1` or `1.0.0-beta+sha`.
function hasPreRelease(value: string): boolean {
  return value.trim().replace(/^v/, "").split("+")[0].includes("-");
}

// Compares only the dotted numeric core; pre-release/build suffixes are dropped,
// so "1.0.0-rc.1" is treated as equal to "1.0.0" rather than ordered before it.
// This is a deliberate simplification for the marketplace's coarse gating.
function parseVersion(value: string): number[] | null {
  const core = value.trim().replace(/^v/, "").split(/[-+]/)[0];
  if (!core) return null;
  const parts = core.split(".").map((part) => Number.parseInt(part, 10));
  return parts.every((part) => Number.isFinite(part)) ? parts : null;
}
