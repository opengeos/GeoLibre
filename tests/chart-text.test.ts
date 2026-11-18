import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  approximateTextWidth,
  CHART_LABEL_FONT_SIZE,
  truncateToWidth,
} from "../apps/geolibre-desktop/src/components/panels/charts/chart-text";

/** One unit per code point: makes the expected cut points easy to read. */
const perChar = (text: string) => Array.from(text).length;

describe("approximateTextWidth", () => {
  it("scales with the font size and is zero for empty text", () => {
    assert.equal(approximateTextWidth(""), 0);
    assert.equal(approximateTextWidth("Park", 22), approximateTextWidth("Park", 11) * 2);
  });

  it("counts CJK as full-width and combining marks as zero-width", () => {
    // Two ideographs are two ems; four Latin letters are well under that.
    assert.equal(approximateTextWidth("公民", 10), 20);
    assert.ok(approximateTextWidth("abcd", 10) < 30);
    // "é" written as e + U+0301 measures the same as a bare "e".
    assert.equal(approximateTextWidth("é"), approximateTextWidth("e"));
  });

  it("estimates an 11px Latin label at roughly 6px per character", () => {
    const width = approximateTextWidth("Riverside Commons", CHART_LABEL_FONT_SIZE);
    assert.ok(width > 80 && width < 120, `width ${width}`);
  });
});

describe("truncateToWidth", () => {
  it("returns a label that fits unchanged", () => {
    assert.deepEqual(truncateToWidth("Park", 10, perChar), { text: "Park", truncated: false });
    assert.deepEqual(truncateToWidth("Park", 4, perChar), { text: "Park", truncated: false });
  });

  it("cuts a long label to the longest prefix that fits with an ellipsis", () => {
    const fitted = truncateToWidth("Riverside Commons", 8, perChar);
    assert.deepEqual(fitted, { text: "Riversi…", truncated: true });
    assert.ok(perChar(fitted.text) <= 8);
  });

  it("drops trailing whitespace before the ellipsis", () => {
    // "Fire " + "…" would fit, but the space is trimmed so the label reads cleanly.
    assert.equal(truncateToWidth("Fire station", 6, perChar).text, "Fire…");
  });

  it("returns the ellipsis alone when nothing else fits, still flagged", () => {
    assert.deepEqual(truncateToWidth("Library", 1, perChar), { text: "…", truncated: true });
    assert.deepEqual(truncateToWidth("Library", 0, perChar), { text: "…", truncated: true });
  });

  it("never splits a grapheme cluster (emoji, combining marks)", () => {
    const flag = "🇯🇵🇯🇵🇯🇵"; // three flags, six code points
    const fitted = truncateToWidth(flag, 5, perChar);
    assert.equal(fitted.text, "🇯🇵🇯🇵…");
    const accented = "éééé";
    assert.equal(truncateToWidth(accented, 5, perChar).text, "éé…");
  });

  it("truncates Arabic and Japanese labels by their measured width", () => {
    const arabic = truncateToWidth("مركز المجتمع الكبير", 40);
    assert.equal(arabic.truncated, true);
    assert.ok(arabic.text.endsWith("…"));
    assert.ok(approximateTextWidth(arabic.text) <= 40);
    assert.ok(arabic.text.startsWith("مركز"));

    const japanese = truncateToWidth("公民館と図書館", 50);
    assert.equal(japanese.truncated, true);
    // 11px per ideograph: three ideographs plus the ellipsis fit in 50px.
    assert.equal(japanese.text, "公民館…");
  });

  it("uses the default 11px estimate when no measurer is given", () => {
    const label = "Riverside Commons Recreational Facility and Annex";
    const fitted = truncateToWidth(label, 80);
    assert.equal(fitted.truncated, true);
    assert.ok(approximateTextWidth(fitted.text) <= 80);
  });
});
