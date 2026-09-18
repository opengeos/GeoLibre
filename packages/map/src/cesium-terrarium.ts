import type {
  Credit,
  Event,
  TileAvailability,
  WebMercatorTilingScheme,
  HeightmapTerrainData,
} from "@cesium/engine";

type CesiumNs = typeof import("@cesium/engine");
type TileReader = (z: number, x: number, y: number) => Promise<Uint8ClampedArray>;
const GRID = 65;
const SIZE = 256;

/** Decode shared edge samples from the adjacent tiles as well as the interior. */
export function terrariumHeightmap(
  tiles: readonly Uint8ClampedArray[],
  clampSouth = false,
): Float32Array {
  const heights = new Float32Array(GRID * GRID);
  for (let row = 0; row < GRID; row++) {
    for (let col = 0; col < GRID; col++) {
      const x = col * 4;
      const y = clampSouth && row === GRID - 1 ? SIZE - 1 : row * 4;
      const tile = tiles[(y === SIZE ? 2 : 0) + (x === SIZE ? 1 : 0)];
      const offset = ((y % SIZE) * SIZE + (x % SIZE)) * 4;
      heights[row * GRID + col] = tile[offset + 3]
        ? tile[offset] * 256 + tile[offset + 1] + tile[offset + 2] / 256 - 32768
        : 0;
    }
  }
  return heights;
}

/** Native heightmap terrain, with bounded requests and exact shared tile edges. */
export class TerrariumTerrainProvider {
  readonly tilingScheme: WebMercatorTilingScheme;
  readonly errorEvent: Event;
  readonly credit: Credit;
  readonly availability: TileAvailability;
  readonly hasWaterMask = false;
  readonly hasVertexNormals = false;
  private readonly levelZeroError: number;
  private readonly cache = new Map<string, Promise<Uint8ClampedArray>>();
  private readonly abort = new AbortController();
  private pending = 0;

  constructor(
    private readonly Cesium: CesiumNs,
    private readonly readTile?: TileReader,
    private readonly maxLevel = 15,
  ) {
    this.tilingScheme = new Cesium.WebMercatorTilingScheme();
    this.errorEvent = new Cesium.Event();
    this.credit = new Cesium.Credit(
      readTile
        ? "Elevation from user-provided Cloud Optimized GeoTIFF"
        : '<a href="https://github.com/tilezen/joerd/blob/master/docs/attribution.md">Mapzen terrain tiles</a>',
    );
    this.availability = new Cesium.TileAvailability(this.tilingScheme, maxLevel);
    for (let level = 0; level <= maxLevel; level++) {
      const end = 2 ** level - 1;
      this.availability.addAvailableTileRange(level, 0, 0, end, end);
    }
    this.levelZeroError = Cesium.TerrainProvider.getEstimatedLevelZeroGeometricErrorForAHeightmap(
      this.tilingScheme.ellipsoid,
      GRID,
      this.tilingScheme.getNumberOfXTilesAtLevel(0),
    );
  }

  getLevelMaximumGeometricError(level: number): number {
    return this.levelZeroError / 2 ** level;
  }
  getTileDataAvailable(x: number, y: number, level: number): boolean {
    return (
      !this.abort.signal.aborted &&
      level <= this.maxLevel &&
      level >= 0 &&
      x >= 0 &&
      y >= 0 &&
      x < 2 ** level &&
      y < 2 ** level
    );
  }
  loadTileDataAvailability(): undefined {
    return undefined;
  }

  requestTileGeometry(
    x: number,
    y: number,
    level: number,
  ): Promise<HeightmapTerrainData> | undefined {
    if (this.abort.signal.aborted || this.pending >= 16) return undefined;
    this.pending++;
    const n = 2 ** level;
    return Promise.all([
      this.tile(level, x, y),
      this.tile(level, (x + 1) % n, y),
      this.tile(level, x, Math.min(y + 1, n - 1)),
      this.tile(level, (x + 1) % n, Math.min(y + 1, n - 1)),
    ])
      .then((tiles) => {
        this.abort.signal.throwIfAborted();
        return new this.Cesium.HeightmapTerrainData({
          buffer: terrariumHeightmap(tiles, y === n - 1),
          width: GRID,
          height: GRID,
          childTileMask: level < this.maxLevel ? 15 : 0,
        });
      })
      .finally(() => {
        this.pending--;
      });
  }

  private tile(z: number, x: number, y: number): Promise<Uint8ClampedArray> {
    const key = `${z}/${x}/${y}`;
    const existing = this.cache.get(key);
    if (existing) return existing;
    const result = this.readTile ? this.readTile(z, x, y) : this.fetchTile(key);
    this.cache.set(key, result);
    // Keep shared reads around for neighbouring geometry; evicted in-flight
    // requests still complete for their current callers.
    if (this.cache.size > 128) this.cache.delete(this.cache.keys().next().value!);
    void result.catch(() => {
      if (this.cache.get(key) === result) this.cache.delete(key);
    });
    return result;
  }

  private async fetchTile(key: string): Promise<Uint8ClampedArray> {
    const response = await fetch(
      `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${key}.png`,
      { signal: this.abort.signal },
    );
    if (!response.ok) throw new Error(`Terrain tile ${key}: HTTP ${response.status}`);
    const bitmap = await createImageBitmap(await response.blob());
    try {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = SIZE;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context) throw new Error("Could not decode terrain tile");
      context.drawImage(bitmap, 0, 0, SIZE, SIZE);
      return context.getImageData(0, 0, SIZE, SIZE).data;
    } finally {
      bitmap.close();
    }
  }

  destroy(): void {
    this.abort.abort();
    this.cache.clear();
  }
}
