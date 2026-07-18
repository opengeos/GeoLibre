import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildDates, nasaTileUrl } from "../packages/plugins/src/plugins/maplibre-clouds";

/** The number of scrub frames the plugin exposes (mirrors HISTORY_DAYS). */
const HISTORY_DAYS = 10;

/** `YYYY-MM-DD` for `daysAgo` complete UTC days back, computed independently. */
function utcDaysAgo(daysAgo: number): string {
  const now = new Date();
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - daysAgo));
  return d.toISOString().slice(0, 10);
}

describe("buildDates", () => {
  it("returns HISTORY_DAYS complete UTC days, oldest first", () => {
    const dates = buildDates();
    assert.equal(dates.length, HISTORY_DAYS);
    for (const date of dates) assert.match(date, /^\d{4}-\d{2}-\d{2}$/);
  });

  it("ends on the previous full UTC day (never today) and starts HISTORY_DAYS back", () => {
    const dates = buildDates();
    // The current UTC day is skipped — its mosaic is still being imaged.
    assert.equal(dates.at(-1), utcDaysAgo(1));
    assert.equal(dates[0], utcDaysAgo(HISTORY_DAYS));
    assert.ok(!dates.includes(utcDaysAgo(0)), "today's date must be excluded");
  });

  it("is strictly increasing with no gaps (consecutive UTC days)", () => {
    const dates = buildDates();
    for (let i = 1; i < dates.length; i += 1) {
      const prev = Date.parse(`${dates[i - 1]}T00:00:00Z`);
      const curr = Date.parse(`${dates[i]}T00:00:00Z`);
      assert.equal(curr - prev, 86_400_000, `gap between ${dates[i - 1]} and ${dates[i]}`);
    }
  });
});

describe("nasaTileUrl", () => {
  it("substitutes the date and keeps GIBS's {z}/{y}/{x} axis order", () => {
    const url = nasaTileUrl("2026-07-08");
    assert.ok(url.includes("/default/2026-07-08/"), "date is substituted into the path");
    assert.ok(url.endsWith("/{z}/{y}/{x}.jpg"), "y precedes x for GIBS WMTS");
    assert.ok(!url.includes("%DATE%"), "placeholder is fully replaced");
  });
});
