import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { parseHTML } from "linkedom";
import {
  arcgisPortalItemPageUrl,
  arcgisPortalRestBase,
  arcgisPortalThumbnailUrl,
  buildPortalSearchQuery,
  buildPortalSearchUrl,
  fetchPortalUser,
  fetchPortalWebMapLayers,
  isTrustedPortalServiceUrl,
  portalItemBounds,
  portalItemLayerType,
  type ArcGisPortalUser,
} from "../packages/plugins/src/plugins/arcgis-portal-api";
import {
  ARCGIS_PORTAL_PLUGIN_ID,
  maplibreArcGisPortalPlugin,
  setArcGisPortalAuth,
  type ArcGisPortalAuth,
  type ArcGisPortalConnection,
} from "../packages/plugins/src/plugins/maplibre-arcgis-portal";
import { WEB_SERVICE_PLUGIN_IDS } from "../packages/plugins/src/plugins/web-service-sync";
import type { GeoLibreAppAPI } from "../packages/plugins/src/types";

const GROUP = "0123456789abcdef0123456789abcdef";
const FAVORITES = "fedcba9876543210fedcba9876543210";
const USER: ArcGisPortalUser = {
  username: "jane.doe@utk",
  orgId: "AbCdEfGhIjKlMnOp",
  favGroupId: FAVORITES,
  groups: [{ id: GROUP, title: "Field crews" }],
};

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("arcgisPortalRestBase", () => {
  it("routes an ArcGIS Online organization through www.arcgis.com", () => {
    assert.equal(arcgisPortalRestBase("https://myorg.maps.arcgis.com"), "https://www.arcgis.com");
    assert.equal(arcgisPortalRestBase("https://www.arcgis.com"), "https://www.arcgis.com");
  });

  it("keeps an Enterprise portal as it is", () => {
    assert.equal(
      arcgisPortalRestBase("https://gis.example.org/portal"),
      "https://gis.example.org/portal",
    );
  });

  it("links item pages to the portal the user signed in to", () => {
    assert.equal(
      arcgisPortalItemPageUrl("https://myorg.maps.arcgis.com", "abc"),
      "https://myorg.maps.arcgis.com/home/item.html?id=abc",
    );
  });
});

describe("buildPortalSearchQuery", () => {
  const types = '(type:"Feature Service")';

  it("scopes each view", () => {
    const query = (view: Parameters<typeof buildPortalSearchQuery>[0]["view"]) =>
      buildPortalSearchQuery({ view, user: USER, groupId: GROUP, types: ["Feature Service"] });
    assert.equal(query("content"), `owner:"jane.doe@utk" AND ${types}`);
    assert.equal(query("favorites"), `group:${FAVORITES} AND ${types}`);
    assert.equal(query("groups"), `group:${GROUP} AND ${types}`);
    assert.equal(query("organization"), `orgid:${USER.orgId} AND ${types}`);
    assert.equal(query("portal"), types);
  });

  it("returns null when a view has nothing to search", () => {
    const bare: ArcGisPortalUser = { username: "jane", groups: [] };
    assert.equal(buildPortalSearchQuery({ view: "favorites", user: bare }), null);
    assert.equal(buildPortalSearchQuery({ view: "organization", user: bare }), null);
    assert.equal(buildPortalSearchQuery({ view: "groups", user: bare }), null);
  });

  it("refuses ids and usernames that could break out of the query", () => {
    assert.equal(
      buildPortalSearchQuery({ view: "groups", user: USER, groupId: "x OR owner:esri" }),
      null,
    );
    assert.equal(
      buildPortalSearchQuery({ view: "content", user: { username: 'a" OR "b', groups: [] } }),
      null,
    );
  });

  it("sanitizes keywords and keeps web mapping applications out", () => {
    const query = buildPortalSearchQuery({ view: "portal", user: USER, text: "roads (2024)" });
    assert.match(query ?? "", /^\(roads 2024\) AND \(/);
    assert.match(query ?? "", /type:"Web Map"\) -type:"Web Mapping Application"$/);
  });

  it("ignores item types the panel cannot add", () => {
    assert.equal(
      buildPortalSearchQuery({ view: "portal", user: USER, types: ["constructor", "Map Service"] }),
      '(type:"Map Service")',
    );
  });
});

describe("isTrustedPortalServiceUrl", () => {
  it("trusts Esri hosting for ArcGIS Online and its organizations", () => {
    for (const portal of ["https://www.arcgis.com", "https://myorg.maps.arcgis.com"]) {
      assert.ok(
        isTrustedPortalServiceUrl(portal, "https://services3.arcgis.com/x/FeatureServer/0"),
      );
      assert.ok(isTrustedPortalServiceUrl(portal, "https://tiles.arcgis.com/x/VectorTileServer"));
    }
  });

  it("trusts only the portal's own host for Enterprise", () => {
    const portal = "https://gis.example.org/portal";
    assert.ok(
      isTrustedPortalServiceUrl(portal, "https://gis.example.org/server/rest/services/a/MapServer"),
    );
    assert.equal(
      isTrustedPortalServiceUrl(portal, "https://services.arcgis.com/x/FeatureServer"),
      false,
    );
  });

  it("refuses foreign, look-alike, plain-http and credentialed URLs", () => {
    const portal = "https://www.arcgis.com";
    assert.equal(isTrustedPortalServiceUrl(portal, "https://evil.example/FeatureServer/0"), false);
    assert.equal(isTrustedPortalServiceUrl(portal, "https://arcgis.com.evil.example/x"), false);
    assert.equal(isTrustedPortalServiceUrl(portal, "https://evilarcgis.com/x"), false);
    assert.equal(isTrustedPortalServiceUrl(portal, "http://services.arcgis.com/x"), false);
    assert.equal(isTrustedPortalServiceUrl(portal, "https://u:p@services.arcgis.com/x"), false);
    assert.equal(isTrustedPortalServiceUrl(portal, "not a url"), false);
  });
});

describe("portal URLs", () => {
  it("searches through the REST base with paging, sort and token", () => {
    const url = new URL(
      buildPortalSearchUrl("https://myorg.maps.arcgis.com", "q", { start: 21, token: "t" }),
    );
    assert.equal(url.origin + url.pathname, "https://www.arcgis.com/sharing/rest/search");
    assert.equal(url.searchParams.get("start"), "21");
    assert.equal(url.searchParams.get("sortField"), "modified");
    assert.equal(url.searchParams.get("token"), "t");
  });

  it("adds the token to a thumbnail only for non-public items, without dot segments", () => {
    const portal = "https://gis.example.org/portal";
    const secured = arcgisPortalThumbnailUrl(
      portal,
      { id: "i", thumbnail: "../../thumbnail/a.png", access: "org" },
      "t",
    );
    assert.equal(
      secured,
      "https://gis.example.org/portal/sharing/rest/content/items/i/info/thumbnail/a.png?token=t",
    );
    const open = arcgisPortalThumbnailUrl(
      portal,
      { id: "i", thumbnail: "a.png", access: "public" },
      "t",
    );
    assert.equal(new URL(open ?? "").searchParams.has("token"), false);
    assert.equal(arcgisPortalThumbnailUrl(portal, { id: "i" }), null);
  });
});

describe("portal items", () => {
  it("maps supported item types and nothing inherited", () => {
    assert.equal(portalItemLayerType("Vector Tile Service"), "vector-tile");
    assert.equal(portalItemLayerType("Web Map"), "web-map");
    assert.equal(portalItemLayerType("Web Mapping Application"), undefined);
    assert.equal(portalItemLayerType("constructor"), undefined);
  });

  it("reads geographic bounds only", () => {
    assert.deepEqual(
      portalItemBounds({
        extent: [
          [-84, 35],
          [-83, 36],
        ],
      }),
      [-84, 35, -83, 36],
    );
    assert.equal(
      portalItemBounds({
        extent: [
          [0, 0],
          [500000, 4000000],
        ],
      }),
      null,
    );
    assert.equal(portalItemBounds({}), null);
  });

  it("reads the signed-in user and drops malformed groups", async () => {
    const requests: URL[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      requests.push(new URL(String(input)));
      return Response.json({
        username: "jane",
        orgId: USER.orgId,
        favGroupId: FAVORITES,
        groups: [{ id: GROUP, title: "Zeta" }, { id: "bad" }, { id: FAVORITES, title: "Alpha" }],
      });
    }) as typeof fetch;
    const user = await fetchPortalUser("https://myorg.maps.arcgis.com", "t");
    assert.equal(
      requests[0].href,
      "https://www.arcgis.com/sharing/rest/community/self?f=json&token=t",
    );
    assert.deepEqual(
      user.groups.map((group) => group.title),
      ["Alpha", "Zeta"],
    );
  });

  it("reports a portal error envelope", async () => {
    globalThis.fetch = (async () =>
      Response.json({ error: { code: 498, message: "Invalid token." } })) as typeof fetch;
    await assert.rejects(fetchPortalUser("https://www.arcgis.com", "t"), /Invalid token/);
  });

  it("lists a web map's addable layers", async () => {
    globalThis.fetch = (async () =>
      Response.json({
        operationalLayers: [
          { layerType: "ArcGISFeatureLayer", title: "Roads", url: "https://s/FeatureServer/0" },
          {
            layerType: "GroupLayer",
            layers: [
              { layerType: "ArcGISMapServiceLayer", title: "Parcels", url: "https://s/MapServer" },
            ],
          },
          { layerType: "VectorTileLayer", title: "Base", styleUrl: "https://s/style.json" },
        ],
      })) as typeof fetch;
    const layers = await fetchPortalWebMapLayers("https://www.arcgis.com", "m", "t");
    assert.deepEqual(layers, [
      { title: "Roads", url: "https://s/FeatureServer/0", layerType: "feature" },
      { title: "Parcels", url: "https://s/MapServer", layerType: "map-service" },
    ]);
  });
});

describe("ArcGIS Portal plugin", () => {
  it("is a Web Services plugin", () => {
    assert.ok(WEB_SERVICE_PLUGIN_IDS.includes(ARCGIS_PORTAL_PLUGIN_ID));
  });

  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  /** Open the panel against a fake app, sign-in and portal. */
  const openPanel = (connections: ArcGisPortalConnection[]) => {
    const { document, window } = parseHTML("<html><body></body></html>");
    Object.assign(globalThis, { document, window });
    const requests: URL[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      requests.push(url);
      if (url.pathname.endsWith("/community/self")) {
        return Response.json({ ...USER, username: "jane" });
      }
      return Response.json({
        results: [{ id: "item1", title: "Roads", owner: "jane", type: "Feature Service" }],
        total: 1,
        nextStart: -1,
      });
    }) as typeof fetch;
    const signIns: [string, string][] = [];
    const auth: ArcGisPortalAuth = {
      connections: () => connections,
      subscribe: () => () => {},
      normalizePortalUrl: (input) => input.trim() || "https://www.arcgis.com",
      clientId: (portal) => (portal.includes("myorg") ? "org-client" : "default-client"),
      signIn: async (portalUrl, clientId) => {
        signIns.push([portalUrl, clientId]);
        return { portal: "https://www.arcgis.com", username: "jane" };
      },
      signOut: async () => {},
      getToken: async () => "secret",
      tokenProvider: () => async () => "secret",
      errorMessage: (error) => String(error),
    };
    setArcGisPortalAuth(auth);
    const container = document.createElement("div");
    document.body.append(container);
    const opened: string[] = [];
    const app = {
      registerRightPanel: (panel: { render: (el: HTMLElement) => void }) => {
        panel.render(container);
        return () => {};
      },
      openRightPanel: () => true,
      closeRightPanel: () => {},
      openExternalUrl: (url: string) => opened.push(url),
    } as unknown as GeoLibreAppAPI;
    maplibreArcGisPortalPlugin.activate(app);
    const button = (label: string) =>
      Array.from(container.querySelectorAll("button")).find(
        (candidate) => candidate.textContent === label,
      ) as HTMLButtonElement;
    return {
      container,
      window,
      requests,
      signIns,
      opened,
      button,
      close: () => {
        maplibreArcGisPortalPlugin.deactivate?.(app);
        setArcGisPortalAuth(null);
      },
    };
  };

  it("asks to sign in, with the remembered client ID filled in", async () => {
    const panel = openPanel([]);
    try {
      const inputs = Array.from(panel.container.querySelectorAll("input"));
      assert.equal(inputs[1].value, "default-client");
      panel.container.querySelector("form")?.dispatchEvent(new panel.window.Event("submit"));
      await settle();
      assert.deepEqual(panel.signIns, [["", "default-client"]]);
      assert.equal(panel.requests.length, 0);
    } finally {
      panel.close();
    }
  });

  it("starts with the portal last signed in to, and remembers the next one", async () => {
    const stored = new Map([
      ["geolibre:arcgis-portal:last-portal", "https://myorg.maps.arcgis.com"],
    ]);
    const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: (key: string) => stored.get(key) ?? null,
        setItem: (key: string, value: string) => stored.set(key, value),
      },
    });
    const panel = openPanel([]);
    try {
      const [portalInput, clientInput] = Array.from(panel.container.querySelectorAll("input"));
      assert.equal(portalInput.value, "https://myorg.maps.arcgis.com");
      assert.equal(clientInput.value, "org-client");
      portalInput.value = "";
      portalInput.dispatchEvent(new panel.window.Event("input"));
      assert.equal(clientInput.value, "default-client");
      panel.container.querySelector("form")?.dispatchEvent(new panel.window.Event("submit"));
      await settle();
      assert.equal(stored.get("geolibre:arcgis-portal:last-portal"), "");
    } finally {
      panel.close();
      if (original) Object.defineProperty(globalThis, "localStorage", original);
      else delete (globalThis as { localStorage?: unknown }).localStorage;
    }
  });

  it("browses the user's own content through www.arcgis.com for an organization", async () => {
    const panel = openPanel([{ portal: "https://myorg.maps.arcgis.com", username: "jane" }]);
    try {
      await settle();
      await settle();
      const search = panel.requests.find((url) => url.pathname.endsWith("/search"));
      assert.equal(search?.origin, "https://www.arcgis.com");
      assert.match(search?.searchParams.get("q") ?? "", /^owner:"jane" AND /);
      assert.equal(search?.searchParams.get("token"), "secret");
      assert.match(panel.container.textContent ?? "", /Roads/);
      panel.button("Details").click();
      assert.deepEqual(panel.opened, ["https://myorg.maps.arcgis.com/home/item.html?id=item1"]);
    } finally {
      panel.close();
    }
  });
});
