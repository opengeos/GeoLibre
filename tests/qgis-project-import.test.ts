import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { strToU8, zipSync } from "fflate";
import { DOMParser } from "linkedom";
import { importQgisProject } from "../apps/geolibre-desktop/src/lib/qgis-project-import";

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
    { id: "cities", name: "Cities", source: "../data/cities.gpkg|layername=cities" },
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
      ${options.extent ?? "<extent><xmin>-125</xmin><ymin>24</ymin><xmax>-66</xmax><ymax>50</ymax></extent>"}
      <destinationsrs><spatialrefsys><authid>${options.authId ?? "EPSG:4326"}</authid></spatialrefsys></destinationsrs>
    </mapcanvas>
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

  it("warns and omits remote and UNC file sources that cannot be restored", () => {
    const result = importQgisProject(
      projectXml({
        dataSources: [
          { id: "roads", name: "Remote", source: "https://example.com/roads.geojson" },
          { id: "cities", name: "Network", source: "\\\\server\\share\\cities.gpkg" },
        ],
      }),
      "C:\\projects\\example.qgs",
    );

    assert.deepEqual(result.project.layers, []);
    assert.deepEqual(
      result.warnings.map((warning) => [warning.layerName, warning.reason]),
      [
        ["Network", "network-path"],
        ["Remote", "remote-file"],
      ],
    );
  });
});
