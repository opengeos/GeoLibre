import { act, cleanup, render, resetStores, useAppStore } from "./helpers/dom";
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createElement } from "react";
import { parseProject } from "@geolibre/core";
import { setArcGISFetch } from "@geolibre/plugins";
import { geojsonLayer } from "./helpers/layer-fixtures";
import { strToU8, zipSync } from "fflate";
import type { ProjectFileActions } from "../apps/geolibre-desktop/src/hooks/useProjectFileActions";

// Loaded after the harness so its CSS imports and Vite globals are handled.
const { placeImportedServiceLayers, signInForImportedService, useProjectFileActions } =
  await import("../apps/geolibre-desktop/src/hooks/useProjectFileActions");
const { installNativeArcGISFetch } = await import("../apps/geolibre-desktop/src/lib/arcgis-fetch");
const { ARCGIS_ONLINE_PORTAL } = await import("../apps/geolibre-desktop/src/lib/arcgis-oauth");

/**
 * The desktop build's half of ArcGIS Pro feature service import: the Tauri
 * file dialog hands over the project, and every ArcGIS REST request goes
 * through the native `fetch_arcgis_response` command rather than the
 * webview's `fetch`. Tauri's IPC is stood in for at `__TAURI_INTERNALS__`, so
 * the hook, the importer, the ArcGIS loader and the native transport are all
 * the shipped code. The browser half is `e2e/arcgis-project-feature-service.spec.ts`.
 */

const SERVICE = "https://gis.fixture.test/arcgis/rest/services/Water/FeatureServer";
const DOWN = "https://down.fixture.test/arcgis/rest/services/Hydrants/FeatureServer";
const SECRET = "fixture-secret-token";
const APRX_PATH = "/Users/me/projects/water.aprx";
const SAVED_PATH = "/Users/me/projects/water.geolibre.json";

function hostedLayer(name: string, root: string, dataset: string, extra = {}) {
  return {
    type: "CIMFeatureLayer",
    name,
    uRI: `CIMPATH=map/${name.toLowerCase()}.json`,
    visibility: true,
    featureTable: {
      dataConnection: {
        type: "CIMStandardDataConnection",
        workspaceConnectionString: `URL=${root}?token=${SECRET}`,
        workspaceFactory: "FeatureService",
        dataset,
        datasetType: "esriDTFeatureClass",
      },
    },
    ...extra,
  };
}

function tiledLayer(name: string) {
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

const member = (value: unknown) => strToU8(JSON.stringify(value));
const APRX = zipSync({
  "GISProject.json": member({
    projectItems: [{ itemType: "Map", catalogPath: "CIMPATH=map/map.json" }],
  }),
  "map/map.json": member({
    type: "CIMMap",
    name: "Water network",
    mapType: "Map",
    defaultExtent: { xmin: -80, ymin: 30, xmax: -70, ymax: 40, spatialReference: { wkid: 4326 } },
    layers: [
      "CIMPATH=map/utilities.json",
      "CIMPATH=map/treatment.json",
      "CIMPATH=map/hydrants.json",
    ],
  }),
  "map/utilities.json": member({
    type: "CIMGroupLayer",
    name: "Utilities",
    uRI: "CIMPATH=map/utilities.json",
    layers: ["CIMPATH=map/streets.json", "CIMPATH=map/network.json", "CIMPATH=map/contours.json"],
  }),
  "map/network.json": member({
    type: "CIMGroupLayer",
    name: "Network",
    uRI: "CIMPATH=map/network.json",
    layers: ["CIMPATH=map/hillshade.json", "CIMPATH=map/mains.json", "CIMPATH=map/valves.json"],
  }),
  // Project layers on either side of the services, in the parent group and in
  // the services' own subgroup, so the services' draw order is checked against
  // how the store lays out nested groups.
  // A service as its group's first member, ahead of a subgroup and a later
  // member: the group's block forms at the service.
  "map/treatment.json": member({
    type: "CIMGroupLayer",
    name: "Treatment",
    uRI: "CIMPATH=map/treatment.json",
    layers: [
      "CIMPATH=map/pumps.json",
      "CIMPATH=map/storage.json",
      "CIMPATH=map/intake.json",
      "CIMPATH=map/outfalls.json",
    ],
  }),
  "map/storage.json": member({
    type: "CIMGroupLayer",
    name: "Storage",
    uRI: "CIMPATH=map/storage.json",
    layers: ["CIMPATH=map/tanks.json"],
  }),
  // A subgroup holding only a service, after another subgroup.
  "map/intake.json": member({
    type: "CIMGroupLayer",
    name: "Intake",
    uRI: "CIMPATH=map/intake.json",
    layers: ["CIMPATH=map/filters.json"],
  }),
  "map/filters.json": member(hostedLayer("Filters", SERVICE, "9")),
  "map/pumps.json": member(hostedLayer("Pumps", SERVICE, "7")),
  "map/tanks.json": member(tiledLayer("Tanks")),
  "map/outfalls.json": member(tiledLayer("Outfalls")),
  "map/streets.json": member(tiledLayer("Streets")),
  "map/hillshade.json": member(tiledLayer("Hillshade")),
  "map/contours.json": member(tiledLayer("Contours")),
  "map/mains.json": member(hostedLayer("Mains", SERVICE, "3")),
  "map/valves.json": member(
    hostedLayer("Valves", SERVICE, "5", { visibility: false, transparency: 40 }),
  ),
  "map/hydrants.json": member(hostedLayer("Hydrants", DOWN, "1")),
});

/** The fixture FeatureServer, answered as the Rust command would. */
function serviceResponse(url: URL): { status: number; body: string; contentType?: string } {
  const match = url.href.startsWith(SERVICE)
    ? url.pathname.match(/\/FeatureServer\/(3|5|7|9)(\/query)?$/)
    : null;
  if (!match) return { status: 503, body: "unavailable" };
  const json = (body: unknown) => ({
    status: 200,
    body: JSON.stringify(body),
    contentType: "application/json",
  });
  if (!match[2]) {
    return json({
      name: `Sublayer ${match[1]}`,
      geometryType: "esriGeometryPoint",
      objectIdField: "OBJECTID",
      maxRecordCount: 1000,
      fields: [{ name: "OBJECTID", type: "esriFieldTypeOID" }],
      extent: { xmin: -76, ymin: 34, xmax: -73, ymax: 37, spatialReference: { wkid: 4326 } },
    });
  }
  if (url.searchParams.get("returnCountOnly") === "true") return json({ count: 1 });
  return json({
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        id: 1,
        properties: { OBJECTID: 1 },
        geometry: { type: "Point", coordinates: [-75, 35] },
      },
    ],
  });
}

const globals = window as unknown as Record<string, unknown>;
let nativeRequests: string[] = [];
let savedText = "";
let dialogPath = APRX_PATH;

beforeEach(async () => {
  nativeRequests = [];
  let callbackId = 0;
  globals.__TAURI_INTERNALS__ = {
    transformCallback: () => ++callbackId,
    invoke: async (cmd: string, args: Record<string, unknown>, ipc?: { headers?: unknown }) => {
      switch (cmd) {
        case "plugin:dialog|open":
          return dialogPath;
        case "plugin:fs|read_file":
          assert.equal(args.path, APRX_PATH);
          return Array.from(APRX);
        case "plugin:fs|read_text_file":
          assert.equal(args.path, SAVED_PATH);
          return Array.from(strToU8(savedText));
        case "fetch_arcgis_response":
          nativeRequests.push(String(args.url));
          return serviceResponse(new URL(String(args.url)));
        case "plugin:dialog|save":
          return SAVED_PATH;
        case "plugin:fs|write_text_file": {
          // The fs plugin sends the text as the raw body and the path in a header.
          const headers = new Headers(ipc?.headers as HeadersInit);
          assert.equal(decodeURIComponent(headers.get("path") ?? ""), SAVED_PATH);
          savedText = new TextDecoder().decode(args as unknown as Uint8Array);
          return null;
        }
        default:
          // Desktop-only side effects (recent projects, window title) are not
          // what this test is about.
          return null;
      }
    },
  };
  await installNativeArcGISFetch();
});

afterEach(() => {
  cleanup();
  resetStores();
  setArcGISFetch(null);
  delete globals.__TAURI_INTERNALS__;
});

function renderActions(): () => ProjectFileActions {
  let actions: ProjectFileActions | null = null;
  function Harness() {
    actions = useProjectFileActions({ current: null });
    return null;
  }
  render(createElement(Harness));
  return () => {
    assert.ok(actions, "hook rendered");
    return actions;
  };
}

describe("ArcGIS Pro feature service import on desktop", () => {
  it("loads explicit sublayers through the native transport and reopens them", async () => {
    const actions = renderActions();
    const errors: unknown[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => errors.push(args);
    try {
      await act(() => actions().handleImportArcgisProject());
    } finally {
      console.error = originalError;
    }

    // The down service is reported; the rest of the project loaded.
    assert.deepEqual(
      actions().arcgisImportWarnings?.map((warning) => [warning.layerName, warning.reason]),
      [["Hydrants", "service-unavailable"]],
    );
    const state = useAppStore.getState();
    const groups = new Map(state.layerGroups.map((group) => [group.name, group]));
    assert.equal(groups.get("Network")?.parentId, groups.get("Utilities")?.id);
    const network = groups.get("Network")?.id;
    const utilities = groups.get("Utilities")?.id;
    // The store keeps a group's own layers together and each subgroup as its
    // own block, so Contours (Utilities) sits below the Network block, and the
    // services follow Hillshade inside it.
    assert.deepEqual(
      state.layers.map((layer) => [layer.name, layer.groupId]),
      [
        ["Streets", utilities],
        ["Contours", utilities],
        ["Hillshade", network],
        ["Mains", network],
        ["Valves", network],
        ["Pumps", groups.get("Treatment")?.id],
        ["Outfalls", groups.get("Treatment")?.id],
        ["Tanks", groups.get("Storage")?.id],
        ["Filters", groups.get("Intake")?.id],
      ],
    );
    const services = state.layers.filter((layer) => layer.source.arcgisQueryUrl);
    const imported = services.map((layer) => ({
      name: layer.name,
      visible: layer.visible,
      opacity: layer.opacity,
      groupId: layer.groupId,
      arcgisQueryUrl: layer.source.arcgisQueryUrl,
      arcgisLayerUri: layer.metadata.arcgisLayerUri,
    }));
    assert.deepEqual(imported, [
      {
        name: "Mains",
        visible: true,
        opacity: 1,
        groupId: network,
        arcgisQueryUrl: `${SERVICE}/3/query`,
        arcgisLayerUri: "CIMPATH=map/mains.json",
      },
      {
        name: "Valves",
        visible: false,
        opacity: 0.6,
        groupId: network,
        arcgisQueryUrl: `${SERVICE}/5/query`,
        arcgisLayerUri: "CIMPATH=map/valves.json",
      },
      {
        name: "Pumps",
        visible: true,
        opacity: 1,
        groupId: groups.get("Treatment")?.id,
        arcgisQueryUrl: `${SERVICE}/7/query`,
        arcgisLayerUri: "CIMPATH=map/pumps.json",
      },
      {
        name: "Filters",
        visible: true,
        opacity: 1,
        groupId: groups.get("Intake")?.id,
        arcgisQueryUrl: `${SERVICE}/9/query`,
        arcgisLayerUri: "CIMPATH=map/filters.json",
      },
    ]);
    // Every REST request went through Rust, to the explicit sublayers only.
    assert.ok(nativeRequests.some((url) => url.startsWith(`${SERVICE}/3?`)));
    assert.ok(nativeRequests.some((url) => url.startsWith(`${SERVICE}/5?`)));
    assert.ok(nativeRequests.some((url) => url.startsWith(`${DOWN}/1?`)));
    assert.ok(!nativeRequests.some((url) => /\/FeatureServer\/0\b/.test(url)));
    // The saved extent survived: no service zoomed the map to itself.
    assert.deepEqual(state.mapView.center, [-75, 35]);

    // Save and reopen through the desktop dialog.
    await act(() => actions().handleSave());
    resetStores();
    dialogPath = SAVED_PATH;
    await act(() => actions().handleOpenFromFile());
    const reopened = useAppStore.getState();
    assert.deepEqual(
      reopened.layers
        .filter((layer) => layer.source.arcgisQueryUrl)
        .map((layer) => [
          layer.name,
          layer.visible,
          layer.opacity,
          layer.groupId,
          layer.source.arcgisQueryUrl,
        ]),
      imported.map((layer) => [
        layer.name,
        layer.visible,
        layer.opacity,
        layer.groupId,
        layer.arcgisQueryUrl,
      ]),
    );
    assert.deepEqual(
      reopened.layerGroups.map((group) => [group.name, group.parentId ?? null]),
      [
        ["Utilities", null],
        ["Network", groups.get("Utilities")?.id],
        ["Treatment", null],
        ["Storage", groups.get("Treatment")?.id],
        ["Intake", groups.get("Treatment")?.id],
      ],
    );
    assert.deepEqual(parseProject(savedText).mapView.center, [-75, 35]);

    // The project's token never left the project file.
    for (const text of [savedText, nativeRequests.join("\n"), JSON.stringify(errors)]) {
      assert.doesNotMatch(text, new RegExp(SECRET));
    }
  });

  it("offers a sign-in token only to its own organisation's services", async () => {
    const online = ARCGIS_ONLINE_PORTAL;
    const org = "https://myorg.maps.arcgis.com";
    const enterprise = "https://gis.example.org/portal";
    const ORG = "AbCdEfGh12345678";
    const hosted = (orgId: string) =>
      `https://services3.arcgis.com/${orgId}/arcgis/rest/services/Water/FeatureServer/3`;
    const orgIds: Record<string, string> = { [online]: ORG, [org]: ORG };
    const lookups: string[] = [];
    const signIn = (url: string, portals: string[], failing: string[] = []) =>
      signInForImportedService(url, {
        portals,
        token: async (portal) => {
          if (failing.includes(portal)) throw new Error("refresh failed");
          return `token-for-${portal}`;
        },
        orgId: async (portal) => {
          lookups.push(portal);
          return orgIds[portal];
        },
      });

    // The user's own organisation's hosted service gets the token.
    assert.deepEqual(await signIn(hosted(ORG), [online]), {
      portal: online,
      token: `token-for-${online}`,
    });
    assert.deepEqual(await signIn(hosted(ORG), [org]), { portal: org, token: `token-for-${org}` });
    // Another organisation's service on the same shared hosting does not.
    assert.equal(await signIn(hosted("ZzZzZzZz87654321"), [online, org]), null);
    // Nor does any other *.arcgis.com host, an untrusted host, or plain HTTP.
    assert.equal(
      await signIn("https://utility.arcgis.com/usrsvcs/servers/x/rest/services/A/FeatureServer/0", [
        online,
      ]),
      null,
    );
    assert.equal(await signIn(`${SERVICE}/3`, [online, org]), null);
    // An Enterprise portal's own host gets its token without an organisation check.
    const lookupsBefore = lookups.length;
    assert.deepEqual(
      await signIn("https://gis.example.org/server/rest/services/A/FeatureServer/0", [enterprise]),
      { portal: enterprise, token: `token-for-${enterprise}` },
    );
    assert.equal(lookups.length, lookupsBefore);
    assert.equal(
      await signIn("http://gis.example.org/server/rest/services/A/FeatureServer/0", [enterprise]),
      null,
    );
    // A session whose token cannot be read is skipped; the next one is tried.
    assert.deepEqual(await signIn(hosted(ORG), [online, org], [online]), {
      portal: org,
      token: `token-for-${org}`,
    });
    assert.equal(await signIn(hosted(ORG), [online], [online]), null);
  });

  it("keeps a layer placed another way with its group when services move past it", () => {
    // Project order: services S1 and S2 at the root, then group G holding file
    // layer A. Raster R was added to G after load, so it is not ranked.
    const layer = (id: string, groupId?: string) =>
      geojsonLayer({ id, name: id, ...(groupId ? { groupId } : {}) });
    useAppStore.setState({
      layerGroups: [{ id: "g", name: "G", visible: true, collapsed: false, opacity: 1 }],
      layers: [layer("A", "g"), layer("R", "g"), layer("S1"), layer("S2")],
    });
    placeImportedServiceLayers(
      ["A"],
      [
        { layerId: "S1", nextLayerIds: ["A"] },
        { layerId: "S2", nextLayerIds: ["A"] },
      ],
    );
    assert.deepEqual(
      useAppStore.getState().layers.map((item) => item.id),
      ["S1", "S2", "A", "R"],
    );
  });
});
