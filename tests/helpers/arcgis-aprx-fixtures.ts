import { strToU8, zipSync } from "fflate";

/**
 * Builders for ArcGIS Pro project fixtures, shared by the importer tests, the
 * desktop hook test and the browser e2e spec.
 */

/**
 * A hosted feature layer as ArcGIS Pro saves it: the FeatureServer root in the
 * connection string and the sublayer number as the dataset (the shape in
 * public .lyrx files such as Esri samples and USEPA/BEEP's USA_Structures).
 *
 * @param connectionUrl - The `URL=` value, which may carry a query string.
 */
export function hostedFeatureLayer(
  name: string,
  connectionUrl: string,
  dataset: string,
  extra: Record<string, unknown> = {},
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
        workspaceConnectionString: `URL=${connectionUrl}`,
        workspaceFactory: "FeatureService",
        dataset,
        datasetType: "esriDTFeatureClass",
      },
    },
    ...extra,
  };
}

/** A cached MapServer layer, which the importer keeps as a project layer. */
export function tiledServiceLayer(name: string) {
  return {
    type: "CIMTiledServiceLayer",
    name,
    uRI: `CIMPATH=map/${name.toLowerCase()}.json`,
    serviceConnection: {
      objectType: "MapServer",
      url: `https://tiles.fixture.test/arcgis/rest/services/${name}/MapServer`,
    },
  };
}

/** A group layer whose members are listed top first, by archive path. */
export function groupLayer(name: string, members: string[]) {
  return {
    type: "CIMGroupLayer",
    name,
    uRI: `CIMPATH=map/${name.toLowerCase()}.json`,
    layers: members.map((member) => `CIMPATH=map/${member.toLowerCase()}.json`),
  };
}

/**
 * An `.aprx` holding one 2D map centred on (-75, 35). `layers` are the map's
 * top-level members by name, top first; `members` are the CIM documents in the
 * archive, each stored at `map/<name in lower case>.json`.
 */
export function aprx(layers: string[], members: Record<string, unknown>): Uint8Array {
  const json = (value: unknown) => strToU8(JSON.stringify(value));
  return zipSync({
    "GISProject.json": json({
      projectItems: [{ itemType: "Map", catalogPath: "CIMPATH=map/map.json" }],
    }),
    "map/map.json": json({
      type: "CIMMap",
      name: "Water network",
      mapType: "Map",
      defaultExtent: { xmin: -80, ymin: 30, xmax: -70, ymax: 40, spatialReference: { wkid: 4326 } },
      layers: layers.map((name) => `CIMPATH=map/${name.toLowerCase()}.json`),
    }),
    ...Object.fromEntries(
      Object.entries(members).map(([name, member]) => [
        `map/${name.toLowerCase()}.json`,
        json(member),
      ]),
    ),
  });
}
