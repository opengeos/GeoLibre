import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type {
  Feature,
  FeatureCollection,
  GeometryCollection,
  MultiPolygon,
  Polygon,
} from "geojson";
import type { OvertureMapsState, OvertureTheme } from "maplibre-gl-overture-maps";
import {
  maplibreOvertureMapsPlugin,
  mergeOvertureMapsState,
} from "../packages/plugins/src/plugins/maplibre-overture-maps";
import {
  overtureFeatureMatchesFilter,
  overtureTileCountForBBox,
  overtureTilesForBBox,
  overtureZoomForBBox,
} from "../packages/plugins/src/plugins/overture-query";
import type { GeoLibreAppAPI } from "../packages/plugins/src/types";

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
    assert.equal(overtureTileCountForBBox([-0.9, 38.8, 0.2, 39.9], 12), tiles.length);
    assert.deepEqual(tiles[0], { x: 2037, y: 1552, z: 12 });
  });

  it("backs off zoom before materializing a tile range above the cap", () => {
    const bbox: [number, number, number, number] = [-0.9, 38.8, 0.2, 39.9];
    const zoom = overtureZoomForBBox(bbox, 12, 50);

    assert.ok(zoom < 12);
    assert.ok(overtureTileCountForBBox(bbox, zoom) <= 50);
    assert.ok(overtureTileCountForBBox(bbox, zoom + 1) > 50);
    assert.equal(overtureTilesForBBox(bbox, zoom).length, overtureTileCountForBBox(bbox, zoom));
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

    assert.equal(overtureFeatureMatchesFilter(building, flood, "centroid-within"), true);
    assert.equal(overtureFeatureMatchesFilter(road, flood, "intersects"), true);
    assert.equal(overtureFeatureMatchesFilter(outside, flood, "intersects"), false);
  });

  it("detects polygon overlap when the vertex mean is outside the filter", () => {
    const overlapping: Feature<Polygon> = {
      type: "Feature",
      properties: {},
      geometry: {
        type: "Polygon",
        coordinates: [
          [
            [-2, 0.4],
            [0.2, 0.4],
            [0.2, 0.6],
            [-2, 0.6],
            [-2, 0.4],
          ],
        ],
      },
    };

    assert.equal(overtureFeatureMatchesFilter(overlapping, flood, "centroid-within"), false);
    assert.equal(overtureFeatureMatchesFilter(overlapping, flood, "intersects"), true);
  });

  it("rejects filters that contain no usable area geometry", () => {
    const building = flood.features[0];

    assert.throws(
      () =>
        overtureFeatureMatchesFilter(building, {
          type: "Point",
          coordinates: [0.5, 0.5],
        }),
      /must contain a usable Polygon or MultiPolygon/,
    );
    assert.throws(
      () =>
        overtureFeatureMatchesFilter(building, {
          type: "LineString",
          coordinates: [
            [0, 0],
            [1, 1],
          ],
        }),
      /must contain a usable Polygon or MultiPolygon/,
    );
    assert.throws(
      () =>
        overtureFeatureMatchesFilter(building, {
          type: "GeometryCollection",
          geometries: [],
        }),
      /must contain a usable Polygon or MultiPolygon/,
    );
  });

  it("collects area filters recursively from GeometryCollections", () => {
    const filter: GeometryCollection = {
      type: "GeometryCollection",
      geometries: [{ type: "Point", coordinates: [10, 10] }, flood.features[0].geometry],
    };

    assert.equal(overtureFeatureMatchesFilter(flood.features[0], filter), true);
  });

  it("respects polygon holes and MultiPolygon components", () => {
    const withHole: Polygon = {
      type: "Polygon",
      coordinates: [
        [
          [0, 0],
          [4, 0],
          [4, 4],
          [0, 4],
          [0, 0],
        ],
        [
          [1, 1],
          [3, 1],
          [3, 3],
          [1, 3],
          [1, 1],
        ],
      ],
    };
    const separateAreas: MultiPolygon = {
      type: "MultiPolygon",
      coordinates: [
        flood.features[0].geometry.coordinates,
        [
          [
            [3, 0],
            [4, 0],
            [4, 1],
            [3, 1],
            [3, 0],
          ],
        ],
      ],
    };
    const pointInHole: Feature = {
      type: "Feature",
      properties: {},
      geometry: { type: "Point", coordinates: [2, 2] },
    };
    const pointInOuter: Feature = {
      type: "Feature",
      properties: {},
      geometry: { type: "Point", coordinates: [0.5, 0.5] },
    };
    const pointInSecondPolygon: Feature = {
      type: "Feature",
      properties: {},
      geometry: { type: "Point", coordinates: [3.5, 0.5] },
    };

    assert.equal(overtureFeatureMatchesFilter(pointInHole, withHole), false);
    assert.equal(overtureFeatureMatchesFilter(pointInOuter, withHole), true);
    assert.equal(overtureFeatureMatchesFilter(pointInSecondPolygon, separateAreas), true);
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

  it("drops unknown state keys and rejects invalid or no-op patches", () => {
    const base = maplibreOvertureMapsPlugin.getProjectState?.() as OvertureMapsState | undefined;
    const invalid = maplibreOvertureMapsPlugin.applyProjectState?.({} as GeoLibreAppAPI, {
      themes: "buildings",
    });
    const unknown = maplibreOvertureMapsPlugin.applyProjectState?.({} as GeoLibreAppAPI, {
      themes: { future_theme: { expanded: true } },
    });
    const unchanged = maplibreOvertureMapsPlugin.applyProjectState?.({} as GeoLibreAppAPI, {
      collapsed: false,
    });

    assert.equal(base, undefined);
    assert.equal(invalid, false);
    assert.equal(unknown, false);
    assert.equal(unchanged, false);

    const themeIds: OvertureTheme[] = [
      "addresses",
      "base",
      "buildings",
      "divisions",
      "places",
      "transportation",
    ];
    const state: OvertureMapsState = {
      collapsed: false,
      panelWidth: 340,
      release: "",
      releases: [],
      inspect: true,
      themes: Object.fromEntries(
        themeIds.map((theme) => [
          theme,
          {
            expanded: false,
            layers: {},
          },
        ]),
      ) as OvertureMapsState["themes"],
    };
    const merged = mergeOvertureMapsState(state, {
      inspect: false,
      unexpected: "ignored",
    } as Parameters<typeof mergeOvertureMapsState>[1] & { unexpected: string });

    assert.equal(merged.inspect, false);
    assert.equal("unexpected" in merged, false);
  });
});
