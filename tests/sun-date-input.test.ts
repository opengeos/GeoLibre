import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  fromLocalDateTimeParts,
  isCompleteDateInput,
  localDateParts,
} from "../apps/geolibre-desktop/src/lib/sun-date-input";

describe("Sun panel date input helpers", () => {
  it("formats a local date and time for the native inputs", () => {
    const ms = new Date(2024, 11, 21, 9, 5).getTime();
    assert.deepEqual(localDateParts(ms), { date: "2024-12-21", time: "09:05" });
  });

  it("zero-pads years below 1000 so the date input accepts the value", () => {
    const d = new Date(2024, 11, 21, 12, 0);
    d.setFullYear(2);
    assert.equal(localDateParts(d.getTime()).date, "0002-12-21");
  });

  it("treats partial years typed digit by digit as incomplete", () => {
    for (const partial of ["0002-12-21", "0020-12-21", "0202-12-21", "", "2024-12"]) {
      assert.equal(isCompleteDateInput(partial), false, partial);
    }
    assert.equal(isCompleteDateInput("2024-12-21"), true);
    assert.equal(isCompleteDateInput("1000-01-01"), true);
  });

  it("parses complete local date and time parts", () => {
    assert.equal(
      fromLocalDateTimeParts("2024-12-21", "12:30"),
      new Date(2024, 11, 21, 12, 30).getTime(),
    );
    assert.equal(fromLocalDateTimeParts("", "12:30"), null);
  });
});
