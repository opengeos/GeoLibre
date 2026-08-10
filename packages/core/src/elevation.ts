/**
 * Shared ground-elevation resolution.
 *
 * Several places in the app need "how high is the ground at this coordinate":
 * the Elevation Profile plugin (along a drawn line), the Measure tool's
 * terrain-aware readout (along a measured geometry), and the status bar (under
 * the cursor). They all resolve it the same way, from two sources tried in
 * order:
 *
 *  1. The map's own terrain (`map.queryTerrainElevation`) when 3D terrain is
 *     enabled — instant and offline, but only where DEM tiles are loaded.
 *     MapLibre returns elevations multiplied by the terrain exaggeration, so
 *     values are divided back to true meters.
 *  2. The keyless Open-Meteo elevation API — works without terrain enabled and
 *     anywhere on Earth, but costs a network round-trip.
 *
 * This module lives in `@geolibre/core` rather than beside the Elevation
 * Profile plugin because `@geolibre/map` (which owns the pointer readout)
 * cannot import from `@geolibre/plugins` without a dependency cycle — plugins
 * already depends on map. Core is the only package all three can share.
 *
 * Source 2 is Earth-only: Open-Meteo has no data for the planetary basemaps, so
 * callers must not reach for it when the active body is not Earth.
 */

/** A coordinate as `[longitude, latitude]` in degrees. */
export type LngLat = [number, number];

/** Open-Meteo accepts at most 100 coordinates per elevation request. */
export const MAX_POINTS_PER_REQUEST = 100;

/** Abort an elevation request that has not responded within this window. */
export const ELEVATION_REQUEST_TIMEOUT_MS = 15000;

const ENDPOINT = "https://api.open-meteo.com/v1/elevation";

/** Error thrown when an elevation request cannot be completed or parsed. */
export class ElevationFetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ElevationFetchError";
  }
}

/** A `fetch`-compatible function, so tests can inject a stub. */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

interface ElevationResponse {
  elevation?: number[];
}

/**
 * Fetch elevations (in meters) for an ordered list of coordinates.
 *
 * @param points - Coordinates as `[lng, lat]`, at most {@link MAX_POINTS_PER_REQUEST}
 * @param fetchImpl - Optional `fetch` implementation; defaults to the global `fetch`
 * @returns The elevation in meters for each input coordinate, in the same order
 * @throws {ElevationFetchError} On too many points, a network error, a non-2xx
 *   response, a malformed body, or a length mismatch
 */
export async function fetchElevations(points: LngLat[], fetchImpl?: FetchLike): Promise<number[]> {
  if (points.length === 0) return [];
  if (points.length > MAX_POINTS_PER_REQUEST) {
    throw new ElevationFetchError(
      `Too many points: ${points.length} (max ${MAX_POINTS_PER_REQUEST}).`,
    );
  }

  const doFetch: FetchLike = fetchImpl ?? ((url, init) => fetch(url, init));
  const latitudes = points.map((p) => p[1].toFixed(6)).join(",");
  const longitudes = points.map((p) => p[0].toFixed(6)).join(",");
  const url = `${ENDPOINT}?latitude=${latitudes}&longitude=${longitudes}`;

  // A default fetch never times out, so a hung request would leave the control's
  // busy state stuck with no recovery. Abort after ELEVATION_REQUEST_TIMEOUT_MS
  // and surface it as a normal fetch error the caller already handles.
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), ELEVATION_REQUEST_TIMEOUT_MS);
  let response: Response;
  try {
    response = await doFetch(url, { signal: controller.signal });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new ElevationFetchError("Elevation request timed out.");
    }
    const detail = error instanceof Error ? error.message : "unknown error";
    throw new ElevationFetchError(`Could not reach the elevation service: ${detail}`);
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response.ok) {
    throw new ElevationFetchError(`Elevation request failed (HTTP ${response.status}).`);
  }

  let data: ElevationResponse;
  try {
    data = (await response.json()) as ElevationResponse;
  } catch {
    throw new ElevationFetchError("Could not parse the elevation response.");
  }

  if (!data || !Array.isArray(data.elevation)) {
    throw new ElevationFetchError("Malformed elevation response.");
  }
  if (data.elevation.length !== points.length) {
    throw new ElevationFetchError(
      `Expected ${points.length} elevations but received ${data.elevation.length}.`,
    );
  }

  return data.elevation;
}

/** The slice of the MapLibre map the terrain sampler needs (stubbed in tests). */
export interface TerrainMapLike {
  getTerrain?: () => { exaggeration?: number } | null | undefined;
  queryTerrainElevation?: (lngLat: LngLat) => number | null;
}

/**
 * Sample elevations from the map's enabled 3D terrain, in true meters
 * (MapLibre's `queryTerrainElevation` bakes the exaggeration in, so it is
 * divided back out). Returns null when terrain is not enabled.
 */
export function sampleMapTerrain(
  map: TerrainMapLike | null | undefined,
  points: LngLat[],
): (number | null)[] | null {
  if (!map?.getTerrain || !map.queryTerrainElevation) return null;
  const terrain = map.getTerrain();
  if (!terrain) return null;
  const exaggeration =
    typeof terrain.exaggeration === "number" && terrain.exaggeration > 0 ? terrain.exaggeration : 1;
  return points.map((point) => {
    const elevation = map.queryTerrainElevation!(point);
    return typeof elevation === "number" && Number.isFinite(elevation)
      ? elevation / exaggeration
      : null;
  });
}

/**
 * Sample a single point's elevation from enabled 3D terrain, in true meters.
 * Returns null when terrain is off or the DEM tile under the point has not
 * loaded — the caller decides whether that is worth a network round-trip.
 */
export function sampleMapTerrainPoint(
  map: TerrainMapLike | null | undefined,
  point: LngLat,
): number | null {
  return sampleMapTerrain(map, [point])?.[0] ?? null;
}

/**
 * Sample elevations from the Open-Meteo API, chunked to its 100-point request
 * limit. A failed chunk yields nulls for its points rather than throwing, so a
 * flaky network degrades the readout instead of breaking the caller.
 */
export async function sampleRemoteElevations(
  points: LngLat[],
  fetchImpl?: FetchLike,
): Promise<(number | null)[]> {
  const chunks: LngLat[][] = [];
  for (let i = 0; i < points.length; i += MAX_POINTS_PER_REQUEST) {
    chunks.push(points.slice(i, i + MAX_POINTS_PER_REQUEST));
  }
  // The chunks are independent, so fire them concurrently; Promise.all
  // preserves their order for reassembly.
  const chunkResults = await Promise.all(
    chunks.map(async (chunk) => {
      try {
        const elevations = await fetchElevations(chunk, fetchImpl);
        return elevations.map((elevation) => (Number.isFinite(elevation) ? elevation : null));
      } catch {
        return chunk.map(() => null);
      }
    }),
  );
  return chunkResults.flat();
}

// --- Pointer elevation resolver --------------------------------------------

/** Round a coordinate to ~11 m so nearby hovers share one cache entry. */
function cacheKey(point: LngLat): string {
  return `${point[0].toFixed(4)},${point[1].toFixed(4)}`;
}

/** How long the pointer must sit still before a remote lookup is worth it. */
export const POINTER_ELEVATION_DEBOUNCE_MS = 500;

/** Remote results kept per resolver; bounded so a long session cannot grow it without limit. */
export const POINTER_ELEVATION_CACHE_LIMIT = 500;

export interface PointerElevationResolverOptions {
  /** The live map, for the terrain sample. May return null before init. */
  getMap: () => TerrainMapLike | null | undefined;
  /**
   * Whether the readout is switched on (Controls -> Elevation). Read per call
   * rather than captured, and rechecked before publishing a remote result, so
   * turning it off mid-request neither shows a late value nor leaves the last
   * one on screen. Defaults to always-on for callers that do not gate it.
   */
  isEnabled?: () => boolean;
  /**
   * Whether the *remote* Open-Meteo fallback may run. The terrain path sends
   * nothing anywhere, so it is deliberately not gated by this — a user who has
   * declined the network lookup still gets a live readout wherever 3D terrain
   * is on. Defaults to allowed for callers that do not gate it.
   */
  canUseRemote?: () => boolean;
  /** Whether the active body is Earth — Open-Meteo has no data for anything else. */
  isEarth: () => boolean;
  /** Called with the resolved elevation in true metres, or null when unknown. */
  emit: (elevation: number | null) => void;
  fetchImpl?: FetchLike;
  debounceMs?: number;
}

export interface PointerElevationResolver {
  /** Report a new pointer position, or null when the pointer leaves the map. */
  update: (point: LngLat | null) => void;
  /**
   * Drop any pending *and* in-flight lookup without tearing the resolver down.
   * Used when the map's context changes under it — loading another project
   * resets the readout, and a response for the previous project must not
   * repaint it.
   */
  invalidate: () => void;
  /** Cancel any pending lookup. */
  dispose: () => void;
}

/**
 * Resolves the ground elevation under the pointer for the status bar.
 *
 * Two paths, deliberately asymmetric:
 *
 *  - **Terrain enabled** — `queryTerrainElevation` is synchronous and free, so
 *    it runs on every move and the readout tracks the cursor live.
 *  - **Terrain disabled** — falls back to Open-Meteo, but only after the
 *    pointer has been still for {@link POINTER_ELEVATION_DEBOUNCE_MS}, and only
 *    on Earth. Results are cached per ~11 m cell, so sweeping back over ground
 *    already looked up costs nothing. Without both guards a hover readout would
 *    fire a request per mousemove at a free, keyless public service.
 *
 * While a remote lookup is outstanding the readout reads null rather than the
 * previous point's value: showing a stale height next to fresh coordinates
 * would be worse than showing nothing.
 */
export function createPointerElevationResolver(
  options: PointerElevationResolverOptions,
): PointerElevationResolver {
  const { getMap, isEarth, emit, fetchImpl } = options;
  const isEnabled = options.isEnabled ?? (() => true);
  const canUseRemote = options.canUseRemote ?? (() => true);
  const debounceMs = options.debounceMs ?? POINTER_ELEVATION_DEBOUNCE_MS;
  const cache = new Map<string, number | null>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  // Bumped on every update so a slow response for an abandoned point is dropped
  // rather than overwriting the readout for wherever the pointer is now.
  let generation = 0;

  const cancelPending = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const update = (point: LngLat | null) => {
    generation += 1;
    cancelPending();

    if (!point || !isEnabled()) {
      emit(null);
      return;
    }

    const fromTerrain = sampleMapTerrainPoint(getMap(), point);
    if (fromTerrain !== null) {
      emit(fromTerrain);
      return;
    }

    // Open-Meteo has no data off Earth, and the remote path needs consent.
    if (!isEarth() || !canUseRemote()) {
      emit(null);
      return;
    }

    const key = cacheKey(point);
    if (cache.has(key)) {
      const cached = cache.get(key) ?? null;
      // Re-insert to move this entry to the end: Map iterates in insertion
      // order, so the first key is always the least recently used.
      cache.delete(key);
      cache.set(key, cached);
      emit(cached);
      return;
    }

    emit(null);
    const requested = generation;
    timer = setTimeout(() => {
      timer = null;
      void (async () => {
        const [elevation] = await sampleRemoteElevations([point], fetchImpl);
        const value = elevation ?? null;
        // `sampleRemoteElevations` turns a fetch failure into a null, which is
        // indistinguishable here from "no data for this cell". Caching that
        // would blackhole the readout for this ~11 m cell for the rest of the
        // session, so only successes are remembered and a transient network
        // blip gets another chance on the next hover.
        if (value !== null) {
          // Evict just the oldest entry. Clearing the whole cache at the cap
          // would make every 500th distinct cell trigger a burst of re-fetches
          // for cells that may still be under active hovering.
          if (cache.size >= POINTER_ELEVATION_CACHE_LIMIT) {
            const oldest = cache.keys().next();
            if (!oldest.done) cache.delete(oldest.value);
          }
          cache.set(key, value);
        }
        // The pointer moved, left, or the resolver was disposed while the
        // request was in flight. Also recheck the body: a switch to a planetary
        // basemap mid-request must not publish an Earth elevation over it.
        if (requested !== generation || !isEarth() || !isEnabled() || !canUseRemote()) return;
        emit(value);
      })();
    }, debounceMs);
  };

  // Bumping the generation is what actually invalidates an *in-flight*
  // request; cancelPending alone only clears a timer that has not fired yet, so
  // a fetch already in progress would still emit into a torn-down map.
  const invalidate = (): void => {
    generation += 1;
    cancelPending();
  };

  return { update, invalidate, dispose: invalidate };
}
