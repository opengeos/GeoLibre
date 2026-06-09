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
  /** Minimum GeoLibre app version this plugin supports, e.g. "0.9.0". */
  minGeoLibreVersion?: string;
}

export interface PluginRegistry {
  entries: PluginRegistryEntry[];
  /** Absolute URL the registry was fetched from. */
  registryUrl: string;
}

/**
 * Resolve the registry URL. Honors VITE_GEOLIBRE_PLUGIN_REGISTRY_URL and falls
 * back to a registry bundled with the build (so the marketplace works offline
 * and in both the web and desktop builds). Both are made absolute against the
 * app origin so the entry-relative manifest URLs resolve correctly.
 */
export function resolveRegistryUrl(): string {
  const configured = import.meta.env.VITE_GEOLIBRE_PLUGIN_REGISTRY_URL;
  if (configured && configured.trim()) {
    return new URL(configured.trim(), window.location.href).href;
  }
  const base = import.meta.env.BASE_URL.endsWith("/")
    ? import.meta.env.BASE_URL
    : `${import.meta.env.BASE_URL}/`;
  return new URL(`${base}plugin-registry.json`, window.location.href).href;
}

/**
 * Fetch and normalize the plugin registry. Entry manifest URLs are resolved to
 * absolute URLs against the registry location; malformed entries are dropped.
 * Throws on a failed fetch or non-array payload so the UI can surface the error.
 */
export async function fetchPluginRegistry(
  registryUrl: string = resolveRegistryUrl(),
): Promise<PluginRegistry> {
  // Bound the request so a slow or stalled registry endpoint cannot leave the
  // UI stuck in its loading state indefinitely.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  let response: Response;
  try {
    response = await fetch(registryUrl, { signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) {
    throw new Error(`Could not fetch plugin registry: HTTP ${response.status}`);
  }
  const payload = (await response.json()) as unknown;
  const rawEntries = extractEntries(payload);
  const entries = rawEntries
    .map((entry) => normalizeEntry(entry, registryUrl))
    .filter((entry): entry is PluginRegistryEntry => entry !== null);
  return { entries, registryUrl };
}

/** Accept either a bare array or `{ plugins: [...] }` / `{ entries: [...] }`. */
function extractEntries(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === "object") {
    const record = payload as Record<string, unknown>;
    if (Array.isArray(record.plugins)) return record.plugins;
    if (Array.isArray(record.entries)) return record.entries;
  }
  throw new Error("Plugin registry must be an array or { plugins: [...] }.");
}

function normalizeEntry(
  value: unknown,
  registryUrl: string,
): PluginRegistryEntry | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const id = trimmedString(record.id);
  const name = trimmedString(record.name);
  const version = trimmedString(record.version);
  const rawManifestUrl = trimmedString(record.manifestUrl);
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
    description: trimmedString(record.description) || undefined,
    author: trimmedString(record.author) || undefined,
    homepage: httpUrlOrUndefined(trimmedString(record.homepage)),
    categories: stringArray(record.categories),
    minGeoLibreVersion: trimmedString(record.minGeoLibreVersion) || undefined,
  };
}

function trimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
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
    .map((item) => trimmedString(item))
    .filter((item) => item.length > 0);
  return items.length ? items : undefined;
}

/**
 * Compare dotted numeric versions. Returns true when `current` is greater than
 * or equal to `required`. Non-numeric or missing requirements are treated as
 * satisfied so a malformed `minGeoLibreVersion` never blocks installation.
 */
export function satisfiesMinVersion(current: string, required?: string): boolean {
  if (!required) return true;
  const currentParts = parseVersion(current);
  const requiredParts = parseVersion(required);
  if (!currentParts || !requiredParts) return true;
  const length = Math.max(currentParts.length, requiredParts.length);
  for (let index = 0; index < length; index += 1) {
    const a = currentParts[index] ?? 0;
    const b = requiredParts[index] ?? 0;
    if (a !== b) return a > b;
  }
  return true;
}

function parseVersion(value: string): number[] | null {
  const core = value.trim().replace(/^v/, "").split(/[-+]/)[0];
  if (!core) return null;
  const parts = core.split(".").map((part) => Number.parseInt(part, 10));
  return parts.every((part) => Number.isFinite(part)) ? parts : null;
}
