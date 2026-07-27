import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Feature, FeatureCollection, Polygon } from "geojson";
import type {
  OvertureMapsState,
  OvertureTheme,
} from "maplibre-gl-overture-maps";
import { mergeOvertureMapsState } from "../packages/plugins/src/plugins/maplibre-overture-maps";
import {
  overtureFeatureMatchesFilter,
  overtureTilesForBBox,
} from "../packages/plugins/src/plugins/overture-query";

const flood: FeatureCollection<Polygon> = {
  type: "FeatureCollection",
  features: [
    {
      type: "Feature",
      properties: {},
      geometry: {
        type: "Polygon",
        coordinates: [
          [
            [0, 0],
            [1, 0],
            [1, 1],
            [0, 1],
            [0, 0],
          ],
        ],
      },
    },
  ],
};

describe("Overture PMTiles query helpers", () => {
  it("enumerates bounded XYZ tile ranges", () => {
    const tiles = overtureTilesForBBox([-0.9, 38.8, 0.2, 39.9], 12);
    assert.equal(tiles.length, 238);
    assert.deepEqual(tiles[0], { x: 2037, y: 1552, z: 12 });
  });

  it("supports centroid and line-intersection polygon filters", () => {
    const building: Feature<Polygon> = {
      type: "Feature",
      properties: {},
      geometry: {
        type: "Polygon",
        coordinates: [
          [
            [0.2, 0.2],
            [0.4, 0.2],
            [0.4, 0.4],
            [0.2, 0.4],
            [0.2, 0.2],
          ],
        ],
      },
    };
    const road: Feature = {
      type: "Feature",
      properties: {},
      geometry: {
        type: "LineString",
        coordinates: [
          [-1, 0.5],
          [2, 0.5],
        ],
      },
    };
    const outside: Feature = {
      type: "Feature",
      properties: {},
      geometry: {
        type: "LineString",
        coordinates: [
          [-1, 2],
          [2, 2],
        ],
      },
    };

    assert.equal(
      overtureFeatureMatchesFilter(building, flood, "centroid-within"),
      true
    );
    assert.equal(overtureFeatureMatchesFilter(road, flood, "intersects"), true);
    assert.equal(
      overtureFeatureMatchesFilter(outside, flood, "intersects"),
      false
    );
  });
});

describe("Overture plugin state coordination", () => {
  it("deep-merges a disaster style patch without dropping other themes", () => {
    const themeIds: OvertureTheme[] = [
      "addresses",
      "base",
      "buildings",
      "divisions",
      "places",
      "transportation",
    ];
    const base: OvertureMapsState = {
      collapsed: false,
      panelWidth: 340,
      release: "2026-07-22.0",
      releases: ["2026-07-22.0"],
      inspect: false,
      themes: Object.fromEntries(
        themeIds.map((theme) => [
          theme,
          {
            expanded: false,
            layers: {
              [theme === "transportation" ? "segment" : "building"]: {
                visible: false,
                opacity: 1,
                color: "#000000",
                size: 1,
              },
            },
          },
        ]),
      ) as OvertureMapsState["themes"],
    };

    const merged = mergeOvertureMapsState(base, {
      inspect: true,
      themes: {
        buildings: {
          expanded: true,
          layers: {
            building: {
              visible: true,
              opacity: 0.4,
              color: "#64748b",
            },
          },
        },
      },
    });

    assert.equal(merged.inspect, true);
    assert.deepEqual(merged.themes.buildings.layers.building, {
      visible: true,
      opacity: 0.4,
      color: "#64748b",
      size: 1,
    });
    assert.equal(merged.themes.transportation.layers.segment.visible, false);
    assert.equal(merged.themes.places.expanded, false);
  });
});
