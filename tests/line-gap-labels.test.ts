import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Feature, FeatureCollection, MultiLineString, Point } from "geojson";
import { DEFAULT_LAYER_STYLE, type GeoLibreLayer, type LabelStyle } from "@geolibre/core";
import { hasLineGapLabels } from "../packages/map/src/layer-sync";
import {
  LINE_GAP_ANGLE_PROPERTY,
  LINE_GAP_TEXT_PROPERTY,
  buildLineGapLabels,
  getLineGapLabels,
  lineGapTextResolver,
  lineGapZoomBucket,
} from "../packages/map/src/line-gap-labels";

// At zoom 10 one degree of longitude near the equator is 512 * 1024 / 360
// ≈ 1456 px, so a 0.2° line is ~291 px long.
const ZOOM = 10;

function line(coordinates: number[][], properties: Record<string, unknown> = {}): Feature {
  return { type: "Feature", properties, geometry: { type: "LineString", coordinates } };
}

function fc(...features: Feature[]): FeatureCollection {
  return { type: "FeatureCollection", features };
}

const base = {
  zoom: ZOOM,
  textFor: (feature: Feature) => String(feature.properties?.elev ?? ""),
  measure: (text: string) => text.length * 8,
  size: 12,
  padding: 3,
  spacing: 1000,
};

describe("lineGapZoomBucket", () => {
  it("rounds down to half zoom levels", () => {
    assert.equal(lineGapZoomBucket(10.49), 10);
    assert.equal(lineGapZoomBucket(10.5), 10.5);
    assert.equal(lineGapZoomBucket(10.99), 10.5);
    assert.equal(lineGapZoomBucket(-1), 0);
  });
});

describe("buildLineGapLabels", () => {
  it("cuts a gap as wide as the text plus padding and labels its middle", () => {
    const input = fc(
      line(
        [
          [0, 0],
          [0.2, 0],
        ],
        { elev: 125 },
      ),
    );
    const { lines, labels } = buildLineGapLabels(input, base);

    assert.equal(labels.features.length, 1);
    const label = labels.features[0];
    assert.equal(label.properties?.[LINE_GAP_TEXT_PROPERTY], "125");
    assert.equal(label.properties?.[LINE_GAP_ANGLE_PROPERTY], 0);
    assert.equal(label.properties?.elev, 125, "keeps the line's attributes");
    const [lon] = (label.geometry as Point).coordinates;
    assert.ok(Math.abs(lon - 0.1) < 1e-9, "single label sits mid-line");

    const geometry = lines.features[0].geometry as MultiLineString;
    assert.equal(geometry.type, "MultiLineString");
    assert.equal(geometry.coordinates.length, 2);
    const gapStart = geometry.coordinates[0].at(-1)![0];
    const gapEnd = geometry.coordinates[1][0][0];
    const pxPerDegree = (512 * 2 ** ZOOM) / 360;
    const gapPx = (gapEnd - gapStart) * pxPerDegree;
    // "125" is 24 px wide plus 3 px padding on each side.
    assert.ok(Math.abs(gapPx - 30) < 1e-6, `gap is ${gapPx}px`);
    assert.deepEqual(geometry.coordinates[0][0], [0, 0]);
    assert.deepEqual(geometry.coordinates[1].at(-1), [0.2, 0]);
  });

  it("keeps text upright on a line drawn right to left", () => {
    const { labels } = buildLineGapLabels(
      fc(
        line(
          [
            [0.2, 0],
            [0, 0],
          ],
          { elev: 5 },
        ),
      ),
      base,
    );
    assert.equal(labels.features[0].properties?.[LINE_GAP_ANGLE_PROPERTY], 0);
  });

  it("rotates text along a sloped line", () => {
    const { labels } = buildLineGapLabels(
      fc(
        line(
          [
            [0, 0],
            [0.1, 0.1],
          ],
          { elev: 5 },
        ),
      ),
      base,
    );
    // Screen y points down, so a line rising to the north-east reads at -45°.
    const angle = labels.features[0].properties?.[LINE_GAP_ANGLE_PROPERTY] as number;
    assert.ok(Math.abs(angle + 45) < 0.2, `angle ${angle}`);
  });

  it("repeats labels along a long line at the spacing", () => {
    const input = fc(
      line(
        [
          [0, 0],
          [1, 0],
        ],
        { elev: 10 },
      ),
    );
    const { labels, lines } = buildLineGapLabels(input, { ...base, spacing: 300 });
    // ~1456 px / 300 px → 4 labels, so 5 pieces of line.
    assert.equal(labels.features.length, 4);
    assert.equal((lines.features[0].geometry as MultiLineString).coordinates.length, 5);
  });

  it("stops and reports overBudget past maxTargets, leaving the input uncut", () => {
    const input = fc(
      line(
        [
          [0, 0],
          [1, 0],
        ],
        { elev: 10 },
      ),
    );
    // The line asks for 4 targets at a 300 px spacing.
    const result = buildLineGapLabels(input, { ...base, spacing: 300, maxTargets: 3 });
    assert.equal(result.overBudget, true);
    assert.equal(result.lines, input);
    assert.equal(result.labels.features.length, 0);
  });

  it("leaves lines too short for their text, unlabeled lines and points untouched", () => {
    const short = line(
      [
        [0, 0],
        [0.01, 0],
      ],
      { elev: 100 },
    );
    const blank = line(
      [
        [0, 1],
        [0.2, 1],
      ],
      { elev: "" },
    );
    const point: Feature = {
      type: "Feature",
      properties: { elev: 3 },
      geometry: { type: "Point", coordinates: [0, 0] },
    };
    const { lines, labels } = buildLineGapLabels(fc(short, blank, point), base);
    assert.equal(labels.features.length, 0);
    assert.equal(lines.features[0], short);
    assert.equal(lines.features[1], blank);
    assert.equal(lines.features[2], point);
  });

  it("skips a stretch too bent for straight text", () => {
    // A tight hairpin: 20 px out and back, shorter than its 30 px gap allows
    // straight, and nothing straight to slide to.
    const pxPerDegree = (512 * 2 ** ZOOM) / 360;
    const d = 25 / pxPerDegree;
    const hairpin = line(
      [
        [0, 0],
        [d, 0],
        [d, 0.0001],
        [0, 0.0001],
      ],
      { elev: 125 },
    );
    const { labels, lines } = buildLineGapLabels(fc(hairpin), base);
    assert.equal(labels.features.length, 0);
    assert.equal(lines.features[0], hairpin);
  });

  it("drops a label that would collide with one already placed", () => {
    // Two parallel 50 px lines 5 px apart: no room to slide the second label
    // clear of the first.
    const pxPerDegree = (512 * 2 ** ZOOM) / 360;
    const dy = 5 / pxPerDegree;
    const len = 50 / pxPerDegree;
    const input = fc(
      line(
        [
          [0, 0],
          [len, 0],
        ],
        { elev: 1 },
      ),
      line(
        [
          [0, dy],
          [len, dy],
        ],
        { elev: 2 },
      ),
    );
    const { labels, lines } = buildLineGapLabels(input, base);
    assert.equal(labels.features.length, 1);
    assert.equal(lines.features[1], input.features[1], "no label, no gap");
    const overlapping = buildLineGapLabels(input, { ...base, allowOverlap: true });
    assert.equal(overlapping.labels.features.length, 2);
  });

  it("slides a colliding label along its line to a free spot", () => {
    const pxPerDegree = (512 * 2 ** ZOOM) / 360;
    const dy = 5 / pxPerDegree;
    const input = fc(
      line(
        [
          [0, 0],
          [0.2, 0],
        ],
        { elev: 1 },
      ),
      line(
        [
          [0, dy],
          [0.2, dy],
        ],
        { elev: 2 },
      ),
    );
    const { labels } = buildLineGapLabels(input, base);
    assert.equal(labels.features.length, 2);
    const [first, second] = labels.features.map((f) => (f.geometry as Point).coordinates[0]);
    assert.ok(Math.abs(first - second) * pxPerDegree >= 15, "staggered, not stacked");
  });

  it("labels each part of a multi-line", () => {
    const multi: Feature = {
      type: "Feature",
      properties: { elev: 50 },
      geometry: {
        type: "MultiLineString",
        coordinates: [
          [
            [0, 0],
            [0.2, 0],
          ],
          [
            [0, 1],
            [0.2, 1],
          ],
        ],
      },
    };
    const { labels, lines } = buildLineGapLabels(fc(multi), base);
    assert.equal(labels.features.length, 2);
    assert.equal((lines.features[0].geometry as MultiLineString).coordinates.length, 4);
  });

  it("finds a wide label placed earlier on another line when checking collisions", () => {
    // At zoom 0 a 300 px label (radius 150) centred at x=250 and a 20 px label
    // centred 150 px away at x=100 overlap. The grid cells are 62.5 px, so the
    // narrow label's search must reach the wide label's cell, not only its own
    // radius's.
    const wide = line(
      [
        [-172.96875, 0],
        [164.53125, 0],
      ],
      { elev: "wide" },
    );
    const narrow = line(
      [
        [-120.5859375, 0],
        [-98.7890625, 0],
      ],
      { elev: "x" },
    );
    const { labels } = buildLineGapLabels(fc(wide, narrow), {
      ...base,
      zoom: 0,
      measure: (text) => (text === "wide" ? 300 : 20),
      padding: 0,
      spacing: 250,
    });
    assert.equal(labels.features.length, 1);
  });

  it("cuts the gap in screen pixels on a steep line", () => {
    // Mercator stretches latitude, so a gap cut by degrees would not be 40 px.
    const input = fc(
      line(
        [
          [0, 0],
          [0, 80],
        ],
        { elev: "x" },
      ),
    );
    const { lines, labels } = buildLineGapLabels(input, {
      ...base,
      zoom: 0,
      measure: () => 40,
      padding: 0,
    });
    assert.equal(labels.features.length, 1);
    const geometry = lines.features[0].geometry as MultiLineString;
    assert.equal(geometry.coordinates.length, 2);
    const before = projectPx(geometry.coordinates[0].at(-1)!);
    const after = projectPx(geometry.coordinates[1][0]);
    const gapPx = Math.hypot(after[0] - before[0], after[1] - before[1]);
    assert.ok(Math.abs(gapPx - 40) < 1e-6, `gap is ${gapPx}px`);
  });

  it("leaves hidden features uncut and unlabeled", () => {
    const shown = line(
      [
        [0, 0],
        [0.2, 0],
      ],
      { elev: 1 },
    );
    const hidden = line(
      [
        [0, 1],
        [0.2, 1],
      ],
      { elev: 2 },
    );
    const input = fc(shown, hidden);
    const { lines, labels } = buildLineGapLabels(input, {
      ...base,
      visible: (feature) => feature.properties?.elev === 1,
    });
    assert.equal(labels.features.length, 1);
    assert.equal(labels.features[0].properties?.elev, 1);
    assert.equal(lines.features[1], hidden, "hidden line keeps its geometry");
  });
});

describe("lineGapTextResolver", () => {
  it("evaluates a zoom-dependent text at the placement zoom", () => {
    const textFor = lineGapTextResolver(["step", ["zoom"], "low", 10, "high"], "none", 12);
    assert.ok(textFor);
    const point: Feature = {
      type: "Feature",
      properties: {},
      geometry: { type: "Point", coordinates: [0, 0] },
    };
    assert.equal(textFor(point), "high");
  });
});

/** Mercator world pixels at zoom 0, the space the placement measures in. */
function projectPx(position: number[]): [number, number] {
  const sin = Math.sin((position[1] * Math.PI) / 180);
  return [
    ((position[0] + 180) / 360) * 512,
    (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * 512,
  ];
}

const gapLabels: LabelStyle = {
  ...DEFAULT_LAYER_STYLE.labels,
  enabled: true,
  field: "elev",
  placement: "line",
  lineGap: true,
};

describe("getLineGapLabels", () => {
  it("falls back to ordinary labels when a placement would place far too many labels", () => {
    // A 10° line at zoom 22 is ~1.5e9 px long: millions of label targets.
    const input = fc(
      line(
        [
          [0, 0],
          [10, 0],
        ],
        { elev: 10 },
      ),
    );
    const measure = (text: string) => text.length * 8;
    assert.equal(getLineGapLabels(input, gapLabels, ["get", "elev"], 22, measure), null);
    // The same layer at a low zoom still gets its gaps.
    const low = getLineGapLabels(input, gapLabels, ["get", "elev"], 6, measure);
    assert.ok(low && low.labels.features.length > 0);
  });
});

describe("hasLineGapLabels", () => {
  function contourLayer(extra: Partial<GeoLibreLayer> = {}): GeoLibreLayer {
    return {
      id: "contours",
      name: "Contours",
      type: "geojson",
      visible: true,
      opacity: 1,
      geojson: fc(
        line(
          [
            [0, 0],
            [1, 0],
          ],
          { elev: 10 },
        ),
      ),
      style: { ...DEFAULT_LAYER_STYLE, labels: gapLabels },
      ...extra,
    } as GeoLibreLayer;
  }

  it("applies to a visible line layer with gap labels", () => {
    assert.equal(hasLineGapLabels([contourLayer()]), true);
  });

  it("keeps ordinary labels while a priority expression is set", () => {
    const layer = contourLayer();
    layer.style = {
      ...layer.style,
      labels: { ...gapLabels, priorityExpression: '["get", "elev"]' },
    };
    assert.equal(hasLineGapLabels([layer]), false);
  });

  it("keeps ordinary labels while a feature filter is active", () => {
    // MapLibre filters after collision placement, so a hidden line could
    // otherwise take a visible line's label spot.
    const filtered = contourLayer({
      embedFilter: ["==", ["get", "elev"], 20],
    } as Partial<GeoLibreLayer>);
    assert.equal(hasLineGapLabels([filtered]), false);
  });
});
