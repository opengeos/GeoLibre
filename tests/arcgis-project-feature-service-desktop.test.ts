import { act, cleanup, render, resetStores, useAppStore } from "./helpers/dom";
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createElement } from "react";
import { createEmptyProject, parseProject } from "@geolibre/core";
import { setArcGISFetch } from "@geolibre/plugins";
import { strToU8 } from "fflate";
import { geojsonLayer } from "./helpers/layer-fixtures";
import type { ProjectFileActions } from "../apps/geolibre-desktop/src/hooks/useProjectFileActions";
import {
  aprx,
  groupLayer,
  hostedFeatureLayer,
  tiledServiceLayer,
} from "./helpers/arcgis-aprx-fixtures";

// Loaded after the harness so its CSS imports and Vite globals are handled.
const { useProjectFileActions } =
  await import("../apps/geolibre-desktop/src/hooks/useProjectFileActions");
const { installNativeArcGISFetch } = await import("../apps/geolibre-desktop/src/lib/arcgis-fetch");
const {
  ARCGIS_ONLINE_HOSTING,
  cachedOrgIdLookup,
  PLAIN_SERVICE_PATH,
  serviceTokenProvider,
  signInForImportedService,
} = await import("../apps/geolibre-desktop/src/lib/arcgis-project-services");
const { ARCGIS_ONLINE_PORTAL } = await import("../apps/geolibre-desktop/src/lib/arcgis-oauth");

/**
 * The desktop build's half of ArcGIS Pro feature service import: the Tauri
 * file dialog hands over the project, and every ArcGIS REST request goes
 * through the native `fetch_arcgis_response` command rather than the
 * webview's `fetch`. Tauri's IPC is stood in for at `__TAURI_INTERNALS__`, so
 * the hook, the importer, the ArcGIS loader and the native transport are all
 * the shipped code. The browser half is `e2e/arcgis-project-feature-service.spec.ts`.
 * The import session itself is tested in `tests/project-import-session.test.ts`
 * and `tests/component-arcgis-project-import.test.ts`; this file checks each
 * point where this import can be superseded.
 */

const SERVICE = "https://gis.fixture.test/arcgis/rest/services/Water/FeatureServer";
const DOWN = "https://down.fixture.test/arcgis/rest/services/Hydrants/FeatureServer";
const SECRET = "fixture-secret-token";
const APRX_PATH = "/Users/me/projects/water.aprx";
const SAVED_PATH = "/Users/me/projects/water.geolibre.json";

/** A hosted layer whose connection string carries a token that must go nowhere. */
const hosted = (name: string, root: string, dataset: string, extra = {}) =>
  hostedFeatureLayer(name, `${root}?token=${SECRET}`, dataset, extra);

// Top first, as ArcGIS Pro lists them. The services sit between project
// layers, and inside a nested group below one, so their place is checked
// against both. Hydrants' service is down.
const APRX = aprx(["Streets", "Utilities", "Contours", "Hydrants"], {
  Streets: tiledServiceLayer("Streets"),
  Utilities: groupLayer("Utilities", ["Network"]),
  Network: groupLayer("Network", ["Hillshade", "Mains", "Valves"]),
  Hillshade: tiledServiceLayer("Hillshade"),
  Mains: hosted("Mains", SERVICE, "3"),
  Valves: hosted("Valves", SERVICE, "5", { visibility: false, transparency: 40 }),
  Contours: tiledServiceLayer("Contours"),
  Hydrants: hosted("Hydrants", DOWN, "1"),
});

/** The fixture FeatureServer, answered as the Rust command would. */
function serviceResponse(url: URL): { status: number; body: string; contentType?: string } {
  const match = url.href.startsWith(SERVICE)
    ? url.pathname.match(/\/FeatureServer\/(3|5)(\/query)?$/)
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
let onServiceRequest: (() => void) | null = null;
let onRasterRead: (() => void) | null = null;
let rasterReads: string[] = [];
let allowRasters = false;

/** A GeoTIFF layer read from `/data`, which only the desktop build loads. */
const rasterLayer = (name: string) => ({
  type: "CIMRasterLayer",
  name,
  uRI: `CIMPATH=map/${name.toLowerCase()}.json`,
  dataConnection: { workspaceConnectionString: "DATABASE=/data", dataset: `${name}.tif` },
});
const RASTER_APRX_PATH = "/Users/me/projects/rasters.aprx";
const TILED_APRX_PATH = "/Users/me/projects/tiled.aprx";
const archives: Record<string, Uint8Array> = {
  [APRX_PATH]: APRX,
  [RASTER_APRX_PATH]: aprx(["dem", "slope", "Mains"], {
    dem: rasterLayer("dem"),
    slope: rasterLayer("slope"),
    Mains: hosted("Mains", SERVICE, "3"),
  }),
  [TILED_APRX_PATH]: aprx(["Streets"], { Streets: tiledServiceLayer("Streets") }),
};

beforeEach(async () => {
  nativeRequests = [];
  let callbackId = 0;
  globals.__TAURI_INTERNALS__ = {
    transformCallback: () => ++callbackId,
    convertFileSrc: (path: string, protocol = "asset") => `${protocol}://localhost${path}`,
    invoke: async (cmd: string, args: Record<string, unknown>, ipc?: { headers?: unknown }) => {
      switch (cmd) {
        case "plugin:dialog|open":
          return dialogPath;
        case "plugin:fs|read_file":
          assert.ok(archives[String(args.path)], String(args.path));
          return Array.from(archives[String(args.path)]);
        case "allow_raster_asset":
          rasterReads.push(String(args.path));
          onRasterRead?.();
          if (allowRasters) return null;
          throw new Error("raster read refused in this test");
        case "plugin:fs|read_text_file":
          assert.equal(args.path, SAVED_PATH);
          return Array.from(strToU8(savedText));
        case "fetch_arcgis_response":
          nativeRequests.push(String(args.url));
          onServiceRequest?.();
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
  onServiceRequest = null;
  onRasterRead = null;
  rasterReads = [];
  allowRasters = false;
  dialogPath = APRX_PATH;
  cleanup();
  resetStores();
  setArcGISFetch(null);
  delete globals.__TAURI_INTERNALS__;
});

function renderActions(
  mapControllerRef: Parameters<typeof useProjectFileActions>[0] = { current: null },
): () => ProjectFileActions {
  let actions: ProjectFileActions | null = null;
  function Harness() {
    actions = useProjectFileActions(mapControllerRef);
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
    const groups = new Map(state.layerGroups.map((group) => [group.name, group.id]));
    const network = groups.get("Network");
    // ArcGIS Pro's drawing order, bottom first as the store keeps it: the
    // services land below Hillshade inside their group, not on top.
    assert.deepEqual(
      state.layers.map((layer) => [layer.name, layer.groupId]),
      [
        ["Contours", undefined],
        ["Valves", network],
        ["Mains", network],
        ["Hillshade", network],
        ["Streets", undefined],
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
      importedFrom: layer.metadata.importedFrom,
    }));
    const service = (name: string, sublayer: number, visible: boolean, opacity: number) => ({
      name,
      visible,
      opacity,
      groupId: network,
      arcgisQueryUrl: `${SERVICE}/${sublayer}/query`,
      arcgisLayerUri: `CIMPATH=map/${name.toLowerCase()}.json`,
      importedFrom: "arcgis-pro",
    });
    assert.deepEqual(imported, [service("Valves", 5, false, 0.6), service("Mains", 3, true, 1)]);
    // Every REST request went through Rust, to the explicit sublayers only.
    assert.ok(nativeRequests.some((url) => url.startsWith(`${SERVICE}/3?`)));
    assert.ok(nativeRequests.some((url) => url.startsWith(`${SERVICE}/5?`)));
    assert.ok(nativeRequests.some((url) => url.startsWith(`${DOWN}/1?`)));
    assert.ok(!nativeRequests.some((url) => /\/FeatureServer\/0\b/.test(url)));
    // The saved extent survived: no service zoomed the map to itself.
    assert.deepEqual(state.mapView.center, [-75, 35]);
    assert.equal(state.isDirty, true);

    // Save and reopen through the desktop dialog.
    await act(() => actions().handleSave());
    resetStores();
    dialogPath = SAVED_PATH;
    await act(() => actions().handleOpenFromFile());
    const reopened = useAppStore.getState();
    assert.deepEqual(
      reopened.layers.map((layer) => layer.name),
      state.layers.map((layer) => layer.name),
    );
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
        ["Network", groups.get("Utilities")],
      ],
    );
    assert.deepEqual(parseProject(savedText).mapView.center, [-75, 35]);

    // The project's token never left the project file.
    for (const text of [savedText, nativeRequests.join("\n"), JSON.stringify(errors)]) {
      assert.doesNotMatch(text, new RegExp(SECRET));
    }
  });

  /** Opens another project, with a layer of its own, as the user would mid-import. */
  let historyAtSwitch = -1;
  let rasterGranted = false;
  function switchProject() {
    const other = createEmptyProject("Other");
    other.layers = [geojsonLayer({ id: "their-layer", name: "Their layer" })];
    useAppStore.getState().loadProject(other, null);
    historyAtSwitch = useAppStore.temporal.getState().pastStates.length;
  }

  /** Switches project during the first of the two frames the import waits for the map. */
  function switchOnFirstFrame(): () => void {
    const originalFrame = globalThis.requestAnimationFrame;
    let switched = false;
    globalThis.requestAnimationFrame = (callback) =>
      originalFrame((time) => {
        if (!switched) {
          switched = true;
          switchProject();
        }
        callback(time);
      });
    return () => {
      globalThis.requestAnimationFrame = originalFrame;
      assert.ok(switched);
    };
  }

  // Each point where the import awaits, and so where the user can open another
  // project. Whatever the import was doing, the replacement keeps its own
  // layers, stays clean, gains no undo step and shows no import report.
  const switches: {
    name: string;
    path?: string;
    arm: () => (() => void) | void;
    mapControllerRef?: Parameters<typeof useProjectFileActions>[0];
    requests: (urls: string[]) => void;
    reads?: string[];
  }[] = [
    {
      name: "the first feature service request",
      arm: () => {
        onServiceRequest = () => {
          onServiceRequest = null;
          switchProject();
        };
      },
      // Only the first service was asked for; the rest of the old import stopped.
      requests: (urls) => {
        assert.ok(urls.length > 0);
        assert.ok(
          urls.every((url) => url.startsWith(`${SERVICE}/3`)),
          urls.join(),
        );
      },
    },
    {
      name: "the map settling, before any service loads",
      arm: switchOnFirstFrame,
      requests: (urls) => assert.deepEqual(urls, []),
    },
    {
      name: "the map settling, with nothing left to load",
      path: TILED_APRX_PATH,
      arm: switchOnFirstFrame,
      requests: (urls) => assert.deepEqual(urls, []),
    },
    {
      // The read is refused, so the import would go on to the next raster.
      name: "a raster file read",
      path: RASTER_APRX_PATH,
      arm: () => {
        onRasterRead = () => {
          onRasterRead = null;
          switchProject();
        };
      },
      requests: (urls) => assert.deepEqual(urls, []),
      reads: ["/data/dem.tif"],
    },
    {
      name: "a raster load",
      path: RASTER_APRX_PATH,
      // The switch lands inside the raster add: the first time the import asks
      // for the map after the first raster file was granted.
      arm: () => {
        allowRasters = true;
        onRasterRead = () => {
          onRasterRead = null;
          rasterGranted = true;
        };
      },
      mapControllerRef: {
        get current() {
          if (rasterGranted) {
            rasterGranted = false;
            switchProject();
          }
          return null;
        },
      } as Parameters<typeof useProjectFileActions>[0],
      requests: (urls) => assert.deepEqual(urls, []),
      reads: ["/data/dem.tif"],
    },
  ];

  for (const { name, path, arm, mapControllerRef, requests, reads } of switches) {
    it(`adds nothing to a project opened during ${name}`, async () => {
      if (path) dialogPath = path;
      historyAtSwitch = -1;
      rasterGranted = false;
      const actions = renderActions(mapControllerRef);
      const disarm = arm();
      const originalError = console.error;
      console.error = () => {};
      try {
        await act(() => actions().handleImportArcgisProject());
      } finally {
        console.error = originalError;
        disarm?.();
      }
      const state = useAppStore.getState();
      assert.equal(state.projectName, "Other");
      assert.deepEqual(
        state.layers.map((layer) => layer.id),
        ["their-layer"],
      );
      assert.equal(state.isDirty, false);
      assert.equal(useAppStore.temporal.getState().pastStates.length, historyAtSwitch);
      assert.equal(actions().arcgisImportWarnings, null);
      requests(nativeRequests);
      if (reads) assert.deepEqual(rasterReads, reads);
    });
  }
});

describe("tokens for an imported project's services", () => {
  const ORG = "AbCdEfGh12345678";
  const online = ARCGIS_ONLINE_PORTAL;
  const org = "https://myorg.maps.arcgis.com";
  const enterprise = "https://gis.example.org/portal";
  const hostedIn = (orgId: string, host = "services3.arcgis.com") =>
    `https://${host}/${orgId}/arcgis/rest/services/Water/FeatureServer/3`;
  const OTHER = "ZzZzZzZz87654321";
  const orgIds: Record<string, string> = { [online]: ORG, [org]: ORG };
  const cases: {
    name: string;
    url: string;
    portals: string[];
    failing?: string[];
    expected: string | null;
    lookups?: number;
  }[] = [
    { name: "own organisation, Online", url: hostedIn(ORG), portals: [online], expected: online },
    { name: "own organisation, org portal", url: hostedIn(ORG), portals: [org], expected: org },
    {
      name: "another organisation on the shared hosting",
      url: hostedIn(OTHER),
      portals: [online, org],
      expected: null,
    },
    // The same holds on the unnumbered and regional hosting servers.
    ...["services.arcgis.com", "services-eu1.arcgis.com", "SERVICES-AP1.arcgis.com"].flatMap(
      (host) => [
        {
          name: `own organisation on ${host}`,
          url: hostedIn(ORG, host),
          portals: [online],
          expected: online,
        },
        {
          name: `another organisation on ${host}`,
          url: hostedIn(OTHER, host),
          portals: [online, org],
          expected: null,
        },
      ],
    ),
    // A host that only looks like the shared hosting never gets the token,
    // even with the user's own organisation id in its path.
    ...[
      "services-eu1.arcgis.com.evil.example",
      "evilservices-eu1.arcgis.com",
      "services-eu1x.arcgis.com",
      "services-eu.arcgis.com",
      "services-1.arcgis.com",
      "services-eu1.evil.arcgis.com",
      "services-eu1.arcgis.com.",
    ].map((host) => ({
      name: `look-alike host ${host}`,
      url: hostedIn(ORG, host),
      portals: [online, org],
      expected: null,
    })),
    // Nor does a path that carries the user's organisation id first but could
    // be resolved into another organisation's folder by the server.
    ...[
      `${ORG}/%2e%2e%2f${OTHER}/arcgis/rest/services/Water/FeatureServer/3`,
      `${ORG}/..;/${OTHER}/arcgis/rest/services/Water/FeatureServer/3`,
      `${ORG}/%2E%2E%5C${OTHER}/arcgis/rest/services/Water/FeatureServer/3`,
      `${ORG}/arcgis;x/rest/services/Water/FeatureServer/3`,
      `${ORG}/arcgis/rest/services/Water/FeatureServer/3/%2e%2e%2f%2e%2e%2f%2e%2e%2fZzZz`,
    ].map((path) => ({
      name: `unsafe path ${path}`,
      url: `https://services-eu1.arcgis.com/${path}`,
      portals: [online, org],
      expected: null,
    })),
    {
      name: "a trailing slash is still a plain path",
      url: `${hostedIn(ORG, "services-eu1.arcgis.com")}/`,
      portals: [online],
      expected: online,
    },
    {
      name: "another *.arcgis.com host",
      url: "https://utility.arcgis.com/usrsvcs/servers/x/rest/services/A/FeatureServer/0",
      portals: [online],
      expected: null,
    },
    { name: "an untrusted host", url: `${SERVICE}/3`, portals: [online, org], expected: null },
    {
      name: "Enterprise portal's own host, without an organisation lookup",
      url: "https://gis.example.org/server/rest/services/A/FeatureServer/0",
      portals: [enterprise],
      expected: enterprise,
      lookups: 0,
    },
    {
      name: "plain http on the Enterprise host",
      url: "http://gis.example.org/server/rest/services/A/FeatureServer/0",
      portals: [enterprise],
      expected: null,
    },
    {
      name: "a session whose token cannot be read is skipped",
      url: hostedIn(ORG),
      portals: [online, org],
      failing: [online],
      expected: org,
    },
    {
      name: "no readable session",
      url: hostedIn(ORG),
      portals: [online],
      failing: [online],
      expected: null,
    },
  ];
  for (const { name, url, portals, failing = [], expected, lookups } of cases) {
    it(`signInForImportedService: ${name}`, async () => {
      const asked: string[] = [];
      const signIn = await signInForImportedService(url, {
        portals,
        token: async (portal) => {
          if (failing.includes(portal)) throw new Error("refresh failed");
          return `token-for-${portal}`;
        },
        orgId: async (portal) => {
          asked.push(portal);
          return orgIds[portal];
        },
      });
      assert.deepEqual(signIn, expected && { portal: expected, token: `token-for-${expected}` });
      if (lookups !== undefined) assert.equal(asked.length, lookups);
    });
  }

  it("matches only ArcGIS Online's hosting servers and plain service paths", () => {
    // Called directly: most look-alike hosts never reach the pattern, because
    // the portal trust check turns away anything outside arcgis.com first.
    for (const host of [
      "services.arcgis.com",
      "services3.arcgis.com",
      "services-eu1.arcgis.com",
      "services-ap1.arcgis.com",
    ]) {
      assert.equal(ARCGIS_ONLINE_HOSTING.test(host), true, host);
    }
    for (const host of [
      "services-eu1.arcgis.com.",
      "services-eu1.arcgis.com.evil.example",
      "evilservices-eu1.arcgis.com",
      "services-eu1x.arcgis.com",
      "services-eu.arcgis.com",
      "services-1.arcgis.com",
      "services-eu1.evil.arcgis.com",
      "tiles.arcgis.com",
    ]) {
      assert.equal(ARCGIS_ONLINE_HOSTING.test(host), false, host);
    }
    for (const path of ["/AbCd_12-3/arcgis/rest/services/Water/FeatureServer/3", "/AbCd/x/"]) {
      assert.equal(PLAIN_SERVICE_PATH.test(path), true, path);
    }
    for (const path of [
      "",
      "/",
      "//AbCd/x",
      "/AbCd/%2e%2e%2fZzZz/x",
      "/AbCd/..;/ZzZz/x",
      "/AbCd/arcgis;x/rest",
      "/AbCd/x.y",
    ]) {
      assert.equal(PLAIN_SERVICE_PATH.test(path), false, path);
    }
  });

  it("looks up a token's organisation once, and again after a failure", async () => {
    let calls = 0;
    const orgOf: Record<string, string> = { a: ORG, b: "ZzZzZzZz87654321" };
    const orgId = cachedOrgIdLookup(async (_portal, token) => {
      calls += 1;
      if (calls === 1) throw new Error("offline");
      return orgOf[token];
    });
    assert.equal(await orgId(online, "a"), undefined);
    assert.equal(await orgId(online, "a"), ORG);
    assert.equal(await orgId(online, "a"), ORG);
    assert.equal(calls, 2);
    // Another account's token on the same portal is never matched against the
    // first account's organisation.
    assert.equal(await orgId(online, "b"), "ZzZzZzZz87654321");
    assert.equal(calls, 3);
    // Only the portal's latest token is kept, so going back looks up again.
    assert.equal(await orgId(online, "a"), ORG);
    assert.equal(calls, 4);
  });

  it("withholds a renewed token from another account's organisation", async () => {
    const orgOf: Record<string, string> = { a: ORG, b: "ZzZzZzZz87654321" };
    let current = "a";
    const provider = serviceTokenProvider(
      hostedIn(ORG),
      online,
      async () => current,
      cachedOrgIdLookup(async (_portal, token) => orgOf[token]),
    );
    assert.equal(await provider(), "a");
    // The portal's session switches to an account in another organisation.
    current = "b";
    assert.equal(await provider(), undefined);
    // An Enterprise portal's own host keeps receiving its renewed token.
    const ownHost = serviceTokenProvider(
      "https://gis.example.org/server/rest/services/A/FeatureServer/0",
      enterprise,
      async () => current,
      async () => undefined,
    );
    assert.equal(await ownHost(), "b");
  });
});
