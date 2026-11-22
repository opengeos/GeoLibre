import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import { DEFAULT_LAYER_STYLE } from "@geolibre/core";
import { strToU8, zipSync } from "fflate";
import {
  countArcgisUnloadedLayers,
  dropArcgisImportLayers,
  importArcgisProject,
  readArcgisProject,
} from "../apps/geolibre-desktop/src/lib/arcgis-project-import";
import { aprx, groupLayer, hostedFeatureLayer } from "./helpers/arcgis-aprx-fixtures";
import { loadArcgisFileGeodatabaseLayers } from "../apps/geolibre-desktop/src/lib/arcgis-gdb-import";
import { useAppStore, withoutHistory } from "../packages/core/src/store";
import { geojsonLayer } from "./helpers/layer-fixtures";

function featureLayer(name: string, path: string) {
  return {
    type: "CIMFeatureLayer",
    name,
    uRI: `CIMPATH=Layers/${name}.lyrx`,
    visibility: true,
    featureTable: {
      dataConnection: {
        type: "CIMStandardDataConnection",
        workspaceFactory: "Shapefile",
        workspaceConnectionString: `DATABASE=${path}`,
        dataset: name.toLowerCase(),
      },
    },
    renderer: {
      type: "CIMSimpleRenderer",
      symbol: {
        type: "CIMSymbolReference",
        symbol: {
          type: "CIMPointSymbol",
          symbolLayers: [
            {
              type: "CIMVectorMarker",
              size: 9,
              color: { type: "CIMRGBColor", values: [10, 20, 30, 80] },
              // ArcGIS Pro's circle: one curve ring, one arc back to its start.
              markerGraphics: [
                {
                  geometry: { curveRings: [[[0, 5], { a: [[0, 5], [0, 0], 0, 1] }]] },
                  symbol: {
                    type: "CIMPolygonSymbol",
                    symbolLayers: [
                      {
                        type: "CIMSolidFill",
                        enable: true,
                        color: { type: "CIMRGBColor", values: [10, 20, 30, 80] },
                      },
                    ],
                  },
                },
              ],
            },
          ],
        },
      },
    },
    labelVisibility: true,
    labelClasses: [{ expression: "[NAME]" }],
  };
}

describe("ArcGIS Pro project import", () => {
  it("imports MAPX groups, extent, styles, labels, visibility, and paths", () => {
    const mapx = {
      type: "CIMMapDocument",
      mapDefinition: {
        type: "CIMMap",
        name: "City map",
        mapType: "Map",
        defaultExtent: {
          xmin: -80,
          ymin: 30,
          xmax: -70,
          ymax: 40,
          spatialReference: { wkid: 4326 },
        },
        layerDefinitions: [
          {
            type: "CIMGroupLayer",
            name: "Places",
            visibility: false,
            layerDefinitions: [featureLayer("Cities", "../data")],
          },
        ],
      },
    };

    const result = importArcgisProject(JSON.stringify(mapx), "/work/projects/city.mapx");
    assert.equal(result.project.name, "City map");
    assert.deepEqual(result.project.mapView.center, [-75, 35]);
    assert.equal(result.project.layerGroups?.[0].name, "Places");
    // The hidden group keeps its own flag; the child keeps *its* own. Ancestor
    // visibility is folded in later by applyGroupEffects, so re-enabling the
    // group must bring the child back rather than leaving it stuck hidden.
    assert.equal(result.project.layerGroups?.[0].visible, false);
    assert.equal(result.project.layers[0].visible, true);
    assert.equal(result.project.layers[0].sourcePath, "/work/data/cities.shp");
    assert.equal(result.project.layers[0].style.fillColor, "#0a141e");
    assert.equal(result.project.layers[0].style.fillOpacity, 0.8);
    assert.equal(result.project.layers[0].style.labels.enabled, true);
    assert.equal(result.project.layers[0].style.labels.field, "NAME");
    assert.deepEqual(result.warnings, []);
  });

  it("reads map and layer CIM documents from an APRX archive", () => {
    const archive = zipSync({
      "GISProject.json": strToU8(
        JSON.stringify({
          projectItems: [
            {
              type: "CIMProjectItem",
              itemType: "Map",
              catalogPath: "CIMPATH=Maps/Main.json",
            },
          ],
        }),
      ),
      "Maps/Main.json": strToU8(
        JSON.stringify({
          type: "CIMMap",
          name: "Main",
          layers: ["CIMPATH=Layers/Roads.lyrx"],
        }),
      ),
      "Layers/Roads.lyrx": strToU8(JSON.stringify(featureLayer("Roads", "C:\\data"))),
    });

    const result = importArcgisProject(archive, "C:\\projects\\main.aprx");
    assert.equal(result.project.name, "Main");
    assert.equal(result.project.layers[0].sourcePath, "C:/data/roads.shp");
    assert.equal(result.project.metadata.importedFrom, "arcgis-pro");
    assert.deepEqual(result.rasters, []);
    assert.deepEqual(result.services, []);
  });

  it("lists every 2D map in project order and imports the one chosen", () => {
    const mapItem = (name: string) => ({
      type: "CIMProjectItem",
      itemType: "Map",
      catalogPath: `CIMPATH=Maps/${name}.json`,
    });
    // Detail is stored ahead of Overview: the catalogue, not archive order, sets the order.
    const archive = zipSync({
      "GISProject.json": strToU8(
        JSON.stringify({
          projectItems: [mapItem("Overview"), mapItem("Terrain"), mapItem("Detail")],
        }),
      ),
      "Maps/Detail.json": strToU8(
        JSON.stringify({
          type: "CIMMap",
          name: "Detail",
          layers: ["CIMPATH=Layers/Parks.lyrx"],
        }),
      ),
      "Maps/Terrain.json": strToU8(
        JSON.stringify({
          type: "CIMMap",
          name: "Terrain",
          mapType: "Scene",
          layers: [],
        }),
      ),
      "Maps/Overview.json": strToU8(
        JSON.stringify({
          type: "CIMMap",
          name: "Overview",
          layers: ["CIMPATH=Layers/Roads.lyrx"],
        }),
      ),
      "Layers/Roads.lyrx": strToU8(JSON.stringify(featureLayer("Roads", "C:\\data"))),
      "Layers/Parks.lyrx": strToU8(JSON.stringify(featureLayer("Parks", "C:\\data"))),
    });

    const reader = readArcgisProject(archive, "C:\\projects\\city.aprx");
    // The scene is left out; the 2D maps keep the project's order.
    assert.deepEqual(reader.maps, [
      { index: 0, name: "Overview" },
      { index: 1, name: "Detail" },
    ]);
    const detail = reader.importMap(1);
    assert.equal(detail.project.name, "Detail");
    assert.deepEqual(
      detail.project.layers.map((layer) => layer.name),
      ["Parks"],
    );
    // Without a choice the first 2D map is imported, as before.
    assert.equal(importArcgisProject(archive, "C:\\projects\\city.aprx").project.name, "Overview");
    assert.throws(() => reader.importMap(2), /no such map/);
  });

  it("offers no choice for a MAPX or a project with one 2D map", () => {
    const mapx = {
      type: "CIMMapDocument",
      mapDefinition: { type: "CIMMap", name: "Solo" },
    };
    assert.deepEqual(readArcgisProject(JSON.stringify(mapx), "/work/solo.mapx").maps, [
      { index: 0, name: "Solo" },
    ]);

    const archive = zipSync({
      "Maps/Scene.json": strToU8(
        JSON.stringify({ type: "CIMMap", name: "Scene", mapType: "Scene" }),
      ),
      "Maps/Main.json": strToU8(JSON.stringify({ type: "CIMMap", name: "Main" })),
      "Maps/Links.json": strToU8(
        JSON.stringify({ type: "CIMMap", name: "Links", mapType: "LinkChart" }),
      ),
      "Maps/Basemap.json": strToU8(
        JSON.stringify({ type: "CIMMap", name: "Basemap", mapType: "Basemap" }),
      ),
      "Layers/Imagery.json": strToU8(JSON.stringify({ type: "CIMMapImageLayer", name: "Imagery" })),
    });
    // With no project catalogue every map document is considered, but only a
    // plain map is offered: not a scene, link chart, basemap or map-service layer.
    assert.deepEqual(readArcgisProject(archive, "/work/main.aprx").maps, [
      { index: 0, name: "Main" },
    ]);
  });

  it("refuses a project whose only map is a scene", () => {
    const archive = zipSync({
      "Maps/Scene.json": strToU8(
        JSON.stringify({ type: "CIMMap", name: "Scene", mapType: "Scene" }),
      ),
    });
    assert.throws(
      () => readArcgisProject(archive, "/work/scene.aprx"),
      /does not contain an ArcGIS Pro map/,
    );
  });

  it("imports local rasters and cached map services", () => {
    const mapx = {
      type: "CIMMapDocument",
      mapDefinition: {
        type: "CIMMap",
        defaultExtent: {
          xmin: -80,
          ymin: 30,
          xmax: -70,
          ymax: 40,
          spatialReference: { wkid: 4326 },
        },
        layerDefinitions: [
          {
            type: "CIMRasterLayer",
            name: "Elevation",
            visibility: false,
            dataConnection: {
              workspaceConnectionString: "DATABASE=../rasters",
              dataset: "dem.tif",
            },
          },
          {
            type: "CIMVectorTileLayer",
            name: "Basemap",
            sourceURI: "79a4630cf75d49bba0d54d85030ba338",
          },
          {
            type: "CIMTiledServiceLayer",
            name: "Hillshade",
            serviceConnection: {
              objectType: "MapServer",
              url: "https://example.com/arcgis/rest/services/Hillshade/MapServer",
            },
          },
        ],
      },
    };
    const result = importArcgisProject(JSON.stringify(mapx), "/work/projects/main.mapx");
    assert.deepEqual(result.rasters, [
      {
        id: "elevation",
        name: "Elevation",
        sourcePath: "/work/rasters/dem.tif",
        visible: false,
        opacity: 1,
      },
    ]);
    assert.equal(result.project.layers[0].type, "xyz");
    assert.deepEqual(result.project.layers[0].source.tiles, [
      "https://example.com/arcgis/rest/services/Hillshade/MapServer/tile/{z}/{y}/{x}",
    ]);
    assert.deepEqual(result.services, [
      {
        kind: "vector-tile",
        id: "basemap",
        name: "Basemap",
        itemId: "79a4630cf75d49bba0d54d85030ba338",
        visible: true,
      },
    ]);
    // ArcGIS Pro lists Elevation on top; the store order is bottom first.
    assert.deepEqual(result.layerOrder, ["hillshade", "basemap", "elevation"]);
    assert.deepEqual(result.warnings, []);
  });

  it("reports unsupported services, file geodatabases, and layer types", () => {
    const mapx = {
      type: "CIMMapDocument",
      mapDefinition: {
        type: "CIMMap",
        defaultExtent: {
          xmin: -80,
          ymin: 30,
          xmax: -70,
          ymax: 40,
          spatialReference: { wkid: 4326 },
        },
        layerDefinitions: [
          {
            ...featureLayer("Hosted", ""),
            featureTable: {
              dataConnection: { url: "https://example.com/FeatureServer/0" },
            },
          },
          {
            ...featureLayer("Parcels", ""),
            featureTable: {
              dataConnection: {
                workspaceFactory: "FileGDB",
                workspaceConnectionString: "DATABASE=C:\\data\\city.gdb",
                dataset: "parcels",
              },
            },
          },
          { type: "CIMAnnotationLayer", name: "Labels" },
        ],
      },
    };
    const result = importArcgisProject(JSON.stringify(mapx), "C:\\projects\\main.mapx");
    assert.deepEqual(
      result.warnings.map((warning) => [warning.layerName, warning.reason]),
      [
        ["Hosted", "service"],
        // Distinct from a plain "format" so a .gdb-backed project, where every
        // layer fails this way, says which format that was (GeoLibre#1904).
        ["Parcels", "file-geodatabase"],
        ["Labels", "layer-type"],
      ],
    );
  });

  it("reports a geodatabase raster as a geodatabase, not a bad format", () => {
    const mapx = {
      type: "CIMMap",
      name: "Elevation",
      defaultExtent: { xmin: -80, ymin: 30, xmax: -70, ymax: 40, spatialReference: { wkid: 4326 } },
      layerDefinitions: [
        {
          type: "CIMRasterLayer",
          name: "DEM",
          dataConnection: {
            workspaceFactory: "FileGDB",
            workspaceConnectionString: "DATABASE=C:\\data\\terrain.gdb",
            dataset: "dem",
          },
        },
      ],
    };
    const result = importArcgisProject(JSON.stringify(mapx), "C:\\projects\\main.mapx");
    assert.deepEqual(
      result.warnings.map((warning) => [warning.layerName, warning.reason]),
      // Its own reason, not the feature-class one: the desktop File
      // Geodatabase source that reason points at lists only feature classes
      // with geometry, so a raster must not be sent there.
      [["DEM", "file-geodatabase-raster"]],
    );
  });

  it("still loads a GeoTIFF from a plain folder whose name ends in .gdb", () => {
    // The workspace suffix is a last resort, not a short circuit: a readable
    // dataset wins over a folder that merely looks like a geodatabase. ArcGIS
    // reserves .gdb for real geodatabases, so this is unlikely -- but the
    // suffix check must not cost a raster that would otherwise have loaded.
    const mapx = {
      type: "CIMMap",
      name: "Elevation",
      defaultExtent: { xmin: -80, ymin: 30, xmax: -70, ymax: 40, spatialReference: { wkid: 4326 } },
      layerDefinitions: [
        {
          type: "CIMRasterLayer",
          name: "DEM",
          dataConnection: {
            workspaceConnectionString: "DATABASE=C:\\data\\rasters.gdb",
            dataset: "dem.tif",
          },
        },
      ],
    };
    const result = importArcgisProject(JSON.stringify(mapx), "C:\\projects\\main.mapx");
    assert.deepEqual(result.warnings, []);
    assert.equal(result.rasters[0].sourcePath, "C:/data/rasters.gdb/dem.tif");
  });

  it("reports a geodatabase raster with no dataset name as a geodatabase", () => {
    // The geodatabase check deliberately precedes the missing-dataset guard,
    // so this matches what the vector resolver already did for the same
    // connection. "It is a geodatabase" is the actionable half; the absent
    // dataset name would not change what the user has to do.
    const mapx = {
      type: "CIMMap",
      name: "Elevation",
      defaultExtent: { xmin: -80, ymin: 30, xmax: -70, ymax: 40, spatialReference: { wkid: 4326 } },
      layerDefinitions: [
        {
          type: "CIMRasterLayer",
          name: "DEM",
          dataConnection: { workspaceConnectionString: "DATABASE=C:\\data\\terrain.gdb" },
        },
      ],
    };
    const result = importArcgisProject(JSON.stringify(mapx), "C:\\projects\\main.mapx");
    assert.deepEqual(
      result.warnings.map((warning) => [warning.layerName, warning.reason]),
      [["DEM", "file-geodatabase-raster"]],
    );
  });

  it("recognizes a geodatabase by its workspace path when no factory names one", () => {
    // Not every connection reports a workspaceFactory, so a .gdb workspace has
    // to be enough on its own -- otherwise these fall back to a bare "format"
    // and the user is told nothing about which format that was.
    const mapx = {
      type: "CIMMap",
      name: "Survey",
      defaultExtent: { xmin: -80, ymin: 30, xmax: -70, ymax: 40, spatialReference: { wkid: 4326 } },
      layerDefinitions: [
        {
          ...featureLayer("Parcels", ""),
          featureTable: {
            dataConnection: {
              workspaceConnectionString: "DATABASE=C:\\data\\city.gdb",
              dataset: "parcels",
            },
          },
        },
        {
          type: "CIMRasterLayer",
          name: "DEM",
          dataConnection: {
            workspaceConnectionString: "DATABASE=C:\\data\\city.gdb",
            dataset: "dem",
          },
        },
      ],
    };
    const result = importArcgisProject(JSON.stringify(mapx), "C:\\projects\\main.mapx");
    assert.deepEqual(
      result.warnings.map((warning) => [warning.layerName, warning.reason]),
      [
        ["Parcels", "file-geodatabase"],
        ["DEM", "file-geodatabase-raster"],
      ],
    );
  });

  it("keeps a nested layer's own visibility instead of the cascaded value", () => {
    // A visible layer inside a hidden group inside a visible group: every level
    // must store only its own toggle, or re-enabling "Hidden" in the UI would
    // leave "Wells" hidden forever.
    const mapx = {
      type: "CIMMap",
      name: "Nested",
      defaultExtent: { xmin: -80, ymin: 30, xmax: -70, ymax: 40, spatialReference: { wkid: 4326 } },
      layerDefinitions: [
        {
          type: "CIMGroupLayer",
          name: "Outer",
          visibility: true,
          layerDefinitions: [
            {
              type: "CIMGroupLayer",
              name: "Hidden",
              visibility: false,
              layerDefinitions: [featureLayer("Wells", "../data")],
            },
          ],
        },
      ],
    };
    const result = importArcgisProject(JSON.stringify(mapx), "/work/projects/nested.mapx");
    const groups = new Map(result.project.layerGroups?.map((group) => [group.name, group]));
    assert.equal(groups.get("Outer")?.visible, true);
    assert.equal(groups.get("Hidden")?.visible, false);
    assert.equal(result.project.layers[0].name, "Wells");
    assert.equal(result.project.layers[0].visible, true);
  });

  it("warns when the saved extent uses a coordinate system it cannot convert", () => {
    const mapx = {
      type: "CIMMap",
      name: "State Plane",
      defaultExtent: {
        xmin: 1000,
        ymin: 2000,
        xmax: 3000,
        ymax: 4000,
        spatialReference: { wkid: 2264 },
      },
      layerDefinitions: [],
    };
    const result = importArcgisProject(JSON.stringify(mapx), "/work/projects/sp.mapx");
    assert.deepEqual(
      result.warnings.map((warning) => [warning.layerName, warning.reason]),
      [["State Plane", "map-extent"]],
    );
    // Falls back to the generic view rather than reading the projected numbers
    // as degrees.
    assert.deepEqual(result.project.mapView.center, [-100, 40]);
  });

  it("converts each CIM color model rather than reading every one as RGB", () => {
    const withFill = (color: unknown) => ({
      type: "CIMMap",
      name: "Colors",
      defaultExtent: { xmin: -80, ymin: 30, xmax: -70, ymax: 40, spatialReference: { wkid: 4326 } },
      layerDefinitions: [
        {
          ...featureLayer("Zones", "../data"),
          renderer: {
            symbol: {
              symbol: { symbolLayers: [{ type: "CIMSolidFill", color }] },
            },
          },
        },
      ],
    });
    const fillColor = (color: unknown) =>
      importArcgisProject(JSON.stringify(withFill(color)), "/work/p.mapx").project.layers[0].style
        .fillColor;

    assert.equal(fillColor({ type: "CIMRGBColor", values: [255, 0, 0, 100] }), "#ff0000");
    // Pure cyan in CMYK is red-free; read as RGB it would wrongly be near-black.
    assert.equal(fillColor({ type: "CIMCMYKColor", values: [100, 0, 0, 0, 100] }), "#00ffff");
    assert.equal(fillColor({ type: "CIMGrayColor", values: [50, 100] }), "#808080");
    // Asymmetric, so the assertion pins the scale direction: a level read as
    // ink coverage rather than lightness would give #bfbfbf here.
    assert.equal(fillColor({ type: "CIMGrayColor", values: [25, 100] }), "#404040");
    assert.equal(fillColor({ type: "CIMHSVColor", values: [120, 100, 100, 100] }), "#00ff00");
    // An unrecognized subclass keeps the default style instead of inventing one.
    assert.equal(
      fillColor({ type: "CIMSomeFutureColor", values: [1, 2, 3, 4] }),
      DEFAULT_LAYER_STYLE.fillColor,
    );
  });

  it("converts CIM transparency into opacity", () => {
    // CIM records transparency as a 0-100 percentage where 0 is opaque, the
    // inverse of GeoLibre's opacity. Reading the wrong field leaves every
    // imported layer fully opaque.
    const mapx = {
      type: "CIMMap",
      name: "Faded",
      defaultExtent: { xmin: -80, ymin: 30, xmax: -70, ymax: 40, spatialReference: { wkid: 4326 } },
      layerDefinitions: [
        {
          type: "CIMGroupLayer",
          name: "Faded group",
          transparency: 50,
          layerDefinitions: [
            {
              type: "CIMRasterLayer",
              name: "Elevation",
              transparency: 25,
              dataConnection: {
                workspaceConnectionString: "DATABASE=../rasters",
                dataset: "dem.tif",
              },
            },
          ],
        },
        { ...featureLayer("Cities", "../data"), transparency: 80 },
      ],
    };
    const result = importArcgisProject(JSON.stringify(mapx), "/work/projects/faded.mapx");
    assert.equal(result.rasters[0].opacity, 0.75);
    assert.equal(result.project.layerGroups?.[0].opacity, 0.5);
    assert.equal(result.project.layers[0].name, "Cities");
    assert.equal(result.project.layers[0].opacity, 0.2);
  });

  it("treats a layer with no transparency as fully opaque", () => {
    // ArcGIS omits the property at the default, so absence must not be read as
    // transparent.
    const mapx = {
      type: "CIMMap",
      name: "Opaque",
      defaultExtent: { xmin: -80, ymin: 30, xmax: -70, ymax: 40, spatialReference: { wkid: 4326 } },
      layerDefinitions: [featureLayer("Cities", "../data")],
    };
    const result = importArcgisProject(JSON.stringify(mapx), "/work/projects/opaque.mapx");
    assert.equal(result.project.layers[0].opacity, 1);
  });

  it("keeps a group whose only members are a raster or a service", () => {
    // The raster and service join the store after the project loads, so the
    // group must survive the prune or the later moveLayerToGroup is a no-op and
    // they strand at the top level.
    const mapx = {
      type: "CIMMap",
      name: "Grouped",
      defaultExtent: { xmin: -80, ymin: 30, xmax: -70, ymax: 40, spatialReference: { wkid: 4326 } },
      layerDefinitions: [
        {
          type: "CIMGroupLayer",
          name: "Imagery",
          layerDefinitions: [
            {
              type: "CIMRasterLayer",
              name: "Elevation",
              dataConnection: {
                workspaceConnectionString: "DATABASE=../rasters",
                dataset: "dem.tif",
              },
            },
          ],
        },
        {
          type: "CIMGroupLayer",
          name: "Basemaps",
          layerDefinitions: [
            {
              type: "CIMVectorTileLayer",
              name: "Streets",
              sourceURI: "79a4630cf75d49bba0d54d85030ba338",
            },
          ],
        },
      ],
    };
    const result = importArcgisProject(JSON.stringify(mapx), "/work/projects/grouped.mapx");
    const groupNames = result.project.layerGroups?.map((group) => group.name);
    assert.deepEqual(groupNames, ["Imagery", "Basemaps"]);
    const groupIds = new Map(result.project.layerGroups?.map((group) => [group.name, group.id]));
    assert.equal(result.rasters[0].groupId, groupIds.get("Imagery"));
    assert.equal(result.services[0].groupId, groupIds.get("Basemaps"));
  });

  it("stores layers bottom first, the reverse of ArcGIS Pro's table of contents", () => {
    const mapx = {
      type: "CIMMap",
      name: "Order",
      layerDefinitions: [
        featureLayer("Roads", "../data"),
        {
          type: "CIMGroupLayer",
          name: "Places",
          layerDefinitions: [
            featureLayer("Cities", "../data"),
            {
              type: "CIMRasterLayer",
              name: "Elevation",
              dataConnection: { workspaceConnectionString: "DATABASE=../r", dataset: "dem.tif" },
            },
            featureLayer("Towns", "../data"),
          ],
        },
        {
          type: "CIMVectorTileLayer",
          name: "Basemap",
          sourceURI: "79a4630cf75d49bba0d54d85030ba338",
        },
      ],
    };
    const result = importArcgisProject(JSON.stringify(mapx), "/work/projects/order.mapx");
    // Roads draws on top in ArcGIS Pro, so it comes last in the store.
    assert.deepEqual(
      result.project.layers.map((layer) => layer.name),
      ["Towns", "Cities", "Roads"],
    );
    assert.deepEqual(result.layerOrder, [
      "basemap",
      result.project.layers[0].id,
      "elevation",
      result.project.layers[1].id,
      result.project.layers[2].id,
    ]);
  });

  it("prunes a group that holds only empty groups, keeping ancestors of what loads", () => {
    const mapx = {
      type: "CIMMap",
      name: "Nested",
      layerDefinitions: [
        {
          type: "CIMGroupLayer",
          name: "Outer",
          layerDefinitions: [
            { type: "CIMGroupLayer", name: "Empty", layerDefinitions: [] },
            {
              type: "CIMGroupLayer",
              name: "Inner",
              layerDefinitions: [featureLayer("Cities", "../data")],
            },
          ],
        },
        {
          type: "CIMGroupLayer",
          name: "Hollow",
          layerDefinitions: [{ type: "CIMGroupLayer", name: "Void", layerDefinitions: [] }],
        },
      ],
    };
    const result = importArcgisProject(JSON.stringify(mapx), "/work/projects/nested.mapx");
    assert.deepEqual(
      result.project.layerGroups?.map((group) => group.name),
      ["Outer", "Inner"],
    );
  });

  it("drops layers with their tagged warnings and any group left empty", () => {
    const mapx = {
      type: "CIMMap",
      name: "Drop",
      layerDefinitions: [
        featureLayer("Roads", "../data"),
        {
          type: "CIMGroupLayer",
          name: "Imagery",
          layerDefinitions: [
            {
              type: "CIMRasterLayer",
              name: "Elevation",
              dataConnection: { workspaceConnectionString: "DATABASE=../r", dataset: "dem.tif" },
            },
          ],
        },
      ],
    };
    const result = importArcgisProject(JSON.stringify(mapx), "/work/projects/drop.mapx");
    const roads = result.project.layers[0].id;
    result.warnings.push(
      { layerName: "Roads", reason: "format", layerId: roads },
      { layerName: "Elevation", reason: "format", layerId: "elevation" },
      { layerName: "Elsewhere", reason: "layer-type" },
    );
    dropArcgisImportLayers(result, new Set(["elevation"]));
    assert.deepEqual(result.rasters, []);
    assert.deepEqual(result.layerOrder, [roads]);
    assert.deepEqual(result.project.layerGroups, []);
    assert.deepEqual(
      result.warnings.map((warning) => warning.layerName),
      // "Drop" is the map's own missing-extent note.
      ["Drop", "Roads", "Elsewhere"],
    );
  });

  it("counts only layers that were not loaded in the import headline", () => {
    const extent = { layerName: "Map", reason: "map-extent" } as const;
    const symbology = {
      layerName: "Zoning",
      layerId: "zoning",
      reason: "symbology-partial",
      symbologyIssue: "effects",
    } as const;
    const unloaded = { layerName: "Roads", reason: "format" } as const;
    // A map-extent or symbology note alone is not an unloaded layer.
    assert.equal(countArcgisUnloadedLayers([extent]), 0);
    assert.equal(countArcgisUnloadedLayers([extent, symbology]), 0);
    assert.equal(countArcgisUnloadedLayers([extent, symbology, unloaded]), 1);
  });

  it("reports a raster on a network share as a network path, not a bad format", () => {
    const mapx = {
      type: "CIMMap",
      name: "Shared",
      defaultExtent: { xmin: -80, ymin: 30, xmax: -70, ymax: 40, spatialReference: { wkid: 4326 } },
      layerDefinitions: [
        {
          type: "CIMRasterLayer",
          name: "Remote DEM",
          dataConnection: {
            workspaceConnectionString: "DATABASE=\\\\server\\share\\rasters",
            dataset: "dem.tif",
          },
        },
      ],
    };
    const result = importArcgisProject(JSON.stringify(mapx), "/work/projects/shared.mapx");
    assert.deepEqual(
      result.warnings.map((warning) => [warning.layerName, warning.reason]),
      [["Remote DEM", "network-path"]],
    );
    assert.deepEqual(result.rasters, []);
  });

  it("does not recurse forever when a group refers back to itself", () => {
    // Two group members that reference each other by path -- the archive's file
    // map hands back the same object each time, so without the ancestor guard
    // this recurses until the stack overflows.
    const archive = zipSync({
      "GISProject.json": strToU8(
        JSON.stringify({
          projectItems: [{ itemType: "Map", catalogPath: "CIMPATH=Maps/Main.json" }],
        }),
      ),
      "Maps/Main.json": strToU8(
        JSON.stringify({
          type: "CIMMap",
          name: "Loop",
          layers: ["CIMPATH=Layers/A.lyrx"],
        }),
      ),
      "Layers/A.lyrx": strToU8(
        JSON.stringify({
          type: "CIMGroupLayer",
          name: "A",
          layers: ["CIMPATH=Layers/B.lyrx"],
        }),
      ),
      "Layers/B.lyrx": strToU8(
        JSON.stringify({
          type: "CIMGroupLayer",
          name: "B",
          layers: ["CIMPATH=Layers/A.lyrx"],
        }),
      ),
    });

    const result = importArcgisProject(archive, "C:\\projects\\loop.aprx");
    assert.deepEqual(
      result.warnings
        .filter((warning) => warning.reason === "nesting")
        .map((warning) => warning.layerName),
      ["A"],
    );
    // B's only child was the cycle back to A, so it holds nothing, and A held
    // only B: both are pruned as empty.
    assert.deepEqual(result.project.layerGroups, []);
  });

  it("measures the map size in bytes, not UTF-16 code units", () => {
    // Each of these characters is 3 bytes in UTF-8 but one UTF-16 unit, so a
    // `String.length` guard would let a map far past the cap through.
    const padding = "\u4e2d".repeat(9 * 1024 * 1024);
    const mapx = JSON.stringify({ type: "CIMMap", name: padding, layerDefinitions: [] });
    assert.throws(
      () => importArcgisProject(mapx, "/work/projects/big.mapx"),
      /too large to import safely/,
    );
  });

  it("caps the combined decompressed size of an archive, not just each member", () => {
    // Two members, each comfortably under the 25 MB per-member cap, together
    // over it -- the per-entry check alone would decompress both.
    const member = (name: string) =>
      strToU8(JSON.stringify({ type: "CIMMap", name, pad: "x".repeat(15 * 1024 * 1024) }));
    const archive = zipSync({
      "Maps/One.json": member("One"),
      "Maps/Two.json": member("Two"),
    });
    assert.throws(
      () => importArcgisProject(archive, "C:\\projects\\big.aprx"),
      /too large to import safely/,
    );
  });

  describe("hosted feature layers", () => {
    const root = "https://services3.example.com/abc/arcgis/rest/services/Water/FeatureServer";
    const mapx = (...layerDefinitions: unknown[]) =>
      JSON.stringify({
        type: "CIMMap",
        name: "Water",
        defaultExtent: {
          xmin: -80,
          ymin: 30,
          xmax: -70,
          ymax: 40,
          spatialReference: { wkid: 4326 },
        },
        layerDefinitions,
      });

    it("imports explicit FeatureServer sublayers with their group, state and place", () => {
      const result = importArcgisProject(
        aprx(["Utilities", "Cities"], {
          Utilities: groupLayer("Utilities", ["Network"]),
          Network: groupLayer("Network", ["Mains", "Valves"]),
          Mains: hostedFeatureLayer("Mains", root, "3"),
          Valves: hostedFeatureLayer("Valves", root, "5", { visibility: false, transparency: 40 }),
          Cities: featureLayer("Cities", "../data"),
        }),
        "/work/projects/water.aprx",
      );

      assert.deepEqual(result.warnings, []);
      const groups = new Map(result.project.layerGroups?.map((group) => [group.name, group]));
      // Both groups survive the prune although only services sit in them.
      const network = groups.get("Network")?.id;
      assert.equal(groups.get("Network")?.parentId, groups.get("Utilities")?.id);
      const [mains, valves] = result.services;
      assert.deepEqual(result.services, [
        {
          kind: "feature",
          id: mains.id,
          name: "Mains",
          url: `${root}/3`,
          visible: true,
          opacity: 1,
          arcgisLayerUri: "CIMPATH=map/mains.json",
          groupId: network,
        },
        {
          kind: "feature",
          id: valves.id,
          name: "Valves",
          url: `${root}/5`,
          visible: false,
          opacity: 0.6,
          arcgisLayerUri: "CIMPATH=map/valves.json",
          groupId: network,
        },
      ]);
      // ArcGIS Pro lists Mains on top; the store order is bottom first.
      assert.deepEqual(result.layerOrder, ["layers-cities", valves.id, mains.id]);
    });

    it("keeps secrets in a FeatureServer connection string out of the import", () => {
      const result = importArcgisProject(
        mapx(
          hostedFeatureLayer(
            "Parcels",
            "https://user:pass@gis.example.com/server/rest/services/Parcels/FeatureServer/?token=SECRET#frag",
            "02",
          ),
        ),
        "/work/projects/secured.mapx",
      );
      const [service] = result.services;
      assert.equal(result.services.length, 1);
      assert.equal(
        service.kind === "feature" && service.url,
        "https://gis.example.com/server/rest/services/Parcels/FeatureServer/2",
      );
      assert.doesNotMatch(JSON.stringify(result), /SECRET|user:pass/);
    });

    it("reports a feature service connection it would have to guess at", () => {
      const cases: [string, string, string][] = [
        // No dataset: not guessed as sublayer 0.
        ["Rootless", root, ""],
        ["Named", root, "parcels"],
        // A MapServer root is not a FeatureServer.
        ["Dynamic", "https://gis.example.com/server/rest/services/Parcels/MapServer", "1"],
        ["Ftp", "ftp://gis.example.com/rest/services/Parcels/FeatureServer", "1"],
        ["Unparsable", "not a url", "1"],
      ];
      const result = importArcgisProject(
        mapx(...cases.map(([name, url, dataset]) => hostedFeatureLayer(name, url, dataset))),
        "/work/projects/ambiguous.mapx",
      );
      assert.deepEqual(result.services, []);
      assert.deepEqual(
        result.warnings.map((warning) => [warning.layerName, warning.reason]),
        cases.map(([name]) => [name, "service"]),
      );
    });
  });
});

describe("ArcGIS Pro File Geodatabase layers", () => {
  function gdbLayer(name: string, workspace: string, dataset = name.toLowerCase()) {
    return {
      ...featureLayer(name, ""),
      featureTable: {
        dataConnection: {
          workspaceFactory: "FileGDB",
          workspaceConnectionString: `DATABASE=${workspace}`,
          dataset,
        },
      },
    };
  }

  function gdbProject() {
    return JSON.stringify({
      type: "CIMMap",
      name: "Survey",
      defaultExtent: { xmin: -80, ymin: 30, xmax: -70, ymax: 40, spatialReference: { wkid: 4326 } },
      layerDefinitions: [
        featureLayer("Roads", "../data"),
        {
          type: "CIMGroupLayer",
          name: "Cadastre",
          visibility: false,
          layerDefinitions: [gdbLayer("Parcels", "..\\data\\city.gdb")],
        },
        {
          type: "CIMGroupLayer",
          name: "Missing",
          layerDefinitions: [gdbLayer("Gone", "C:\\data\\gone.gdb")],
        },
        gdbLayer("Wells", "..\\data\\city.gdb", "WELLS"),
        gdbLayer("Shared", "\\\\server\\share\\city.gdb"),
      ],
    });
  }

  it("keeps feature classes as ordered, grouped, styled layers when asked", () => {
    const result = importArcgisProject(gdbProject(), "C:\\work\\projects\\survey.mapx", {
      readFileGeodatabase: true,
    });
    // Bottom first, as the store keeps them: ArcGIS lists Roads at the top.
    assert.deepEqual(
      result.project.layers.map((layer) => [layer.name, layer.sourcePath]),
      [
        ["Wells", "C:/work/data/city.gdb"],
        ["Gone", "C:/data/gone.gdb"],
        ["Parcels", "C:/work/data/city.gdb"],
        ["Roads", "C:/work/data/roads.shp"],
      ],
    );
    const parcels = result.project.layers[2];
    assert.equal(parcels.groupId, result.project.layerGroups?.[0].id);
    assert.equal(result.project.layerGroups?.[0].visible, false);
    assert.equal(parcels.style.fillColor, "#0a141e");
    assert.equal(parcels.geojson, undefined);
    // Saved like an Add data → File geodatabase layer: features embedded, not
    // re-read from a path the reopen code cannot open.
    assert.equal(parcels.metadata.sourceKind, "gdb");
    assert.equal(parcels.metadata.localFileReloadable, undefined);
    assert.deepEqual(
      result.fileGeodatabaseLayers.map((entry) => [entry.name, entry.gdbPath, entry.featureClass]),
      [
        ["Parcels", "C:/work/data/city.gdb", "parcels"],
        ["Gone", "C:/data/gone.gdb", "gone"],
        ["Wells", "C:/work/data/city.gdb", "WELLS"],
      ],
    );
    assert.deepEqual(
      result.warnings.map((warning) => [warning.layerName, warning.reason]),
      [["Shared", "network-path"]],
    );
  });

  it("reports unsupported symbology on a feature class like any other layer", () => {
    const mapx = {
      type: "CIMMap",
      name: "Heat",
      defaultExtent: { xmin: -80, ymin: 30, xmax: -70, ymax: 40, spatialReference: { wkid: 4326 } },
      layerDefinitions: [
        {
          ...gdbLayer("Wells", "C:\\data\\city.gdb"),
          renderer: { type: "CIMHeatMapRenderer" },
        },
      ],
    };
    const result = importArcgisProject(JSON.stringify(mapx), "C:\\work\\heat.mapx", {
      readFileGeodatabase: true,
    });
    assert.equal(result.fileGeodatabaseLayers.length, 1);
    assert.deepEqual(
      result.warnings.map((warning) => [
        warning.layerName,
        warning.layerId,
        warning.reason,
        warning.symbologyIssue,
      ]),
      [["Wells", result.project.layers[0].id, "symbology", "renderer"]],
    );
  });

  it("still reports feature classes as unsupported by default", () => {
    const result = importArcgisProject(gdbProject(), "C:\\work\\projects\\survey.mapx");
    assert.deepEqual(result.fileGeodatabaseLayers, []);
    assert.deepEqual(
      result.project.layers.map((layer) => layer.name),
      ["Roads"],
    );
    assert.deepEqual(
      result.warnings.map((warning) => [warning.layerName, warning.reason]),
      [
        ["Parcels", "file-geodatabase"],
        ["Gone", "file-geodatabase"],
        ["Wells", "file-geodatabase"],
        ["Shared", "network-path"],
      ],
    );
  });

  it("only reads geodatabases that are local .gdb folders", () => {
    // The path comes from the project file and the desktop sidecar does not
    // confine its reads, so a crafted connection must not reach an arbitrary
    // folder, a URL or a GDAL virtual path. Those stay listed, unread.
    const project = JSON.stringify({
      type: "CIMMap",
      name: "Crafted",
      defaultExtent: { xmin: -80, ymin: 30, xmax: -70, ymax: 40, spatialReference: { wkid: 4326 } },
      layerDefinitions: [
        gdbLayer("Folder", "C:\\Users\\someone\\Documents"),
        gdbLayer("Url", "https://example.com/data/city.gdb"),
        gdbLayer("Vsi", "/vsicurl/https://example.com/city.gdb"),
        gdbLayer("Zip", "/vsizip/C:/data/city.zip/city.gdb"),
        gdbLayer("Query", "C:\\data\\city.gdb?mode=x"),
        gdbLayer("Posix", "/data/city.gdb/"),
        gdbLayer("Relative", "..\\data\\City.GDB"),
        // Names a geodatabase but no feature class: reported as the default
        // path reports it, not as a missing source.
        gdbLayer("NoDataset", "C:\\data\\city.gdb", ""),
      ],
    });
    const result = importArcgisProject(project, "C:\\work\\projects\\survey.mapx", {
      readFileGeodatabase: true,
    });
    assert.deepEqual(
      result.fileGeodatabaseLayers.map((entry) => [entry.name, entry.gdbPath]),
      [
        ["Posix", "/data/city.gdb"],
        ["Relative", "C:/work/data/City.GDB"],
      ],
    );
    assert.deepEqual(
      result.warnings.map((warning) => [warning.layerName, warning.reason]),
      [
        ["Folder", "file-geodatabase"],
        ["Url", "file-geodatabase"],
        ["Vsi", "file-geodatabase"],
        ["Zip", "file-geodatabase"],
        ["Query", "file-geodatabase"],
        ["NoDataset", "file-geodatabase"],
      ],
    );
  });

  it("refuses a relative geodatabase in a project opened from a network share", () => {
    const project = JSON.stringify({
      type: "CIMMap",
      name: "Shared",
      defaultExtent: { xmin: -80, ymin: 30, xmax: -70, ymax: 40, spatialReference: { wkid: 4326 } },
      layerDefinitions: [gdbLayer("Parcels", "..\\city.gdb")],
    });
    const result = importArcgisProject(project, "\\\\server\\share\\proj\\survey.aprx", {
      readFileGeodatabase: true,
    });
    // Normalising would otherwise turn it into the rooted local path
    // /server/share/city.gdb.
    assert.deepEqual(result.fileGeodatabaseLayers, []);
    assert.deepEqual(
      result.warnings.map((warning) => [warning.layerName, warning.reason]),
      [["Parcels", "network-path"]],
    );
  });

  it("fills readable layers and drops missing ones with their empty groups", async () => {
    const result = importArcgisProject(gdbProject(), "C:\\work\\projects\\survey.mapx", {
      readFileGeodatabase: true,
    });
    const reads: string[] = [];
    let listings = 0;
    await loadArcgisFileGeodatabaseLayers(result, {
      start: async () => undefined,
      listLayers: async (gdbPath) => {
        listings += 1;
        if (gdbPath === "C:/data/gone.gdb") throw new Error("not found");
        return [
          { name: "parcels", feature_count: 1, geometry_type: "Polygon", crs: "EPSG:2193" },
          { name: "wells", feature_count: 1, geometry_type: "Point", crs: "EPSG:4326" },
        ];
      },
      readLayer: async (gdbPath, featureClass) => {
        reads.push(`${gdbPath}|${featureClass}`);
        return { type: "FeatureCollection", features: [] };
      },
    });
    // Parcels and Wells share a geodatabase, so it is listed once; the
    // listing's casing ("wells") is what is read, not the connection's.
    assert.equal(listings, 2);
    assert.deepEqual(reads, ["C:/work/data/city.gdb|parcels", "C:/work/data/city.gdb|wells"]);
    assert.deepEqual(
      result.project.layers.map((layer) => [layer.name, layer.geojson !== undefined]),
      [
        ["Wells", true],
        ["Parcels", true],
        ["Roads", false],
      ],
    );
    assert.equal(result.project.layers[1].metadata.sourceCrs, "EPSG:2193");
    assert.equal(result.project.layers[0].metadata.gdbLayer, "wells");
    assert.deepEqual(
      result.project.layerGroups?.map((group) => group.name),
      ["Cadastre"],
    );
    assert.deepEqual(
      result.warnings.map((warning) => [warning.layerName, warning.reason]),
      [
        ["Shared", "network-path"],
        // A failed listing is reported as unreadable: it may be a moved
        // geodatabase, but also a busy or failed sidecar.
        ["Gone", "file-geodatabase-read"],
      ],
    );
  });

  it("warns instead of misplacing a layer with no CRS, or a failed read", async () => {
    const result = importArcgisProject(gdbProject(), "C:\\work\\projects\\survey.mapx", {
      readFileGeodatabase: true,
    });
    await loadArcgisFileGeodatabaseLayers(result, {
      start: async () => undefined,
      listLayers: async () => [
        { name: "parcels", feature_count: 1, geometry_type: "Polygon", crs: null },
        { name: "gone", feature_count: 1, geometry_type: "Point", crs: "EPSG:4326" },
      ],
      readLayer: async () => {
        throw new Error("boom");
      },
    });
    assert.deepEqual(
      result.project.layers.map((layer) => layer.name),
      ["Roads"],
    );
    assert.deepEqual(result.project.layerGroups, []);
    assert.deepEqual(
      result.warnings.map((warning) => [warning.layerName, warning.reason]),
      [
        ["Shared", "network-path"],
        ["Parcels", "file-geodatabase-crs"],
        ["Gone", "file-geodatabase-read"],
        ["Wells", "missing-source"],
      ],
    );
  });

  it("reads only the chosen map's geodatabase layers from a multi-map project", async () => {
    const mapItem = (name: string) => ({
      type: "CIMProjectItem",
      itemType: "Map",
      catalogPath: `CIMPATH=Maps/${name}.json`,
    });
    const archive = zipSync({
      "GISProject.json": strToU8(
        JSON.stringify({ projectItems: [mapItem("Overview"), mapItem("Assets")] }),
      ),
      "Maps/Overview.json": strToU8(
        JSON.stringify({
          type: "CIMMap",
          name: "Overview",
          layerDefinitions: [gdbLayer("Boundary", "..\\data\\overview.gdb")],
        }),
      ),
      "Maps/Assets.json": strToU8(
        JSON.stringify({
          type: "CIMMap",
          name: "Assets",
          layers: ["CIMPATH=Layers/Pipes.lyrx", "CIMPATH=Layers/Valves.lyrx"],
        }),
      ),
      "Layers/Pipes.lyrx": strToU8(JSON.stringify(gdbLayer("Pipes", "..\\data\\assets.gdb"))),
      "Layers/Valves.lyrx": strToU8(JSON.stringify(featureLayer("Valves", "..\\data"))),
    });

    const reader = readArcgisProject(archive, "C:\\work\\projects\\city.aprx", {
      readFileGeodatabase: true,
    });
    assert.deepEqual(
      reader.maps.map((map) => map.name),
      ["Overview", "Assets"],
    );
    const assets = reader.importMap(1);
    // The other map's geodatabase is never queued, so it is never listed or read.
    assert.deepEqual(
      assets.fileGeodatabaseLayers.map((entry) => [entry.name, entry.gdbPath]),
      [["Pipes", "C:/work/data/assets.gdb"]],
    );
    const listed: string[] = [];
    await loadArcgisFileGeodatabaseLayers(assets, {
      start: async () => undefined,
      listLayers: async (gdbPath) => {
        listed.push(gdbPath);
        return [{ name: "pipes", feature_count: 0, geometry_type: "LineString", crs: "EPSG:4326" }];
      },
      readLayer: async () => ({ type: "FeatureCollection", features: [] }),
    });
    assert.deepEqual(listed, ["C:/work/data/assets.gdb"]);
    assert.equal(assets.project.name, "Assets");
    assert.deepEqual(
      assets.project.layers.map((layer) => [layer.name, layer.geojson !== undefined]),
      [
        ["Valves", false],
        ["Pipes", true],
      ],
    );
    // Only the missing extent is reported (the fixture saves none); no
    // geodatabase layer was dropped.
    assert.deepEqual(
      assets.warnings.map((warning) => warning.reason),
      ["map-extent"],
    );
    // The picker's default (first) map still gets its own layer, and the
    // option carries through importArcgisProject too.
    assert.deepEqual(
      importArcgisProject(archive, "C:\\work\\projects\\city.aprx", {
        readFileGeodatabase: true,
      }).fileGeodatabaseLayers.map((entry) => entry.name),
      ["Boundary"],
    );
  });

  it("keeps ArcGIS Pro's order across geodatabase layers, rasters and services", async () => {
    const featureRoot =
      "https://services3.example.com/abc/arcgis/rest/services/Water/FeatureServer";
    const result = importArcgisProject(
      JSON.stringify({
        type: "CIMMap",
        name: "Mixed",
        layerDefinitions: [
          gdbLayer("Parcels", "C:\\data\\city.gdb"),
          hostedFeatureLayer("Mains", featureRoot, "3"),
          {
            type: "CIMGroupLayer",
            name: "Base",
            layerDefinitions: [
              {
                type: "CIMVectorTileLayer",
                name: "Streets",
                sourceURI: "0123456789abcdef0123456789abcdef",
              },
              {
                type: "CIMRasterLayer",
                name: "Imagery",
                dataConnection: {
                  workspaceConnectionString: "DATABASE=C:\\rasters",
                  dataset: "ortho.tif",
                },
              },
            ],
          },
          gdbLayer("Lots", "C:\\data\\city.gdb"),
          featureLayer("Roads", "C:\\data"),
        ],
      }),
      "C:\\work\\mixed.mapx",
      { readFileGeodatabase: true },
    );
    const id = (name: string) =>
      [...result.project.layers, ...result.rasters, ...result.services].find(
        (item) => item.name === name,
      )?.id;
    // Bottom first: Roads, Lots, then the group (Imagery below Streets), then
    // the Mains service, then Parcels on top.
    assert.deepEqual(
      result.layerOrder,
      ["Roads", "Lots", "Imagery", "Streets", "Mains", "Parcels"].map(id),
    );
    const lots = id("Lots");
    await loadArcgisFileGeodatabaseLayers(result, {
      start: async () => undefined,
      listLayers: async () => [
        { name: "parcels", feature_count: 0, geometry_type: "Polygon", crs: "EPSG:4326" },
      ],
      readLayer: async () => ({ type: "FeatureCollection", features: [] }),
    });
    // The unreadable feature class leaves the order with its layer.
    assert.ok(lots && !result.layerOrder.includes(lots));
    assert.deepEqual(
      result.layerOrder,
      ["Roads", "Imagery", "Streets", "Mains", "Parcels"].map(id),
    );

    // As the desktop hook does: load the project, then add the raster and the
    // services on top of the stack under new store ids as each lands (here in
    // an order unlike ArcGIS Pro's), and apply the import order once.
    useAppStore.getState().loadProject(result.project, null);
    const storeIds = new Map(result.project.layers.map((layer) => [layer.id, layer.id]));
    for (const [name, storeId] of [
      ["Mains", "arcgis-layer-1"],
      ["Imagery", "raster-1"],
      ["Streets", "arcgis-layer-2"],
    ]) {
      useAppStore.getState().addLayer(geojsonLayer({ id: storeId, name }));
      const importId = id(name);
      assert.ok(importId);
      storeIds.set(importId, storeId);
    }
    const order = result.layerOrder.flatMap((importId) => storeIds.get(importId) ?? []);
    withoutHistory(() => useAppStore.getState().applyLayerOrder(order));
    assert.deepEqual(
      useAppStore.getState().layers.map((layer) => layer.name),
      ["Roads", "Imagery", "Streets", "Mains", "Parcels"],
    );
  });

  // When another project opens: before the reads, while the only layer is
  // read (whether that read then succeeds or fails), or during the first of
  // several reads. None of them may hand back layers.
  for (const { when, project, abortAt, readFails, expectedCalls } of [
    { when: "before the reads", project: "one", abortAt: "start", expectedCalls: [] },
    {
      when: "during the last read",
      project: "one",
      abortAt: "read",
      expectedCalls: ["start", "read"],
    },
    {
      when: "during a last read that fails",
      project: "one",
      abortAt: "read",
      readFails: true,
      expectedCalls: ["start", "read"],
    },
    {
      when: "during an earlier read",
      project: "many",
      abortAt: "read",
      expectedCalls: ["start", "read"],
    },
  ]) {
    it(`rejects without filling layers when abandoned ${when}`, async () => {
      const result = importArcgisProject(
        project === "one"
          ? JSON.stringify({
              type: "CIMMap",
              name: "One",
              layerDefinitions: [gdbLayer("Parcels", "C:\\data\\city.gdb")],
            })
          : gdbProject(),
        "C:\\work\\projects\\survey.mapx",
        { readFileGeodatabase: true },
      );
      const controller = new AbortController();
      if (abortAt === "start") controller.abort();
      const calls: string[] = [];
      await assert.rejects(
        loadArcgisFileGeodatabaseLayers(
          result,
          {
            start: async () => {
              calls.push("start");
            },
            listLayers: async () => [
              { name: "parcels", feature_count: 0, geometry_type: "Polygon", crs: "EPSG:4326" },
            ],
            readLayer: async () => {
              calls.push("read");
              controller.abort();
              if (readFails) throw new Error("sidecar stopped");
              return { type: "FeatureCollection", features: [] };
            },
          },
          controller.signal,
        ),
        { name: "AbortError" },
      );
      assert.deepEqual(calls, expectedCalls);
      assert.ok(result.project.layers.every((layer) => layer.geojson === undefined));
    });
  }

  // As the sidecar client does: the wait rejects with the abort.
  for (const stage of ["listing", "read"] as const) {
    it(`does not log an abandoned ${stage} as a failed read`, async () => {
      const result = importArcgisProject(gdbProject(), "C:\\work\\projects\\survey.mapx", {
        readFileGeodatabase: true,
      });
      const controller = new AbortController();
      const abandon = (signal?: AbortSignal) => {
        controller.abort();
        signal?.throwIfAborted();
      };
      const warn = mock.method(console, "warn", () => {});
      try {
        await assert.rejects(
          loadArcgisFileGeodatabaseLayers(
            result,
            {
              start: async () => {},
              listLayers: async (_gdbPath, signal) => {
                if (stage === "listing") abandon(signal);
                return [
                  { name: "parcels", feature_count: 0, geometry_type: "Polygon", crs: "EPSG:4326" },
                ];
              },
              readLayer: async (_gdbPath, _featureClass, signal) => {
                abandon(signal);
                return { type: "FeatureCollection", features: [] };
              },
            },
            controller.signal,
          ),
          { name: "AbortError" },
        );
        assert.equal(warn.mock.callCount(), 0);
      } finally {
        warn.mock.restore();
      }
    });
  }

  it("stops waiting for a sidecar that is still starting when abandoned", async () => {
    const result = importArcgisProject(gdbProject(), "C:\\work\\projects\\survey.mapx", {
      readFileGeodatabase: true,
    });
    const controller = new AbortController();
    const error = mock.method(console, "error", () => {});
    try {
      const loading = loadArcgisFileGeodatabaseLayers(
        result,
        {
          // Never settles, like a sidecar still bootstrapping.
          start: () => new Promise(() => {}),
          listLayers: async () => assert.fail("must not list"),
          readLayer: async () => assert.fail("must not read"),
        },
        controller.signal,
      );
      controller.abort();
      await assert.rejects(loading, { name: "AbortError" });
      // Abandoned, not reported as a sidecar that failed to start.
      assert.equal(error.mock.callCount(), 0);
      assert.ok(result.project.layers.every((layer) => layer.geojson === undefined));
    } finally {
      error.mock.restore();
    }
  });

  it("reports every layer as unreadable when the sidecar cannot start", async () => {
    const result = importArcgisProject(gdbProject(), "C:\\work\\projects\\survey.mapx", {
      readFileGeodatabase: true,
    });
    await loadArcgisFileGeodatabaseLayers(result, {
      start: async () => {
        throw new Error("no sidecar");
      },
      listLayers: async () => assert.fail("must not list"),
      readLayer: async () => assert.fail("must not read"),
    });
    assert.deepEqual(
      result.warnings.slice(1).map((warning) => [warning.layerName, warning.reason]),
      [
        ["Parcels", "file-geodatabase-read"],
        ["Gone", "file-geodatabase-read"],
        ["Wells", "file-geodatabase-read"],
      ],
    );
  });
});
