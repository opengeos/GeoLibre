import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  createEmptyProject,
  arcgisLocatorInputField,
  fetchArcGISLocatorInfo,
  GEOCODE_ATTRIBUTE_PREFIX,
  geocodeMatchToFeature,
  geocodeSuggest,
  geocoderSupportsSuggest,
  getGeocoderConfig,
  normalizeGeocodingLocator,
  geocodeForward,
  geocodeReverse,
  GeocoderServiceError,
  geocoderSupportsReverse,
  GeocoderUnsupportedError,
  getGeocodingProvider,
  normalizeArcGISLocatorUrl,
  parseArcGISLocatorInfo,
  parseProject,
  resolveGeocoderConfig,
  serializeProject,
  setGeocodingFetch,
  setGeocodingTokenProvider,
  type GeocodingLocator,
} from "@geolibre/core";
import {
  approveLocatorPortalToken,
  commitLocatorPortalApprovals,
  listLocatorPortalApprovals,
  revokeLocatorPortalApproval,
  discardStagedLocatorApprovals,
  locatorAcceptsPortalToken,
  resetLocatorFederationCache,
  resolveLocatorToken,
  stageLocatorPortalApproval,
} from "../apps/geolibre-desktop/src/lib/geocoding-auth";

const BASE = "https://gis.example.org/server/rest/services/Locators/Parcels/GeocodeServer";
const PARCELS: GeocodingLocator = {
  id: "parcels",
  name: "County Parcel Locator",
  url: BASE,
  singleLineField: "SingleLine",
  reverse: true,
  suggest: false,
};
const ASSETS: GeocodingLocator = {
  id: "assets",
  name: "Hydrant IDs",
  url: "https://gis.example.org/server/rest/services/Locators/Assets/GeocodeServer",
  addressFields: ["AssetID"],
  reverse: false,
};
const locatorConfig = (locator: GeocodingLocator = PARCELS) =>
  resolveGeocoderConfig({
    providerId: "arcgis-locator",
    locators: [locator],
    locatorId: locator.id,
  });

/** Record the URLs a stubbed geocoder fetch is asked for, answering with `body`. */
function stubFetch(body: unknown): string[] {
  const urls: string[] = [];
  setGeocodingFetch(async (input) => {
    urls.push(String(input));
    return Response.json(body);
  });
  return urls;
}

afterEach(() => {
  setGeocodingFetch(null);
  setGeocodingTokenProvider(null);
});

describe("normalizeArcGISLocatorUrl", () => {
  it("keeps the GeocodeServer base and drops operations, queries and credentials", () => {
    assert.equal(normalizeArcGISLocatorUrl(`${BASE}/`), BASE);
    assert.equal(normalizeArcGISLocatorUrl(`${BASE}/findAddressCandidates?SingleLine=x`), BASE);
    assert.equal(normalizeArcGISLocatorUrl(`${BASE}/reverseGeocode`), BASE);
    // A pasted token must never be stored.
    assert.equal(normalizeArcGISLocatorUrl(`${BASE}?token=secret#x`), BASE);
    assert.equal(
      normalizeArcGISLocatorUrl(
        "https://user:pw@gis.example.org/arcgis/rest/services/L/GeocodeServer",
      ),
      "https://gis.example.org/arcgis/rest/services/L/GeocodeServer",
    );
  });

  it("rejects anything that is not a GeocodeServer over HTTP(S)", () => {
    assert.equal(normalizeArcGISLocatorUrl(""), null);
    assert.equal(normalizeArcGISLocatorUrl("not a url"), null);
    assert.equal(
      normalizeArcGISLocatorUrl("https://gis.example.org/rest/services/Parcels/FeatureServer"),
      null,
    );
    assert.equal(normalizeArcGISLocatorUrl("ftp://gis.example.org/x/GeocodeServer"), null);
  });
});

describe("parseArcGISLocatorInfo", () => {
  it("reads the input fields and advertised operations", () => {
    assert.deepEqual(
      parseArcGISLocatorInfo({
        capabilities: "Geocode,ReverseGeocode,Suggest",
        singleLineAddressField: { name: "SingleLine" },
        addressFields: [{ name: "Address" }, { name: "City" }],
      }),
      {
        singleLineField: "SingleLine",
        addressFields: ["Address", "City"],
        reverse: true,
        suggest: true,
      },
    );
    // A forward-only asset locator without suggestions.
    assert.deepEqual(
      parseArcGISLocatorInfo({ capabilities: "Geocode", addressFields: [{ name: "AssetID" }] }),
      { singleLineField: undefined, addressFields: ["AssetID"], reverse: false, suggest: false },
    );
  });

  it("assumes geocode and reverse when an older server lists no capabilities", () => {
    const info = parseArcGISLocatorInfo({ singleLineAddressField: { name: "Single Line Input" } });
    assert.equal(info.reverse, true);
    assert.equal(info.suggest, false);
    assert.equal(info.singleLineField, "Single Line Input");
  });

  it("reports service errors, non-locators and locators that cannot geocode", () => {
    assert.throws(
      () => parseArcGISLocatorInfo({ error: { code: 499, message: "Token Required" } }),
      (error: unknown) => error instanceof GeocoderServiceError && error.isAuthError,
    );
    assert.throws(
      () => parseArcGISLocatorInfo({ layers: [] }),
      (error: unknown) => error instanceof GeocoderServiceError && !error.isAuthError,
    );
    assert.throws(
      () =>
        parseArcGISLocatorInfo({
          capabilities: "ReverseGeocode",
          singleLineAddressField: { name: "SingleLine" },
        }),
      GeocoderUnsupportedError,
    );
  });

  it("fetches the metadata from the normalized base URL with an optional token", async () => {
    const urls = stubFetch({
      capabilities: "Geocode",
      singleLineAddressField: { name: "SingleLine" },
    });
    await fetchArcGISLocatorInfo(`${BASE}/findAddressCandidates?token=old`, { token: "t1" });
    const url = new URL(urls[0]);
    assert.equal(`${url.origin}${url.pathname}`, BASE);
    assert.equal(url.searchParams.get("f"), "json");
    assert.equal(url.searchParams.get("token"), "t1");
  });
});

describe("arcgis-locator provider config", () => {
  it("is selectable without a key and derives endpoints from the selected locator", () => {
    const provider = getGeocodingProvider("arcgis-locator");
    assert.equal(provider.id, "arcgis-locator");
    assert.equal(provider.requiresApiKey, false);
    const config = resolveGeocoderConfig({
      providerId: "arcgis-locator",
      locators: [PARCELS, ASSETS],
      locatorId: "assets",
      // Overrides belong to the built-in providers and are ignored here.
      forwardEndpoint: "https://elsewhere.example.org/search",
    });
    assert.equal(config.locator?.id, "assets");
    assert.equal(config.forwardEndpoint, `${ASSETS.url}/findAddressCandidates`);
    assert.equal(config.reverseEndpoint, `${ASSETS.url}/reverseGeocode`);
    // An unknown id falls back to the first locator.
    assert.equal(
      resolveGeocoderConfig({ providerId: "arcgis-locator", locators: [PARCELS], locatorId: "x" })
        .locator?.id,
      "parcels",
    );
  });

  it("advertises reverse geocoding only for locators that support it", () => {
    assert.equal(geocoderSupportsReverse(locatorConfig(PARCELS)), true);
    assert.equal(geocoderSupportsReverse(locatorConfig(ASSETS)), false);
    // Unchecked locators are assumed to support it.
    assert.equal(geocoderSupportsReverse(locatorConfig({ id: "u", name: "u", url: BASE })), true);
  });
});

describe("arcgis-locator forward geocoding", () => {
  it("asks for WGS 84 through the published single-line field", async () => {
    const urls = stubFetch({
      spatialReference: { wkid: 4326, latestWkid: 4326 },
      candidates: [
        { address: "222 W Hargett St", location: { x: -78.643, y: 35.7787 }, score: 100 },
      ],
    });
    const matches = await geocodeForward("222 W Hargett St", { config: locatorConfig(), limit: 5 });
    const url = new URL(urls[0]);
    assert.equal(`${url.origin}${url.pathname}`, `${BASE}/findAddressCandidates`);
    assert.equal(url.searchParams.get("SingleLine"), "222 W Hargett St");
    assert.equal(url.searchParams.get("outSR"), "4326");
    assert.equal(url.searchParams.get("maxLocations"), "5");
    assert.equal(url.searchParams.get("token"), null);
    assert.deepEqual(matches, [
      { lon: -78.643, lat: 35.7787, displayName: "222 W Hargett St", score: 100 },
    ]);
  });

  it("sends an identifier through a locator's only structured field", async () => {
    const urls = stubFetch({ candidates: [] });
    await geocodeForward("HYD-0042", { config: locatorConfig(ASSETS) });
    assert.equal(new URL(urls[0]).searchParams.get("AssetID"), "HYD-0042");
  });

  it("unprojects Web Mercator and refuses other projected coordinates", async () => {
    stubFetch({
      spatialReference: { wkid: 102100, latestWkid: 3857 },
      candidates: [{ address: "A", location: { x: -8754231.9, y: 4270102.6 }, score: 90 }],
    });
    const [match] = await geocodeForward("A", { config: locatorConfig() });
    assert.ok(Math.abs(match.lon - -78.641) < 0.001, String(match.lon));
    assert.ok(Math.abs(match.lat - 35.7786) < 0.001, String(match.lat));

    // NC State Plane feet: plotting these as degrees would be wildly wrong.
    stubFetch({
      spatialReference: { wkid: 102719, latestWkid: 2264 },
      candidates: [{ address: "A", location: { x: 2105887.3, y: 738554.7 }, score: 100 }],
    });
    await assert.rejects(
      geocodeForward("A", { config: locatorConfig() }),
      /spatial reference 2264/,
    );
  });

  it("reports a service error instead of an empty result", async () => {
    stubFetch({ error: { code: 498, message: "Invalid Token" } });
    await assert.rejects(
      geocodeForward("A", { config: locatorConfig() }),
      (error: unknown) => error instanceof GeocoderServiceError && error.isAuthError,
    );
    stubFetch({ candidates: [] });
    assert.deepEqual(await geocodeForward("nowhere", { config: locatorConfig() }), []);
  });

  it("fails clearly when no locator is configured", async () => {
    const urls = stubFetch({ candidates: [] });
    await assert.rejects(
      geocodeForward("A", { config: resolveGeocoderConfig({ providerId: "arcgis-locator" }) }),
      GeocoderUnsupportedError,
    );
    assert.equal(urls.length, 0);
  });
});

describe("arcgis-locator reverse geocoding", () => {
  it("sends the clicked point as WGS 84 and reads the address", async () => {
    const urls = stubFetch({
      address: { Match_addr: "11 S Salisbury St", LongLabel: "11 S Salisbury St, Raleigh, NC" },
      location: { x: -78.64, y: 35.78 },
    });
    const result = await geocodeReverse(-78.64, 35.78, { config: locatorConfig() });
    const url = new URL(urls[0]);
    assert.equal(`${url.origin}${url.pathname}`, `${BASE}/reverseGeocode`);
    assert.deepEqual(JSON.parse(url.searchParams.get("location")!), {
      x: -78.64,
      y: 35.78,
      spatialReference: { wkid: 4326 },
    });
    assert.equal(url.searchParams.get("outSR"), "4326");
    assert.equal(result?.displayName, "11 S Salisbury St, Raleigh, NC");
  });

  it("treats 'unable to find address' as no address, and other errors as failures", async () => {
    stubFetch({
      error: { code: 400, message: "Unable to find address for the specified location." },
    });
    assert.equal(await geocodeReverse(0, 0, { config: locatorConfig() }), null);
    // Enterprise puts the reason in `details`.
    stubFetch({
      error: {
        code: 400,
        message: "Cannot perform query. Invalid query parameters.",
        details: ["Unable to find address for the specified location."],
      },
    });
    assert.equal(await geocodeReverse(0, 0, { config: locatorConfig() }), null);
    stubFetch({ error: { code: 400, message: "Invalid parameter outSR.", details: [] } });
    await assert.rejects(geocodeReverse(0, 0, { config: locatorConfig() }), /outSR/);
    stubFetch({ error: { code: 403, message: "You do not have permissions" } });
    await assert.rejects(geocodeReverse(0, 0, { config: locatorConfig() }), GeocoderServiceError);
  });

  it("refuses a forward-only locator without sending a request", async () => {
    const urls = stubFetch({});
    await assert.rejects(
      geocodeReverse(-78.64, 35.78, { config: locatorConfig(ASSETS) }),
      GeocoderUnsupportedError,
    );
    assert.equal(urls.length, 0);
  });
});

describe("secured locators", () => {
  it("ask the token provider only for a locator with a portal", async () => {
    const asked: string[] = [];
    setGeocodingTokenProvider(async (locator) => {
      asked.push(locator.id);
      return "portal-token";
    });
    let urls = stubFetch({ candidates: [] });
    await geocodeForward("A", { config: locatorConfig() });
    assert.deepEqual(asked, []);
    assert.equal(new URL(urls[0]).searchParams.get("token"), null);

    const secured = { ...PARCELS, portalUrl: "https://gis.example.org/portal" };
    urls = stubFetch({ candidates: [] });
    await geocodeForward("A", { config: locatorConfig(secured) });
    assert.deepEqual(asked, ["parcels"]);
    assert.equal(new URL(urls[0]).searchParams.get("token"), "portal-token");
  });

  it("never send a locator token to another provider", async () => {
    let asked = 0;
    setGeocodingTokenProvider(async () => {
      asked += 1;
      return "portal-token";
    });
    const urls = stubFetch([]);
    await geocodeForward("A", {
      config: { ...resolveGeocoderConfig({ providerId: "nominatim" }), locator: PARCELS },
    });
    assert.equal(asked, 0);
    assert.equal(new URL(urls[0]).searchParams.get("token"), null);
  });
});

describe("locatorAcceptsPortalToken", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
    resetLocatorFederationCache();
  });

  /** Answer `rest/info` with `owningSystemUrl`, counting the requests. */
  const serveInfo = (owningSystemUrl: string | undefined) => {
    const requests: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      requests.push(String(input));
      return Response.json(owningSystemUrl ? { owningSystemUrl } : {});
    }) as typeof fetch;
    return requests;
  };

  it("accepts the portal's own host without asking the server", async () => {
    const requests = serveInfo(undefined);
    assert.equal(await locatorAcceptsPortalToken(BASE, "https://gis.example.org/portal"), true);
    assert.equal(requests.length, 0);
  });

  it("accepts a server federated with the portal, once per session", async () => {
    const requests = serveInfo("https://portal.example.org/portal");
    const locator = "https://maps.example.org/arcgis/rest/services/Locators/Parcels/GeocodeServer";
    assert.equal(
      await locatorAcceptsPortalToken(locator, "https://portal.example.org/portal"),
      true,
    );
    assert.equal(
      await locatorAcceptsPortalToken(locator, "https://portal.example.org/portal"),
      true,
    );
    assert.deepEqual(requests, ["https://maps.example.org/arcgis/rest/info?f=json"]);
  });

  it("refuses standalone servers, other portals, and plain HTTP", async () => {
    serveInfo(undefined);
    const standalone = "https://maps.example.org/arcgis/rest/services/L/GeocodeServer";
    assert.equal(await locatorAcceptsPortalToken(standalone, "https://portal.example.org"), false);
    resetLocatorFederationCache();
    serveInfo("https://other.example.org/portal");
    assert.equal(await locatorAcceptsPortalToken(standalone, "https://portal.example.org"), false);
    assert.equal(
      await locatorAcceptsPortalToken(
        "http://portal.example.org/arcgis/rest/services/L/GeocodeServer",
        "https://portal.example.org",
      ),
      false,
    );
    // No portal configured: a public locator never gets a token.
    assert.equal(await locatorAcceptsPortalToken(BASE, undefined), false);
  });
});

describe("locators in the project file", () => {
  it("round-trip, dropping malformed entries, duplicate ids and pasted tokens", () => {
    const project = createEmptyProject();
    project.preferences.geocoding = {
      providerId: "arcgis-locator",
      apiKeys: {},
      locators: [
        { ...PARCELS, url: `${BASE}/findAddressCandidates?token=secret` },
        { ...PARCELS, name: "duplicate id" },
        { id: "bad", name: "Not a locator", url: "https://example.org/FeatureServer/0" },
        ASSETS,
      ],
      locatorId: "assets",
    };
    const geocoding = parseProject(serializeProject(project)).preferences.geocoding;
    assert.deepEqual(geocoding.locators, [{ ...PARCELS, url: BASE }, ASSETS]);
    assert.equal(geocoding.locatorId, "assets");
    assert.ok(!JSON.stringify(geocoding).includes("secret"));
  });

  it("leave older projects unchanged", () => {
    const geocoding = parseProject(serializeProject(createEmptyProject())).preferences.geocoding;
    assert.equal("locators" in geocoding, false);
    assert.equal("locatorId" in geocoding, false);
  });
});

describe("resolveLocatorToken", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
    resetLocatorFederationCache();
  });

  const federated: GeocodingLocator = {
    id: "fed",
    name: "Federated",
    url: "https://maps.example.org/arcgis/rest/services/Locators/Parcels/GeocodeServer",
    portalUrl: "https://portal.example.org/portal",
  };

  it("needs this device's approval before a federated server gets the token", async () => {
    // The server claims the portal; that alone must not release the token.
    globalThis.fetch = (async () =>
      Response.json({ owningSystemUrl: "https://portal.example.org/portal" })) as typeof fetch;
    await assert.rejects(resolveLocatorToken(federated), /Check this locator in Settings/);
    approveLocatorPortalToken(federated.url, federated.portalUrl);
    // Approved, but not signed in: sent without a token rather than refused.
    assert.equal(await resolveLocatorToken(federated), undefined);
  });

  it("needs no approval on the portal's own host", async () => {
    const sameHost = { ...PARCELS, portalUrl: "https://gis.example.org/portal" };
    assert.equal(await resolveLocatorToken(sameHost), undefined);
  });

  it("refuses a server that does not claim the portal, approved or not", async () => {
    globalThis.fetch = (async () => Response.json({})) as typeof fetch;
    approveLocatorPortalToken(federated.url, federated.portalUrl);
    await assert.rejects(resolveLocatorToken(federated), /not on a server federated/);
  });
});

describe("locator token routing", () => {
  const secured = { ...PARCELS, portalUrl: "https://gis.example.org/portal" };
  const tokenProvider = async () => "portal-token";

  it("ignores endpoint overrides from the runtime env for a locator", () => {
    const globals = globalThis as { window?: unknown };
    const previous = globals.window;
    globals.window = {
      __GEOLIBRE_RUNTIME_ENV__: {
        VITE_GEOCODER_PROVIDER: "arcgis-locator",
        VITE_GEOCODER_LOCATOR: JSON.stringify(secured),
        VITE_GEOCODER_ENDPOINT: "https://attacker.example/search",
        VITE_GEOCODER_REVERSE_ENDPOINT: "https://attacker.example/reverse",
      },
    };
    try {
      const config = getGeocoderConfig();
      assert.equal(config.locator?.id, "parcels");
      assert.equal(config.forwardEndpoint, `${BASE}/findAddressCandidates`);
      assert.equal(config.reverseEndpoint, `${BASE}/reverseGeocode`);
    } finally {
      globals.window = previous;
    }
  });

  it("refuses to attach the token to a request outside the locator's URL", async () => {
    setGeocodingTokenProvider(tokenProvider);
    const urls = stubFetch({ candidates: [] });
    const config = {
      ...locatorConfig(secured),
      forwardEndpoint: "https://attacker.example/findAddressCandidates",
    };
    await assert.rejects(
      geocodeForward("A", { config }),
      /does not go to the locator's own server/,
    );
    assert.equal(urls.length, 0);
  });

  it("does not follow redirects on requests that carry a token", async () => {
    setGeocodingTokenProvider(tokenProvider);
    const redirects: (RequestRedirect | undefined)[] = [];
    setGeocodingFetch(async (_input, init) => {
      redirects.push(init?.redirect);
      return Response.json({ candidates: [] });
    });
    await geocodeForward("A", { config: locatorConfig(secured) });
    await geocodeForward("A", { config: locatorConfig(PARCELS) });
    await fetchArcGISLocatorInfo(BASE, { token: "t" }).catch(() => undefined);
    assert.deepEqual(redirects, ["error", undefined, "error"]);
  });
});

describe("locator approvals and federation caching", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
    resetLocatorFederationCache();
  });
  const locator: GeocodingLocator = {
    id: "fed",
    name: "Federated",
    url: "https://maps.example.org/arcgis/rest/services/Locators/Parcels/GeocodeServer",
    portalUrl: "https://portal.example.org/portal",
  };
  const claimPortal = () => {
    globalThis.fetch = (async () =>
      Response.json({ owningSystemUrl: "https://portal.example.org/portal" })) as typeof fetch;
  };

  it("does not cache a failed rest/info as 'not federated'", async () => {
    globalThis.fetch = (async () => new Response("busy", { status: 503 })) as typeof fetch;
    assert.equal(await locatorAcceptsPortalToken(locator.url, locator.portalUrl), false);
    claimPortal();
    assert.equal(await locatorAcceptsPortalToken(locator.url, locator.portalUrl), true);
  });

  it("grants a staged approval only when Settings saves that locator", async () => {
    claimPortal();
    stageLocatorPortalApproval(locator.url, locator.portalUrl);
    discardStagedLocatorApprovals();
    commitLocatorPortalApprovals([locator]);
    await assert.rejects(resolveLocatorToken(locator), /Check this locator in Settings/);

    stageLocatorPortalApproval(locator.url, locator.portalUrl);
    // Saved without that locator: nothing is granted.
    commitLocatorPortalApprovals([]);
    await assert.rejects(resolveLocatorToken(locator), /Check this locator in Settings/);

    stageLocatorPortalApproval(locator.url, locator.portalUrl);
    commitLocatorPortalApprovals([locator]);
    assert.equal(await resolveLocatorToken(locator), undefined);
  });
});

describe("locator suggestions (#3123)", () => {
  const SUGGESTING: GeocodingLocator = { ...PARCELS, suggest: true };

  it("are offered only for a locator that advertises suggest, through its single-line field", () => {
    assert.equal(geocoderSupportsSuggest(locatorConfig(SUGGESTING)), true);
    assert.equal(geocoderSupportsSuggest(locatorConfig(PARCELS)), false);
    assert.equal(geocoderSupportsSuggest(locatorConfig({ ...ASSETS, suggest: true })), false);
    // A structured field chosen for search does not take whole-address suggestions.
    assert.equal(
      geocoderSupportsSuggest(
        locatorConfig({ ...SUGGESTING, addressFields: ["Parcel"], searchField: "Parcel" }),
      ),
      false,
    );
    assert.equal(
      geocoderSupportsSuggest(resolveGeocoderConfig({ providerId: "nominatim" })),
      false,
    );
  });

  it("asks suggest and drops category suggestions", async () => {
    const urls = stubFetch({
      suggestions: [
        { text: "222 W Hargett St, Raleigh, NC, 27601", magicKey: "abc", isCollection: false },
        { text: "Coffee shop", magicKey: "cat", isCollection: true },
        { text: "", magicKey: "empty" },
        null,
      ],
    });
    const suggestions = await geocodeSuggest("222 W Harg", {
      config: locatorConfig(SUGGESTING),
      limit: 6,
    });
    const url = new URL(urls[0]);
    assert.equal(`${url.origin}${url.pathname}`, `${BASE}/suggest`);
    assert.equal(url.searchParams.get("text"), "222 W Harg");
    assert.equal(url.searchParams.get("maxSuggestions"), "6");
    assert.deepEqual(suggestions, [
      { text: "222 W Hargett St, Raleigh, NC, 27601", magicKey: "abc" },
    ]);
  });

  it("refuses a locator that does not suggest, and reports service errors", async () => {
    const urls = stubFetch({ suggestions: [] });
    await assert.rejects(
      geocodeSuggest("A", { config: locatorConfig(PARCELS) }),
      GeocoderUnsupportedError,
    );
    assert.equal(urls.length, 0);
    stubFetch({ error: { code: 499, message: "Token Required" } });
    await assert.rejects(
      geocodeSuggest("A", { config: locatorConfig(SUGGESTING) }),
      (error: unknown) => error instanceof GeocoderServiceError && error.isAuthError,
    );
  });

  it("resolves a picked suggestion by its magicKey", async () => {
    const urls = stubFetch({ candidates: [] });
    await geocodeForward("222 W Hargett St", {
      config: locatorConfig(SUGGESTING),
      magicKey: "abc",
      limit: 1,
    });
    const url = new URL(urls[0]);
    assert.equal(url.searchParams.get("magicKey"), "abc");
    assert.equal(url.searchParams.get("SingleLine"), "222 W Hargett St");
  });

  it("carries the secured locator's token, like other requests", async () => {
    const urls = stubFetch({ suggestions: [] });
    setGeocodingTokenProvider(async () => "secret");
    await geocodeSuggest("A", {
      config: locatorConfig({ ...SUGGESTING, portalUrl: "https://gis.example.org/portal" }),
    });
    assert.equal(new URL(urls[0]).searchParams.get("token"), "secret");
  });
});

describe("locator search field (#3123)", () => {
  const STRUCTURED: GeocodingLocator = {
    ...PARCELS,
    addressFields: ["Address", "Parcel", "Postal"],
  };

  it("sends the search to the published field the user chose", async () => {
    const urls = stubFetch({ candidates: [] });
    await geocodeForward("0123456789", {
      config: locatorConfig({ ...STRUCTURED, searchField: "Parcel" }),
    });
    const url = new URL(urls[0]);
    assert.equal(url.searchParams.get("Parcel"), "0123456789");
    assert.equal(url.searchParams.get("SingleLine"), null);
  });

  it("falls back to the default when the chosen field is no longer published", () => {
    assert.equal(arcgisLocatorInputField({ ...STRUCTURED, searchField: "Gone" }), "SingleLine");
    assert.equal(arcgisLocatorInputField({ ...ASSETS, searchField: "Gone" }), "AssetID");
  });

  it("is kept in the project file", () => {
    assert.equal(
      normalizeGeocodingLocator({ ...STRUCTURED, searchField: " Parcel " })?.searchField,
      "Parcel",
    );
    assert.equal(
      normalizeGeocodingLocator({ ...STRUCTURED, searchField: "" })?.searchField,
      undefined,
    );
  });
});

describe("locator candidate attributes (#3123)", () => {
  it("are requested and kept on the match, without empty values or the shape", async () => {
    const urls = stubFetch({
      spatialReference: { wkid: 4326 },
      candidates: [
        {
          address: "PIN 1703",
          location: { x: -78.6, y: 35.7 },
          score: 100,
          attributes: {
            PIN: "1703",
            Addr_type: "Parcel",
            Rank: 20,
            Shape: { x: 1, y: 2 },
            DisplayX: -78.6,
            Phone: "",
            Nothing: null,
          },
        },
      ],
    });
    const [match] = await geocodeForward("1703", { config: locatorConfig(), attributes: true });
    assert.equal(new URL(urls[0]).searchParams.get("outFields"), "*");
    await geocodeForward("1703", { config: locatorConfig() });
    // The search box does not ask for them.
    assert.equal(new URL(urls[1]).searchParams.get("outFields"), null);
    assert.deepEqual(match.attributes, { PIN: "1703", Addr_type: "Parcel", Rank: 20 });
  });

  it("become prefixed columns only when asked", () => {
    const match = {
      lat: 35.7,
      lon: -78.6,
      displayName: "PIN 1703",
      score: 100,
      attributes: { PIN: "1703" },
    };
    const row = { address: "1703", [`${GEOCODE_ATTRIBUTE_PREFIX}PIN`]: "mine" };
    assert.equal(
      geocodeMatchToFeature(match, { address: "1703" })?.properties?.geocode_attr_PIN,
      undefined,
    );
    const properties = geocodeMatchToFeature(match, row, { attributes: true })?.properties ?? {};
    // The row's own column of that name is kept; the locator's value gets a free key.
    assert.equal(properties[`${GEOCODE_ATTRIBUTE_PREFIX}PIN`], "mine");
    assert.ok(Object.values(properties).includes("1703"));
  });
});

describe("revoking locator approvals (#3123)", () => {
  afterEach(() => resetLocatorFederationCache());

  it("lists approvals and forgets a revoked one", () => {
    const federated: GeocodingLocator = {
      ...PARCELS,
      url: "https://maps.example.org/arcgis/rest/services/Locators/Parcels/GeocodeServer",
      portalUrl: "https://gis.example.org/portal",
    };
    approveLocatorPortalToken(federated.url, federated.portalUrl);
    assert.deepEqual(listLocatorPortalApprovals(), [
      { portalHost: "gis.example.org", locatorHost: "maps.example.org" },
    ]);
    revokeLocatorPortalApproval({ portalHost: "gis.example.org", locatorHost: "maps.example.org" });
    assert.deepEqual(listLocatorPortalApprovals(), []);
    // Approving it again (checking and saving) restores it.
    approveLocatorPortalToken(federated.url, federated.portalUrl);
    assert.equal(listLocatorPortalApprovals().length, 1);
  });
});
