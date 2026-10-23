import { encodeTerrariumDem, type CogDemSourceRegistration } from "./cog-dem-source";
import type { ArcgisElevationLayer, ArcgisSceneSdk } from "./arcgis-sdk";

const TILE_SIZE = 256;
const HALF_WORLD = 20037508.342789244;

/**
 * Convert the shared Terrarium DEM's pixel centres into ArcGIS's 257x257
 * elevation vertices. Neighbouring tiles supply edge samples so adjacent
 * meshes calculate exactly the same height along their shared border.
 */
export function createCogElevationLayer(
  scene: ArcgisSceneSdk,
  source: CogDemSourceRegistration,
  exaggeration: number,
): ArcgisElevationLayer {
  const cache = new Map<string, Promise<Uint8ClampedArray>>();
  let zeroTile: Uint8ClampedArray | undefined;
  const read = (level: number, col: number, row: number) => {
    const count = 2 ** level;
    const x = ((col % count) + count) % count;
    if (row < 0 || row >= count) {
      zeroTile ??= encodeTerrariumDem(new Float32Array(TILE_SIZE * TILE_SIZE), null);
      return Promise.resolve(zeroTile);
    }
    const y = row;
    const key = `${level}/${x}/${y}`;
    let tile = cache.get(key);
    if (!tile) {
      tile = source.renderTile(level, x, y);
      cache.set(key, tile);
      void tile.catch(() => {
        if (cache.get(key) === tile) cache.delete(key);
      });
      if (cache.size > 64) cache.delete(cache.keys().next().value!);
    } else {
      // Keep recently reused neighbours when panning back over tile boundaries.
      cache.delete(key);
      cache.set(key, tile);
    }
    return tile;
  };
  const CogElevation = scene.BaseElevationLayer.createSubclass({
    load(this: ArcgisElevationLayer) {
      this.spatialReference = { wkid: 3857 };
      this.tileInfo = {
        size: [TILE_SIZE, TILE_SIZE],
        dpi: 96,
        format: "lerc",
        spatialReference: { wkid: 3857 },
        origin: { x: -HALF_WORLD, y: HALF_WORLD },
        lods: Array.from({ length: 23 }, (_, level) => ({
          level,
          resolution: (2 * HALF_WORLD) / TILE_SIZE / 2 ** level,
          scale: 591657527.591555 / 2 ** level,
        })),
      };
    },
    async fetchTile(level: number, row: number, col: number, options?: { signal?: AbortSignal }) {
      options?.signal?.throwIfAborted();
      const neighbours = await Promise.all(
        [-1, 0, 1].flatMap((dy) => [-1, 0, 1].map((dx) => read(level, col + dx, row + dy))),
      );
      options?.signal?.throwIfAborted();
      const sample = (x: number, y: number) => {
        const dx = Math.floor(x / TILE_SIZE);
        const dy = Math.floor(y / TILE_SIZE);
        const image = neighbours[(dy + 1) * 3 + dx + 1];
        const offset =
          (((y + TILE_SIZE) % TILE_SIZE) * TILE_SIZE + ((x + TILE_SIZE) % TILE_SIZE)) * 4;
        return image[offset] * 256 + image[offset + 1] + image[offset + 2] / 256 - 32768;
      };
      const width = TILE_SIZE + 1;
      const values = new Float32Array(width * width);
      for (let y = 0; y < width; y++) {
        for (let x = 0; x < width; x++) {
          values[y * width + x] =
            (sample(x - 1, y - 1) + sample(x, y - 1) + sample(x - 1, y) + sample(x, y)) *
            0.25 *
            exaggeration;
        }
      }
      return { values, width, height: width, noDataValue: -3.4028234663852886e38 };
    },
  });
  return new CogElevation({ listMode: "hide" });
}
