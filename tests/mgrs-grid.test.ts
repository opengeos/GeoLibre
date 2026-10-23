import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseLocationInput } from "../apps/geolibre-desktop/src/lib/grid-reference";
import {
  lngLatToUtm,
  normalizeGraticuleSettings,
} from "../packages/plugins/src/plugins/maplibre-graticule";
import {
  buildMgrsGrid,
  clipPolyline,
  gridZoneCells,
  type MgrsGridBounds,
  metersPerPixelAt,
  mgrsGridStep,
  principalDigits,
} from "../packages/plugins/src/plugins/mgrs-grid";
import {
  gridZoneLongitudeRange,
  lngLatToMgrs,
  mgrsSquareId,
  utmZoneNumber,
} from "../packages/plugins/src/plugins/mgrs-reference";

const MONUMENT: [number, number] = [-77.03653728231987, 38.889805116520165];
const BERGEN: [number, number] = [5.3221, 60.3913];
const LONGYEARBYEN: [number, number] = [15.6356, 78.2232];

/** A viewport of `widthPx` x `heightPx` around a centre at a zoom level. */
function viewAt(
  center: [number, number],
  zoom: number,
  widthPx = 1280,
  heightPx = 720,
): { bounds: MgrsGridBounds; zoom: number } {
  const metersPerPixel = metersPerPixelAt(zoom, center[1]);
  const halfLat = ((heightPx / 2) * metersPerPixel) / 111_320;
  const halfLon =
    ((widthPx / 2) * metersPerPixel) / (111_320 * Math.cos((center[1] * Math.PI) / 180));
  return {
    bounds: {
      west: center[0] - halfLon,
      east: center[0] + halfLon,
      south: center[1] - halfLat,
      north: center[1] + halfLat,
    },
    zoom,
  };
}

function labelsOf(geometry: ReturnType<typeof buildMgrsGrid>, kind: string) {
  return geometry.labels.features.filter((f) => f.properties?.kind === kind);
}

describe("utmZoneNumber", () => {
  it("uses the regular 6-degree zones away from the exceptions", () => {
    assert.equal(utmZoneNumber(...MONUMENT), 18);
    assert.equal(utmZoneNumber(-180, 0), 1);
    assert.equal(utmZoneNumber(179.9, 0), 60);
    assert.equal(utmZoneNumber(190, 0), utmZoneNumber(-170, 0));
    // Just outside the Norway rectangle the regular zone applies.
    assert.equal(utmZoneNumber(5, 55.9), 31);
    assert.equal(utmZoneNumber(5, 64), 31);
  });

  it("widens zone 32 over southern Norway (band V)", () => {
    assert.equal(utmZoneNumber(...BERGEN), 32);
    assert.equal(utmZoneNumber(3, 60), 32);
    assert.equal(utmZoneNumber(2.99, 60), 31);
  });

  it("uses the four widened Svalbard zones in band X", () => {
    assert.equal(utmZoneNumber(...LONGYEARBYEN), 33);
    assert.equal(utmZoneNumber(8.9, 78), 31);
    assert.equal(utmZoneNumber(9, 78), 33);
    assert.equal(utmZoneNumber(25, 78), 35);
    assert.equal(utmZoneNumber(40, 78), 37);
    assert.equal(utmZoneNumber(42, 78), 38);
  });

  it("agrees with the mgrs package's zone everywhere it is sampled", () => {
    for (let lat = -79.5; lat < 84; lat += 1.5) {
      for (let lng = -179.5; lng < 180; lng += 1.25) {
        const reference = lngLatToMgrs(lng, lat, 0);
        assert.ok(reference);
        const zone = Number(/^\d+/.exec(reference)?.[0]);
        assert.equal(utmZoneNumber(lng, lat), zone, `${lng},${lat} -> ${reference}`);
      }
    }
  });
});

describe("UTM readout zone (lngLatToUtm)", () => {
  it("applies the Norway exception at Bergen (32V)", () => {
    const utm = lngLatToUtm(...BERGEN);
    assert.ok(utm);
    assert.equal(`${utm.zone}${utm.band}`, "32V");
    // Bergen is west of zone 32's 9°E meridian, so its easting is under 500 km.
    assert.ok(utm.easting > 280_000 && utm.easting < 320_000, String(utm.easting));
  });

  it("applies the Svalbard exception at Longyearbyen (33X)", () => {
    const utm = lngLatToUtm(...LONGYEARBYEN);
    assert.ok(utm);
    assert.equal(`${utm.zone}${utm.band}`, "33X");
  });

  it("matches the MGRS readout's zone and digits inside the exceptions", () => {
    for (const point of [BERGEN, LONGYEARBYEN, [8.5, 78.2] as [number, number]]) {
      const utm = lngLatToUtm(...point);
      const reference = lngLatToMgrs(...point, 5);
      assert.ok(utm && reference);
      assert.ok(reference.startsWith(`${utm.zone}${utm.band}`), `${reference} vs ${utm.zone}`);
      const easting = String(Math.floor(utm.easting) % 100_000).padStart(5, "0");
      const northing = String(Math.floor(utm.northing) % 100_000).padStart(5, "0");
      assert.ok(reference.endsWith(`${easting}${northing}`), reference);
    }
  });
});

describe("gridZoneLongitudeRange", () => {
  it("returns regular 6-degree zones", () => {
    assert.deepEqual(gridZoneLongitudeRange(18, "S"), [-78, -72]);
    assert.deepEqual(gridZoneLongitudeRange(1, "C"), [-180, -174]);
    assert.deepEqual(gridZoneLongitudeRange(60, "X"), [174, 180]);
  });

  it("widens 32V to 9 degrees and narrows 31V", () => {
    assert.deepEqual(gridZoneLongitudeRange(32, "V"), [3, 12]);
    assert.deepEqual(gridZoneLongitudeRange(31, "V"), [0, 3]);
    // Zone 32 is regular in the neighbouring bands.
    assert.deepEqual(gridZoneLongitudeRange(32, "W"), [6, 12]);
  });

  it("uses the Svalbard zones in band X and drops 32X/34X/36X", () => {
    assert.deepEqual(gridZoneLongitudeRange(31, "X"), [0, 9]);
    assert.deepEqual(gridZoneLongitudeRange(33, "X"), [9, 21]);
    assert.deepEqual(gridZoneLongitudeRange(35, "X"), [21, 33]);
    assert.deepEqual(gridZoneLongitudeRange(37, "X"), [33, 42]);
    for (const zone of [32, 34, 36]) assert.equal(gridZoneLongitudeRange(zone, "X"), null);
  });

  it("rejects invalid zones and bands", () => {
    assert.equal(gridZoneLongitudeRange(0, "S"), null);
    assert.equal(gridZoneLongitudeRange(61, "S"), null);
    assert.equal(gridZoneLongitudeRange(18, "I"), null);
    assert.equal(gridZoneLongitudeRange(18, "Y"), null);
  });
});

describe("mgrsSquareId", () => {
  it("names the square containing the Washington Monument 18S UJ", () => {
    const utm = lngLatToUtm(...MONUMENT);
    assert.ok(utm);
    assert.equal(mgrsSquareId(utm.zone, utm.easting, utm.northing), "UJ");
  });

  it("matches the mgrs package for points across the globe", () => {
    for (let lat = -79.5; lat < 84; lat += 3.7) {
      for (let lng = -179.5; lng < 180; lng += 4.3) {
        const utm = lngLatToUtm(lng, lat);
        const reference = lngLatToMgrs(lng, lat, 0);
        assert.ok(utm && reference);
        assert.equal(
          mgrsSquareId(utm.zone, utm.easting, utm.northing),
          reference.slice(-2),
          `${lng},${lat}`,
        );
      }
    }
  });

  it("returns null outside a zone's eight columns", () => {
    assert.equal(mgrsSquareId(18, 50_000, 4_300_000), null);
    assert.equal(mgrsSquareId(18, 950_000, 4_300_000), null);
    assert.equal(mgrsSquareId(0, 500_000, 0), null);
  });
});

describe("gridZoneCells", () => {
  it("lists the widened Norway zone over Bergen", () => {
    const cells = gridZoneCells({ west: 0, east: 14, south: 57, north: 63 });
    const names = cells.map((c) => `${c.zone}${c.band}`).sort();
    assert.deepEqual(names, ["31V", "32V", "33V"]);
    const z32 = cells.find((c) => c.zone === 32);
    assert.equal(z32 && z32.east - z32.west, 9);
  });

  it("lists only the four Svalbard zones over band X", () => {
    const cells = gridZoneCells({ west: 0, east: 42, south: 76, north: 80 });
    assert.deepEqual(cells.map((c) => `${c.zone}${c.band}`).sort(), ["31X", "33X", "35X", "37X"]);
  });

  it("finds zone 1 in the next world copy across the antimeridian", () => {
    const cells = gridZoneCells({ west: 178, east: 182, south: -18, north: -17 });
    const names = cells.map((c) => `${c.zone}${c.band}@${c.offset}`).sort();
    assert.deepEqual(names, ["1K@360", "60K@0"]);
  });

  it("clamps to the UTM latitude range", () => {
    assert.deepEqual(gridZoneCells({ west: 0, east: 5, south: 85, north: 89 }), []);
  });
});

describe("mgrsGridStep", () => {
  it("adds finer tiers as the map zooms in over Washington", () => {
    const step = (zoom: number) => mgrsGridStep(metersPerPixelAt(zoom, MONUMENT[1]));
    assert.equal(step(3), 0);
    assert.equal(step(5), 100_000);
    assert.equal(step(9), 10_000);
    assert.equal(step(13), 1_000);
  });

  it("returns 0 for a nonsense resolution", () => {
    assert.equal(mgrsGridStep(0), 0);
    assert.equal(mgrsGridStep(Number.NaN), 0);
  });
});

describe("buildMgrsGrid", () => {
  const options = { showLabels: true, labelEdges: "left-bottom" as const };

  it("labels the square under the Washington Monument UJ in zone 18S", () => {
    for (const zoom of [5, 9, 13]) {
      const { bounds } = viewAt(MONUMENT, zoom);
      const grid = buildMgrsGrid(bounds, { ...options, zoom });
      const zones = labelsOf(grid, "zone").map((f) => f.properties?.label);
      assert.ok(zones.includes("18S"), `zoom ${zoom}: ${zones.join(",")}`);
      const squares = labelsOf(grid, "square").map((f) => f.properties?.label);
      assert.ok(squares.includes("UJ"), `zoom ${zoom}: ${squares.join(",")}`);
    }
  });

  it("puts every square label inside the square it names", () => {
    const centers: [number, number][] = [MONUMENT, BERGEN, LONGYEARBYEN, [151.2, -33.9]];
    for (const center of centers) {
      for (const zoom of [5, 7]) {
        const { bounds } = viewAt(center, zoom);
        const grid = buildMgrsGrid(bounds, { ...options, zoom });
        const squares = labelsOf(grid, "square");
        assert.ok(squares.length > 0, `${center} z${zoom}`);
        for (const feature of squares) {
          const [lng, lat] = feature.geometry.coordinates;
          const reference = lngLatToMgrs(lng, lat, 0);
          assert.ok(
            reference?.endsWith(feature.properties?.label),
            `${reference} at ${lng},${lat}`,
          );
        }
      }
    }
  });

  it("draws zone boundaries at the Norway and Svalbard exceptions", () => {
    const norway = buildMgrsGrid(
      { west: -2, east: 16, south: 57, north: 63 },
      { ...options, zoom: 4 },
    );
    const meridians = norway.lines.features
      .filter((f) => f.properties?.level === "zone")
      .map((f) => f.geometry.coordinates)
      .filter((c) => c[0][0] === c[1][0])
      .map((c) => c[0][0])
      .sort((a, b) => a - b);
    // 0 (31V west), 3 (32V west), 12 (33V west); no regular 6°E boundary.
    assert.deepEqual(meridians, [0, 3, 12]);

    const svalbard = buildMgrsGrid(
      { west: -2, east: 44, south: 75, north: 81 },
      {
        ...options,
        zoom: 4,
      },
    );
    const xMeridians = svalbard.lines.features
      .filter((f) => f.properties?.level === "zone")
      .map((f) => f.geometry.coordinates)
      .filter((c) => c[0][0] === c[1][0])
      .map((c) => c[0][0])
      .sort((a, b) => a - b);
    assert.deepEqual(xMeridians, [0, 9, 21, 33, 42]);
    const zones = labelsOf(svalbard, "zone")
      .map((f) => f.properties?.label)
      .sort();
    // The 2°-wide slivers of 30X and 38X at the view edges are too narrow to
    // label; no 32X, 34X or 36X exists.
    assert.deepEqual(zones, ["31X", "33X", "35X", "37X"]);
  });

  it("clips 100 km lines to their zone so none crosses a zone boundary", () => {
    const { bounds, zoom } = viewAt([-72, 40], 5);
    const grid = buildMgrsGrid(bounds, { ...options, zoom });
    const squares = grid.lines.features.filter((f) => f.properties?.level === "square");
    assert.ok(squares.length > 10);
    for (const line of squares) {
      const lons = line.geometry.coordinates.map((c) => c[0]);
      const west = Math.min(...lons);
      const east = Math.max(...lons);
      // Zone edges at -78, -72, -66: a line may touch one but not straddle it.
      for (const edge of [-78, -72, -66]) {
        assert.ok(!(west < edge - 1e-6 && east > edge + 1e-6), `${west}..${east} crosses ${edge}`);
      }
      for (const [lng, lat] of line.geometry.coordinates) {
        assert.ok(lng >= bounds.west - 1e-9 && lng <= bounds.east + 1e-9);
        assert.ok(lat >= bounds.south - 1e-9 && lat <= bounds.north + 1e-9);
      }
    }
  });

  it("labels 1 km lines with their principal digits at zoom 13", () => {
    const { bounds, zoom } = viewAt(MONUMENT, 13);
    const grid = buildMgrsGrid(bounds, { ...options, zoom });
    assert.equal(grid.step, 1_000);
    const levels = new Set(grid.lines.features.map((f) => f.properties?.level));
    assert.ok(levels.has("1km") && levels.has("10km"));
    const edges = labelsOf(grid, "edge");
    const bottom = edges.filter((f) => f.properties?.anchor === "bottom");
    const left = edges.filter((f) => f.properties?.anchor === "left");
    // A ~9.5 x 5.3 km view: about nine eastings and five northings.
    assert.ok(bottom.length >= 8 && left.length >= 4, `${bottom.length} ${left.length}`);
    // The monument's easting 323371 lies between the 23 and 24 km lines.
    const labels = bottom.map((f) => f.properties?.label);
    assert.ok(labels.includes("23") && labels.includes("24"), labels.join(","));
    // The 10 km line inside the view is labelled alongside the 1 km lines.
    assert.ok(labels.includes("20"), labels.join(","));
    // Edge labels sit on the viewport's bottom edge.
    for (const f of bottom) assert.ok(Math.abs(f.geometry.coordinates[1] - bounds.south) < 1e-7);
  });

  it("labels all four edges when asked", () => {
    const { bounds, zoom } = viewAt(MONUMENT, 13);
    const grid = buildMgrsGrid(bounds, { ...options, labelEdges: "all", zoom });
    const anchors = new Set(labelsOf(grid, "edge").map((f) => f.properties?.anchor));
    assert.deepEqual([...anchors].sort(), ["bottom", "left", "right", "top"]);
  });

  it("omits labels when they are off", () => {
    const { bounds, zoom } = viewAt(MONUMENT, 9);
    const grid = buildMgrsGrid(bounds, { ...options, showLabels: false, zoom });
    assert.equal(grid.labels.features.length, 0);
    assert.ok(grid.lines.features.length > 0);
  });

  it("draws only zones, within the line cap, for a whole-world view", () => {
    const grid = buildMgrsGrid(
      { west: -180, east: 180, south: -85, north: 85 },
      { ...options, zoom: 1 },
    );
    assert.equal(grid.step, 0);
    assert.ok(grid.lines.features.every((f) => f.properties?.level === "zone"));
    assert.ok(grid.lines.features.length <= 3000);
  });

  it("labels high-latitude zones as well as the tropics on a world view", () => {
    // Web Mercator stretches the polar bands, so their zones are no smaller
    // on screen than equatorial ones and must not be dropped as too small.
    const grid = buildMgrsGrid(
      { west: -180, east: 180, south: -85, north: 85 },
      { ...options, zoom: 3 },
    );
    const zones = new Set(labelsOf(grid, "zone").map((f) => f.properties?.label));
    for (const name of ["1C", "18S", "32V", "33X", "60X"]) assert.ok(zones.has(name), name);
    assert.ok(!zones.has("32X"));
  });

  it("honours the line cap", () => {
    const { bounds, zoom } = viewAt(MONUMENT, 9);
    const grid = buildMgrsGrid(bounds, { ...options, zoom, maxLines: 20 });
    assert.ok(grid.lines.features.length <= 20);
  });

  it("keeps an antimeridian view continuous", () => {
    const { zoom } = viewAt([180, -17], 7);
    const grid = buildMgrsGrid(
      { west: 179, east: 181, south: -17.5, north: -16.5 },
      { ...options, zoom },
    );
    for (const line of grid.lines.features) {
      for (const [lng] of line.geometry.coordinates)
        assert.ok(lng >= 179 - 1e-9 && lng <= 181 + 1e-9);
    }
    const zones = labelsOf(grid, "zone")
      .map((f) => f.properties?.label)
      .sort();
    assert.deepEqual(zones, ["1K", "60K"]);
  });

  it("returns nothing for an empty or polar view", () => {
    const polar = buildMgrsGrid(
      { west: 0, east: 10, south: 85, north: 89 },
      {
        ...options,
        zoom: 10,
      },
    );
    assert.equal(polar.lines.features.length, 0);
  });
});

describe("clipPolyline", () => {
  const rect = { west: 0, east: 10, south: 0, north: 10 };

  it("clips a crossing line to the rectangle", () => {
    assert.deepEqual(
      clipPolyline(
        [
          [-5, 5],
          [5, 5],
          [15, 5],
        ],
        rect,
      ),
      [
        [
          [0, 5],
          [5, 5],
          [10, 5],
        ],
      ],
    );
  });

  it("splits a line that leaves and re-enters", () => {
    const pieces = clipPolyline(
      [
        [1, 1],
        [1, 20],
        [5, 20],
        [5, 1],
      ],
      rect,
    );
    assert.equal(pieces.length, 2);
  });

  it("drops a line entirely outside", () => {
    assert.deepEqual(
      clipPolyline(
        [
          [20, 20],
          [30, 30],
        ],
        rect,
      ),
      [],
    );
  });
});

describe("principalDigits", () => {
  it("prints the kilometres within the 100 km square", () => {
    assert.equal(principalDigits(323_000), "23");
    assert.equal(principalDigits(4_306_000), "06");
    assert.equal(principalDigits(320_000), "20");
    assert.equal(principalDigits(300_000), "00");
  });
});

describe("graticule MGRS setting", () => {
  it("round-trips the mgrs grid type and keeps old projects geographic", () => {
    assert.equal(normalizeGraticuleSettings({ gridType: "mgrs" }).gridType, "mgrs");
    assert.equal(normalizeGraticuleSettings({}).gridType, "geographic");
    assert.equal(normalizeGraticuleSettings({ gridType: "utm" }).gridType, "utm");
  });
});

describe("parseLocationInput (Set View paste box)", () => {
  it("reads an MGRS reference", () => {
    const match = parseLocationInput("18SUJ2337106519");
    assert.ok(match);
    assert.equal(match.kind, "mgrs");
    assert.ok(Math.abs(match.lon - MONUMENT[0]) < 1e-4);
    assert.ok(Math.abs(match.lat - MONUMENT[1]) < 1e-4);
  });

  it("reads USNG and UTM spellings of the same point", () => {
    const usng = parseLocationInput("18S UJ 23371 06519");
    assert.equal(usng?.kind, "mgrs");
    const utm = parseLocationInput("18S 323371 4306519");
    assert.equal(utm?.kind, "utm");
    assert.ok(utm && Math.abs(utm.lat - MONUMENT[1]) < 1e-4);
  });

  it("reads a Norway-exception reference in its widened zone", () => {
    const match = parseLocationInput(lngLatToMgrs(...BERGEN, 5) ?? "");
    assert.ok(match);
    assert.ok(Math.abs(match.lon - BERGEN[0]) < 1e-4 && Math.abs(match.lat - BERGEN[1]) < 1e-4);
  });

  it("still reads plain lat/lon", () => {
    assert.deepEqual(parseLocationInput("51.5074, -0.1278"), {
      kind: "latlon",
      lat: 51.5074,
      lon: -0.1278,
    });
    assert.equal(parseLocationInput("51°30'26\"N, 0°07'39\"W")?.kind, "latlon");
  });

  it("rejects text that is neither", () => {
    assert.equal(parseLocationInput("hello"), null);
    assert.equal(parseLocationInput("18SAA"), null);
    assert.equal(parseLocationInput(""), null);
  });
});
