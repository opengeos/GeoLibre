import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_LAYER_STYLE } from "@geolibre/core";
import { strToU8, zipSync } from "fflate";
import {
  importArcgisProject,
  readArcgisProject,
} from "../apps/geolibre-desktop/src/lib/arcgis-project-import";

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
            },
          ],
        },
      },
    },
    labelVisibility: true,
    labelClasses: [{ expression: "[NAME]" }],
  };
}

/**
 * A hosted feature layer as ArcGIS Pro saves it: the FeatureServer root in the
 * connection string and the sublayer number as the dataset (the shape in
 * public .lyrx files such as Esri samples and USEPA/BEEP's USA_Structures).
 */
function hostedFeatureLayer(
  name: string,
  dataset: string,
  extra: Record<string, unknown> = {},
  serviceUrl = "https://services3.example.com/abc/arcgis/rest/services/Water/FeatureServer",
) {
  return {
    type: "CIMFeatureLayer",
    name,
    uRI: `CIMPATH=map/${name.toLowerCase()}.json`,
    visibility: true,
    featureTable: {
      type: "CIMFeatureTable",
      dataConnection: {
        type: "CIMStandardDataConnection",
        workspaceConnectionString: `URL=${serviceUrl}`,
        workspaceFactory: "FeatureService",
        dataset,
        datasetType: "esriDTFeatureClass",
      },
    },
    ...extra,
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
        name: "Basemap",
        itemId: "79a4630cf75d49bba0d54d85030ba338",
        visible: true,
      },
    ]);
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
    // B's only child was the cycle back to A, so it is pruned as empty; A
    // survives because B still names it as a parent.
    assert.deepEqual(
      result.project.layerGroups?.map((group) => group.name),
      ["A"],
    );
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

  it("imports explicit FeatureServer sublayers from an APRX with their place and state", () => {
    const map = {
      type: "CIMMapDocument",
      mapDefinition: {
        type: "CIMMap",
        name: "Water",
        mapType: "Map",
        defaultExtent: {
          xmin: -80,
          ymin: 30,
          xmax: -70,
          ymax: 40,
          spatialReference: { wkid: 4326 },
        },
        layers: ["CIMPATH=map/utilities.json", "CIMPATH=map/cities.json"],
      },
    };
    const zip = zipSync({
      "GISProject.json": strToU8(
        JSON.stringify({
          projectItems: [{ itemType: "Map", catalogPath: "CIMPATH=map/map.json" }],
        }),
      ),
      "map/map.json": strToU8(JSON.stringify(map)),
      "map/utilities.json": strToU8(
        JSON.stringify({
          type: "CIMGroupLayer",
          name: "Utilities",
          uRI: "CIMPATH=map/utilities.json",
          layers: ["CIMPATH=map/network.json"],
        }),
      ),
      "map/network.json": strToU8(
        JSON.stringify({
          type: "CIMGroupLayer",
          name: "Network",
          uRI: "CIMPATH=map/network.json",
          layers: ["CIMPATH=map/mains.json", "CIMPATH=map/valves.json"],
        }),
      ),
      "map/mains.json": strToU8(JSON.stringify(hostedFeatureLayer("Mains", "3"))),
      "map/valves.json": strToU8(
        JSON.stringify(
          hostedFeatureLayer("Valves", "5", {
            visibility: false,
            transparency: 40,
          }),
        ),
      ),
      "map/cities.json": strToU8(JSON.stringify(featureLayer("Cities", "../data"))),
    });

    const result = importArcgisProject(zip, "/work/projects/water.aprx");

    assert.deepEqual(result.warnings, []);
    const groups = new Map(result.project.layerGroups?.map((group) => [group.name, group]));
    // Both groups survive the prune although only services sit in them.
    assert.equal(groups.get("Network")?.parentId, groups.get("Utilities")?.id);
    const root = "https://services3.example.com/abc/arcgis/rest/services/Water/FeatureServer";
    assert.deepEqual(result.services, [
      {
        kind: "feature",
        name: "Mains",
        url: `${root}/3`,
        visible: true,
        opacity: 1,
        arcgisLayerUri: "CIMPATH=map/mains.json",
        nextLayerIds: ["layers-cities"],
        groupId: groups.get("Network")?.id,
      },
      {
        kind: "feature",
        name: "Valves",
        url: `${root}/5`,
        visible: false,
        opacity: 0.6,
        arcgisLayerUri: "CIMPATH=map/valves.json",
        nextLayerIds: ["layers-cities"],
        groupId: groups.get("Network")?.id,
      },
    ]);
    assert.deepEqual(
      result.project.layers.map((layer) => layer.id),
      ["layers-cities"],
    );
  });

  it("keeps secrets in a FeatureServer connection string out of the import", () => {
    const mapx = {
      type: "CIMMap",
      name: "Secured",
      defaultExtent: {
        xmin: -80,
        ymin: 30,
        xmax: -70,
        ymax: 40,
        spatialReference: { wkid: 4326 },
      },
      layerDefinitions: [
        hostedFeatureLayer(
          "Parcels",
          "02",
          {},
          "https://user:pass@gis.example.com/server/rest/services/Parcels/FeatureServer/?token=SECRET#frag",
        ),
      ],
    };
    const result = importArcgisProject(JSON.stringify(mapx), "/work/projects/secured.mapx");
    assert.equal(result.services.length, 1);
    const [service] = result.services;
    assert.equal(service.kind, "feature");
    assert.equal(
      service.kind === "feature" && service.url,
      "https://gis.example.com/server/rest/services/Parcels/FeatureServer/2",
    );
    assert.doesNotMatch(JSON.stringify(result), /SECRET|user:pass/);
  });

  it("reports a feature service connection without an explicit sublayer", () => {
    const mapx = {
      type: "CIMMap",
      name: "Ambiguous",
      defaultExtent: {
        xmin: -80,
        ymin: 30,
        xmax: -70,
        ymax: 40,
        spatialReference: { wkid: 4326 },
      },
      layerDefinitions: [
        // No dataset: not guessed as sublayer 0.
        hostedFeatureLayer("Rootless", ""),
        hostedFeatureLayer("Named", "parcels"),
        // A MapServer root is not a FeatureServer.
        hostedFeatureLayer(
          "Dynamic",
          "1",
          {},
          "https://gis.example.com/server/rest/services/Parcels/MapServer",
        ),
      ],
    };
    const result = importArcgisProject(JSON.stringify(mapx), "/work/projects/ambiguous.mapx");
    assert.deepEqual(result.services, []);
    assert.deepEqual(
      result.warnings.map((warning) => [warning.layerName, warning.reason]),
      [
        ["Rootless", "service"],
        ["Named", "service"],
        ["Dynamic", "service"],
      ],
    );
  });
});
