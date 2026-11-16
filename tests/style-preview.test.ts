import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_LAYER_STYLE, type LayerStyle } from "@geolibre/core";

import {
  MAX_STYLE_PREVIEW_COLORS,
  stylePreviewColors,
} from "../apps/geolibre-desktop/src/lib/style-preview";

const style = (patch: Partial<LayerStyle>): LayerStyle => ({ ...DEFAULT_LAYER_STYLE, ...patch });

describe("stylePreviewColors", () => {
  it("shows a rule-based style's rule colors before its else color (#3471)", () => {
    const colors = stylePreviewColors(
      style({
        vectorStyleMode: "rule-based",
        fillColor: "#cccccc",
        vectorRules: [
          {
            id: "a",
            label: "A",
            filter: '["==", ["get", "k"], 1]',
            color: "#ff0000",
            isElse: false,
          },
          {
            id: "b",
            label: "B",
            filter: '["==", ["get", "k"], 2]',
            color: "#00ff00",
            isElse: false,
          },
          {
            id: "off",
            label: "Off",
            filter: '["==", ["get", "k"], 3]',
            color: "#0000ff",
            isElse: false,
            enabled: false,
          },
          { id: "else", label: "Other", filter: "", color: "#cccccc", isElse: true },
        ],
      }),
    );
    assert.deepEqual(colors, ["#ff0000", "#00ff00", "#cccccc"]);
  });

  it("uses graduated stop colors, sampled down to the band cap", () => {
    const stops = Array.from({ length: 11 }, (_, index) => ({
      value: index,
      color: `#0000${index.toString(16).padStart(2, "0")}`,
    }));
    const colors = stylePreviewColors(
      style({ vectorStyleMode: "graduated", vectorStyleStops: stops }),
    );
    assert.equal(colors?.length, MAX_STYLE_PREVIEW_COLORS);
    assert.equal(colors?.[0], "#000000");
    assert.equal(colors?.at(-1), "#00000a");
  });

  it("returns null for a single-symbol style", () => {
    assert.equal(stylePreviewColors(style({ vectorStyleMode: "single" })), null);
  });
});
