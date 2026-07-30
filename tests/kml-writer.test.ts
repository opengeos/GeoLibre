import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { FeatureCollection } from "geojson";
import { strFromU8, unzipSync } from "fflate";
import { writeKml } from "../apps/geolibre-desktop/src/lib/kml-writer";
import { exportBinaryVectorLayer } from "../apps/geolibre-desktop/src/lib/vector-exporter";

const SAMPLE: FeatureCollection = {
  type: "FeatureCollection",
  features: [
    {
      type: "Feature",
      id: "city-1",
      geometry: { type: "Point", coordinates: [-115.14, 36.17, 610] },
      properties: {
        name: "Las Vegas & Valley",
        description: 'A <sample> "place"',
        population: 641_903,
        active: true,
        details: { state: "Nevada" },
        "marker-color": "#123456",
        "marker-opacity": 0.5,
        stroke: "#00ff00",
        "stroke-width": 3,
        fill: "#0000ff",
        "fill-opacity": 0.25,
      },
    },
  ],
};

describe("writeKml", () => {
  it("writes a KML 2.2 document with escaped names, attributes, and altitude", () => {
    const kml = writeKml(SAMPLE, "Cities & towns");

    assert.match(kml, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
    assert.match(kml, /<kml xmlns="http:\/\/www\.opengis\.net\/kml\/2\.2">/);
    assert.match(kml, /<name>Cities &amp; towns<\/name>/);
    assert.match(kml, /<name>Las Vegas &amp; Valley<\/name>/);
    assert.match(kml, /<description>A &lt;sample&gt; &quot;place&quot;<\/description>/);
    assert.match(kml, /<Data name="population"><value>641903<\/value><\/Data>/);
    assert.match(kml, /<Data name="active"><value>true<\/value><\/Data>/);
    assert.match(
      kml,
      /<Data name="details"><value>\{&quot;state&quot;:&quot;Nevada&quot;\}<\/value><\/Data>/,
    );
    assert.match(kml, /<Data name="feature_id"><value>city-1<\/value><\/Data>/);
    assert.match(
      kml,
      /<Point><altitudeMode>absolute<\/altitudeMode><coordinates>-115\.14,36\.17,610<\/coordinates><\/Point>/,
    );
    assert.match(kml, /<IconStyle><color>80563412<\/color><\/IconStyle>/);
    assert.match(kml, /<LineStyle><color>ff00ff00<\/color><width>3<\/width><\/LineStyle>/);
    assert.match(kml, /<PolyStyle><color>40ff0000<\/color><\/PolyStyle>/);
  });

  it("writes every GeoJSON geometry type and closes open polygon rings", () => {
    const kml = writeKml(
      {
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            properties: {},
            geometry: {
              type: "GeometryCollection",
              geometries: [
                {
                  type: "MultiPoint",
                  coordinates: [
                    [1, 2],
                    [3, 4],
                  ],
                },
                {
                  type: "MultiLineString",
                  coordinates: [
                    [
                      [0, 0],
                      [1, 1],
                    ],
                    [
                      [2, 2],
                      [3, 3],
                    ],
                  ],
                },
                {
                  type: "MultiPolygon",
                  coordinates: [
                    [
                      [
                        [0, 0],
                        [1, 0],
                        [1, 1],
                        [0, 1],
                      ],
                    ],
                  ],
                },
              ],
            },
          },
        ],
      },
      "All geometries",
    );

    assert.equal((kml.match(/<Point>/g) ?? []).length, 2);
    assert.equal((kml.match(/<LineString>/g) ?? []).length, 2);
    assert.equal((kml.match(/<Polygon>/g) ?? []).length, 1);
    assert.match(kml, /<coordinates>0,0 1,0 1,1 0,1 0,0<\/coordinates>/);
    assert.ok((kml.match(/<MultiGeometry>/g) ?? []).length >= 4);
  });

  it("uses absolute altitude mode for three-dimensional geometries only", () => {
    const kml = writeKml(
      {
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            properties: {},
            geometry: {
              type: "GeometryCollection",
              geometries: [
                {
                  type: "LineString",
                  coordinates: [
                    [0, 0, 10],
                    [1, 1, 20],
                  ],
                },
                {
                  type: "Polygon",
                  coordinates: [
                    [
                      [0, 0, 10],
                      [1, 0, 10],
                      [1, 1, 10],
                      [0, 0, 10],
                    ],
                  ],
                },
                { type: "Point", coordinates: [2, 2] },
              ],
            },
          },
        ],
      },
      "Altitude",
    );

    assert.match(
      kml,
      /<LineString><altitudeMode>absolute<\/altitudeMode><coordinates>0,0,10 1,1,20<\/coordinates><\/LineString>/,
    );
    assert.match(kml, /<Polygon>\s+<altitudeMode>absolute<\/altitudeMode>/);
    assert.match(kml, /<Point><coordinates>2,2<\/coordinates><\/Point>/);
    assert.equal((kml.match(/<altitudeMode>absolute<\/altitudeMode>/g) ?? []).length, 2);
  });

  it("rejects invalid coordinates instead of creating a corrupt KML file", () => {
    assert.throws(
      () =>
        writeKml(
          {
            type: "FeatureCollection",
            features: [
              {
                type: "Feature",
                properties: {},
                geometry: { type: "Point", coordinates: [Number.NaN, 20] },
              },
            ],
          },
          "Invalid",
        ),
      /finite longitude and latitude/,
    );
  });
});

describe("KMZ export", () => {
  it("packages the generated document as doc.kml with the registered MIME type", async () => {
    const result = await exportBinaryVectorLayer(SAMPLE, "kmz", "Cities");
    const files = unzipSync(result.data);

    assert.deepEqual(Object.keys(files), ["doc.kml"]);
    assert.equal(strFromU8(files["doc.kml"]), writeKml(SAMPLE, "Cities"));
    assert.equal(result.extension, "kmz");
    assert.equal(result.mimeType, "application/vnd.google-earth.kmz");
  });
});

describe("KML text export", () => {
  it("writes KML through the browser save picker with matching format metadata", async () => {
    let pickerOptions: unknown;
    let savedContent: unknown;
    const originalWindow = globalThis.window;
    const originalSelfDescriptor = Object.getOwnPropertyDescriptor(globalThis, "self");
    const mockWindow = {
      showSaveFilePicker: async (options: unknown) => {
        pickerOptions = options;
        return {
          name: "Cities.kml",
          createWritable: async () => ({
            write: async (content: unknown) => {
              savedContent = content;
            },
            close: async () => undefined,
          }),
        };
      },
    };
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: mockWindow,
    });
    (globalThis as { self?: unknown }).self ??= globalThis;

    try {
      const { exportVectorLayer } = await import("../apps/geolibre-desktop/src/lib/vector-export");
      const savedName = await exportVectorLayer(SAMPLE, "kml", "Cities");

      assert.equal(savedName, "Cities.kml");
      assert.equal(savedContent, writeKml(SAMPLE, "Cities"));
      assert.deepEqual(pickerOptions, {
        suggestedName: "Cities.kml",
        types: [
          {
            description: "KML",
            accept: {
              "application/vnd.google-earth.kml+xml": [".kml"],
            },
          },
        ],
        excludeAcceptAllOption: false,
      });
    } finally {
      if (originalWindow === undefined) {
        Reflect.deleteProperty(globalThis, "window");
      } else {
        Object.defineProperty(globalThis, "window", {
          configurable: true,
          value: originalWindow,
        });
      }
      if (originalSelfDescriptor === undefined) {
        Reflect.deleteProperty(globalThis, "self");
      } else {
        Object.defineProperty(globalThis, "self", originalSelfDescriptor);
      }
    }
  });
});
