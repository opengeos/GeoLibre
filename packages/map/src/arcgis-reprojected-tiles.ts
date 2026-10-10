import type {
  ArcgisPoint,
  ArcgisProjectOperator,
  ArcgisRasterLayer,
  ArcgisSdk,
  ArcgisSpatialReference,
} from "./arcgis-sdk";
import { zoomToScale } from "./arcgis-layers";

/**
 * Web Mercator tiles drawn on a map in another projection (issue #2708).
 *
 * The SDK cannot reproject a tile layer, so a flat map in Spilhaus, Robinson
 * or any other projection would leave GeoLibre's rendered raster tiles (COGs)
 * blank. This layer tiles the *view's* projection instead and warps each of
 * its tiles from the 256 px Web Mercator tiles the source already renders: a
 * coarse grid of the tile's points is projected to longitude/latitude, mapped
 * to Web Mercator pixels, and the pixels between grid points are interpolated
 * and sampled (nearest neighbour). A grid cell that cannot be interpolated
 * (it straddles one of the projection's seams, or the edge of its domain) is
 * projected pixel by pixel instead. Rendering, styling and caching stay with
 * the source; only placement changes. Web Mercator stops at ±85.05°, so
 * latitudes past it draw nothing.
 */

/** Output and source tile size, in pixels. */
const TILE_SIZE = 256;
/** Grid spacing, in output pixels; 33 × 33 projected points per tile. */
const GRID_STEP = 8;
/** Web Mercator half-extent, in metres. */
const MERCATOR_HALF = 20037508.342789244;
/** Web Mercator's latitude limit. */
const MAX_LATITUDE = 85.0511287798066;
/** Metres per degree at the equator, to size a geographic view's tiles. */
const METRES_PER_DEGREE = 111319.49079327357;
/** More source tiles than this behind one output tile means a view too far out to read. */
const MAX_SOURCE_TILES = 64;
/** A grid cell this many times the tile's median size spans a seam in the projection. */
const SEAM_FACTOR = 8;
/**
 * Source tiles kept per layer (256 KB of RGBA each): enough for one output
 * tile's worst case and its neighbours without holding a whole session.
 */
const SOURCE_CACHE_SIZE = 96;
/** Zoom levels in the view's tiling scheme. */
const LEVELS = 24;

/** One 256 × 256 RGBA source tile, or null where the source has nothing. */
export type MercatorTileData = Uint8Array | Uint8ClampedArray | null;

/** What the warped layer reads from: a Web Mercator tile renderer and its limits. */
export interface MercatorTileSource {
  /** Render tile `z/x/y` as 256 × 256 RGBA; the result is copied before reuse. */
  render(z: number, x: number, y: number): Promise<MercatorTileData>;
  /** The deepest zoom worth reading; deeper output tiles magnify it. */
  maxZoom?: number;
  /** WGS 84 bounds `[west, south, east, north]`; tiles outside are not read. */
  bounds?: number[];
}

/**
 * The view projection's tiling scheme: square tiles from a top-left origin
 * far enough out to cover any projected world. Each level has the scale of
 * the same level of the standard Web Mercator scheme, so the view's zoom
 * means what it means on a Web Mercator map (the engine converts between the
 * two by scale, see `zoomToScale`).
 *
 * Args:
 *   geographic: Whether the projection's units are degrees.
 *
 * Returns:
 *   The origin's half-span and each level's resolution (in projection units)
 *   and scale denominator.
 */
export function reprojectedTilingScheme(geographic: boolean): {
  span: number;
  resolutions: number[];
  scales: number[];
} {
  // Projected worlds are at most ~2 × 2e7 m across; 4e7 leaves margin for
  // projections whose domain is offset from the origin.
  const span = geographic ? 400 : 4e7;
  const scales = Array.from({ length: LEVELS }, (_, level) => zoomToScale(level));
  // The SDK's scale is the resolution in metres at 96 dpi and 39.37 in/m.
  const resolutions = scales.map((scale) => {
    const metres = scale / 96 / 39.37;
    return geographic ? metres / METRES_PER_DEGREE : metres;
  });
  return { span, resolutions, scales };
}

/**
 * The Web Mercator zoom whose pixels best match an output tile's resolution.
 *
 * Args:
 *   metresPerPixel: The output tile's resolution, in metres.
 *   maxZoom: The source's deepest useful zoom, if known.
 *
 * Returns:
 *   An integer zoom from 0 to `maxZoom` (or 22).
 */
export function sourceZoomForResolution(metresPerPixel: number, maxZoom = 22): number {
  if (!(metresPerPixel > 0)) return 0;
  const zoom = Math.round(Math.log2((2 * MERCATOR_HALF) / TILE_SIZE / metresPerPixel));
  return Math.max(0, Math.min(Math.floor(maxZoom), zoom));
}

/**
 * A longitude/latitude as Web Mercator pixel coordinates at a zoom.
 *
 * Args:
 *   lon: Longitude in degrees.
 *   lat: Latitude in degrees, clamped to Web Mercator's limit.
 *   zoom: The source zoom.
 *
 * Returns:
 *   `[x, y]` in pixels from the top-left of the zoom's world.
 */
export function lonLatToMercatorPixel(lon: number, lat: number, zoom: number): [number, number] {
  const world = TILE_SIZE * 2 ** zoom;
  const clamped = (Math.max(-MAX_LATITUDE, Math.min(MAX_LATITUDE, lat)) * Math.PI) / 180;
  const y = 0.5 - Math.log(Math.tan(Math.PI / 4 + clamped / 2)) / (2 * Math.PI);
  return [((lon + 180) / 360) * world, y * world];
}

/**
 * A projected point as a source pixel, or null when it did not project or
 * lies past Web Mercator's latitude limit (the source has no pixels there).
 * Longitude wraps into [-180, 180).
 *
 * Args:
 *   point: A point in WGS 84, or null.
 *   zoom: The source zoom.
 *
 * Returns:
 *   `[x, y]` source pixels, or null.
 */
export function sourcePixel(
  point: { x: number; y: number } | null,
  zoom: number,
): [number, number] | null {
  if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return null;
  if (Math.abs(point.y) > MAX_LATITUDE) return null;
  // The projection can answer just past ±180° along the antimeridian; wrap it
  // into the source's single world.
  const lon = ((((point.x + 180) % 360) + 360) % 360) - 180;
  return lonLatToMercatorPixel(lon, point.y, zoom);
}

/** A grid cell's extent in source pixels, or null when a corner is missing. */
function cellSpan(grid: ([number, number] | null)[], size: number, i: number, j: number) {
  const corners = [
    grid[j * size + i],
    grid[j * size + i + 1],
    grid[(j + 1) * size + i],
    grid[(j + 1) * size + i + 1],
  ];
  if (corners.some((corner) => !corner)) return null;
  const xs = corners.map((corner) => corner![0]);
  const ys = corners.map((corner) => corner![1]);
  return Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
}

/**
 * The median grid cell's extent in source pixels, or null when no cell has
 * all four corners.
 *
 * Args:
 *   grid: Source pixel per grid point, row-major, null where unprojectable.
 *   size: Grid points per side.
 *
 * Returns:
 *   The median span, in source pixels.
 */
export function medianCellSpan(grid: ([number, number] | null)[], size: number): number | null {
  const spans: number[] = [];
  for (let j = 0; j < size - 1; j++)
    for (let i = 0; i < size - 1; i++) {
      const span = cellSpan(grid, size, i, j);
      if (span !== null) spans.push(span);
    }
  if (!spans.length) return null;
  spans.sort((a, b) => a - b);
  return spans[Math.floor(spans.length / 2)];
}

/**
 * The source zoom that gives a tile about one source pixel per output pixel.
 * A projection stretches some regions far beyond its nominal scale (land at
 * Spilhaus's edges), so the zoom is corrected by how many source pixels the
 * tile's typical grid cell actually spans at a first guess.
 *
 * Args:
 *   guess: The zoom the grid was measured at.
 *   median: The median cell span at `guess`, in source pixels.
 *   step: Output pixels per grid cell.
 *   maxZoom: The deepest zoom worth reading.
 *
 * Returns:
 *   An integer zoom from 0 to `maxZoom`.
 */
export function adaptedSourceZoom(
  guess: number,
  median: number | null,
  step: number,
  maxZoom = 22,
): number {
  if (median === null || !(median > 0)) return guess;
  const zoom = Math.round(guess + Math.log2(step / median));
  return Math.max(0, Math.min(Math.floor(maxZoom), zoom));
}

/**
 * Which grid cells to interpolate: a cell is skipped when a corner did not project,
 * or when it spans far more source pixels than the tile's typical cell (it
 * straddles a seam, as Spilhaus has, where neighbouring points of the view
 * are continents apart).
 *
 * Args:
 *   grid: Source pixel per grid point, row-major, null where unprojectable.
 *   size: Grid points per side.
 *
 * Returns:
 *   Per cell (row-major, `size - 1` per side), whether to draw it.
 */
export function drawableCells(grid: ([number, number] | null)[], size: number): boolean[] {
  const cells = size - 1;
  const all: (number | null)[] = [];
  for (let j = 0; j < cells; j++)
    for (let i = 0; i < cells; i++) all.push(cellSpan(grid, size, i, j));
  const median = medianCellSpan(grid, size);
  if (median === null) return all.map(() => false);
  // A floor, so a tile of near-identical points (deep zoom) is not all "seam".
  const limit = Math.max(median * SEAM_FACTOR, 4);
  return all.map((span) => span !== null && span <= limit);
}

/**
 * Warp one output tile from source tiles.
 *
 * Args:
 *   grid: Source pixel per grid point (see {@link drawableCells}).
 *   size: Grid points per side.
 *   step: Output pixels between grid points.
 *   tiles: Source tile data keyed `"x,y"`; missing or null keys are blank.
 *   exact: Per-pixel source pixels (`step * step`, row-major) for cells that
 *     cannot be interpolated, keyed by cell index; other such cells are blank.
 *
 * Returns:
 *   The output tile's RGBA, `(size - 1) * step` pixels square.
 */
export function warpTile(
  grid: ([number, number] | null)[],
  size: number,
  step: number,
  tiles: ReadonlyMap<string, MercatorTileData>,
  exact: ReadonlyMap<number, ([number, number] | null)[]> = new Map(),
): Uint8ClampedArray<ArrayBuffer> {
  const width = (size - 1) * step;
  const out = new Uint8ClampedArray(width * width * 4);
  const drawable = drawableCells(grid, size);
  const copy = (x: number, sy: number, to: number) => {
    // cog-tiler leaves the world's first pixel column (at -180°) empty; on a
    // Web Mercator map it sits at the antimeridian's edge, but warped into
    // another projection it would trace the antimeridian as a dotted line.
    const sx = x < 1 ? 1 : x;
    const tx = Math.floor(sx / TILE_SIZE);
    const ty = Math.floor(sy / TILE_SIZE);
    const data = tiles.get(`${tx},${ty}`);
    if (!data) return;
    const px = Math.min(TILE_SIZE - 1, Math.floor(sx - tx * TILE_SIZE));
    const py = Math.min(TILE_SIZE - 1, Math.floor(sy - ty * TILE_SIZE));
    const from = (py * TILE_SIZE + px) * 4;
    out[to] = data[from];
    out[to + 1] = data[from + 1];
    out[to + 2] = data[from + 2];
    out[to + 3] = data[from + 3];
  };
  for (let j = 0; j < size - 1; j++)
    for (let i = 0; i < size - 1; i++) {
      const cell = j * (size - 1) + i;
      if (!drawable[cell]) {
        const pixels = exact.get(cell);
        if (!pixels) continue;
        for (let v = 0; v < step; v++)
          for (let u = 0; u < step; u++) {
            const at = pixels[v * step + u];
            if (at) copy(at[0], at[1], ((j * step + v) * width + (i * step + u)) * 4);
          }
        continue;
      }
      const a = grid[j * size + i]!;
      const b = grid[j * size + i + 1]!;
      const c = grid[(j + 1) * size + i]!;
      const d = grid[(j + 1) * size + i + 1]!;
      for (let v = 0; v < step; v++) {
        const fv = v / step;
        for (let u = 0; u < step; u++) {
          const fu = u / step;
          const sx = (a[0] * (1 - fu) + b[0] * fu) * (1 - fv) + (c[0] * (1 - fu) + d[0] * fu) * fv;
          const sy = (a[1] * (1 - fu) + b[1] * fu) * (1 - fv) + (c[1] * (1 - fu) + d[1] * fu) * fv;
          copy(sx, sy, ((j * step + v) * width + (i * step + u)) * 4);
        }
      }
    }
  return out;
}

/**
 * The source tiles a grid reads at `zoom`, as `[x, y]`, skipping tiles
 * outside the world or the source's bounds.
 *
 * Args:
 *   grid: Source pixel per grid point.
 *   zoom: The source zoom.
 *   bounds: The source's WGS 84 bounds, if known.
 *
 * Returns:
 *   The distinct tiles, in no particular order.
 */
export function sourceTilesForGrid(
  grid: ([number, number] | null)[],
  zoom: number,
  bounds?: number[],
): [number, number][] {
  const count = 2 ** zoom;
  let range: [number, number, number, number] | null = null;
  if (bounds?.length === 4 && bounds.every(Number.isFinite)) {
    const [west, north] = lonLatToMercatorPixel(bounds[0], bounds[3], zoom);
    const [east, south] = lonLatToMercatorPixel(bounds[2], bounds[1], zoom);
    range = [
      Math.floor(west / TILE_SIZE),
      Math.floor(north / TILE_SIZE),
      Math.floor(east / TILE_SIZE),
      Math.floor(south / TILE_SIZE),
    ];
  }
  const tiles = new Map<string, [number, number]>();
  for (const point of grid) {
    if (!point) continue;
    const x = Math.floor(point[0] / TILE_SIZE);
    const y = Math.floor(point[1] / TILE_SIZE);
    if (x < 0 || y < 0 || x >= count || y >= count) continue;
    if (range && (x < range[0] || y < range[1] || x > range[2] || y > range[3])) continue;
    tiles.set(`${x},${y}`, [x, y]);
  }
  return [...tiles.values()];
}

/**
 * A tile layer in the view's projection that warps `source`'s Web Mercator
 * tiles into it.
 *
 * Args:
 *   sdk: The loaded SDK.
 *   operator: The loaded project operator.
 *   spatialReference: The view's spatial reference.
 *   open: Resolves the source once the layer loads (so an unused layer reads nothing).
 *   properties: Common layer properties (title, visibility, opacity, scales).
 *
 * Returns:
 *   The layer, ready to add to the map.
 */
export function createReprojectedTileLayer(
  sdk: ArcgisSdk,
  operator: ArcgisProjectOperator,
  spatialReference: ArcgisSpatialReference,
  open: () => Promise<MercatorTileSource>,
  properties: Record<string, unknown>,
): ArcgisRasterLayer {
  const wkid = spatialReference.wkid;
  const sr = { wkid: wkid as number };
  const geographic = spatialReference.isGeographic === true;
  const { span, resolutions, scales } = reprojectedTilingScheme(geographic);
  const tileInfo = new sdk.TileInfo({
    size: [TILE_SIZE, TILE_SIZE],
    origin: { x: -span, y: span, spatialReference: sr },
    spatialReference: sr,
    lods: resolutions.map((resolution, level) => ({ level, resolution, scale: scales[level] })),
  });
  // Source tiles by "z/x/y", oldest first, shared by every output tile.
  const cache = new Map<string, Promise<MercatorTileData>>();
  const readTile = (source: MercatorTileSource, z: number, x: number, y: number) => {
    const key = `${z}/${x}/${y}`;
    let pending = cache.get(key);
    if (pending) {
      cache.delete(key);
      cache.set(key, pending);
      return pending;
    }
    pending = source.render(z, x, y).then(
      // Copy WASM memory before another render can reuse its backing buffer.
      (data) => (data?.length ? new Uint8ClampedArray(data) : null),
      (error: unknown) => {
        cache.delete(key);
        throw error;
      },
    );
    cache.set(key, pending);
    while (cache.size > SOURCE_CACHE_SIZE) cache.delete(cache.keys().next().value as string);
    return pending;
  };
  let opened: Promise<MercatorTileSource> | undefined;
  const source = () =>
    (opened ??= open().catch((error: unknown) => {
      opened = undefined;
      throw error;
    }));
  const Layer = sdk.layers.BaseTileLayer.createSubclass({
    load(this: ArcgisRasterLayer) {
      this.addResolvingPromise(source());
    },
    async fetchTile(
      this: ArcgisRasterLayer,
      level: number,
      row: number,
      column: number,
      options?: { signal?: AbortSignal },
    ) {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = TILE_SIZE;
      const resolution = resolutions[level];
      if (resolution === undefined) return canvas;
      const reader = await source();
      options?.signal?.throwIfAborted();
      const size = TILE_SIZE / GRID_STEP + 1;
      const left = -span + column * TILE_SIZE * resolution;
      const top = span - row * TILE_SIZE * resolution;
      const points: ArcgisPoint[] = [];
      for (let j = 0; j < size; j++)
        for (let i = 0; i < size; i++)
          points.push(
            new sdk.Point({
              x: left + i * GRID_STEP * resolution,
              y: top - j * GRID_STEP * resolution,
              spatialReference: sr,
            }),
          );
      const project = (batch: ArcgisPoint[]): (ArcgisPoint | null)[] | null => {
        try {
          return operator.executeMany(batch, { wkid: 4326 });
        } catch {
          return null;
        }
      };
      const projected = project(points);
      if (!projected) return canvas;
      const guess = sourceZoomForResolution(
        geographic ? resolution * METRES_PER_DEGREE : resolution,
        reader.maxZoom,
      );
      const guessGrid = projected.map((point) => sourcePixel(point, guess));
      const zoom = adaptedSourceZoom(
        guess,
        medianCellSpan(guessGrid, size),
        GRID_STEP,
        reader.maxZoom,
      );
      // Mercator pixels scale by 2 per zoom, so the grid need not be re-projected.
      const factor = 2 ** (zoom - guess);
      const grid = guessGrid.map((point): [number, number] | null =>
        point ? [point[0] * factor, point[1] * factor] : null,
      );
      // Cells the grid cannot interpolate (a seam or the domain's edge) with at
      // least one corner on the map are projected pixel by pixel.
      const drawable = drawableCells(grid, size);
      const refine: number[] = [];
      drawable.forEach((ok, cell) => {
        if (ok) return;
        const i = cell % (size - 1);
        const j = Math.floor(cell / (size - 1));
        const corners = [
          j * size + i,
          j * size + i + 1,
          (j + 1) * size + i,
          (j + 1) * size + i + 1,
        ];
        if (corners.some((index) => grid[index])) refine.push(cell);
      });
      const exact = new Map<number, ([number, number] | null)[]>();
      if (refine.length) {
        const pixelPoints: ArcgisPoint[] = [];
        for (const cell of refine) {
          const i = cell % (size - 1);
          const j = Math.floor(cell / (size - 1));
          for (let v = 0; v < GRID_STEP; v++)
            for (let u = 0; u < GRID_STEP; u++)
              pixelPoints.push(
                new sdk.Point({
                  // Pixel centres.
                  x: left + (i * GRID_STEP + u + 0.5) * resolution,
                  y: top - (j * GRID_STEP + v + 0.5) * resolution,
                  spatialReference: sr,
                }),
              );
        }
        const pixels = project(pixelPoints);
        if (pixels) {
          const per = GRID_STEP * GRID_STEP;
          refine.forEach((cell, index) =>
            exact.set(
              cell,
              pixels.slice(index * per, (index + 1) * per).map((point) => sourcePixel(point, zoom)),
            ),
          );
        }
      }
      const needed = sourceTilesForGrid(
        [...grid, ...[...exact.values()].flat()],
        zoom,
        reader.bounds,
      );
      // A view far out over a deep source would read too much for one tile.
      if (!needed.length || needed.length > MAX_SOURCE_TILES) return canvas;
      const tiles = new Map<string, MercatorTileData>();
      await Promise.all(
        needed.map(async ([x, y]) => {
          tiles.set(`${x},${y}`, await readTile(reader, zoom, x, y).catch(() => null));
        }),
      );
      options?.signal?.throwIfAborted();
      if (this.destroyed) throw new DOMException("Layer removed", "AbortError");
      const rgba = warpTile(grid, size, GRID_STEP, tiles, exact);
      canvas.getContext("2d")!.putImageData(new ImageData(rgba, TILE_SIZE, TILE_SIZE), 0, 0);
      return canvas;
    },
  });
  return new Layer({ ...properties, tileInfo, spatialReference: sr });
}
