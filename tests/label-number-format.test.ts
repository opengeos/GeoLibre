import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createExpression } from "@maplibre/maplibre-gl-style-spec";
import {
  DEFAULT_LAYER_STYLE,
  formatLabelNumber,
  formatLabelNumberSample,
  labelFieldTextField,
  resolveLabelNumberLocale,
  LABEL_NUMBER_LOCALES,
  type LabelStyle,
} from "@geolibre/core";

function labels(patch: Partial<LabelStyle>): LabelStyle {
  return { ...DEFAULT_LAYER_STYLE.labels, ...patch };
}

/** Compile a text-field through the real style spec and evaluate one feature. */
function renderTextField(style: LabelStyle, value: unknown): string {
  const expression = labelFieldTextField(style);
  const compiled = createExpression(expression as never, { type: "string" } as never);
  assert.equal(compiled.result, "success", JSON.stringify(expression));
  if (compiled.result !== "success") throw new Error("unreachable");
  return compiled.value.evaluate(
    { zoom: 0 } as never,
    {
      properties: { pop: value },
    } as never,
  ) as string;
}

describe("label number formatting", () => {
  it("leaves the text-field alone when formatting is off", () => {
    assert.deepEqual(labelFieldTextField(labels({ field: "pop" })), [
      "to-string",
      ["coalesce", ["get", "pop"], ""],
    ]);
  });

  it("reports no text-field when no label field is set", () => {
    assert.equal(labelFieldTextField(labels({ numberFormatEnabled: true })), "");
  });

  it("groups thousands on the map with the requested locale", () => {
    const style = labels({
      field: "pop",
      numberFormatEnabled: true,
      numberDecimals: 0,
      numberLocale: "en-US",
    });
    assert.equal(renderTextField(style, 1234567), "1,234,567");
  });

  it("rounds to whole numbers at zero decimals", () => {
    // MapLibre's `number-format` ignores a falsy option, so zero fraction
    // digits cannot be requested directly; the builder rounds instead. Without
    // that the spec default of three fraction digits would leak through.
    const style = labels({
      field: "pop",
      numberFormatEnabled: true,
      numberDecimals: 0,
      numberLocale: "en-US",
    });
    assert.equal(renderTextField(style, 1234567.5), "1,234,568");
  });

  it("pads to a fixed number of decimals", () => {
    const style = labels({
      field: "pop",
      numberFormatEnabled: true,
      numberDecimals: 2,
      numberLocale: "en-US",
    });
    assert.equal(renderTextField(style, 1234567.5), "1,234,567.50");
  });

  it("switches the thousands and decimal separators with the locale", () => {
    const style = labels({
      field: "pop",
      numberFormatEnabled: true,
      numberDecimals: 2,
      numberLocale: "de-DE",
    });
    assert.equal(renderTextField(style, 1234567.5), "1.234.567,50");
  });

  it("leaves a non-numeric value as its own text", () => {
    const style = labels({
      field: "pop",
      numberFormatEnabled: true,
      numberDecimals: 2,
      numberLocale: "en-US",
    });
    assert.equal(renderTextField(style, "n/a"), "n/a");
    assert.equal(renderTextField(style, null), "");
  });

  it("formats the same value the same way in JavaScript as on the map", () => {
    for (const locale of LABEL_NUMBER_LOCALES) {
      for (const decimals of [0, 2]) {
        const style = labels({
          field: "pop",
          numberFormatEnabled: true,
          numberDecimals: decimals,
          numberLocale: locale,
        });
        assert.equal(
          formatLabelNumber(1234567.5, style),
          renderTextField(style, 1234567.5),
          `${locale} @ ${decimals}`,
        );
      }
    }
  });

  it("formats nothing in JavaScript when off or the value is not a number", () => {
    const on = labels({ numberFormatEnabled: true, numberDecimals: 1, numberLocale: "en-US" });
    assert.equal(formatLabelNumber(12.5, labels({})), null);
    assert.equal(formatLabelNumber("12.5", on), null);
    assert.equal(formatLabelNumber(Number.NaN, on), null);
    assert.equal(formatLabelNumber(12.5, on), "12.5");
  });

  it("falls back to the supplied locale only when none is pinned", () => {
    const app = labels({ numberFormatEnabled: true, numberDecimals: 0, numberLocale: "" });
    assert.equal(formatLabelNumber(1234, app, "de-DE"), "1.234");
    const pinned = labels({ numberFormatEnabled: true, numberDecimals: 0, numberLocale: "en-US" });
    assert.equal(formatLabelNumber(1234, pinned, "de-DE"), "1,234");
  });

  it("clamps an out-of-range decimals value from a hand-edited project", () => {
    const style = labels({
      field: "pop",
      numberFormatEnabled: true,
      numberDecimals: 99,
      numberLocale: "en-US",
    });
    assert.equal(renderTextField(style, 1.5), "1.5000000000");
    assert.equal(formatLabelNumber(1.5, labels({ ...style, numberDecimals: -3 })), "2");
  });

  it("previews each offered locale by the separators it produces", () => {
    assert.equal(formatLabelNumberSample("en-US", 2), "1,234,567.50");
    assert.equal(formatLabelNumberSample("de-DE", 0), "1.234.568");
  });

  it("degrades a locale tag Intl rejects to the runtime default", () => {
    // A malformed tag can only arrive from a hand-edited project, but Intl
    // throws a RangeError on one, which would take down a whole layer's
    // labels rather than just that setting.
    const runtimeDefault = formatLabelNumberSample("", 0);
    assert.equal(formatLabelNumberSample("not a locale", 0), runtimeDefault);
    assert.equal(formatLabelNumberSample("en_US", 0), runtimeDefault);

    const bad = labels({
      field: "pop",
      numberFormatEnabled: true,
      numberDecimals: 0,
      numberLocale: "not a locale",
    });
    assert.equal(
      formatLabelNumber(1234, bad),
      formatLabelNumber(1234, { ...bad, numberLocale: "" }),
    );
    // The expression path is exposed too: MapLibre builds its own
    // Intl.NumberFormat per feature, so the tag must not reach the style.
    assert.equal(renderTextField(bad, 1234), formatLabelNumber(1234, bad));
    // A rejected pinned tag falls through to the caller's fallback locale.
    assert.equal(formatLabelNumber(1234, bad, "de-DE"), "1.234");
  });

  it("rounds halves away from zero on both paths", () => {
    // The zero-decimals branch rounds with MapLibre's `round`, which is
    // half-away-from-zero (`v < 0 ? -Math.round(-v) : Math.round(v)`), not
    // Math.round's half-toward-+Infinity. That happens to match Intl's default
    // rounding, so the map and the globe agree — but only by agreement, not by
    // construction, so pin it.
    const style = labels({
      field: "pop",
      numberFormatEnabled: true,
      numberDecimals: 0,
      numberLocale: "en-US",
    });
    for (const [value, expected] of [
      [-2.5, "-3"],
      [2.5, "3"],
      [-1.4, "-1"],
    ] as const) {
      assert.equal(renderTextField(style, value), expected, `map ${value}`);
      assert.equal(formatLabelNumber(value, style), expected, `js ${value}`);
    }
  });

  it("keeps the two paths in step for negative values at two decimals", () => {
    const style = labels({
      field: "pop",
      numberFormatEnabled: true,
      numberDecimals: 2,
      numberLocale: "en-US",
    });
    for (const value of [-2.005, -1234.5, -0.001, 1234.005]) {
      assert.equal(formatLabelNumber(value, style), renderTextField(style, value), String(value));
    }
  });

  it("refuses a locale the map's glyph stack cannot draw", () => {
    // The curated picker list is not the only route in: a hand-edited project
    // can pin any tag, and the "" default follows the app language, so a French
    // or Arabic UI would otherwise bake U+202F / Arabic-Indic digits into the
    // text-field and label the map with blank boxes.
    const runtimeDefault = formatLabelNumberSample("", 0);
    for (const tag of ["fr-FR", "ar-EG"]) {
      assert.equal(formatLabelNumberSample(tag, 0), runtimeDefault, tag);
      const style = labels({
        field: "pop",
        numberFormatEnabled: true,
        numberDecimals: 0,
        numberLocale: tag,
      });
      // Nothing rejected may reach the emitted style either.
      assert.ok(!JSON.stringify(labelFieldTextField(style)).includes(tag), `${tag} in expression`);
    }
    // A rejected app-language fallback degrades the same way.
    assert.equal(formatLabelNumber(1234, labels({ numberFormatEnabled: true }), "fr-FR"), "1,234");
  });

  it("refuses a locale whose negative sign the map cannot draw", () => {
    // sv-SE, fi-FI and nb-NO group with U+00A0 (safe) but write negatives with
    // U+2212 MINUS SIGN, so checking only a positive sample would let them
    // through and blank-box every negative label.
    for (const tag of ["sv-SE", "fi-FI", "nb-NO"]) {
      assert.equal(resolveLabelNumberLocale(tag), undefined, tag);
    }
  });

  it("resolves the effective locale the same way for every path", () => {
    assert.equal(resolveLabelNumberLocale("en-US"), "en-US");
    assert.equal(resolveLabelNumberLocale("not a locale"), undefined);
    assert.equal(resolveLabelNumberLocale("fr-FR"), undefined);
    // Falls through to the next usable candidate.
    assert.equal(resolveLabelNumberLocale("fr-FR", "de-DE"), "de-DE");
    assert.equal(resolveLabelNumberLocale("", undefined), undefined);
  });

  it("only offers locales whose separators the map's glyph stack can draw", () => {
    for (const locale of LABEL_NUMBER_LOCALES) {
      const sample = formatLabelNumberSample(locale, 2);
      for (const char of sample) {
        const code = char.codePointAt(0) ?? 0;
        const ascii = code < 0x80;
        assert.ok(
          ascii || code === 0x00a0,
          `${locale} formats with U+${code.toString(16)}, which is not a safe map glyph`,
        );
      }
    }
  });
});
