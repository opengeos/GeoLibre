import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  type DdmAxis,
  type DmsAxis,
  decimalToDdmAxis,
  decimalToDmsAxis,
  ddmAxisToDecimal,
  dmsAxisToDecimal,
} from "../apps/geolibre-desktop/src/lib/dms";

describe("decimalToDmsAxis", () => {
  it("splits a positive longitude into D/M/S with the E hemisphere", () => {
    // 12.582° = 12° 34' 55.2"
    assert.deepEqual(decimalToDmsAxis(12.582, "lon"), {
      deg: "12",
      min: "34",
      sec: "55.2",
      dir: "E",
    });
  });

  it("uses the negative hemisphere and unsigned parts for a negative value", () => {
    const dms = decimalToDmsAxis(-98.468972, "lon");
    assert.equal(dms.dir, "W");
    assert.equal(dms.deg, "98");
    // Parts are the magnitude, never negative.
    assert.ok(Number(dms.min) >= 0 && Number(dms.sec) >= 0);
  });

  it("picks N/S for the latitude axis", () => {
    assert.equal(decimalToDmsAxis(42.1, "lat").dir, "N");
    assert.equal(decimalToDmsAxis(-42.1, "lat").dir, "S");
  });

  it("carries rounded seconds into minutes and degrees", () => {
    // 12.9999999° computes to 12° 59' 59.99964", whose seconds round to 60.00
    // and must carry all the way up to 13° 0' 0", not render as 12° 59' 60".
    const dms = decimalToDmsAxis(12.9999999, "lat");
    assert.equal(dms.deg, "13");
    assert.equal(dms.min, "0");
    assert.equal(dms.sec, "0");
  });

  it("returns blank parts for a non-finite value", () => {
    assert.deepEqual(decimalToDmsAxis(Number.NaN, "lon"), {
      deg: "",
      min: "",
      sec: "",
      dir: "E",
    });
  });
});

describe("dmsAxisToDecimal", () => {
  const parts = (over: Partial<DmsAxis>): DmsAxis => ({
    deg: "0",
    min: "",
    sec: "",
    dir: "E",
    ...over,
  });

  it("recombines D/M/S into a decimal degree", () => {
    const decimal = dmsAxisToDecimal({ deg: "12", min: "34", sec: "55.2", dir: "E" }, "lon");
    assert.ok(Math.abs(decimal - 12.582) < 1e-9);
  });

  it("applies a negative sign for the negative hemisphere", () => {
    const decimal = dmsAxisToDecimal({ deg: "98", min: "28", sec: "8.3", dir: "W" }, "lon");
    assert.ok(decimal < 0);
  });

  it("round-trips with decimalToDmsAxis", () => {
    const original = 42.145937;
    const back = dmsAxisToDecimal(decimalToDmsAxis(original, "lat"), "lat");
    // Two-decimal seconds limit precision to roughly 0.01" ~= 3e-6 degrees.
    assert.ok(Math.abs(back - original) < 1e-4);
  });

  it("defaults blank minutes and seconds to zero", () => {
    assert.equal(dmsAxisToDecimal(parts({ deg: "45" }), "lat"), 45);
  });

  it("returns NaN when degrees are blank", () => {
    assert.ok(Number.isNaN(dmsAxisToDecimal(parts({ deg: "" }), "lon")));
  });

  it("rejects out-of-range minutes and seconds", () => {
    assert.ok(Number.isNaN(dmsAxisToDecimal(parts({ deg: "1", min: "60" }), "lat")));
    assert.ok(Number.isNaN(dmsAxisToDecimal(parts({ deg: "1", sec: "75" }), "lat")));
  });

  it("rejects negative degrees (the sign belongs to the hemisphere)", () => {
    assert.ok(Number.isNaN(dmsAxisToDecimal(parts({ deg: "-5" }), "lon")));
  });

  it("rejects non-numeric parts", () => {
    assert.ok(Number.isNaN(dmsAxisToDecimal(parts({ deg: "abc" }), "lon")));
  });
});

describe("decimalToDdmAxis", () => {
  it("splits a positive longitude into degrees and decimal minutes (E)", () => {
    // 12.582° = 12° 34.92'
    assert.deepEqual(decimalToDdmAxis(12.582, "lon"), {
      deg: "12",
      min: "34.92",
      dir: "E",
    });
  });

  it("uses the negative hemisphere and unsigned parts for a negative value", () => {
    const ddm = decimalToDdmAxis(-98.468972, "lon");
    assert.equal(ddm.dir, "W");
    assert.equal(ddm.deg, "98");
    assert.ok(Number(ddm.min) >= 0);
  });

  it("picks N/S for the latitude axis", () => {
    assert.equal(decimalToDdmAxis(42.1, "lat").dir, "N");
    assert.equal(decimalToDdmAxis(-42.1, "lat").dir, "S");
  });

  it("carries rounded minutes into degrees", () => {
    // 12.99999999° computes to 12° 59.9999994', whose minutes round to 60.0000
    // and must carry up to 13° 0', not render as 12° 60'.
    const ddm = decimalToDdmAxis(12.99999999, "lat");
    assert.equal(ddm.deg, "13");
    assert.equal(ddm.min, "0");
  });

  it("returns blank parts for a non-finite value", () => {
    assert.deepEqual(decimalToDdmAxis(Number.NaN, "lon"), {
      deg: "",
      min: "",
      dir: "E",
    });
  });
});

describe("ddmAxisToDecimal", () => {
  const parts = (over: Partial<DdmAxis>): DdmAxis => ({
    deg: "0",
    min: "",
    dir: "E",
    ...over,
  });

  it("recombines degrees and decimal minutes into a decimal degree", () => {
    const decimal = ddmAxisToDecimal({ deg: "12", min: "34.92", dir: "E" }, "lon");
    assert.ok(Math.abs(decimal - 12.582) < 1e-9);
  });

  it("applies a negative sign for the negative hemisphere", () => {
    const decimal = ddmAxisToDecimal({ deg: "98", min: "28.14", dir: "W" }, "lon");
    assert.ok(decimal < 0);
  });

  it("round-trips with decimalToDdmAxis", () => {
    const original = 42.145937;
    const back = ddmAxisToDecimal(decimalToDdmAxis(original, "lat"), "lat");
    // Four-decimal minutes limit precision to ~0.0001'/60 ≈ 1.7e-6 degrees; the
    // bound sits a few times above that so it guards regressions without flaking.
    assert.ok(Math.abs(back - original) < 5e-6);
  });

  it("defaults blank minutes to zero", () => {
    assert.equal(ddmAxisToDecimal(parts({ deg: "45" }), "lat"), 45);
  });

  it("returns NaN when degrees are blank", () => {
    assert.ok(Number.isNaN(ddmAxisToDecimal(parts({ deg: "" }), "lon")));
  });

  it("rejects out-of-range minutes", () => {
    assert.ok(Number.isNaN(ddmAxisToDecimal(parts({ deg: "1", min: "60" }), "lat")));
  });

  it("rejects negative degrees (the sign belongs to the hemisphere)", () => {
    assert.ok(Number.isNaN(ddmAxisToDecimal(parts({ deg: "-5" }), "lon")));
  });

  it("rejects non-numeric parts", () => {
    assert.ok(Number.isNaN(ddmAxisToDecimal(parts({ deg: "abc" }), "lon")));
  });
});
