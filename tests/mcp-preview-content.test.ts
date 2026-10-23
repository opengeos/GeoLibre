import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_LAYER_STYLE, parseProject, type GeoLibreLayer } from "@geolibre/core";
import {
  previewableLayers,
  previewOrigins,
  unsupportedContent,
} from "../apps/geolibre-mcp-app/src/unsupported-content";

function layer(type: GeoLibreLayer["type"], extra: Partial<GeoLibreLayer> = {}): GeoLibreLayer {
  return {
    id: type,
    name: type,
    type,
    visible: true,
    opacity: 1,
    source: { type: "raster", tiles: ["https://maps.example.com/{z}/{x}/{y}.png"] },
    style: { ...DEFAULT_LAYER_STYLE },
    metadata: {},
    ...extra,
  };
}

function project(layers: GeoLibreLayer[]) {
  return parseProject(
    JSON.stringify({
      version: "0.2.0",
      name: "Preview",
      mapView: { center: [0, 0], zoom: 3 },
      layers,
    }),
  );
}

describe("MCP preview omitted content", () => {
  it("keeps WMS sources while rejecting plugin archives, video, and desktop sources", () => {
    const saved = project([
      layer("wms", { sourcePath: "https://maps.example.com/wms" }),
      layer("pmtiles"),
      layer("mbtiles"),
      layer("video"),
      layer("xyz", {
        source: { type: "raster", tiles: ["file:///private/tiles/{z}/{x}/{y}.png"] },
      }),
      layer("lidar", { visible: false }),
    ]);
    assert.deepEqual(
      previewableLayers(saved).map((item) => item.id),
      ["wms"],
    );
    const notices = unsupportedContent(saved).join("\n");
    for (const omitted of ["pmtiles", "mbtiles", "video", "xyz"])
      assert.ok(notices.includes(`“${omitted}”`));
    assert.equal(notices.includes("“wms”"), false);
    assert.equal(notices.includes("“lidar”"), false);
  });

  it("only omits elevation-enabled GeoJSON when it actually has Z coordinates", () => {
    const flat = layer("geojson", {
      id: "flat",
      style: { ...DEFAULT_LAYER_STYLE, elevation3dEnabled: true },
      geojson: {
        type: "FeatureCollection",
        features: [
          { type: "Feature", properties: {}, geometry: { type: "Point", coordinates: [0, 0] } },
        ],
      },
    });
    const elevated = {
      ...flat,
      id: "elevated",
      name: "Elevated",
      geojson: {
        type: "FeatureCollection" as const,
        features: [
          {
            type: "Feature" as const,
            properties: {},
            geometry: { type: "Point" as const, coordinates: [0, 0, 100] },
          },
        ],
      },
    };
    const saved = project([flat, elevated]);
    assert.deepEqual(
      previewableLayers(saved).map((item) => item.id),
      ["flat"],
    );
    assert.ok(unsupportedContent(saved).some((notice) => notice.includes("“Elevated”")));
  });

  it("does not warn for layers hidden by a saved group", () => {
    const saved = project([layer("lidar")]);
    saved.layers[0].groupId = "hidden";
    saved.layerGroups = [
      { id: "hidden", name: "Hidden", collapsed: false, visible: false, opacity: 1 },
    ];
    assert.equal(
      unsupportedContent(saved).some((notice) => notice.includes("“lidar”")),
      false,
    );
  });

  it("collects distinct renderable destinations, not hidden sources or URLs in feature properties", () => {
    const saved = project([
      layer("wms"),
      layer("image", {
        source: {
          type: "image",
          url: "https://images.example.com/overlay.png",
          coordinates: [
            [0, 1],
            [1, 1],
            [1, 0],
            [0, 0],
          ],
        },
      }),
      layer("vector-tiles", {
        source: { type: "vector", url: "http://tiles.example.com:8080/source.json" },
      }),
      layer("xyz", {
        id: "hidden",
        visible: false,
        source: { type: "raster", tiles: ["https://hidden.example.com/tile"] },
      }),
      layer("xyz", {
        id: "grouped",
        groupId: "off",
        source: { type: "raster", tiles: ["https://group.example.com/tile"] },
      }),
      layer("video", { source: { type: "video", urls: ["https://video.example.com/movie.mp4"] } }),
      layer("geojson", {
        geojson: {
          type: "FeatureCollection",
          features: [
            {
              type: "Feature",
              properties: { photo: "https://photos.example.com/private.png" },
              geometry: { type: "Point", coordinates: [0, 0] },
            },
          ],
        },
      }),
    ]);
    saved.basemapStyleUrl = "https://styles.example.com/style.json";
    saved.layerGroups = [{ id: "off", name: "Off", collapsed: false, visible: false, opacity: 1 }];
    saved.layers.find((item) => item.id === "grouped")!.groupId = "off";
    assert.deepEqual(previewOrigins(saved), [
      "https://styles.example.com",
      "https://maps.example.com",
      "https://images.example.com",
      "http://tiles.example.com:8080",
    ]);
    saved.basemapVisible = false;
    assert.equal(previewOrigins(saved).includes("https://styles.example.com"), false);
    saved.basemapVisible = true;
    saved.basemapStyleUrl = "mapbox://styles/mapbox/streets-v12";
    assert.equal(
      previewOrigins(saved).some((origin) => origin.includes("mapbox")),
      false,
    );
  });
});
