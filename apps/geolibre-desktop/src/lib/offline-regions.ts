/**
 * Offline-region manifest: a device-local catalogue of the basemap areas the
 * user has downloaded for offline use (see lib/offline-tiles.ts for the
 * download mechanism).
 *
 * The service worker's `geolibre-basemaps` cache stores tiles keyed by URL and
 * keeps no metadata about *which region* a tile belongs to, so there is nothing
 * to list, size, update, or delete after the fact. This module fills that gap by
 * persisting one record per download — its bounds, zoom range, and the exact
 * URLs it warmed — in `localStorage`. From those records the Offline Manager can
 * show each region's footprint, re-warm it (bulk update), and delete it to
 * reclaim space.
 *
 * Records are device-scoped, not part of the `.geolibre.json` project: they
 * mirror the SW cache on *this* device and would be meaningless elsewhere.
 *
 * Deletion safety: a region stores `tileUrls` (its own raster/vector tiles)
 * separately from `assetUrls` (style/sprite/glyphs). Only tile URLs that no
 * *other* retained region also references are evicted; shared assets are never
 * deleted, so removing one region can never break another or the base app.
 */

import type { Bbox } from "./offline-tiles";

/** The Workbox runtime cache that holds basemap tiles (see vite.config.ts). */
export const BASEMAP_CACHE_NAME = "geolibre-basemaps";

/** localStorage key for the persisted region manifest (versioned for migrations). */
export const OFFLINE_REGIONS_KEY = "geolibre.offlineRegions.v1";

export interface OfflineRegion {
  /** Stable id; derived from bounds + zoom so re-downloading an area updates it. */
  id: string;
  /** User-facing label (editable); defaults to the region's center coordinates. */
  name: string;
  bbox: Bbox;
  minZoom: number;
  maxZoom: number;
  /**
   * Region-specific tile URLs (raster/vector). Safe to evict on delete when no
   * other region references them. Excludes shared style/sprite/glyph assets.
   */
  tileUrls: string[];
  /** Shared assets (style, sprite, glyphs) re-warmed on update, never deleted. */
  assetUrls: string[];
  /** Tile count at download time (cheaper than tileUrls.length for display). */
  tileCount: number;
  /** Distinct tile hosts (for display, e.g. "openfreemap.org"). */
  hosts: string[];
  /** Epoch ms when first downloaded. */
  createdAt: number;
  /** Epoch ms of the most recent download/update. */
  updatedAt: number;
}

/** Every URL a region warmed: its tiles plus the shared assets it depends on. */
export function regionAllUrls(region: OfflineRegion): string[] {
  return [...region.tileUrls, ...region.assetUrls];
}

/**
 * A deterministic id for a region so downloading the same area + zoom range
 * twice updates the existing record instead of creating a duplicate. Bbox
 * coordinates are rounded to ~1e-4° (≈10 m) so trivial viewport jitter between
 * downloads still maps to the same region.
 */
export function regionId(bbox: Bbox, minZoom: number, maxZoom: number): string {
  const key = bbox.map((n) => n.toFixed(4)).join(",");
  return `${key}@${minZoom}-${maxZoom}`;
}

/** Distinct hostnames present in a list of URLs (unparseable entries ignored). */
export function urlHosts(urls: string[]): string[] {
  const hosts = new Set<string>();
  for (const url of urls) {
    try {
      hosts.add(new URL(url).hostname);
    } catch {
      // Ignore unparseable URLs.
    }
  }
  return [...hosts];
}

/**
 * Tile URLs of `region` that no other region in `others` references, i.e. the
 * ones safe to evict from the cache when `region` is deleted. Shared tiles
 * (common to an overlapping region) are retained.
 */
export function exclusiveTileUrls(region: OfflineRegion, others: OfflineRegion[]): string[] {
  const keep = new Set<string>();
  for (const other of others) {
    if (other.id === region.id) continue;
    for (const url of other.tileUrls) keep.add(url);
  }
  return region.tileUrls.filter((url) => !keep.has(url));
}

function getStorage(storage?: Storage): Storage | null {
  if (storage) return storage;
  try {
    return globalThis.localStorage ?? null;
  } catch {
    // Accessing localStorage can throw (e.g. disabled cookies/storage).
    return null;
  }
}

/** Whether a parsed value is a structurally valid persisted region record. */
function isOfflineRegion(value: unknown): value is OfflineRegion {
  if (!value || typeof value !== "object") return false;
  const r = value as Record<string, unknown>;
  const isNum = (v: unknown) => typeof v === "number" && Number.isFinite(v);
  const isStrArray = (v: unknown) => Array.isArray(v) && v.every((x) => typeof x === "string");
  // Validate every field, including numeric and array-element invariants: a
  // tampered or older record that slips through here is cast to a trusted
  // OfflineRegion and would surface as a corrupt id (`regionId` → "NaN…"),
  // bad sort order, or a crash on `region.hosts.length` in the manager.
  return (
    typeof r.id === "string" &&
    typeof r.name === "string" &&
    Array.isArray(r.bbox) &&
    r.bbox.length === 4 &&
    r.bbox.every(isNum) &&
    isNum(r.minZoom) &&
    isNum(r.maxZoom) &&
    isStrArray(r.tileUrls) &&
    isStrArray(r.assetUrls) &&
    isNum(r.tileCount) &&
    isStrArray(r.hosts) &&
    isNum(r.createdAt) &&
    isNum(r.updatedAt)
  );
}

/**
 * Load the persisted region manifest, newest first. Returns an empty list when
 * storage is unavailable or the stored value is missing/corrupt (never throws).
 */
export function loadOfflineRegions(storage?: Storage): OfflineRegion[] {
  const store = getStorage(storage);
  if (!store) return [];
  let raw: string | null;
  try {
    raw = store.getItem(OFFLINE_REGIONS_KEY);
  } catch {
    return [];
  }
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isOfflineRegion).sort((a, b) => b.updatedAt - a.updatedAt);
  } catch {
    return [];
  }
}

/**
 * Persist the manifest. Returns false if storage is unavailable or the write is
 * rejected (e.g. QuotaExceededError when many large regions are stored) so the
 * caller can warn the user rather than silently losing the record.
 */
export function persistOfflineRegions(regions: OfflineRegion[], storage?: Storage): boolean {
  const store = getStorage(storage);
  if (!store) return false;
  try {
    store.setItem(OFFLINE_REGIONS_KEY, JSON.stringify(regions));
    return true;
  } catch {
    return false;
  }
}

/**
 * Insert or update a region (matched by id), preserving the existing record's
 * `name` and `createdAt` when present so a re-download keeps the user's label
 * and original download date. Returns the new list and whether it persisted.
 */
export function upsertOfflineRegion(
  region: OfflineRegion,
  storage?: Storage,
): { regions: OfflineRegion[]; persisted: boolean } {
  const existing = loadOfflineRegions(storage);
  const prior = existing.find((r) => r.id === region.id);
  const merged: OfflineRegion = {
    ...region,
    name: prior?.name ?? region.name,
    createdAt: prior?.createdAt ?? region.createdAt,
  };
  const regions = [merged, ...existing.filter((r) => r.id !== region.id)].sort(
    (a, b) => b.updatedAt - a.updatedAt,
  );
  return { regions, persisted: persistOfflineRegions(regions, storage) };
}

/** Rename a region in place. Returns the updated list. */
export function renameOfflineRegion(id: string, name: string, storage?: Storage): OfflineRegion[] {
  const regions = loadOfflineRegions(storage).map((r) => (r.id === id ? { ...r, name } : r));
  persistOfflineRegions(regions, storage);
  return regions;
}

/**
 * Bump a region's `updatedAt` to `updatedAt` (epoch ms), e.g. after a successful
 * partial retry re-warms its failed tiles. No-ops if the region isn't found.
 */
export function touchOfflineRegion(id: string, updatedAt: number, storage?: Storage): void {
  const existing = loadOfflineRegions(storage);
  if (!existing.some((r) => r.id === id)) return;
  const regions = existing
    .map((r) => (r.id === id ? { ...r, updatedAt } : r))
    .sort((a, b) => b.updatedAt - a.updatedAt);
  persistOfflineRegions(regions, storage);
}

/** Open the basemap cache, or null if the Cache Storage API is unavailable. */
async function openBasemapCache(): Promise<Cache | null> {
  if (typeof caches === "undefined") return null;
  try {
    return await caches.open(BASEMAP_CACHE_NAME);
  } catch {
    return null;
  }
}

/**
 * Sum the on-disk size (in bytes) of a region's tiles currently in the cache.
 * Only tiles are measured — shared assets are common to all regions, so
 * attributing them to one would double-count. Evicted/missing tiles contribute
 * zero. Returns 0 when the cache is unavailable.
 */
export async function measureRegionBytes(region: OfflineRegion): Promise<number> {
  const cache = await openBasemapCache();
  if (!cache) return 0;
  // Look tiles up concurrently; a large region can hold hundreds of entries and
  // a sequential loop would block the dialog noticeably on open. Prefer the
  // cheap Content-Length header and fall back to reading the body only when it
  // is absent (e.g. opaque responses), so we never deserialize megabytes of
  // tile data just to total their size.
  const sizes = await Promise.all(
    region.tileUrls.map(async (url) => {
      try {
        const res = await cache.match(url);
        if (!res) return 0;
        const length = res.headers.get("content-length");
        if (length !== null) {
          const parsed = Number.parseInt(length, 10);
          if (Number.isFinite(parsed) && parsed > 0) return parsed;
        }
        return (await res.blob()).size;
      } catch {
        return 0;
      }
    }),
  );
  return sizes.reduce((sum, n) => sum + n, 0);
}

/**
 * Delete a region from the manifest and evict its exclusive tiles from the
 * cache (tiles no other retained region references). Persists the manifest
 * *before* touching the cache so a failed write can't leave the manifest still
 * listing a region whose tiles are already gone. Returns the remaining regions,
 * how many cache entries were removed, and whether the manifest persisted.
 */
export async function deleteOfflineRegion(
  id: string,
  storage?: Storage,
): Promise<{ regions: OfflineRegion[]; deleted: number; persisted: boolean }> {
  const existing = loadOfflineRegions(storage);
  const target = existing.find((r) => r.id === id);
  const remaining = existing.filter((r) => r.id !== id);
  const persisted = persistOfflineRegions(remaining, storage);
  // Bail before evicting if the manifest couldn't be updated, otherwise the
  // cache and the manifest would diverge (tiles gone but region still listed).
  if (!persisted) return { regions: existing, deleted: 0, persisted: false };
  let deleted = 0;
  if (target) {
    const cache = await openBasemapCache();
    if (cache) {
      for (const url of exclusiveTileUrls(target, remaining)) {
        try {
          if (await cache.delete(url)) deleted++;
        } catch {
          // Skip entries that can't be deleted.
        }
      }
    }
  }
  return { regions: remaining, deleted, persisted: true };
}

/**
 * Best-effort browser storage usage/quota in bytes (Storage Manager API), or
 * null when unavailable. Covers all origin storage, not just basemaps, but is
 * the only quota signal the browser exposes.
 */
export async function getStorageEstimate(): Promise<{
  usage: number;
  quota: number;
} | null> {
  try {
    if (typeof navigator === "undefined" || !navigator.storage?.estimate) {
      return null;
    }
    const { usage = 0, quota = 0 } = await navigator.storage.estimate();
    return { usage, quota };
  } catch {
    return null;
  }
}

/** Human-readable byte size (KB/MB/GB) for footprint displays. */
export function formatBytes(bytes: number): string {
  if (bytes <= 0) return "0 KB";
  if (bytes >= 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  }
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(0)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/**
 * A short, human-readable label for a region's center, e.g. "12.34°N, 56.78°W".
 * Used as the default name when a region is first downloaded.
 */
export function describeBboxCenter(bbox: Bbox): string {
  const [west, south, east, north] = bbox;
  const lat = (south + north) / 2;
  const lng = (west + east) / 2;
  const ns = lat >= 0 ? "N" : "S";
  const ew = lng >= 0 ? "E" : "W";
  return `${Math.abs(lat).toFixed(2)}°${ns}, ${Math.abs(lng).toFixed(2)}°${ew}`;
}
