import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applyGroupEffects } from "@geolibre/core";
import { strToU8, zipSync } from "fflate";
import { DOMParser } from "linkedom";
import { NULL_GEOMETRY } from "./helpers/null-geometry";
import {
  importQgisProject,
  MAX_REMOTE_VECTOR_BYTES,
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

function webLayersProjectXml(): string {
  const layer = (id: string, name: string, source: string, opacity = "1") => `
      <maplayer type="raster">
        <id>${id}</id>
        <layername>${name}</layername>
        <datasource>${source}</datasource>
        <provider>wms</provider>
        <pipe><rasterrenderer type="singlebandcolordata" opacity="${opacity}"/></pipe>
      </maplayer>`;
  return `<qgis version="4.2.3">
    <layer-tree-group>
      <layer-tree-group name="Services" checked="Qt::Checked">
        <layer-tree-layer id="wmts" checked="Qt::Checked"/>
        <layer-tree-layer id="xyz" checked="Qt::Checked"/>
        <layer-tree-layer id="wms" checked="Qt::Unchecked"/>
      </layer-tree-group>
    </layer-tree-group>
    <projectlayers>
      ${layer(
        "wms",
        "OSM WMS (terrestris)",
        "contextualWMSLegend=0&amp;crs=EPSG%3A4326&amp;dpiMode=7&amp;format=image%2Fpng&amp;layers=OSM-WMS&amp;layers=SRTM30-Contour&amp;styles&amp;styles&amp;url=https%3A%2F%2Fows.terrestris.de%2Fosm%2Fservice%3Fservice%3DWMS%26request%3DGetCapabilities",
        "0.5",
      )}
      ${layer(
        "xyz",
        "Topo tiles",
        "type=xyz&amp;url=https://tile.opentopomap.org/%7BZ%7D/%7Bx%7D/%7By%7D.png&amp;zmax=17&amp;zmin=0",
      )}
      ${layer(
        "wmts",
        "Ortho",
        "crs=EPSG:3857&amp;format=image/png&amp;layers=ortho&amp;styles=default&amp;tileMatrixSet=GoogleMapsCompatible&amp;url=https://example.com/wmts",
      )}
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
      ["Transport", "Places"],
    );
    assert.equal(result.project.layerGroups?.[1].parentId, result.project.layerGroups?.[0].id);
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

  it("imports WMS and XYZ layers as tile layers and names what WMTS lacks (#3473)", () => {
    const result = importQgisProject(webLayersProjectXml(), "/work/web.qgs");

    assert.deepEqual(
      result.project.layers.map((layer) => [layer.name, layer.type, layer.visible, layer.opacity]),
      [
        ["OSM WMS (terrestris)", "wms", false, 0.5],
        ["Topo tiles", "xyz", true, 1],
      ],
    );
    const [wms, xyz] = result.project.layers;
    assert.equal(wms.groupId, xyz.groupId);
    assert.ok(wms.groupId);
    assert.equal(wms.sourcePath, undefined);
    assert.equal(wms.source.type, "raster");
    // The capabilities query QGIS kept on the URL is not part of the endpoint.
    assert.equal(wms.source.url, "https://ows.terrestris.de/osm/service");
    assert.equal(wms.source.layers, "OSM-WMS,SRTM30-Contour");
    assert.equal(wms.source.styles, "");
    assert.equal(wms.source.crs, "EPSG:3857");
    const [tile] = wms.source.tiles as string[];
    const query = new URL(tile.replace("{bbox-epsg-3857}", "0,0,1,1")).searchParams;
    assert.equal(query.get("REQUEST"), "GetMap");
    assert.equal(query.get("LAYERS"), "OSM-WMS,SRTM30-Contour");
    assert.equal(query.get("FORMAT"), "image/png");
    assert.equal(query.get("TRANSPARENT"), "TRUE");
    assert.equal(query.get("SRS"), "EPSG:3857");
    assert.match(tile, /BBOX=\{bbox-epsg-3857\}/);

    assert.deepEqual(xyz.source.tiles, ["https://tile.opentopomap.org/{z}/{x}/{y}.png"]);
    assert.equal(xyz.source.minzoom, 0);
    assert.equal(xyz.source.maxzoom, 17);

    assert.deepEqual(result.warnings, [{ layerName: "Ortho", reason: "wmts", provider: "wms" }]);
  });

  it("reads a default view extent stored as attributes when there is no canvas (#3473)", () => {
    const xml = projectXml({ extent: "" })
      .replace(/<mapcanvas>[\s\S]*<\/mapcanvas>/, "")
      .replace(
        "</qgis>",
        `<ProjectViewSettings UseProjectScales="0" rotation="0">
          <DefaultViewExtent xmin="-9349000" ymin="4285000" xmax="-9331000" ymax="4301000">
            <spatialrefsys nativeFormat="Wkt"><authid>EPSG:3857</authid></spatialrefsys>
          </DefaultViewExtent>
        </ProjectViewSettings>
      </qgis>`,
      );
    const { mapView } = importQgisProject(xml, "/work/knoxville.qgs").project;

    assert.ok(mapView.bbox);
    const [west, south, east, north] = mapView.bbox;
    assert.ok(Math.abs(west - -83.9835) < 1e-3, `west ${west}`);
    assert.ok(Math.abs(east - -83.8218) < 1e-3, `east ${east}`);
    assert.ok(Math.abs(south - 35.8864) < 1e-3, `south ${south}`);
    assert.ok(Math.abs(north - 36.0028) < 1e-3, `north ${north}`);
    assert.ok(mapView.zoom > 9, `zoom ${mapView.zoom}`);
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

  it("preserves remote URL credentials when materializing GeoJSON", async () => {
    const remote = importQgisProject(
      projectXml({
        dataSources: [
          {
            id: "roads",
            name: "Remote",
            source:
              '"/vsicurl/https://example.com/roads.geojson?token=secret&amp;version=2"|layername=roads',
          },
        ],
      }),
      "/work/example.qgs",
    );
    const requested: string[] = [];
    await materializeQgisRemoteLayers(remote, async (input) => {
      requested.push(String(input));
      return Response.json({ type: "FeatureCollection", features: [] });
    });

    assert.deepEqual(requested, ["https://example.com/roads.geojson?token=secret&version=2"]);
  });

  it("rejects UNC file URLs", () => {
    const unc = importQgisProject(
      projectXml({
        dataSources: [
          {
            id: "cities",
            name: "Network file URL",
            source: "file://server/share/cities.gpkg",
          },
        ],
      }),
      "C:\\projects\\example.qgs",
    );
    assert.deepEqual(unc.project.layers, []);
    assert.deepEqual(
      unc.warnings.map((warning) => [warning.layerName, warning.reason]),
      [["Network file URL", "network-path"]],
    );
  });

  it("inherits visibility from unchecked parent groups", () => {
    const xml = projectXml().replace(
      'name="Transport" checked="Qt::Checked"',
      'name="Transport" checked="Qt::Unchecked"',
    );
    const result = importQgisProject(xml, "/work/example.qgs");

    assert.deepEqual(
      result.project.layerGroups?.map((group) => [group.name, group.visible]),
      [
        ["Transport", false],
        ["Places", false],
      ],
    );
    const rendered = applyGroupEffects(result.project.layers, result.project.layerGroups ?? []);
    assert.equal(rendered.find((layer) => layer.name === "Cities")?.visible, false);
  });

  it("ignores the frozen layer trees inside Print Layout legends", () => {
    const legend = (name: string, entries: string) => `
      <Layout name="${name}" units="mm">
        <LayoutItem type="65642" autoUpdateModel="0">
          <layer-tree-group name="" checked="Qt::Checked">${entries}</layer-tree-group>
        </LayoutItem>
      </Layout>`;
    const xml = projectXml().replace(
      "</qgis>",
      `<Layouts>
        ${legend(
          "Baseline",
          `<layer-tree-layer id="roads" checked="Qt::Checked"/>
           <layer-tree-layer id="cities" checked="Qt::Unchecked"/>`,
        )}
        ${legend("Proposed", '<layer-tree-layer id="cities" checked="Qt::Unchecked"/>')}
        ${legend("Stale template", '<layer-tree-layer id="deleted" checked="Qt::Checked"/>')}
      </Layouts></qgis>`,
    );
    const result = importQgisProject(xml, "/work/example.qgs");

    assert.deepEqual(
      result.project.layers.map((layer) => [layer.id, layer.name, layer.visible]),
      [
        ["cities", "Cities", true],
        ["roads", "Roads", false],
      ],
    );
  });

  it("normalizes Windows file URLs, query strings, encoded delimiters, and bare names", () => {
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

    const encoded = importQgisProject(
      projectXml({
        dataSources: [
          { id: "roads", name: "Encoded delimiter", source: "file:///tmp/a%23b.geojson" },
        ],
      }),
      "/work/example.qgs",
    );
    assert.equal(encoded.project.layers[0].sourcePath, "/tmp/a#b.geojson");

    const malformed = importQgisProject(
      projectXml({
        dataSources: [
          { id: "roads", name: "Malformed escape", source: "file://C:/data%zz/roads.geojson" },
        ],
      }),
      "C:\\projects\\example.qgs",
    );
    assert.equal(malformed.project.layers[0].sourcePath, "C:/data%zz/roads.geojson");

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

  it("sizes a categorized marker like the same single-symbol marker (#3450)", () => {
    // Real QGIS files wrap a symbol layer's options in <Option type="Map">, which the classified
    // path's QML reader requires.
    const singleXml = projectXml()
      .replaceAll('<layer class="SimpleMarker">', '<layer class="SimpleMarker"><Option type="Map">')
      .replaceAll("</layer></symbol>", "</Option></layer></symbol>");
    const categorizedXml = singleXml
      .replaceAll(
        '<renderer-v2 type="singleSymbol">',
        `<renderer-v2 type="categorizedSymbol" attr="kind"><categories>
          <category value="a" symbol="0" label="A" render="true"/>
        </categories>`,
      )
      .replaceAll("<symbols><symbol>", '<symbols><symbol type="marker" name="0">');
    const single = importQgisProject(singleXml, "/work/example.qgs").project.layers[0].style;
    const categorized = importQgisProject(categorizedXml, "/work/example.qgs").project.layers[0]
      .style;
    assert.equal(categorized.vectorStyleMode, "categorized");
    // A 4 mm marker: 4 × 3.78 px across, half that as a radius.
    assert.ok(Math.abs((single.circleRadius ?? 0) - 7.56) < 0.01, `single ${single.circleRadius}`);
    assert.ok(
      Math.abs((categorized.circleRadius ?? 0) - 7.56) < 0.01,
      `categorized ${categorized.circleRadius}`,
    );
  });

  it("rejects oversized QGS members before decompressing them", () => {
    const oversized = zipSync({
      "project.qgs": new Uint8Array(25 * 1024 * 1024 + 1),
    });
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
      [["Bad", "remote-unreadable"]],
    );
  });

  it("reads remote non-GeoJSON files through the host reader (#3473)", async () => {
    const result = importQgisProject(
      projectXml({
        dataSources: [
          {
            id: "roads",
            name: "Countries",
            source: "/vsicurl/https://example.com/data/world_countries.parquet",
          },
          {
            id: "cities",
            name: "Sites",
            source: "/vsicurl/https://example.com/data/sites.gpkg|layername=field_sites",
          },
        ],
      }),
      "/work/example.qgs",
    );
    const reads: Array<[string, string, number, string | undefined]> = [];
    await materializeQgisRemoteLayers(
      result,
      async () => new Response(new Uint8Array([1, 2, 3])),
      async (file) => {
        reads.push([file.name, file.extension, file.data.byteLength, file.sourceLayer]);
        return {
          type: "FeatureCollection",
          features: [{ type: "Feature", geometry: NULL_GEOMETRY, properties: { name: file.name } }],
        };
      },
    );

    assert.deepEqual(reads.sort(), [
      ["sites.gpkg", "gpkg", 3, "field_sites"],
      ["world_countries.parquet", "parquet", 3, undefined],
    ]);
    assert.deepEqual(
      result.project.layers.map((layer) => [layer.name, layer.geojson?.features.length]),
      [
        ["Sites", 1],
        ["Countries", 1],
      ],
    );
    assert.deepEqual(result.warnings, []);
  });

  it("reports a remote non-GeoJSON file as unreadable without a host reader", async () => {
    const result = importQgisProject(
      projectXml({
        dataSources: [
          { id: "roads", name: "Countries", source: "https://example.com/world.parquet" },
        ],
      }),
      "/work/example.qgs",
    );
    let fetched = false;
    await materializeQgisRemoteLayers(result, async () => {
      fetched = true;
      return new Response("");
    });

    assert.equal(fetched, false);
    assert.deepEqual(result.project.layers, []);
    assert.deepEqual(
      result.warnings.map((warning) => [warning.layerName, warning.reason]),
      [["Countries", "remote-unreadable"]],
    );
  });

  it("refuses a remote non-GeoJSON file larger than the import ceiling", async () => {
    const result = importQgisProject(
      projectXml({
        dataSources: [
          { id: "roads", name: "Countries", source: "https://example.com/world.parquet" },
        ],
      }),
      "/work/example.qgs",
    );
    let read = false;
    await materializeQgisRemoteLayers(
      result,
      async () =>
        new Response("x", {
          headers: { "content-length": String(MAX_REMOTE_VECTOR_BYTES + 1) },
        }),
      async () => {
        read = true;
        return { type: "FeatureCollection", features: [] };
      },
    );

    assert.equal(read, false);
    assert.deepEqual(
      result.warnings.map((warning) => [warning.layerName, warning.reason]),
      [["Countries", "remote-unreadable"]],
    );
  });

  it("reads an extensionless remote endpoint as GeoJSON without the host reader", async () => {
    const result = importQgisProject(
      projectXml({
        dataSources: [{ id: "roads", name: "Items", source: "https://example.com/items.geojson" }],
      }),
      "/work/example.qgs",
    );
    // The parser only imports sources with a known extension; a caller that
    // hands over an extensionless endpoint still gets it read as GeoJSON.
    result.project.layers[0].sourcePath = "https://example.com/api/items?f=json";
    await materializeQgisRemoteLayers(
      result,
      async () =>
        Response.json({
          type: "FeatureCollection",
          features: [{ type: "Feature", geometry: null, properties: {} }],
        }),
      async () => {
        throw new Error("the host reader must not be asked");
      },
    );

    assert.deepEqual(result.warnings, []);
    assert.equal(result.project.layers[0]?.geojson?.features.length, 1);
  });

  it("stops reading a remote body that passes the ceiling without a length", async () => {
    const result = importQgisProject(
      projectXml({
        dataSources: [
          { id: "roads", name: "Countries", source: "https://example.com/world.parquet" },
        ],
      }),
      "/work/example.qgs",
    );
    const chunk = new Uint8Array(64 * 1024 * 1024);
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        sent += 1;
        controller.enqueue(chunk);
      },
    });
    await materializeQgisRemoteLayers(
      result,
      async () => new Response(body),
      async () => ({ type: "FeatureCollection", features: [] }),
    );

    assert.ok(sent <= 6, `read ${sent} chunks`);
    assert.deepEqual(
      result.warnings.map((warning) => [warning.layerName, warning.reason]),
      [["Countries", "remote-unreadable"]],
    );
  });

  it("downloads non-GeoJSON files one at a time", async () => {
    const result = importQgisProject(
      projectXml({
        dataSources: [
          { id: "roads", name: "A", source: "https://example.com/a.parquet" },
          { id: "cities", name: "B", source: "https://example.com/b.parquet" },
        ],
      }),
      "/work/example.qgs",
    );
    let active = 0;
    let peak = 0;
    await materializeQgisRemoteLayers(
      result,
      async () => {
        active += 1;
        peak = Math.max(peak, active);
        return new Response(new Uint8Array([1]));
      },
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        return { type: "FeatureCollection", features: [] };
      },
    );

    assert.equal(peak, 1);
    assert.equal(result.project.layers.length, 2);
  });
});
