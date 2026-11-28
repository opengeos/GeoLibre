import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  comparePinFor,
  compareFeatureProperties,
  wantsHoverTooltip,
  type ComparePin,
} from "../packages/core/src/compare";
import type { LayerPopupConfig } from "../packages/core/src/types";

const pinned = { lot: "12", use: "Residential", assessed: 250000, acres: 0.5, zone: "R-1" };

describe("compareFeatureProperties", () => {
  it("lists the fields that differ, with signed differences for numbers", () => {
    const hovered = { lot: "13", use: "Residential", assessed: 292000, acres: 0.2, zone: "R-1" };
    const result = compareFeatureProperties(hovered, pinned, { locale: "en-US" });
    assert.deepEqual(
      result.rows.map((row) => [row.field, row.text, row.pinnedText, row.delta]),
      [
        ["lot", "13", "12", undefined],
        ["assessed", "292000", "250000", "+42,000"],
        ["acres", "0.2", "0.5", "−0.3"],
      ],
    );
    assert.equal(result.sameCount, 2);
    assert.equal(result.moreCount, 0);
  });

  it("finds nothing to list for a feature the same in every field", () => {
    const result = compareFeatureProperties({ ...pinned }, pinned);
    assert.deepEqual(result.rows, []);
    assert.equal(result.sameCount, 5);
  });

  it("uses the popup's fields, labels and number format", () => {
    const popup: LayerPopupConfig = {
      fields: [
        {
          field: "assessed",
          label: "Assessed value",
          kind: "number",
          format: { thousands: true, prefix: "$" },
        },
        { field: "use", label: "Land use" },
      ],
    };
    const hovered = { ...pinned, assessed: 208000, use: "Commercial", lot: "99" };
    const result = compareFeatureProperties(hovered, pinned, { popup, locale: "en-US" });
    assert.deepEqual(
      result.rows.map((row) => [row.label, row.text, row.delta]),
      [
        ["Assessed value", "$208,000", "−$42,000"],
        ["Land use", "Commercial", undefined],
      ],
    );
    // "lot" differs but is not one of the popup's fields.
    assert.equal(result.sameCount, 0);
  });

  it("never compares a field the author hid", () => {
    const result = compareFeatureProperties(
      { ...pinned, owner: "B" },
      { ...pinned, owner: "A" },
      {
        fieldVisibility: { owner: "hidden" },
      },
    );
    assert.deepEqual(result.rows, []);
  });

  it("compares numeric-looking text and identifier columns as text", () => {
    const result = compareFeatureProperties(
      { parcel: "00124", OBJECTID: 7 },
      { parcel: "00123", OBJECTID: 2 },
      { locale: "en-US" },
    );
    assert.deepEqual(
      result.rows.map((row) => [row.field, row.delta]),
      [
        ["parcel", undefined],
        ["OBJECTID", undefined],
      ],
    );
  });

  it("treats a numeric string as a number in a field formatted as one", () => {
    const popup: LayerPopupConfig = { fields: [{ field: "area", kind: "number" }] };
    const result = compareFeatureProperties({ area: "150" }, { area: "100" }, { popup });
    assert.equal(result.rows[0].delta, "+50");
  });

  it("shows a field only one of the two features has", () => {
    const result = compareFeatureProperties(
      { lot: "12", note: "corner" },
      { lot: "12", year: 1987 },
    );
    assert.deepEqual(
      result.rows.map((row) => [row.field, row.text, row.pinnedText, row.delta]),
      [
        ["note", "corner", "", undefined],
        ["year", "", "1987", undefined],
      ],
    );
  });

  it("drops the sign from a difference that rounds to zero", () => {
    const result = compareFeatureProperties(
      { ratio: 0.1 + 0.2 },
      { ratio: 0.3 },
      { locale: "en-US" },
    );
    assert.equal(result.rows[0].delta, "0");
  });

  it("keeps the sign where the locale's digits are not 0-9", () => {
    const locale = "ar-EG-u-nu-arab";
    const five = new Intl.NumberFormat(locale).format(5);
    assert.equal(
      compareFeatureProperties({ area: 15 }, { area: 10 }, { locale }).rows[0].delta,
      `+${five}`,
    );
    assert.equal(
      compareFeatureProperties({ area: 10 }, { area: 15 }, { locale }).rows[0].delta,
      `\u2212${five}`,
    );
  });

  it("compares a date stored as a number as dates, not as a count", () => {
    const popup: LayerPopupConfig = {
      fields: [{ field: "sold", kind: "date", format: { dateFormat: "iso" } }],
    };
    const result = compareFeatureProperties(
      { sold: 1704153600000 },
      { sold: 1704067200000 },
      { popup, locale: "en-US" },
    );
    assert.deepEqual(
      result.rows.map((row) => [row.text, row.pinnedText, row.delta]),
      [["2024-01-02T00:00:00.000Z", "2024-01-01T00:00:00.000Z", undefined]],
    );
  });

  it("skips image fields", () => {
    const image = "data:image/png;base64,iVBORw0KGgo=";
    const result = compareFeatureProperties({ photo: image }, { photo: `${image}AA` });
    assert.deepEqual(result.rows, []);
  });

  it("lists at most maxRows differences and counts the rest", () => {
    const a = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`f${i}`, i]));
    const b = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`f${i}`, i + 1]));
    const result = compareFeatureProperties(a, b, { maxRows: 8 });
    assert.equal(result.rows.length, 8);
    assert.equal(result.moreCount, 4);
  });
});

describe("wantsHoverTooltip", () => {
  const pin: ComparePin = { layerId: "parcels", featureId: "1", properties: {} };
  const plain = { id: "parcels", popup: undefined };
  const tipped = { id: "roads", popup: { hover: true } };

  it("follows the author's hover switch and the viewer's tooltip toggle", () => {
    assert.equal(wantsHoverTooltip(tipped, { hoverTooltipsEnabled: true, comparePin: null }), true);
    assert.equal(
      wantsHoverTooltip(tipped, { hoverTooltipsEnabled: false, comparePin: null }),
      false,
    );
    assert.equal(wantsHoverTooltip(plain, { hoverTooltipsEnabled: true, comparePin: null }), false);
  });

  it("turns on for the pinned feature's layer, even with tooltips off", () => {
    assert.equal(wantsHoverTooltip(plain, { hoverTooltipsEnabled: false, comparePin: pin }), true);
    assert.equal(
      wantsHoverTooltip(tipped, { hoverTooltipsEnabled: false, comparePin: pin }),
      false,
    );
  });

  it("gives the pin only to its own layer", () => {
    assert.equal(comparePinFor("parcels", { comparePin: pin }), pin);
    assert.equal(comparePinFor("roads", { comparePin: pin }), null);
  });
});
