import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildNetcdfProfileCsv,
  netcdfAxisPositions,
  netcdfSeriesColor,
  NETCDF_SERIES_COLORS,
  niceTickValues,
} from "../apps/geolibre-desktop/src/lib/netcdf-profile-series";
import type { NetcdfProfileSample } from "../apps/geolibre-desktop/src/lib/netcdf-profile-store";

type ProfileAxis = { name: string; size: number; units?: string; values?: number[] };

type ChartedSample = NetcdfProfileSample & { profile: NonNullable<NetcdfProfileSample["profile"]> };

/**
 * Narrows a sample built with values to the shape the axis helper requires,
 * rather than casting the argument away with `as never` — which would let a
 * change to that helper's parameter type through unnoticed.
 */
function charted(sample: NetcdfProfileSample): ChartedSample {
  assert.ok(sample.profile);
  return sample as ChartedSample;
}

/** A sampled pixel, optionally with a profile attached. */
function sample(
  order: number,
  values?: Array<number | null>,
  axis?: ProfileAxis,
): NetcdfProfileSample {
  return {
    id: order,
    order,
    layerId: "a",
    variable: "reflectance",
    lng: 1.5,
    lat: -2.5,
    profile: values ? { axis: axis ?? { name: "bands", size: values.length }, values } : undefined,
  };
}

describe("netcdf profile series", () => {
  it("keys a sample's color off its number, not its position", () => {
    // A point must keep its color when an older one falls off the cap, so the
    // marker on the map and the line in the chart never disagree.
    assert.equal(netcdfSeriesColor({ order: 1 }), NETCDF_SERIES_COLORS[0]);
    assert.equal(netcdfSeriesColor({ order: 3 }), NETCDF_SERIES_COLORS[2]);
    assert.equal(
      netcdfSeriesColor({ order: NETCDF_SERIES_COLORS.length + 1 }),
      NETCDF_SERIES_COLORS[0],
    );
  });

  it("plots against the axis' own coordinates when the file has them", () => {
    const withWavelengths = sample(1, [0.1, 0.2], {
      name: "wavelength",
      size: 2,
      units: "nm",
      values: [381.5, 388.4],
    });
    assert.deepEqual(netcdfAxisPositions(charted(withWavelengths)), [381.5, 388.4]);
  });

  it("falls back to the band index when the axis carries no coordinates", () => {
    assert.deepEqual(netcdfAxisPositions(charted(sample(1, [0.1, 0.2]))), [0, 1]);
  });

  it("labels an EMIT wavelength axis on round numbers", () => {
    // The real complaint: 381 / 1437 / 2493 told you nothing about where a
    // feature sat. Round multiples do.
    assert.deepEqual(
      niceTickValues(381.0, 2493.0, 8),
      [500, 750, 1000, 1250, 1500, 1750, 2000, 2250],
    );
  });

  it("keeps a band-index axis on whole numbers", () => {
    assert.deepEqual(niceTickValues(0, 23, 8), [0, 5, 10, 15, 20]);
  });

  it("does not drift on a fractional step", () => {
    // Repeated addition would surface as "0.6000000000000001" in a label.
    assert.deepEqual(niceTickValues(0, 1, 8), [0, 0.2, 0.4, 0.6, 0.8, 1]);
  });

  it("stays inside the domain, so no tick is drawn off the plot", () => {
    for (const [min, max] of [
      [381, 2493],
      [0, 23],
      [-0.5, 0.5],
      [1e-4, 5e-4],
    ]) {
      for (const tick of niceTickValues(min, max, 8)) {
        assert.ok(tick >= min && tick <= max, `${tick} outside ${min}..${max}`);
      }
    }
  });

  it("degenerates safely on a single-band or empty domain", () => {
    assert.deepEqual(niceTickValues(5, 5, 8), [5]);
    assert.deepEqual(niceTickValues(10, 1, 8), [10]);
    assert.deepEqual(niceTickValues(0, Number.NaN, 8), [0]);
  });

  it("writes one column per sampled pixel, with the axis first", () => {
    const csv = buildNetcdfProfileCsv([
      sample(1, [0.1, 0.2], { name: "wavelength", size: 2, units: "nm", values: [400, 410] }),
      sample(2, [0.3, 0.4], { name: "wavelength", size: 2, units: "nm", values: [400, 410] }),
    ]);
    assert.equal(
      csv,
      [
        // The lon/lat carries a comma, so the header cells are quoted.
        'wavelength (nm),"point 1 (1.50000, -2.50000)","point 2 (1.50000, -2.50000)"',
        "400,0.1,0.3",
        "410,0.2,0.4",
      ].join("\n"),
    );
  });

  it("leaves a fill reading empty so it reads as a gap", () => {
    const csv = buildNetcdfProfileCsv([sample(1, [0.1, null, 0.3])]);
    assert.deepEqual(csv?.split("\n").slice(1), ["0,0.1", "1,", "2,0.3"]);
  });

  it("pads a shorter profile rather than shifting the rows out of line", () => {
    const csv = buildNetcdfProfileCsv([sample(1, [0.1, 0.2, 0.3]), sample(2, [0.4])]);
    assert.deepEqual(csv?.split("\n").slice(1), ["0,0.1,0.4", "1,0.2,", "2,0.3,"]);
  });

  it("drops noise units from the header, as the chart's axis label does", () => {
    const csv = buildNetcdfProfileCsv([
      sample(1, [0.5], { name: "bands", size: 1, units: "unitless" }),
    ]);
    assert.equal(csv?.split("\n")[0].split(",")[0], "bands");
  });

  it("neutralizes a formula in an axis name out of the file's metadata", () => {
    // A dimension name is untrusted file content; a leading `=` would execute
    // when the export is opened in a spreadsheet.
    const csv = buildNetcdfProfileCsv([sample(1, [0.5], { name: "=cmd|'/c calc'!A0", size: 1 })]);
    // The leading apostrophe is what stops the spreadsheet evaluating it; the
    // cell needs no quoting, since it carries no comma, quote, or newline.
    assert.equal(csv?.split("\n")[0].split(",")[0], "'=cmd|'/c calc'!A0");
  });

  it("skips samples with no profile, and returns null when none has one", () => {
    assert.equal(buildNetcdfProfileCsv([sample(1), sample(2)]), null);
    const csv = buildNetcdfProfileCsv([sample(1), sample(2, [0.5])]);
    assert.deepEqual(csv?.split("\n"), ['bands,"point 2 (1.50000, -2.50000)"', "0,0.5"]);
  });
});
