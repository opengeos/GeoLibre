import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  type Affine,
  applyAffine,
  buildGcpTranslateArgs,
  cornersInRange,
  cornersToBounds,
  type GCP,
  gcpResidualsMeters,
  gcpsToCsv,
  haversineMeters,
  imageCornersToMap,
  minGcpsForTransform,
  parseGcpsCsv,
  solveAffine,
  warpArgsForTransform,
} from "../apps/geolibre-desktop/src/lib/georeference";

/** A known affine: lng = 0.001·px + 10, lat = -0.001·py + 50 (y flips). */
const KNOWN: Affine = { a: 0.001, b: 0, c: 10, d: 0, e: -0.001, f: 50 };

function gcpFrom(t: Affine, px: number, py: number): GCP {
  const [lng, lat] = applyAffine(t, px, py);
  return { px, py, lng, lat };
}

describe("solveAffine", () => {
  it("returns null with fewer than 3 GCPs", () => {
    assert.equal(solveAffine([]), null);
    assert.equal(solveAffine([gcpFrom(KNOWN, 0, 0), gcpFrom(KNOWN, 1, 1)]), null);
  });

  it("returns null for collinear GCPs", () => {
    const collinear = [gcpFrom(KNOWN, 0, 0), gcpFrom(KNOWN, 1, 0), gcpFrom(KNOWN, 2, 0)];
    assert.equal(solveAffine(collinear), null);
  });

  it("recovers a known transform exactly from 3 points", () => {
    const gcps = [gcpFrom(KNOWN, 0, 0), gcpFrom(KNOWN, 100, 0), gcpFrom(KNOWN, 0, 80)];
    const t = solveAffine(gcps);
    assert.ok(t);
    for (const k of ["a", "b", "c", "d", "e", "f"] as const) {
      assert.ok(Math.abs(t[k] - KNOWN[k]) < 1e-9, `${k}: ${t[k]} vs ${KNOWN[k]}`);
    }
  });

  it("least-squares fits an over-determined, slightly noisy set", () => {
    const gcps = [
      gcpFrom(KNOWN, 0, 0),
      gcpFrom(KNOWN, 100, 0),
      gcpFrom(KNOWN, 0, 80),
      gcpFrom(KNOWN, 100, 80),
      gcpFrom(KNOWN, 50, 40),
    ];
    // nudge one point's map coord slightly
    gcps[4].lng += 0.0001;
    const t = solveAffine(gcps);
    assert.ok(t);
    // The fit should stay close to the underlying transform.
    assert.ok(Math.abs(t.a - KNOWN.a) < 1e-4);
    assert.ok(Math.abs(t.c - KNOWN.c) < 1e-2);
  });
});

describe("imageCornersToMap", () => {
  it("projects corners in TL, TR, BR, BL order", () => {
    const c = imageCornersToMap(KNOWN, 100, 80);
    assert.deepEqual(c.tl, [10, 50]);
    assert.deepEqual(c.tr, [10.1, 50]);
    assert.deepEqual(c.br, [10.1, 49.92]);
    assert.deepEqual(c.bl, [10, 49.92]);
  });
});

describe("gcpResidualsMeters", () => {
  it("is ~zero for an exact fit", () => {
    const gcps = [gcpFrom(KNOWN, 0, 0), gcpFrom(KNOWN, 100, 0), gcpFrom(KNOWN, 0, 80)];
    const t = solveAffine(gcps)!;
    const { rms, perPoint } = gcpResidualsMeters(t, gcps);
    assert.equal(perPoint.length, 3);
    assert.ok(rms < 1e-3, `rms=${rms}`);
  });

  it("reports a non-zero residual for a misplaced point", () => {
    const t = KNOWN;
    const gcps = [{ px: 0, py: 0, lng: 10.001, lat: 50 }]; // ~71 m east of fit
    const { perPoint } = gcpResidualsMeters(t, gcps);
    assert.ok(perPoint[0] > 50 && perPoint[0] < 100, `${perPoint[0]} m`);
  });
});

describe("haversineMeters", () => {
  it("measures ~111 km per degree of latitude", () => {
    const d = haversineMeters([0, 0], [0, 1]);
    assert.ok(Math.abs(d - 111195) < 500, `${d} m`);
  });

  it("is zero for identical points", () => {
    assert.equal(haversineMeters([5, 5], [5, 5]), 0);
  });
});

describe("cornersToBounds", () => {
  it("returns [west, south, east, north]", () => {
    assert.deepEqual(
      cornersToBounds([
        [10, 50],
        [10.1, 50],
        [10.1, 49.92],
        [10, 49.92],
      ]),
      [10, 49.92, 10.1, 50],
    );
  });
});

describe("GDAL export args", () => {
  it("builds gdal_translate -gcp args (px py lng lat) with the SRS", () => {
    const args = buildGcpTranslateArgs([
      { px: 40, py: 30, lng: -124.5, lat: 48.5 },
      { px: 360, py: 30, lng: -67, lat: 47.2 },
    ]);
    assert.deepEqual(args, [
      "-of",
      "GTiff",
      "-a_srs",
      "EPSG:4326",
      "-gcp",
      "40",
      "30",
      "-124.5",
      "48.5",
      "-gcp",
      "360",
      "30",
      "-67",
      "47.2",
    ]);
  });

  it("maps the transform to the right gdalwarp method + COG output", () => {
    assert.deepEqual(warpArgsForTransform("affine"), [
      "-order",
      "1",
      "-t_srs",
      "EPSG:4326",
      "-r",
      "bilinear",
      "-of",
      "COG",
    ]);
    assert.equal(warpArgsForTransform("polynomial")[1], "2");
    assert.equal(warpArgsForTransform("tps")[0], "-tps");
  });

  it("minGcpsForTransform: 3 / 6 / 4", () => {
    assert.equal(minGcpsForTransform("affine"), 3);
    assert.equal(minGcpsForTransform("polynomial"), 6);
    assert.equal(minGcpsForTransform("tps"), 4);
  });
});

describe("cornersInRange", () => {
  it("accepts in-bounds corners", () => {
    assert.equal(
      cornersInRange([
        [10, 50],
        [-179, -89],
        [180, 90],
        [0, 0],
      ]),
      true,
    );
  });

  it("rejects out-of-range or non-finite corners", () => {
    assert.equal(cornersInRange([[200, 0]]), false);
    assert.equal(cornersInRange([[0, 95]]), false);
    assert.equal(cornersInRange([[Number.NaN, 0]]), false);
    assert.equal(cornersInRange([[0, Infinity]]), false);
  });
});

describe("GCP CSV round-trip", () => {
  const gcps: GCP[] = [
    { px: 93, py: 70, lng: -109.615, lat: 55.9797 },
    { px: 882, py: 68, lng: -85.8178, lat: 42.7052 },
  ];

  it("round-trips through CSV", () => {
    const csv = gcpsToCsv(gcps);
    assert.ok(csv.startsWith("pixelX,pixelY,lng,lat\n"));
    assert.deepEqual(parseGcpsCsv(csv), gcps);
  });

  it("skips the header, blanks, comments, and malformed rows", () => {
    const text = [
      "pixelX,pixelY,lng,lat",
      "",
      "# a comment",
      "93,70,-109.615,55.9797",
      "garbage,row,here,x",
      "1,2,999,0", // lng out of range
      "-50,-30,-1.5,2.5", // negative pixels
      "5,6", // too few columns
      "10,20,-1.5,2.5",
    ].join("\n");
    assert.deepEqual(parseGcpsCsv(text), [
      { px: 93, py: 70, lng: -109.615, lat: 55.9797 },
      { px: 10, py: 20, lng: -1.5, lat: 2.5 },
    ]);
  });

  it("tolerates whitespace and CRLF", () => {
    const text = "pixelX,pixelY,lng,lat\r\n 1 , 2 , 3 , 4 \r\n";
    assert.deepEqual(parseGcpsCsv(text), [{ px: 1, py: 2, lng: 3, lat: 4 }]);
  });
});
