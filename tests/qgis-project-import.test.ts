import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { strToU8, zipSync } from "fflate";
import { DOMParser } from "linkedom";
import {
  importQgisProject,
  materializeQgisRemoteLayers,
} from "../apps/geolibre-desktop/src/lib/qgis-project-import";

globalThis.DOMParser = DOMParser as unknown as typeof globalThis.DOMParser;

function projectXml(
  options: {
    authId?: string;
    extent?: string;
    dataSources?: Array<{ id: string; name: string; source: string }>;
  } = {},
): string {
  const dataSources = options.dataSources ?? [
    { id: "roads", name: "Roads", source: "../data/roads.geojson" },
    {
      id: "cities",
      name: "Cities",
      source: "../data/cities.gpkg|layername=cities",
    },
  ];
  const mapLayers = dataSources
    .map(
      ({ id, name, source }) => `
        <maplayer type="vector">
          <id>${id}</id>
          <layername>${name}</layername>
          <datasource>${source}</datasource>
          <provider>ogr</provider>
          <layerOpacity>0.75</layerOpacity>
          <renderer-v2 type="singleSymbol">
            <symbols><symbol><layer class="SimpleMarker">
              <Option name="color" value="255,0,0,128"/>
              <Option name="outline_color" value="0,0,0,255"/>
              <Option name="size" value="4"/>
            </layer></symbol></symbols>
          </renderer-v2>
          <labeling type="simple">
            <settings><text-style fieldName="name" fontSize="12"/></settings>
          </labeling>
        </maplayer>`,
    )
    .join("");

  return `<qgis version="3.40.0">
    <title>Imported map</title>
    <layer-tree-group name="" checked="Qt::Checked">
      <layer-tree-group name="Transport" checked="Qt::Checked">
        <layer-tree-layer id="roads" checked="Qt::Unchecked"/>
        <layer-tree-group name="Places" checked="Qt::Checked">
          <layer-tree-layer id="cities" checked="Qt::Checked"/>
        </layer-tree-group>
      </layer-tree-group>
    </layer-tree-group>
    <projectlayers>${mapLayers}</projectlayers>
    <mapcanvas>
      ${
        options.extent ??
        "<extent><xmin>-125</xmin><ymin>24</ymin><xmax>-66</xmax><ymax>50</ymax></extent>"
      }
      <destinationsrs><spatialrefsys><authid>${
        options.authId ?? "EPSG:4326"
      }</authid></spatialrefsys></destinationsrs>
    </mapcanvas>
  </qgis>`;
}

function rasterProjectXml(source = "../data/dem.tif"): string {
  return `<qgis version="3.44.0">
    <layer-tree-group>
      <layer-tree-layer id="dem" checked="Qt::Unchecked"/>
    </layer-tree-group>
    <projectlayers>
      <maplayer type="raster">
        <id>dem</id>
        <layername>Elevation</layername>
        <datasource>${source}</datasource>
        <provider>gdal</provider>
        <layerOpacity>0.6</layerOpacity>
        <pipe>
          <rasterrenderer type="singlebandpseudocolor" band="1">
            <rastershader>
              <colorrampshader minimumValue="61.42" maximumValue="1524.33">
                <colorramp type="gradient">
                  <Option name="color1" value="48,18,59,255"/>
                  <Option name="color2" value="122,4,3,255"/>
                </colorramp>
              </colorrampshader>
            </rastershader>
          </rasterrenderer>
          <brightnesscontrast gamma="1.2"/>
        </pipe>
      </maplayer>
    </projectlayers>
  </qgis>`;
}

function osmBasemapProjectXml(): string {
  return `<qgis version="3.44.0">
    <layer-tree-group>
      <layer-tree-layer id="osm" checked="Qt::Unchecked"/>
    </layer-tree-group>
    <projectlayers>
      <maplayer type="raster">
        <id>osm</id>
        <layername>OpenStreetMap</layername>
        <datasource>crs=EPSG:3857&amp;type=xyz&amp;url=https://tile.openstreetmap.org/%7Bz%7D/%7Bx%7D/%7By%7D.png&amp;zmax=19</datasource>
        <provider>wms</provider>
        <layerOpacity>0.7</layerOpacity>
      </maplayer>
    </projectlayers>
  </qgis>`;
}

describe("QGIS project import", () => {
  it("imports vector layers, styles, visibility, nested groups, extent, and relative paths", () => {
    const result = importQgisProject(projectXml(), "/work/projects/example.qgs");

    assert.equal(result.project.name, "Imported map");
    assert.deepEqual(result.project.mapView.center, [-95.5, 37]);
    assert.deepEqual(
      result.project.layerGroups?.map((group) => group.name),
      ["Transport", "Transport / Places"],
    );
    assert.deepEqual(
      result.project.layers.map((layer) => layer.name),
      ["Cities", "Roads"],
    );

    const cities = result.project.layers[0];
    const roads = result.project.layers[1];
    assert.equal(cities.sourcePath, "/work/data/cities.gpkg");
    assert.equal(cities.groupId, result.project.layerGroups?.[1].id);
    assert.equal(cities.opacity, 0.75);
    assert.equal(cities.style.fillColor, "#ff0000");
    assert.equal(cities.style.fillOpacity, 128 / 255);
    assert.equal(cities.style.labels.enabled, true);
    assert.equal(cities.style.labels.field, "name");
    assert.equal(roads.visible, false);
    assert.equal(roads.groupId, result.project.layerGroups?.[0].id);
    assert.deepEqual(result.warnings, []);
  });

  it("reads the QGS document from a QGZ archive", () => {
    const qgz = zipSync({ "nested/project.qgs": strToU8(projectXml()) });
    const result = importQgisProject(qgz, "/work/projects/example.qgz");
    assert.equal(result.project.name, "Imported map");
    assert.equal(result.project.layers.length, 2);
    assert.deepEqual(result.rasters, []);
  });

  it("collects local GDAL GeoTIFFs for the desktop raster loader", () => {
    const result = importQgisProject(rasterProjectXml(), "/work/projects/example.qgz");

    assert.deepEqual(result.project.layers, []);
    assert.deepEqual(result.rasters, [
      {
        id: "dem",
        name: "Elevation",
        sourcePath: "/work/data/dem.tif",
        visible: false,
        opacity: 0.6,
        state: {
          mode: "single",
          bands: [1],
          colormap: "turbo",
          gamma: 1.2,
          rescale: [[61.42, 1524.33]],
          reversed: false,
        },
      },
    ]);
    assert.deepEqual(result.warnings, []);
  });

  it("maps QGIS OpenStreetMap XYZ layers to the built-in basemap", () => {
    const result = importQgisProject(osmBasemapProjectXml(), "/work/example.qgs");

    assert.equal(result.project.basemapStyleUrl, "https://tiles.openfreemap.org/styles/liberty");
    assert.equal(result.project.basemapVisible, false);
    assert.equal(result.project.basemapOpacity, 0.7);
    assert.deepEqual(result.project.layers, []);
    assert.deepEqual(result.rasters, []);
    assert.deepEqual(result.warnings, []);
  });

  it("falls back to the default view for a missing or unsupported-CRS extent", () => {
    const missing = importQgisProject(projectXml({ extent: "" }), "/work/example.qgs");
    assert.deepEqual(missing.project.mapView, {
      center: [-100, 40],
      zoom: 2,
      bearing: 0,
      pitch: 0,
    });

    const projected = importQgisProject(projectXml({ authId: "EPSG:32618" }), "/work/example.qgs");
    assert.deepEqual(projected.project.mapView, {
      center: [-100, 40],
      zoom: 2,
      bearing: 0,
      pitch: 0,
    });
  });

  it("normalizes GDAL VSI URLs and still rejects UNC file sources", () => {
    const result = importQgisProject(
      projectXml({
        dataSources: [
          {
            id: "roads",
            name: "Remote",
            source: "/vsicurl/https://example.com/roads.geojson|layername=roads",
          },
          {
            id: "cities",
            name: "Network",
            source: "\\\\server\\share\\cities.gpkg",
          },
        ],
      }),
      "C:\\projects\\example.qgs",
    );

    assert.equal(result.project.layers.length, 1);
    assert.equal(result.project.layers[0].sourcePath, "https://example.com/roads.geojson");
    assert.equal(result.project.layers[0].source.url, "https://example.com/roads.geojson");
    assert.equal(result.project.layers[0].metadata.localFileReloadable, undefined);
    assert.deepEqual(
      result.warnings.map((warning) => [warning.layerName, warning.reason]),
      [["Network", "network-path"]],
    );
  });

  it("normalizes Windows file URLs, query strings, and bare project names", () => {
    const windows = importQgisProject(
      projectXml({
        dataSources: [
          {
            id: "roads",
            name: "CSV",
            source: "file:///C:/data/points.csv?delimiter=%2C",
          },
        ],
      }),
      "C:\\projects\\example.qgs",
    );
    assert.equal(windows.project.layers[0].sourcePath, "C:/data/points.csv");

    const browser = importQgisProject(
      projectXml({
        dataSources: [{ id: "roads", name: "Roads", source: "data/roads.geojson" }],
      }),
      "example.qgs",
    );
    assert.equal(browser.project.layers[0].sourcePath, "data/roads.geojson");
  });

  it("does not silently flatten categorized styling or mis-scale pixel units", () => {
    const xml = projectXml().replaceAll(
      '<renderer-v2 type="singleSymbol">',
      '<renderer-v2 type="categorizedSymbol">',
    );
    const categorized = importQgisProject(xml, "/work/example.qgs");
    assert.notEqual(categorized.project.layers[0].style.fillColor, "#ff0000");

    const pixelXml = projectXml().replaceAll(
      '<Option name="size" value="4"/>',
      '<Option name="size" value="4"/><Option name="size_unit" value="Pixel"/>',
    );
    const pixel = importQgisProject(pixelXml, "/work/example.qgs");
    assert.equal(pixel.project.layers[0].style.circleRadius, 2);
  });

  it("rejects oversized QGS members before decompressing them", () => {
    const oversized = zipSync({ "project.qgs": new Uint8Array(25 * 1024 * 1024 + 1) });
    assert.throws(
      () => importQgisProject(oversized, "/work/example.qgz"),
      /too large to import safely/,
    );
  });

  it("materializes remote GeoJSON and warns when a remote response cannot be loaded", async () => {
    const result = importQgisProject(
      projectXml({
        dataSources: [
          {
            id: "roads",
            name: "Good",
            source: "https://example.com/good.geojson",
          },
          {
            id: "cities",
            name: "Bad",
            source: "https://example.com/bad.geojson",
          },
        ],
      }),
      "/work/example.qgs",
    );

    await materializeQgisRemoteLayers(result, async (input) => {
      const url = String(input);
      if (url.endsWith("/bad.geojson")) return new Response("no", { status: 404 });
      return Response.json({
        type: "FeatureCollection",
        features: [{ type: "Feature", geometry: null, properties: { name: "Test" } }],
      });
    });

    assert.equal(result.project.layers.length, 1);
    assert.equal(result.project.layers[0].name, "Good");
    assert.equal(result.project.layers[0].geojson?.features.length, 1);
    assert.deepEqual(
      result.project.layerGroups?.map((group) => group.name),
      ["Transport"],
    );
    assert.deepEqual(
      result.warnings.map((warning) => [warning.layerName, warning.reason]),
      [["Bad", "remote-file"]],
    );
  });
});
