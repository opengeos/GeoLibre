import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  composeCubeRgb,
  CUBE_FACES,
  CubeError,
  cubeFaceSize,
  faceSampleIndex,
  intersectRect,
  MAX_CUBE_BANDS,
  paintCubeFace,
  readNetcdfCube,
  recomposeCubeRgb,
  sliceCube,
  strideBands,
  validDataRect,
  type CubeFace,
  type CubeFootprint,
  type NetcdfCube,
} from "../apps/geolibre-desktop/src/lib/netcdf-cube";
import type {
  LocalNetcdfAxis,
  LocalNetcdfGrid,
} from "../packages/plugins/src/plugins/local-netcdf";

/**
 * A cube whose every value encodes its own position as `z*100 + y*10 + x`, so a
 * face's texels can be checked against the cell they are supposed to show
 * rather than against a hand-copied expected array.
 */
function positionCube(nx = 2, ny = 3, nz = 4): NetcdfCube {
  const values = new Float32Array(nx * ny * nz);
  for (let z = 0; z < nz; z++) {
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; x++) {
        values[z * ny * nx + y * nx + x] = z * 100 + y * 10 + x;
      }
    }
  }
  return {
    nx,
    ny,
    nz,
    values,
    bands: Array.from({ length: nz }, (_, i) => ({ index: i })),
    axis: { name: "bands" },
    variable: "reflectance",
    bounds: [0, 0, 1, 1],
    dataClim: [0, z(nz, ny, nx)],
  };
}

/** The largest value {@link positionCube} holds. */
function z(nz: number, ny: number, nx: number): number {
  return (nz - 1) * 100 + (ny - 1) * 10 + (nx - 1);
}

/** The value a face's texel shows, via the index the painter uses. */
function sample(cube: NetcdfCube, face: CubeFace, u: number, v: number): number {
  return cube.values[faceSampleIndex(cube, face, u, v)];
}

/** The footprint the reader would build for a cube, for the tests that need one. */
function footprintOf(cube: NetcdfCube): CubeFootprint {
  const { nx, ny, nz } = cube;
  const cell = new Uint8Array(ny * nx);
  const row = new Uint8Array(ny);
  const column = new Uint8Array(nx);
  const rowFirst = new Int32Array(ny).fill(-1);
  const rowLast = new Int32Array(ny).fill(-1);
  const columnFirst = new Int32Array(nx).fill(-1);
  const columnLast = new Int32Array(nx).fill(-1);
  for (let z = 0; z < nz; z++) {
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; x++) {
        if (!Number.isFinite(cube.values[z * ny * nx + y * nx + x])) continue;
        cell[y * nx + x] = 1;
      }
    }
  }
  for (let y = 0; y < ny; y++) {
    for (let x = 0; x < nx; x++) {
      if (!cell[y * nx + x]) continue;
      row[y] = 1;
      column[x] = 1;
      if (rowFirst[y] < 0) rowFirst[y] = x;
      rowLast[y] = x;
      if (columnFirst[x] < 0) columnFirst[x] = y;
      columnLast[x] = y;
    }
  }
  return { cell, row, column, rowFirst, rowLast, columnFirst, columnLast };
}

/** A one-plane grid, as a windowed band read would return it. */
function grid(values: number[], nx: number, ny: number, fillValue?: number): LocalNetcdfGrid {
  return {
    ny,
    nx,
    values: new Float32Array(values),
    lat: new Float64Array(Array.from({ length: ny }, (_, i) => 40 - i)),
    lon: new Float64Array(Array.from({ length: nx }, (_, i) => -100 + i)),
    ...(fillValue === undefined ? {} : { fillValue }),
    dataClim: [0, 1],
  };
}

describe("strideBands", () => {
  it("returns every band when the axis fits under the cap", () => {
    assert.deepEqual(strideBands(4, 10), [0, 1, 2, 3]);
  });

  it("spans the whole axis when it has to drop bands", () => {
    const picked = strideBands(100, 5);
    assert.equal(picked.length, 5);
    assert.equal(picked[0], 0);
    // The point of striding rather than truncating: the last band read is near
    // the far end of the spectrum, not the fifth one in.
    assert.ok(picked[4] >= 75, `expected the tail of the axis, got ${picked[4]}`);
    assert.deepEqual(
      [...picked].sort((a, b) => a - b),
      picked,
    );
  });

  it("caps a long axis at the reader's ceiling", async () => {
    // Nothing about this feature is EMIT-specific, and a variable with a few
    // thousand entries on its band axis would otherwise be read whole into one
    // unbounded array.
    let reads = 0;
    const cube = await readNetcdfCube({
      readBand: () => {
        reads += 1;
        return Promise.resolve(grid([1], 1, 1));
      },
      variable: "reflectance",
      axis: { name: "bands", size: 5000 },
      maxBands: 5000,
    });
    assert.equal(cube.nz, MAX_CUBE_BANDS);
    assert.equal(reads, MAX_CUBE_BANDS);
  });

  it("never reads past the end of the axis", () => {
    for (const size of [1, 7, 285, 2000]) {
      const picked = strideBands(size, 64);
      assert.ok(picked.every((index) => index >= 0 && index < size));
    }
  });
});

describe("readNetcdfCube", () => {
  const axis: LocalNetcdfAxis = { name: "bands", size: 3, values: [400, 500, 600], units: "nm" };

  it("stacks band planes band-major and unpacks them to physical units", async () => {
    const planes = [
      grid([1, 2, 3, 4], 2, 2),
      grid([5, 6, 7, 8], 2, 2),
      grid([9, 10, 11, 12], 2, 2),
    ];
    const cube = await readNetcdfCube({
      readBand: (index) => Promise.resolve(planes[index]),
      variable: "reflectance",
      axis,
    });
    assert.deepEqual([cube.nx, cube.ny, cube.nz], [2, 2, 3]);
    assert.deepEqual(Array.from(cube.values), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    // The band axis' own coordinates come through, so the viewer can say which
    // wavelength a face is showing rather than which index.
    assert.deepEqual(
      cube.bands.map((band) => band.value),
      [400, 500, 600],
    );
    assert.equal(cube.axis.units, "nm");
  });

  it("applies scale_factor/add_offset and turns fill values into NaN", async () => {
    const plane = grid([10, -9999, 30, 40], 2, 2, -9999);
    plane.scaleFactor = 0.5;
    plane.addOffset = 1;
    const cube = await readNetcdfCube({
      readBand: () => Promise.resolve(plane),
      variable: "reflectance",
      axis: { name: "bands", size: 1 },
    });
    assert.deepEqual(Array.from(cube.values.slice(0, 1)), [6]);
    // Not 1 + 0.5 * -9999: a fill reading is absent, not a very negative one,
    // and scaling it would drag the whole cube's stretch down with it.
    assert.ok(Number.isNaN(cube.values[1]));
    assert.deepEqual(Array.from(cube.values.slice(2)), [16, 21]);
  });

  it("computes one stretch across the whole cube, not per band", async () => {
    const planes = [grid([0, 0, 0, 0], 2, 2), grid([100, 100, 100, 100], 2, 2)];
    const cube = await readNetcdfCube({
      readBand: (index) => Promise.resolve(planes[index]),
      variable: "reflectance",
      axis: { name: "bands", size: 2 },
    });
    // A per-plane range would make the flat first band span 0-0 and the flat
    // second span 100-100, and the two faces would then paint identically.
    assert.equal(cube.dataClim[0], 0);
    assert.equal(cube.dataClim[1], 100);
  });

  it("records where the cube holds data, collapsed across the bands", async () => {
    // Column 1 is fill in band 0 but has a reading in band 1, so a per-plane
    // mask would wrongly mark it empty and the faces would skip a real cell.
    const planes = [grid([1, -9999, 3, -9999], 2, 2, -9999), grid([5, 6, 7, -9999], 2, 2, -9999)];
    const cube = await readNetcdfCube({
      readBand: (index) => Promise.resolve(planes[index]),
      variable: "reflectance",
      axis: { name: "bands", size: 2 },
    });
    assert.ok(cube.footprint);
    assert.deepEqual(Array.from(cube.footprint.cell), [1, 1, 1, 0]);
    assert.deepEqual(Array.from(cube.footprint.row), [1, 1]);
    assert.deepEqual(Array.from(cube.footprint.column), [1, 1]);
    // Row 1 holds data only at column 0, so a ray entering from the east can
    // jump straight there instead of stepping across the gap.
    assert.deepEqual(Array.from(cube.footprint.rowLast), [1, 0]);
    assert.deepEqual(Array.from(cube.footprint.rowFirst), [0, 0]);
  });

  it("reports progress once per band", async () => {
    const seen: Array<[number, number]> = [];
    await readNetcdfCube({
      readBand: () => Promise.resolve(grid([1], 1, 1)),
      variable: "reflectance",
      axis: { name: "bands", size: 3 },
      onProgress: (done, total) => seen.push([done, total]),
    });
    assert.deepEqual(seen, [
      [1, 3],
      [2, 3],
      [3, 3],
    ]);
  });

  it("stops when the read is aborted", async () => {
    const controller = new AbortController();
    let reads = 0;
    await assert.rejects(
      readNetcdfCube({
        readBand: () => {
          reads += 1;
          controller.abort();
          return Promise.resolve(grid([1], 1, 1));
        },
        variable: "reflectance",
        axis: { name: "bands", size: 10 },
        signal: controller.signal,
      }),
      /cancelled/,
    );
    // Abort is checked between planes, so exactly one more read than the one
    // that triggered it must not happen.
    assert.equal(reads, 1);
  });

  it("refuses to stack planes of different shapes", async () => {
    const planes = [grid([1, 2, 3, 4], 2, 2), grid([1, 2], 2, 1)];
    await assert.rejects(
      readNetcdfCube({
        readBand: (index) => Promise.resolve(planes[index]),
        variable: "reflectance",
        axis: { name: "bands", size: 2 },
      }),
      (error: unknown) => {
        assert.ok(error instanceof CubeError);
        assert.equal(error.code, "shapeMismatch");
        return true;
      },
    );
  });
});

describe("sliceCube", () => {
  it("keeps the lowest bands, as a view onto the same values", () => {
    const cube = positionCube(2, 2, 4);
    const sliced = sliceCube(cube, 2);
    assert.equal(sliced.nz, 2);
    assert.equal(sliced.values.length, 2 * 2 * 2);
    // Band-major storage is what makes this a subarray rather than a copy, so a
    // slider drag costs nothing.
    assert.equal(sliced.values.buffer, cube.values.buffer);
    assert.deepEqual(
      sliced.bands.map((band) => band.index),
      [0, 1],
    );
  });

  it("shows the cut plane as the sliced cube's top face", () => {
    const cube = positionCube(2, 2, 4);
    const sliced = sliceCube(cube, 2);
    // Band 1 is now the exterior, so the top face reads it rather than band 3.
    assert.equal(sample(sliced, "top", 0, 0), 1 * 100 + 1 * 10 + 0);
  });

  it("returns the cube itself when nothing is cut", () => {
    const cube = positionCube();
    assert.equal(sliceCube(cube, cube.nz), cube);
    assert.equal(sliceCube(cube, cube.nz + 10), cube);
  });

  it("never slices away every band", () => {
    const cube = positionCube(2, 2, 4);
    // The slider reaches zero, and a cube with no bands has no faces to draw.
    assert.equal(sliceCube(cube, 0).nz, 1);
    assert.equal(sliceCube(cube, -5).nz, 1);
  });
});

describe("composeCubeRgb", () => {
  it("stretches each channel over its own range", () => {
    // Red spans 0-30 and blue 100-130; a shared stretch would make the image
    // one hue instead of three independently scaled channels.
    const red = grid([0, 10, 20, 30], 2, 2);
    const green = grid([0, 10, 20, 30], 2, 2);
    const blue = grid([100, 110, 120, 130], 2, 2);
    const image = composeCubeRgb([red, green, blue]);
    assert.deepEqual([image.width, image.height], [2, 2]);
    // Texel row 0 is south, which is the grid's *last* row: values 20 and 30.
    const [r, g, b, a] = Array.from(image.pixels.slice(0, 4));
    assert.ok(r > 150 && b > 150, `expected a bright corner, got ${r},${g},${b}`);
    assert.equal(a, 255);
  });

  it("puts the grid's southern row first, to match the top face", () => {
    const red = grid([0, 0, 255, 255], 2, 2);
    const image = composeCubeRgb([red, red, red]);
    // Row 0 of the grid is north and holds 0; texel row 0 is south and must
    // therefore show the 255s, or the overlay would land upside down on the cube.
    assert.equal(image.pixels[0], 255);
    assert.equal(image.pixels[(1 * 2 + 0) * 4], 0);
  });

  it("drops a cell unless all three channels have a reading", () => {
    const red = grid([1, 2, 3, 4], 2, 2, -9999);
    const green = grid([1, -9999, 3, 4], 2, 2, -9999);
    const blue = grid([1, 2, 3, 4], 2, 2, -9999);
    const image = composeCubeRgb([red, green, blue]);
    // Grid row 0 col 1 is the gap; texel row 1 (north) col 1.
    assert.equal(image.pixels[(1 * 2 + 1) * 4 + 3], 0);
    assert.equal(image.pixels[(1 * 2 + 0) * 4 + 3], 255);
  });

  it("drops a cell whose scaled value is not finite", () => {
    // A raw reading can be perfectly good and still overflow once an extreme
    // scale_factor is applied. Rounding the resulting NaN into a byte array
    // yields 0, so without the post-scale check the cell would paint opaque
    // black rather than dropping out like every other absent reading here.
    const overflowing = grid([1e300, 2, 3, 4], 2, 2);
    overflowing.scaleFactor = 1e300;
    const plain = grid([1, 2, 3, 4], 2, 2);
    const image = composeCubeRgb([overflowing, plain, plain]);
    // Grid row 0, column 0 is the overflow; texel row 1 (north), column 0.
    assert.equal(image.pixels[(1 * 2 + 0) * 4 + 3], 0);
  });

  it("rejects anything but three same-shaped bands", () => {
    const plane = grid([1, 2, 3, 4], 2, 2);
    assert.throws(() => composeCubeRgb([plane, plane]), /exactly three/);
    assert.throws(
      () => composeCubeRgb([plane, plane, grid([1, 2], 2, 1)]),
      /do not share one shape/,
    );
  });
});

describe("readNetcdfCube with an RGB overlay", () => {
  it("reads the chosen bands on top of the cube's own", async () => {
    const read: number[] = [];
    const cube = await readNetcdfCube({
      readBand: (index) => {
        read.push(index);
        return Promise.resolve(grid([index, index, index, index], 2, 2));
      },
      variable: "reflectance",
      axis: { name: "bands", size: 4 },
      maxBands: 2,
      rgbBands: [3, 1, 0],
    });
    // Two cube planes, then the three overlay bands: the overlay's bands are
    // usually not among the strided cube bands, so they cost their own reads.
    assert.deepEqual(read, [0, 2, 3, 1, 0]);
    assert.equal(cube.nz, 2);
    assert.ok(cube.rgb);
    assert.deepEqual(cube.rgbBands, [3, 1, 0]);
  });

  it("counts the overlay reads in the progress total", async () => {
    const seen: Array<[number, number]> = [];
    await readNetcdfCube({
      readBand: () => Promise.resolve(grid([1], 1, 1)),
      variable: "reflectance",
      axis: { name: "bands", size: 2 },
      rgbBands: [0, 1, 0],
      onProgress: (done, total) => seen.push([done, total]),
    });
    // Otherwise the bar would hit 100% and then sit there for three more reads.
    assert.deepEqual(seen, [
      [1, 5],
      [2, 5],
      [3, 5],
      [4, 5],
      [5, 5],
    ]);
  });

  it("composes no overlay when none was asked for", async () => {
    const cube = await readNetcdfCube({
      readBand: () => Promise.resolve(grid([1], 1, 1)),
      variable: "reflectance",
      axis: { name: "bands", size: 1 },
    });
    assert.equal(cube.rgb, undefined);
    assert.equal(cube.rgbBands, undefined);
  });
});

describe("validDataRect", () => {
  it("tightens onto the readings inside a nodata border", () => {
    // The shape of a real scene: a footprint sitting inside an axis-aligned
    // grid whose outer rows and columns are all fill.
    const f = -9999;
    const rect = validDataRect(grid([f, f, f, f, f, 1, 2, f, f, 3, 4, f, f, f, f, f], 4, 4, f));
    assert.deepEqual(rect, { row: 1, column: 1, rows: 2, columns: 2 });
  });

  it("treats non-finite cells as nodata too", () => {
    const g = grid([Number.NaN, Number.NaN, Number.NaN, 7], 2, 2);
    assert.deepEqual(validDataRect(g), { row: 1, column: 1, rows: 1, columns: 1 });
  });

  it("returns null when the grid holds nothing", () => {
    assert.equal(validDataRect(grid([-9999, -9999], 2, 1, -9999)), null);
  });

  it("keeps the whole grid when every cell is data", () => {
    assert.deepEqual(validDataRect(grid([1, 2, 3, 4], 2, 2)), {
      row: 0,
      column: 0,
      rows: 2,
      columns: 2,
    });
  });
});

describe("intersectRect", () => {
  it("returns the overlap of two rectangles", () => {
    const a = { row: 0, column: 0, rows: 10, columns: 10 };
    const b = { row: 4, column: 6, rows: 10, columns: 10 };
    assert.deepEqual(intersectRect(a, b), { row: 4, column: 6, rows: 6, columns: 4 });
  });

  it("returns null when they do not meet", () => {
    // A map view panned off the scene: the caller has to fall back rather than
    // read a negative-sized window.
    assert.equal(
      intersectRect(
        { row: 0, column: 0, rows: 2, columns: 2 },
        { row: 5, column: 5, rows: 2, columns: 2 },
      ),
      null,
    );
  });

  it("returns null for edge-touching rectangles", () => {
    assert.equal(
      intersectRect(
        { row: 0, column: 0, rows: 2, columns: 2 },
        { row: 2, column: 0, rows: 2, columns: 2 },
      ),
      null,
    );
  });
});

describe("cube faces", () => {
  it("sizes each face from the axes it spans", () => {
    const cube = positionCube();
    assert.deepEqual(cubeFaceSize(cube, "top"), { width: 2, height: 3 });
    assert.deepEqual(cubeFaceSize(cube, "north"), { width: 2, height: 4 });
    assert.deepEqual(cubeFaceSize(cube, "east"), { width: 4, height: 3 });
  });

  it("shows the last band on top and the first on the bottom", () => {
    const cube = positionCube();
    // Top: looking down, u east and v north, and row 0 is north.
    for (let v = 0; v < 3; v++) {
      for (let u = 0; u < 2; u++) {
        assert.equal(sample(cube, "top", u, v), 300 + (2 - v) * 10 + u);
        assert.equal(sample(cube, "bottom", u, v), v * 10 + u);
      }
    }
  });

  it("runs the band axis up the four side faces", () => {
    const cube = positionCube();
    for (let u = 0; u < 2; u++) {
      for (let v = 0; v < 4; v++) {
        // North edge (row 0), v counting down from the top band.
        assert.equal(sample(cube, "north", u, v), (3 - v) * 100 + u);
        // South edge (row ny-1), v counting up from the bottom band.
        assert.equal(sample(cube, "south", u, v), v * 100 + 20 + u);
      }
    }
    for (let u = 0; u < 4; u++) {
      for (let v = 0; v < 3; v++) {
        // East edge (column nx-1); u runs down the band axis there.
        assert.equal(sample(cube, "east", u, v), (3 - u) * 100 + (2 - v) * 10 + 1);
        // West edge (column 0); u runs up it.
        assert.equal(sample(cube, "west", u, v), u * 100 + (2 - v) * 10);
      }
    }
  });

  it("agrees with the top face where the side faces meet it", () => {
    // The corners are the check that the six mappings are one consistent view
    // and not six independently plausible ones.
    const cube = positionCube();
    // The north face's v axis points *down* the cube in world space (see
    // `placeFace`), so its v = 0 row sits against the top face, along row 0 —
    // which is the top face's last texel row, v = ny - 1.
    for (let u = 0; u < cube.nx; u++) {
      assert.equal(sample(cube, "north", u, 0), sample(cube, "top", u, cube.ny - 1));
    }
    // The south face's v axis points up instead, so its last row is the one
    // that meets the top face, along row ny - 1 (the top face's v = 0).
    const south = cubeFaceSize(cube, "south");
    for (let u = 0; u < cube.nx; u++) {
      assert.equal(sample(cube, "south", u, south.height - 1), sample(cube, "top", u, 0));
    }
    // The west face's u axis runs up the band axis, so its last column is the
    // top band along column 0, which is the top face's first column.
    for (let v = 0; v < cube.ny; v++) {
      assert.equal(sample(cube, "west", cube.nz - 1, v), sample(cube, "top", 0, v));
    }
    // The east face's u axis runs the other way, so its *first* column is the
    // top band, along column nx - 1.
    for (let v = 0; v < cube.ny; v++) {
      assert.equal(sample(cube, "east", 0, v), sample(cube, "top", cube.nx - 1, v));
    }
    // And the bottom face, which the sides reach at their other end.
    for (let u = 0; u < cube.nx; u++) {
      assert.equal(sample(cube, "south", u, 0), sample(cube, "bottom", u, cube.ny - 1));
    }
  });

  it("peels inward past a nodata skin to the first real reading", () => {
    // What a rotated satellite footprint looks like inside its axis-aligned
    // grid: the outer shell is nodata, so sampling the face itself would leave
    // every side of the cube invisible.
    const cube = positionCube(4, 4, 4);
    const inner = new Set<number>();
    for (let z = 1; z < 3; z++) {
      for (let y = 1; y < 3; y++) {
        for (let x = 1; x < 3; x++) inner.add(z * 16 + y * 4 + x);
      }
    }
    for (let i = 0; i < cube.values.length; i++) {
      if (!inner.has(i)) cube.values[i] = Number.NaN;
    }
    // The east face's texel over an interior row/band finds the cell one step
    // in from the edge, not the empty edge cell.
    assert.equal(sample(cube, "east", 1, 1), 2 * 100 + 2 * 10 + 2);
    // And the top face walks down the band axis to the topmost filled plane.
    assert.equal(sample(cube, "top", 1, 1), 2 * 100 + 2 * 10 + 1);
  });

  it("stays on the face when the whole ray is nodata", () => {
    const cube = positionCube(2, 2, 2);
    cube.values.fill(Number.NaN);
    const painted = paintCubeFace(cube, "east", [[9, 9, 9]], [0, 1]);
    // Nothing to show along that ray, so the texel must stay transparent
    // rather than latching onto some arbitrary cell.
    assert.ok(Array.from(painted.pixels).every((byte) => byte === 0));
  });

  it("paints identically with and without a footprint", () => {
    // The footprint only ever skips rays that were going to find nothing, or
    // jumps a ray over cells that are nodata at every band. Either way the
    // painted result has to be byte-for-byte what the plain walk produces, so
    // this pins the optimisation to the behaviour it is optimising.
    const plain = positionCube(7, 5, 4);
    // A rotated-footprint shape: a diamond of data inside a nodata margin.
    const cx = (plain.nx - 1) / 2;
    const cy = (plain.ny - 1) / 2;
    for (let z = 0; z < plain.nz; z++) {
      for (let y = 0; y < plain.ny; y++) {
        for (let x = 0; x < plain.nx; x++) {
          if (Math.abs(x - cx) / cx + Math.abs(y - cy) / cy > 1) {
            plain.values[z * plain.ny * plain.nx + y * plain.nx + x] = Number.NaN;
          }
        }
      }
    }
    const withFootprint: NetcdfCube = { ...plain, footprint: footprintOf(plain) };
    const colors: Array<[number, number, number]> = Array.from(
      { length: 64 },
      (_, i) => [i, 255 - i, i * 2] as [number, number, number],
    );
    for (const face of CUBE_FACES) {
      assert.deepEqual(
        Array.from(paintCubeFace(withFootprint, face, colors, [0, 400]).pixels),
        Array.from(paintCubeFace(plain, face, colors, [0, 400]).pixels),
        `${face} differs once the footprint is used`,
      );
    }
  });

  it("paints values through the ramp and leaves NaN cells transparent", () => {
    const cube = positionCube(2, 1, 1);
    cube.values[1] = Number.NaN;
    const colors: Array<[number, number, number]> = [
      [0, 0, 0],
      [255, 255, 255],
    ];
    const face = paintCubeFace(cube, "top", colors, [0, 1]);
    assert.deepEqual(Array.from(face.pixels.slice(0, 4)), [0, 0, 0, 255]);
    // Fill and non-finite cells must drop out of the face rather than painting
    // as the ramp's low end, which is a real reflectance.
    assert.deepEqual(Array.from(face.pixels.slice(4, 8)), [0, 0, 0, 0]);
  });

  it("paints a flat cube as the ramp's low end rather than dropping it", () => {
    const cube = positionCube(2, 1, 1);
    cube.values.fill(5);
    const face = paintCubeFace(cube, "top", [[10, 20, 30]], [5, 5]);
    // A zero-width range has no gradient; dividing by it would give NaN and
    // leave every face invisible.
    assert.deepEqual(Array.from(face.pixels.slice(0, 4)), [10, 20, 30, 255]);
  });

  it("fills every texel of every face", () => {
    const cube = positionCube();
    for (const face of CUBE_FACES) {
      const { width, height } = cubeFaceSize(cube, face);
      const painted = paintCubeFace(cube, face, [[1, 2, 3]], [0, 400]);
      assert.equal(painted.pixels.length, width * height * 4);
      for (let i = 3; i < painted.pixels.length; i += 4) {
        assert.equal(painted.pixels[i], 255, `${face} texel ${(i - 3) / 4} was not painted`);
      }
    }
  });
});

describe("recomposeCubeRgb", () => {
  /** A cube built through the reader, so it carries a recorded read window. */
  async function builtCube(readWindow?: {
    row: number;
    column: number;
    rows: number;
    columns: number;
  }) {
    return readNetcdfCube({
      readBand: (index) => Promise.resolve(grid([index, index + 1, index + 2, index + 3], 2, 2)),
      variable: "reflectance",
      axis: { name: "bands", size: 10 },
      maxBands: 2,
      rgbBands: [0, 1, 2],
      ...(readWindow ? { readWindow } : {}),
    });
  }

  const window = { row: 4, column: 6, rows: 2, columns: 2, maxSize: 192 };

  it("reads only the three overlay planes, not the cube again", async () => {
    const cube = await builtCube(window);
    const read: number[] = [];
    const next = await recomposeCubeRgb(
      cube,
      (index) => {
        read.push(index);
        return Promise.resolve(grid([index, index, index, index], 2, 2));
      },
      [7, 8, 9],
    );
    // Three reads instead of the tens a rebuild costs: this is what makes the
    // band pickers live controls rather than settings behind another read.
    assert.deepEqual(read, [7, 8, 9]);
    assert.deepEqual(next.rgbBands, [7, 8, 9]);
    // Same cube underneath, so nothing about the faces has to be repainted from
    // new values.
    assert.equal(next.values, cube.values);
    assert.equal(next.nz, cube.nz);
  });

  it("re-reads through the cube's own window, so the planes line up", async () => {
    const cube = await builtCube(window);
    const windows: unknown[] = [];
    await recomposeCubeRgb(
      cube,
      (_index, passed) => {
        windows.push(passed);
        return Promise.resolve(grid([1, 2, 3, 4], 2, 2));
      },
      [1, 2, 3],
    );
    // Deriving a window afresh from the map would land on different cells
    // whenever the view had moved since the cube was built.
    assert.deepEqual(windows, [window, window, window]);
  });

  it("hands back a new object, so the view repaints", async () => {
    const cube = await builtCube(window);
    const next = await recomposeCubeRgb(
      cube,
      () => Promise.resolve(grid([1, 2, 3, 4], 2, 2)),
      [1, 2, 3],
    );
    // The texture effect keys on `cube.rgb`; mutating in place would leave the
    // overlay showing the old bands.
    assert.notEqual(next, cube);
    assert.notEqual(next.rgb, cube.rgb);
  });

  it("refuses a cube that never recorded its window", async () => {
    const cube = await builtCube();
    await assert.rejects(
      recomposeCubeRgb(cube, () => Promise.resolve(grid([1], 1, 1)), [1, 2, 3]),
      (error: unknown) => {
        // Carries a code, so the window can show it in the user's language;
        // this module has no `t()` of its own to do that with.
        assert.ok(error instanceof CubeError);
        assert.equal(error.code, "noReadWindow");
        return true;
      },
    );
  });

  it("stops when the read is aborted", async () => {
    const cube = await builtCube(window);
    const controller = new AbortController();
    await assert.rejects(
      recomposeCubeRgb(
        cube,
        () => {
          controller.abort();
          return Promise.resolve(grid([1, 2, 3, 4], 2, 2));
        },
        [1, 2, 3],
        controller.signal,
      ),
      /cancelled/,
    );
  });

  it("refuses planes that do not match the cube's shape", async () => {
    const cube = await builtCube(window);
    await assert.rejects(
      recomposeCubeRgb(cube, () => Promise.resolve(grid([1, 2], 2, 1)), [1, 2, 3]),
      /do not share the cube's shape/,
    );
  });
});
