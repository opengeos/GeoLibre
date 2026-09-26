import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { Feature, FeatureCollection, Polygon } from "geojson";
import { useAppStore } from "@geolibre/core";
import { planArcGISEdits, type ArcGISEditInfo } from "../packages/plugins/src/plugins/arcgis-edits";
import { addArcGISLayer } from "../packages/plugins/src/plugins/arcgis-layer";
import {
  ARCGIS_GENERALIZE_MAX_ZOOM,
  arcgisQuantizationParams,
  decodeArcGISQuantizedFeatures,
  isArcGISQuantizedFeatureSet,
} from "../packages/plugins/src/plugins/arcgis-quantized";
import type { GeoLibreAppAPI } from "../packages/plugins/src/types";

const HALF_WORLD = 20037508.342789244;
const POLYGON_LAYER = {
  geometryType: "esriGeometryPolygon",
  supportsCoordinatesQuantization: true,
};

/** A quantized feature set on a 1 km grid with an upper-left origin at (0, 0) meters. */
const featureSet = (features: unknown[], originPosition = "upperLeft") => ({
  objectIdFieldName: "OBJECTID",
  transform: { originPosition, scale: [1000, 1000], translate: [0, 0] },
  exceededTransferLimit: true,
  features,
});

/** Degrees per kilometer of Web Mercator x, for reading decoded longitudes. */
const KM_LNG = (1000 / 6378137) * (180 / Math.PI);

describe("arcgisQuantizationParams", () => {
  it("requests a one-pixel Web Mercator grid below the full-resolution zoom", () => {
    const params = arcgisQuantizationParams(4, POLYGON_LAYER);
    assert.ok(params);
    assert.equal(params.f, "json");
    assert.equal(params.outSR, "102100");
    const quantization = JSON.parse(params.quantizationParameters);
    assert.equal(quantization.mode, "view");
    assert.equal(quantization.originPosition, "upperLeft");
    assert.equal(quantization.tolerance, (2 * HALF_WORLD) / (512 * 16));
    assert.equal(quantization.extent.spatialReference.wkid, 102100);
  });

  it("loads full resolution when zoomed in, for points, and without service support", () => {
    assert.equal(arcgisQuantizationParams(ARCGIS_GENERALIZE_MAX_ZOOM, POLYGON_LAYER), null);
    assert.ok(arcgisQuantizationParams(ARCGIS_GENERALIZE_MAX_ZOOM - 0.5, POLYGON_LAYER));
    assert.ok(
      arcgisQuantizationParams(3, { ...POLYGON_LAYER, geometryType: "esriGeometryPolyline" }),
    );
    assert.equal(
      arcgisQuantizationParams(3, { ...POLYGON_LAYER, geometryType: "esriGeometryPoint" }),
      null,
    );
    assert.equal(arcgisQuantizationParams(3, { geometryType: "esriGeometryPolygon" }), null);
    assert.equal(arcgisQuantizationParams(Number.NaN, POLYGON_LAYER), null);
  });
});

describe("decodeArcGISQuantizedFeatures", () => {
  it("recognizes only a feature set with a transform", () => {
    assert.ok(isArcGISQuantizedFeatureSet(featureSet([])));
    assert.equal(isArcGISQuantizedFeatureSet({ type: "FeatureCollection", features: [] }), false);
    assert.equal(isArcGISQuantizedFeatureSet({ features: [], transform: { scale: [1] } }), false);
  });

  it("undoes the delta encoding and the upper-left origin", () => {
    const decoded = decodeArcGISQuantizedFeatures(
      featureSet([
        {
          attributes: { OBJECTID: 7, NAME: "Line" },
          // Absolute (1, 2), then +1 x, then -1 row (one grid step up).
          geometry: {
            paths: [
              [
                [1, 2],
                [1, 0],
                [0, -1],
              ],
            ],
          },
        },
      ]),
    );
    assert.equal(decoded.exceededTransferLimit, true);
    const [feature] = decoded.features;
    assert.equal(feature.id, 7);
    assert.deepEqual(feature.properties, { OBJECTID: 7, NAME: "Line" });
    assert.equal(feature.geometry?.type, "LineString");
    const coords = (feature.geometry as { coordinates: number[][] }).coordinates;
    assert.equal(coords.length, 3);
    assert.ok(Math.abs(coords[0][0] - KM_LNG) < 1e-6);
    assert.ok(Math.abs(coords[1][0] - 2 * KM_LNG) < 1e-6);
    // Row 2 below the origin is south of the equator; row 1 is north of row 2.
    assert.ok(coords[0][1] < 0);
    assert.ok(coords[2][1] > coords[1][1]);
  });

  it("flips rows for a lower-left origin and leaves points undelta'd", () => {
    const decoded = decodeArcGISQuantizedFeatures(
      featureSet([{ attributes: {}, geometry: { x: 3, y: 2 } }], "lowerLeft"),
    );
    const [lng, lat] = (decoded.features[0].geometry as { coordinates: number[] }).coordinates;
    assert.ok(Math.abs(lng - 3 * KM_LNG) < 1e-6);
    assert.ok(lat > 0);
  });

  it("groups clockwise shells with their holes and drops collapsed rings", () => {
    // Rows grow downward, so a ring listed with increasing x then increasing
    // row is clockwise on the map: the Esri shell winding.
    const shell = [
      [0, 0],
      [10, 0],
      [0, 10],
      [-10, 0],
      [0, -10],
    ];
    const hole = [
      [2, 2],
      [0, 2],
      [2, 0],
      [0, -2],
      [-2, 0],
    ];
    const secondShell = [
      [20, 0],
      [2, 0],
      [0, 2],
      [-2, 0],
      [0, -2],
    ];
    const collapsed = [
      [30, 30],
      [1, 0],
      [-1, 0],
    ];
    const decoded = decodeArcGISQuantizedFeatures(
      featureSet([
        { attributes: { OBJECTID: 1 }, geometry: { rings: [shell, hole, secondShell, collapsed] } },
      ]),
    );
    const geometry = decoded.features[0].geometry;
    assert.equal(geometry?.type, "MultiPolygon");
    const polygons = (geometry as { coordinates: number[][][][] }).coordinates;
    assert.equal(polygons.length, 2);
    assert.equal(polygons[0].length, 2, "the hole joins the shell that contains it");
    assert.equal(polygons[1].length, 1);
    // GeoJSON winding: shells counter-clockwise, holes clockwise.
    const area = (ring: number[][]) =>
      ring
        .slice(0, -1)
        .reduce((sum, p, i) => sum + p[0] * ring[i + 1][1] - ring[i + 1][0] * p[1], 0);
    assert.ok(area(polygons[0][0]) > 0);
    assert.ok(area(polygons[0][1]) < 0);
  });

  it("assigns a hole whose first vertex snapped onto its shell's edge", () => {
    // The hole's first vertex, column 10 row 5, lies on the shell's right edge
    // (which a point-in-ring test counts as outside); the rest are well inside.
    const shell = [
      [0, 0],
      [10, 0],
      [0, 10],
      [-10, 0],
      [0, -10],
    ];
    const hole = [
      [10, 5],
      [-4, -2],
      [-3, 0],
      [0, 4],
      [3, 0],
      [4, -2],
    ];
    const decoded = decodeArcGISQuantizedFeatures(
      featureSet([{ attributes: { OBJECTID: 1 }, geometry: { rings: [shell, hole] } }]),
    );
    const geometry = decoded.features[0].geometry;
    assert.equal(geometry?.type, "Polygon");
    assert.equal((geometry as Polygon).coordinates.length, 2);
  });

  it("drops a feature whose shape collapsed below the grid", () => {
    const decoded = decodeArcGISQuantizedFeatures(
      featureSet([
        {
          attributes: { OBJECTID: 2 },
          geometry: {
            rings: [
              [
                [5, 5],
                [0, 0],
                [0, 0],
              ],
            ],
          },
        },
        { attributes: { OBJECTID: 3 }, geometry: { x: 1, y: 1 } },
      ]),
    );
    assert.deepEqual(
      decoded.features.map((feature) => feature.id),
      [3],
    );
  });
});

describe("generalized geometry edits", () => {
  const info: ArcGISEditInfo = {
    objectIdField: "OBJECTID",
    geometryType: "esriGeometryPolygon",
    capabilities: "Query,Create,Update,Delete",
    fields: [
      { name: "OBJECTID", type: "esriFieldTypeOID", editable: false },
      { name: "name", type: "esriFieldTypeString", length: 20 },
    ],
    geometryGeneralized: true,
  };
  const square = (size: number): Polygon => ({
    type: "Polygon",
    coordinates: [
      [
        [0, 0],
        [size, 0],
        [size, size],
        [0, size],
        [0, 0],
      ],
    ],
  });
  const feature = (name: string, geometry: Polygon): Feature => ({
    type: "Feature",
    id: 1,
    properties: { OBJECTID: 1, name },
    geometry,
  });
  const fc = (...features: Feature[]): FeatureCollection => ({
    type: "FeatureCollection",
    features,
  });

  it("refuses to write a reshaped simplified geometry back", () => {
    assert.throws(
      () => planArcGISEdits(fc(feature("a", square(1))), fc(feature("a", square(2))), info),
      /Zoom in to edit/,
    );
  });

  it("still saves attribute edits, which leave the geometry out", () => {
    const plan = planArcGISEdits(fc(feature("a", square(1))), fc(feature("b", square(1))), info);
    assert.deepEqual(plan.updates[0].payload, { attributes: { OBJECTID: 1, name: "b" } });
  });
});

describe("generalized viewport loading", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
    useAppStore.setState({ layers: [] });
  });

  const LAYER_INFO = {
    name: "Districts",
    geometryType: "esriGeometryPolygon",
    objectIdField: "OBJECTID",
    supportsCoordinatesQuantization: true,
    capabilities: "Query,Update",
    fields: [{ name: "OBJECTID", type: "esriFieldTypeOID" }],
    advancedQueryCapabilities: { supportsPagination: true, supportsOrderBy: true },
    extent: {
      xmin: -100,
      ymin: 30,
      xmax: -90,
      ymax: 40,
      spatialReference: { wkid: 4326 },
    },
  };

  const load = async (zoom: number) => {
    const queries: URL[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = new URL(typeof input === "string" ? input : input.toString());
      const body = !url.pathname.endsWith("/query")
        ? LAYER_INFO
        : Number(url.searchParams.get("resultOffset") ?? "0") > 0
          ? url.searchParams.get("f") === "json"
            ? featureSet([])
            : { type: "FeatureCollection", features: [] }
          : url.searchParams.get("f") === "json"
            ? featureSet([
                {
                  attributes: { OBJECTID: 1 },
                  geometry: {
                    rings: [
                      [
                        [0, 0],
                        [10, 0],
                        [0, 10],
                        [-10, 0],
                        [0, -10],
                      ],
                    ],
                  },
                },
              ])
            : {
                type: "FeatureCollection",
                features: [
                  { type: "Feature", id: 1, properties: { OBJECTID: 1 }, geometry: square() },
                ],
              };
      if (url.pathname.endsWith("/query")) queries.push(url);
      return {
        ok: true,
        status: 200,
        json: async () => body,
        text: async () => JSON.stringify(body),
      } as Response;
    }) as typeof fetch;
    const map = {
      getBounds: () => ({
        getWest: () => -100,
        getSouth: () => 30,
        getEast: () => -90,
        getNorth: () => 40,
      }),
      getZoom: () => zoom,
      isMoving: () => false,
      on: () => {},
      off: () => {},
    };
    const app = { getMap: () => map, fitBounds: () => {} } as unknown as GeoLibreAppAPI;
    const id = await addArcGISLayer(app, {
      layerType: "feature",
      sourceType: "url",
      url: "https://example.com/arcgis/rest/services/Districts/FeatureServer/0",
    });
    for (let tick = 0; tick < 6; tick += 1) await new Promise((r) => setTimeout(r, 0));
    return { layer: useAppStore.getState().layers.find((entry) => entry.id === id), queries };
  };

  const square = (): Polygon => ({
    type: "Polygon",
    coordinates: [
      [
        [-95, 35],
        [-94, 35],
        [-94, 36],
        [-95, 36],
        [-95, 35],
      ],
    ],
  });

  it("asks for quantized geometry zoomed out and marks it uneditable", async () => {
    const { layer, queries } = await load(4);
    assert.equal(queries[0].searchParams.get("f"), "json");
    assert.ok(queries[0].searchParams.get("quantizationParameters"));
    assert.equal(queries[0].searchParams.get("geometry"), "-100,30,-90,40");
    assert.equal(layer?.geojson?.features.length, 1);
    assert.equal(layer?.geojson?.features[0].geometry?.type, "Polygon");
    assert.equal(
      (layer?.metadata.arcgisEditInfo as ArcGISEditInfo | undefined)?.geometryGeneralized,
      true,
    );
  });

  it("pages by records, so shapes that collapsed do not end the walk early", async () => {
    const shell = (x: number) => [
      [x, 0],
      [10, 0],
      [0, 10],
      [-10, 0],
      [0, -10],
    ];
    const collapsed = [
      [0, 0],
      [0, 0],
      [0, 0],
    ];
    const record = (oid: number, ring: number[][]) => ({
      attributes: { OBJECTID: oid },
      geometry: { rings: [ring] },
    });
    // Three records per page; the first page's middle record collapses.
    const pages = [
      [record(1, shell(0)), record(2, collapsed), record(3, shell(20))],
      [record(4, shell(40)), record(5, shell(60))],
    ];
    const offsets: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = new URL(typeof input === "string" ? input : input.toString());
      const body = !url.pathname.endsWith("/query")
        ? { ...LAYER_INFO, maxRecordCount: 3 }
        : (() => {
            const offset = url.searchParams.get("resultOffset") ?? "0";
            offsets.push(offset);
            return { ...featureSet(pages[Number(offset) / 3] ?? []), exceededTransferLimit: false };
          })();
      return {
        ok: true,
        status: 200,
        json: async () => body,
        text: async () => JSON.stringify(body),
      } as Response;
    }) as typeof fetch;
    const map = {
      getBounds: () => ({
        getWest: () => -100,
        getSouth: () => 30,
        getEast: () => -90,
        getNorth: () => 40,
      }),
      getZoom: () => 4,
      isMoving: () => false,
      on: () => {},
      off: () => {},
    };
    const id = await addArcGISLayer(
      { getMap: () => map, fitBounds: () => {} } as unknown as GeoLibreAppAPI,
      {
        layerType: "feature",
        sourceType: "url",
        url: "https://example.com/arcgis/rest/services/Districts/FeatureServer/0",
      },
    );
    for (let tick = 0; tick < 10; tick += 1) await new Promise((r) => setTimeout(r, 0));
    assert.deepEqual(offsets, ["0", "3"], "the second page starts after all three records");
    const layer = useAppStore.getState().layers.find((entry) => entry.id === id);
    assert.deepEqual(
      layer?.geojson?.features.map((feature) => feature.properties?.OBJECTID),
      [1, 3, 4, 5],
    );
  });

  it("spots a service ignoring resultOffset even when every shape collapsed", async () => {
    const collapsed = (oid: number) => ({
      attributes: { OBJECTID: oid },
      geometry: {
        rings: [
          [
            [0, 0],
            [0, 0],
            [0, 0],
          ],
        ],
      },
    });
    let queries = 0;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = new URL(typeof input === "string" ? input : input.toString());
      const onQuery = url.pathname.endsWith("/query");
      if (onQuery && !url.searchParams.has("returnIdsOnly")) queries += 1;
      // Every offset answers with the same full page of collapsed shapes.
      const body = !onQuery
        ? { ...LAYER_INFO, maxRecordCount: 2 }
        : url.searchParams.has("returnIdsOnly")
          ? { objectIdFieldName: "OBJECTID", objectIds: [1, 2] }
          : { ...featureSet([collapsed(1), collapsed(2)]), exceededTransferLimit: false };
      return {
        ok: true,
        status: 200,
        json: async () => body,
        text: async () => JSON.stringify(body),
      } as Response;
    }) as typeof fetch;
    const map = {
      getBounds: () => ({
        getWest: () => -100,
        getSouth: () => 30,
        getEast: () => -90,
        getNorth: () => 40,
      }),
      getZoom: () => 4,
      isMoving: () => false,
      on: () => {},
      off: () => {},
    };
    await addArcGISLayer({ getMap: () => map, fitBounds: () => {} } as unknown as GeoLibreAppAPI, {
      layerType: "feature",
      sourceType: "url",
      url: "https://example.com/arcgis/rest/services/Districts/FeatureServer/0",
    });
    for (let tick = 0; tick < 10; tick += 1) await new Promise((r) => setTimeout(r, 0));
    // Two offset pages reveal the repeat; one ObjectID range reads the rest.
    assert.ok(queries <= 4, `stopped after ${queries} queries instead of paging to the cap`);
  });

  it("loads full-resolution GeoJSON zoomed in", async () => {
    const { layer, queries } = await load(ARCGIS_GENERALIZE_MAX_ZOOM);
    assert.equal(queries[0].searchParams.get("f"), "geojson");
    assert.equal(queries[0].searchParams.get("quantizationParameters"), null);
    assert.deepEqual(layer?.geojson?.features[0].geometry, square());
    assert.equal(
      (layer?.metadata.arcgisEditInfo as ArcGISEditInfo | undefined)?.geometryGeneralized,
      undefined,
    );
  });
});
