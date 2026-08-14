import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveChartDomain } from "../apps/geolibre-desktop/src/lib/chart-domain";

describe("resolveChartDomain", () => {
  const auto = { min: null, max: null };

  it("follows the data when neither bound is pinned", () => {
    assert.deepEqual(resolveChartDomain([3, 1, 7], auto), { min: 1, max: 7 });
  });

  it("pads a flat series so the value sits mid-axis", () => {
    // Also guards the scale, which would divide by zero on a zero-height range.
    assert.deepEqual(resolveChartDomain([5, 5], auto), { min: 4, max: 6 });
  });

  it("replaces only the pinned end", () => {
    assert.deepEqual(resolveChartDomain([10, 40], { min: 0, max: null }), { min: 0, max: 40 });
    assert.deepEqual(resolveChartDomain([10, 40], { min: null, max: 100 }), { min: 10, max: 100 });
  });

  it("uses both bounds when both are pinned", () => {
    assert.deepEqual(resolveChartDomain([10, 40], { min: 0, max: 50 }), { min: 0, max: 50 });
  });

  it("reads a reversed pair as the range the user meant", () => {
    assert.deepEqual(resolveChartDomain([10, 40], { min: 50, max: 0 }), { min: 0, max: 50 });
  });

  it("keeps a lone pinned floor above the data as the floor", () => {
    // Swapping would make 60 the ceiling and 50 the floor, hiding every reading
    // behind a plausible-looking axis.
    assert.deepEqual(resolveChartDomain([0, 50], { min: 60, max: null }), { min: 59, max: 61 });
  });

  it("keeps a lone pinned ceiling below the data as the ceiling", () => {
    assert.deepEqual(resolveChartDomain([10, 50], { min: null, max: 5 }), { min: 4, max: 6 });
  });

  it("never returns an inverted or zero-height range", () => {
    const cases: { min: number | null; max: number | null }[] = [
      { min: null, max: null },
      { min: 5, max: 5 },
      { min: 60, max: null },
      { min: null, max: -10 },
      { min: 50, max: 0 },
    ];
    for (const domain of cases) {
      const { min, max } = resolveChartDomain([0, 20], domain);
      assert.ok(min < max, `expected min < max for ${JSON.stringify(domain)}`);
    }
  });
});
