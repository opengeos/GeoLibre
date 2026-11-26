/**
 * Building shadows, sun hours and insolation (issue #3530).
 *
 * The sun positions are checked against NREL SPA values computed with pvlib
 * 0.13 (`get_solarposition(..., method="nrel_numpy")`, apparent elevation).
 * The shadows are checked against plain trigonometry: a wall of height `h`
 * under a sun at elevation `e` casts a shadow `h / tan(e)` long, straight away
 * from the sun.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Feature } from "geojson";
import {
  buildHeightGrid,
  buildingHeight,
  buildingShadows,
  castShadows,
  fillPolygon,
} from "../packages/processing/src/raster-shadow";
import {
  clearSkyDni,
  localTimeToUtc,
  sunPosition,
} from "../packages/processing/src/solar-position";
import { runRasterToolClientAsync } from "@geolibre/processing";

const near = (actual: number, expected: number, tolerance: number, label = "value") =>
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${label}: expected ${expected} +/- ${tolerance}, got ${actual}`,
  );

const M = 1 / 111_320; // degrees of latitude (and of longitude at the equator) per metre

/** A rectangular footprint at the equator, in metres east/north of (0, 0). */
function box(x0: number, y0: number, x1: number, y1: number, height: number): Feature {
  return {
    type: "Feature",
    properties: { height },
    geometry: {
      type: "Polygon",
      coordinates: [
        [
          [x0 * M, y0 * M],
          [x1 * M, y0 * M],
          [x1 * M, y1 * M],
          [x0 * M, y1 * M],
          [x0 * M, y0 * M],
        ],
      ],
    },
  };
}

describe("sunPosition", () => {
  // [UTC instant, lat, lon, azimuth, apparent elevation] from pvlib NREL SPA.
  const cases: [string, number, number, number, number][] = [
    ["2026-06-21T16:00:00Z", 35.96, -83.92, 114.015, 65.508],
    ["2026-12-21T17:00:00Z", 35.96, -83.92, 171.025, 30.093],
    ["2026-09-23T06:30:00Z", 51.5, -0.12, 97.341, 5.815],
    ["2026-01-15T23:45:00Z", -33.87, 151.21, 76.395, 56.638],
    ["2026-06-21T02:00:00Z", 64.84, -147.72, 254.608, 32.984],
  ];
  for (const [iso, lat, lon, azimuth, elevation] of cases) {
    it(`matches NREL SPA at ${iso} (${lat}, ${lon})`, () => {
      const sun = sunPosition(Date.parse(iso), lat, lon);
      near(sun.elevation, elevation, 0.05, "elevation");
      near(sun.azimuth, azimuth, 0.1, "azimuth");
    });
  }

  it("puts the equinox sun near the zenith at the equator at noon", () => {
    const sun = sunPosition(Date.parse("2026-03-20T12:00:00Z"), 0, 0);
    near(sun.elevation, 88.141, 0.05);
  });
});

describe("clearSkyDni", () => {
  it("gives the Meinel value overhead and nothing at night", () => {
    // Air mass ~1 overhead: 1353 * 0.7 = 947 W/m².
    near(clearSkyDni(90), 947.1, 0.5);
    assert.ok(clearSkyDni(10) < clearSkyDni(45));
    assert.equal(clearSkyDni(-1), 0);
  });
});

describe("localTimeToUtc", () => {
  it("applies the UTC offset", () => {
    assert.equal(localTimeToUtc("2026-06-21", "12:00", -4), Date.parse("2026-06-21T16:00:00Z"));
    assert.equal(localTimeToUtc("2026-06-21", "01:30", 2), Date.parse("2026-06-20T23:30:00Z"));
  });

  it("rejects malformed input", () => {
    assert.throws(() => localTimeToUtc("21/06/2026", "12:00", 0), /YYYY-MM-DD/);
    assert.throws(() => localTimeToUtc("2026-02-30", "12:00", 0), /calendar date/);
    assert.throws(() => localTimeToUtc("2026-06-21", "25:00", 0), /time of day/);
    assert.throws(() => localTimeToUtc("2026-06-21", "12:00", 20), /UTC offset/);
  });
});

describe("buildingHeight", () => {
  it("prefers the height, then storeys, then the default", () => {
    assert.equal(buildingHeight({ height: "21.5 m" }, {}), 21.5);
    assert.equal(buildingHeight({ "building:levels": 4 }, {}), 12);
    assert.equal(buildingHeight({ levels: 5 }, { levels_field: "levels", level_height: 4 }), 20);
    assert.equal(buildingHeight({}, { default_height: 7 }), 7);
  });
});

describe("fillPolygon", () => {
  it("covers cells by their centres", () => {
    const hits: number[] = [];
    fillPolygon(
      [
        [
          [1, 1],
          [3, 1],
          [3, 3],
          [1, 3],
          [1, 1],
        ],
      ],
      5,
      5,
      (i) => hits.push(i),
    );
    assert.deepEqual(
      hits.sort((a, b) => a - b),
      [6, 7, 11, 12],
    );
  });
});

describe("castShadows", () => {
  /** Shade at a point `metres` north (+) or south (-) of the box's centre line. */
  function shadeAlongNorth(features: Feature[], azimuth: number, elevation: number) {
    const grid = buildHeightGrid(features, { cell_size: 1, margin: 40 });
    const mask = new Uint8Array(grid.width * grid.height);
    castShadows(grid, azimuth, elevation, mask);
    // Cell column at x = 5 m (the box spans 0-10 m east).
    const [west, , , north] = grid.bbox;
    const col = Math.floor((5 * M - west) / M);
    return {
      grid,
      at: (metresNorth: number) => {
        const row = Math.floor((north - metresNorth * M) / M);
        return {
          shaded: mask[row * grid.width + col] === 1,
          roof: grid.heights[row * grid.width + col] > 0,
        };
      },
    };
  }

  it("throws a shadow h / tan(e) long, away from the sun", () => {
    // 10 m tall, sun due south at 45°: the shadow reaches 10 m north of the
    // north wall (y = 10 m), so to y = 20 m.
    const { at } = shadeAlongNorth([box(0, 0, 10, 10, 10)], 180, 45);
    assert.equal(at(10.5).shaded, true, "just north of the wall");
    assert.equal(at(19.5).shaded, true, "near the shadow tip");
    assert.equal(at(20.5).shaded, false, "past the tip");
    assert.equal(at(-0.5).shaded, false, "the sunny side");
  });

  it("lengthens the shadow as the sun drops", () => {
    // tan(26.565°) = 0.5, so 20 m of shadow beyond the wall: to y = 30 m.
    const { at } = shadeAlongNorth([box(0, 0, 10, 10, 10)], 180, 26.565);
    assert.equal(at(29.5).shaded, true);
    assert.equal(at(30.5).shaded, false);
  });

  it("shades a lower roof behind a taller neighbour", () => {
    // A 30 m tower on 0-10 m, a 10 m block on 10-40 m north of it. At 45° the
    // tower's shadow drops 1 m per metre: it is above the block's roof (10 m)
    // until 20 m beyond the tower, i.e. y = 30 m.
    const { at } = shadeAlongNorth([box(0, 0, 10, 10, 30), box(0, 10, 10, 40, 10)], 180, 45);
    assert.equal(at(15.5).roof, true);
    assert.equal(at(15.5).shaded, true, "roof close behind the tower");
    assert.equal(at(28.5).shaded, true, "roof just inside the reach");
    assert.equal(at(31.5).shaded, false, "roof beyond the reach");
    assert.equal(at(5.5).shaded, false, "the tower's own roof");
  });
});

describe("buildingShadows", () => {
  it("labels lit and shaded ground and roofs at a time", () => {
    const { raster, messages } = buildingShadows([box(0, 0, 10, 10, 10)], {
      mode: "shadow",
      date: "2026-03-20",
      time: "09:00",
      utc_offset: 0,
      cell_size: 1,
      margin: 30,
    });
    const values = new Set(raster.bands[0]);
    assert.ok(values.has(0) && values.has(1) && values.has(2), "lit ground, shade and a roof");
    assert.equal(raster.geoKeys.GeographicTypeGeoKey, 4326);
    assert.ok(messages.some((line) => line.startsWith("Sun at 2026-03-20T09:00:00Z")));
  });

  it("counts about 12 hours of sun on open equatorial ground at the equinox", () => {
    const { raster } = buildingShadows([box(0, 0, 10, 10, 10)], {
      mode: "sun-hours",
      date: "2026-03-20",
      utc_offset: 0,
      cell_size: 1,
      margin: 30,
      step_minutes: 15,
    });
    const band = raster.bands[0];
    // The north-west corner of the grid is 30 m from the building.
    near(band[0], 12, 0.5, "open ground");
    // Right next to the west wall the morning sun is blocked for hours.
    const minimum = Math.min(...Array.from(band).filter((_, i) => band[i] > 0));
    assert.ok(minimum < band[0] - 2, "ground beside the building loses hours");
  });

  it("integrates insolation consistently with a fine reference sum", () => {
    const { raster } = buildingShadows([box(0, 0, 10, 10, 10)], {
      mode: "insolation",
      date: "2026-06-21",
      utc_offset: 0,
      cell_size: 2,
      margin: 40,
      step_minutes: 10,
    });
    // Unobstructed: integrate DNI · sin(e) minute by minute.
    let reference = 0;
    const midnight = Date.parse("2026-06-21T00:00:00Z");
    for (let minute = 0.5; minute < 1440; minute += 1) {
      const sun = sunPosition(midnight + minute * 60_000, 0, 5 * M);
      if (sun.elevation < 0.5) continue;
      reference +=
        (clearSkyDni(sun.elevation) * Math.sin((sun.elevation * Math.PI) / 180)) / 60 / 1000;
    }
    near(raster.bands[0][0], reference, reference * 0.01, "kWh/m²");
  });

  it("refuses a grid beyond the cell budget", () => {
    assert.throws(
      () => buildingShadows([box(0, 0, 10_000, 10_000, 10)], { cell_size: 1, date: "2026-06-21" }),
      /larger cell size/,
    );
  });
});

describe("building-shadows through the browser dispatcher", () => {
  it("reprojects a UTM footprint layer and runs", async () => {
    // A 20 m square in UTM 17N near Knoxville, TN.
    const x0 = 236_000;
    const y0 = 3_984_000;
    const buildings = {
      type: "FeatureCollection",
      crs: { type: "name", properties: { name: "urn:ogc:def:crs:EPSG::32617" } },
      features: [
        {
          type: "Feature",
          properties: { height: 15 },
          geometry: {
            type: "Polygon",
            coordinates: [
              [
                [x0, y0],
                [x0 + 20, y0],
                [x0 + 20, y0 + 20],
                [x0, y0 + 20],
                [x0, y0],
              ],
            ],
          },
        },
      ],
    };
    const run = await runRasterToolClientAsync(
      "building-shadows",
      { vectors: { input: buildings } },
      {
        mode: "shadow",
        date: "2026-06-21",
        time: "17:00",
        utc_offset: -4,
        cell_size: 1,
        margin: 20,
      },
    );
    assert.equal(run.kind, "raster");
    if (run.kind !== "raster") return;
    const [west, , , north] = [run.raster.originX, 0, 0, run.raster.originY];
    assert.ok(west > -84.1 && west < -83.8, `lon ${west}`);
    assert.ok(north > 35.9 && north < 36.1, `lat ${north}`);
    assert.ok(run.raster.bands[0].includes(1), "some ground is shaded");
  });
});

describe("courtyards and multipolygons", () => {
  it("casts the inner wall's shadow into a courtyard", () => {
    // A 30 m square block, 10 m tall, with a 10 m courtyard in the middle
    // (10-20 m). Under a 45° south sun the courtyard's south wall (y = 10 m)
    // shades the whole 10 m deep courtyard.
    const ring = (a: number, b: number) => [
      [a * M, a * M],
      [b * M, a * M],
      [b * M, b * M],
      [a * M, b * M],
      [a * M, a * M],
    ];
    const courtyard: Feature = {
      type: "Feature",
      properties: { height: 10 },
      geometry: { type: "MultiPolygon", coordinates: [[ring(0, 30), ring(10, 20).reverse()]] },
    };
    const grid = buildHeightGrid([courtyard], { cell_size: 1, margin: 5 });
    const [west, , , north] = grid.bbox;
    const cell = (x: number, y: number) =>
      Math.floor((north - y * M) / M) * grid.width + Math.floor((x * M - west) / M);
    assert.equal(grid.heights[cell(15, 15)], 0, "the courtyard is open ground");
    const mask = new Uint8Array(grid.width * grid.height);
    castShadows(grid, 180, 45, mask);
    assert.equal(mask[cell(15, 10.5)], 1, "by the south wall");
    assert.equal(mask[cell(15, 19.5)], 1, "by the north wall, 9.5 m from the south wall");
    // A higher sun shortens the shadow to 10 / tan(70°) = 3.6 m.
    castShadows(grid, 180, 70, mask);
    assert.equal(mask[cell(15, 12.5)], 1, "inside the shorter shadow");
    assert.equal(mask[cell(15, 15)], 0, "past it");
  });

  it("refuses a day run beyond the work budget", () => {
    assert.throws(
      () =>
        buildingShadows([box(0, 0, 10, 10, 10)], {
          mode: "sun-hours",
          date: "2026-06-21",
          cell_size: 0.5,
          margin: 400,
          step_minutes: 1,
        }),
      /browser budget/,
    );
  });
});
