import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  axisOptionLabel,
  bandLabel,
  defaultRgbBands,
  isTimeAxisName,
  pickBandAxis,
  wavelengthsInNanometres,
} from "../apps/geolibre-desktop/src/lib/netcdf-band-axis";
import type { LocalNetcdfAxis } from "../packages/plugins/src/plugins/local-netcdf";

/** An axis whose coordinates run evenly from `from` to `to`. */
function axis(
  name: string,
  size: number,
  from?: number,
  to?: number,
  units?: string,
): LocalNetcdfAxis {
  const base: LocalNetcdfAxis = { name, size };
  if (from === undefined || to === undefined) return base;
  return {
    ...base,
    values: Array.from({ length: size }, (_, i) => from + ((to - from) * i) / (size - 1)),
    ...(units ? { units } : {}),
  };
}

describe("wavelengthsInNanometres", () => {
  it("takes a nanometre axis as it stands", () => {
    assert.deepEqual(wavelengthsInNanometres(axis("bands", 3, 400, 600, "nm")), [400, 500, 600]);
  });

  it("converts a micrometre axis", () => {
    // Both spellings are common in CF files, and a 0.4-2.5 axis read as nm
    // would put every natural-colour band at index 0.
    assert.deepEqual(wavelengthsInNanometres(axis("bands", 2, 0.4, 2.5, "um")), [400, 2500]);
    assert.deepEqual(wavelengthsInNanometres(axis("bands", 2, 0.4, 2.5, "µm")), [400, 2500]);
  });

  it("refuses an axis with no wavelength units", () => {
    assert.equal(wavelengthsInNanometres(axis("time", 3, 0, 2, "days since 2020-01-01")), null);
    assert.equal(wavelengthsInNanometres(axis("bands", 3, 0, 2)), null);
    assert.equal(wavelengthsInNanometres(axis("bands", 3)), null);
  });
});

describe("defaultRgbBands", () => {
  it("picks the bands nearest natural colour on a wavelength axis", () => {
    // EMIT's own axis: 285 bands from 381 to 2493 nm.
    const bands = axis("bands", 285, 381, 2493, "nm");
    const [r, g, b] = defaultRgbBands(bands);
    const nm = (index: number) => bands.values?.[index] ?? 0;
    assert.ok(Math.abs(nm(r) - 640) < 12, `red at ${nm(r)} nm`);
    assert.ok(Math.abs(nm(g) - 550) < 12, `green at ${nm(g)} nm`);
    assert.ok(Math.abs(nm(b) - 470) < 12, `blue at ${nm(b)} nm`);
    // Red is the longest wavelength of the three, so on an ascending axis it
    // must also be the highest index; a swap here would invert every composite.
    assert.ok(r > g && g > b);
  });

  it("spreads evenly when the axis is not a wavelength", () => {
    // Guessing colours from, say, a pressure-level axis would be meaningless,
    // but three identical bands would render a grey image.
    assert.deepEqual(defaultRgbBands(axis("level", 9, 0, 8)), [0, 4, 8]);
  });
});

describe("pickBandAxis", () => {
  it("prefers a wavelength axis over any other candidate", () => {
    const axes = [axis("level", 5, 0, 4), axis("bands", 10, 400, 2500, "nm")];
    assert.equal(pickBandAxis(axes)?.name, "bands");
  });

  it("never picks a time axis", () => {
    // (time, lat, lon) is the commonest cube shape there is, and three dates as
    // red/green/blue is meaningless.
    assert.equal(pickBandAxis([axis("time", 12, 0, 11)]), null);
    assert.equal(pickBandAxis([axis("time", 12, 0, 11), axis("level", 4, 0, 3)])?.name, "level");
  });

  it("ignores an axis too short for three channels", () => {
    assert.equal(pickBandAxis([axis("pair", 2, 0, 1)]), null);
  });
});

describe("axis labelling", () => {
  it("puts the coordinate value first, then where it sits", () => {
    const bands = axis("bands", 3, 400, 600, "nm");
    assert.equal(axisOptionLabel(bands, 500.5, 1), "500.50 nm (bands 1)");
    assert.equal(axisOptionLabel(bands, 500, 1), "500 nm (bands 1)");
  });

  it("falls back to the bare index when the axis has no coordinates", () => {
    assert.equal(bandLabel(axis("bands", 3), 2), "bands 2");
  });
});

describe("isTimeAxisName", () => {
  it("recognises the usual spellings, whatever the case", () => {
    for (const name of ["time", "Time", "valid_time", "datetime", "t"]) {
      assert.ok(isTimeAxisName(name), name);
    }
    assert.equal(isTimeAxisName("bands"), false);
  });
});
