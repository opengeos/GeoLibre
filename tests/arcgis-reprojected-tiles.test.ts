import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createArcgisCogLayer } from "../packages/map/src/arcgis-cog-imagery";
import { zoomToScale } from "../packages/map/src/arcgis-layers";
import {
  adaptedSourceZoom,
  createReprojectedTileLayer,
  drawableCells,
  lonLatToMercatorPixel,
  medianCellSpan,
  reprojectedTilingScheme,
  sourcePixel,
  sourceTilesForGrid,
  sourceZoomForResolution,
  warpTile,
  type MercatorTileSource,
} from "../packages/map/src/arcgis-reprojected-tiles";
import type { ArcgisProjectOperator, ArcgisSdk } from "../packages/map/src/arcgis-sdk";
import type { CogTilerModule } from "../packages/map/src/cog-imagery";
import { geojsonLayer } from "./helpers/layer-fixtures";

// Web Mercator tiles warped into a map in another projection, e.g. a COG on a
// Spilhaus map (issue #2708).

type Grid = ([number, number] | null)[];

/** A size × size grid of source pixels, `spacing` apart from `origin`. */
function regularGrid(size: number, spacing: number, origin: [number, number] = [0, 0]): Grid {
  const grid: Grid = [];
  for (let j = 0; j < size; j++)
    for (let i = 0; i < size; i++) grid.push([origin[0] + i * spacing, origin[1] + j * spacing]);
  return grid;
}

/** A 256 × 256 RGBA tile of one colour. */
function solidTile(r: number, g: number, b: number): Uint8ClampedArray {
  const data = new Uint8ClampedArray(256 * 256 * 4);
  for (let k = 0; k < data.length; k += 4) data.set([r, g, b, 255], k);
  return data;
}

function fakeSdk() {
  return {
    layers: {
      BaseTileLayer: {
        createSubclass(definition: object) {
          class Raster {
            pending?: Promise<unknown>;
            destroyed = false;
            addResolvingPromise(p: Promise<unknown>) {
              this.pending = p;
            }
            constructor(props: object) {
              Object.assign(this, props);
            }
          }
          Object.assign(Raster.prototype, definition);
          return Raster;
        },
      },
    },
    TileInfo: class {
      constructor(props: object) {
        Object.assign(this, props);
      }
    },
    Point: class {
      constructor(props: object) {
        Object.assign(this, props);
      }
    },
  } as unknown as ArcgisSdk;
}

/** A "projection" whose metres are 1e5 per degree, failing past ±100°. */
const operator: ArcgisProjectOperator = {
  load: async () => {},
  isLoaded: () => true,
  execute: () => null,
  executeMany: <T>(geometries: T[]) =>
    geometries.map((geometry) => {
      const { x, y } = geometry as { x: number; y: number };
      return Math.abs(x) > 1e7 ? null : ({ x: x / 1e5, y: y / 1e5 } as T);
    }),
};

describe("reprojected tile helpers", () => {
  it("uses the standard Web Mercator scales, so view zooms keep their meaning", () => {
    const { scales, resolutions } = reprojectedTilingScheme(false);
    assert.equal(scales[0], zoomToScale(0));
    assert.equal(scales[10], zoomToScale(10));
    assert.ok(Math.abs(resolutions[0] - 156543.03392804097) < 1e-3);
    const geographic = reprojectedTilingScheme(true);
    assert.ok(Math.abs(geographic.resolutions[0] * 111319.49079327357 - resolutions[0]) < 1e-3);
  });
  it("picks the source zoom that matches a resolution, within the source's range", () => {
    assert.equal(sourceZoomForResolution(156543.03392804097), 0);
    assert.equal(sourceZoomForResolution(156543.03392804097 / 2 ** 7), 7);
    assert.equal(sourceZoomForResolution(1, 12), 12);
    assert.equal(sourceZoomForResolution(Number.NaN), 0);
  });
  it("maps longitude/latitude to Web Mercator pixels", () => {
    assert.deepEqual(lonLatToMercatorPixel(0, 0, 0), [128, 128]);
    assert.deepEqual(lonLatToMercatorPixel(-180, 0, 1), [0, 256]);
    const [, top] = lonLatToMercatorPixel(0, 85.0511287798066, 0);
    assert.ok(Math.abs(top) < 1e-6);
  });
  it("drops unprojectable and polar points and wraps the antimeridian", () => {
    assert.equal(sourcePixel(null, 3), null);
    assert.equal(sourcePixel({ x: 10, y: 86 }, 3), null);
    assert.equal(sourcePixel({ x: Number.NaN, y: 0 }, 3), null);
    assert.deepEqual(sourcePixel({ x: 180.5, y: 0 }, 0), sourcePixel({ x: -179.5, y: 0 }, 0));
  });
  it("corrects the zoom by how far the projection stretches the tile", () => {
    // Cells spanning 2 source pixels for 8 output pixels: read 2 zooms deeper.
    assert.equal(adaptedSourceZoom(3, 2, 8), 5);
    assert.equal(adaptedSourceZoom(3, 32, 8), 1);
    assert.equal(adaptedSourceZoom(3, 2, 8, 4), 4);
    assert.equal(adaptedSourceZoom(3, null, 8), 3);
    assert.equal(medianCellSpan(regularGrid(3, 5), 3), 5);
    assert.equal(medianCellSpan([null, null, null, null], 2), null);
  });
  it("refuses grid cells across a seam or with a missing corner", () => {
    const grid = regularGrid(4, 8);
    grid[2] = [5000, 8]; // A point thrown across the projection's seam.
    grid[12] = null;
    const cells = drawableCells(grid, 4);
    assert.deepEqual(cells, [true, false, false, true, true, true, false, true, true]);
  });
  it("warps by interpolation, exact pixels and the empty world edge", () => {
    const tiles = new Map([
      ["0,0", solidTile(10, 20, 30)],
      ["1,0", solidTile(200, 100, 50)],
    ]);
    // A 3 × 3 grid, 4 output pixels per cell, reading source pixels 1:1.
    const out = warpTile(regularGrid(3, 4, [250, 0]), 3, 4, tiles);
    const pixel = (x: number, y: number) => [...out.slice((y * 8 + x) * 4, (y * 8 + x) * 4 + 4)];
    assert.deepEqual(pixel(0, 0), [10, 20, 30, 255], "x 250 is in tile 0");
    assert.deepEqual(pixel(7, 7), [200, 100, 50, 255], "x 257 is in tile 1");
    // A refused cell draws only from its exact pixels.
    const seam = regularGrid(3, 4, [250, 0]);
    seam[1] = null;
    const exact = new Map([[0, Array.from({ length: 16 }, (_, k) => (k === 5 ? [0, 0] : null))]]);
    const patched = warpTile(seam, 3, 4, tiles, exact as Map<number, ([number, number] | null)[]>);
    const at = (x: number, y: number) => [...patched.slice((y * 8 + x) * 4, (y * 8 + x) * 4 + 4)];
    assert.deepEqual(at(0, 0), [0, 0, 0, 0]);
    // Exact pixel (1, 1) asked for world pixel x 0, which reads x 1 instead.
    assert.deepEqual(at(1, 1), [10, 20, 30, 255]);
  });
  it("lists the source tiles a grid reads, inside the world and the source's bounds", () => {
    const grid: Grid = [[10, 10], [300, 10], [600, 600], [-5, 10], null];
    assert.deepEqual(
      sourceTilesForGrid(grid, 2).sort(),
      [
        [0, 0],
        [1, 0],
        [2, 2],
      ].sort(),
    );
    // Only the western hemisphere's northern half.
    assert.deepEqual(sourceTilesForGrid(grid, 2, [-180, 0, -1, 80]), [
      [0, 0],
      [1, 0],
    ]);
  });
});

describe("createReprojectedTileLayer", () => {
  it("tiles the view's projection and warps the source into it", async () => {
    const renders: number[][] = [];
    const source: MercatorTileSource = {
      render: async (z, x, y) => {
        renders.push([z, x, y]);
        return solidTile(1, 2, 3);
      },
    };
    let opens = 0;
    const layer = createReprojectedTileLayer(
      fakeSdk(),
      operator,
      { wkid: 54099 },
      async () => {
        opens++;
        return source;
      },
      { title: "warped" },
    ) as unknown as {
      tileInfo: { lods: { scale: number }[]; spatialReference: { wkid: number } };
      spatialReference: { wkid: number };
      title: string;
      load(): void;
      pending: Promise<unknown>;
      fetchTile(level: number, row: number, column: number): Promise<unknown>;
    };
    assert.equal(opens, 0, "the source opens on load, not construction");
    assert.equal(layer.spatialReference.wkid, 54099);
    assert.equal(layer.tileInfo.spatialReference.wkid, 54099);
    assert.equal(layer.tileInfo.lods[3].scale, zoomToScale(3));
    assert.equal(layer.title, "warped");
    layer.load();
    await layer.pending;
    assert.equal(opens, 1);

    let drawn: { data: Uint8ClampedArray } | null = null;
    const previous = { document: globalThis.document, ImageData: globalThis.ImageData };
    Object.assign(globalThis, {
      document: {
        createElement: () => ({
          width: 0,
          height: 0,
          getContext: () => ({
            putImageData: (image: { data: Uint8ClampedArray }) => (drawn = image),
          }),
        }),
      },
      ImageData: class {
        constructor(public data: Uint8ClampedArray) {}
      },
    });
    try {
      // The tile whose top-left corner is the projection's origin, at level 8.
      const { span, resolutions } = reprojectedTilingScheme(false);
      const tile = 256 * resolutions[8];
      const index = Math.round(span / tile);
      await layer.fetchTile(8, index, index);
      assert.ok(renders.length > 0);
      assert.ok(renders.every(([z]) => z === renders[0][0]));
      const data = (drawn as { data: Uint8ClampedArray } | null)?.data;
      assert.ok(data);
      assert.deepEqual([...data!.slice(0, 4)], [1, 2, 3, 255]);
      // A tile wholly outside the projection's domain reads nothing.
      const before = renders.length;
      drawn = null;
      await layer.fetchTile(8, 0, 0);
      assert.equal(renders.length, before);
      assert.equal(drawn, null);
    } finally {
      Object.assign(globalThis, previous);
    }
  });
});

describe("createArcgisCogLayer on a projected map", () => {
  it("warps the COG's rendered tiles with its bounds, staying lazy", async () => {
    const layer = geojsonLayer({
      type: "cog",
      geojson: undefined,
      source: { type: "raster", url: "https://example.test/a.tif" },
      metadata: { bandCount: 1, rasterState: { mode: "single", bands: [1], rescale: [0, 255] } },
    });
    let opened = 0;
    const tiler = {
      openCog: async () => {
        opened++;
        return {
          boundsLonLat: [-10, -10, 10, 10],
          info: () => ({ maxzoom: 9 }),
          renderTileRGBA: async () => null,
        };
      },
    } as unknown as CogTilerModule;
    const native = createArcgisCogLayer(fakeSdk(), layer, {}, async () => tiler, {
      operator,
      spatialReference: { wkid: 54030 },
    }) as unknown as {
      spatialReference: { wkid: number };
      load(): void;
      pending: Promise<unknown>;
    };
    assert.equal(opened, 0);
    assert.equal(native.spatialReference.wkid, 54030);
    native.load();
    const source = (await native.pending) as MercatorTileSource;
    assert.equal(opened, 1);
    assert.equal(source.maxZoom, 9);
    assert.deepEqual(source.bounds, [-10, -10, 10, 10]);
  });
});
