import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { GeoLibreLayer } from "../packages/core/src/types";
import {
  checkShareReadiness,
  collectShareSources,
  isPrivateHostname,
  probeShareSources,
  probeTargetFor,
  summarizeShareSources,
} from "../apps/geolibre-desktop/src/lib/share-readiness";

function layer(overrides: Partial<GeoLibreLayer> = {}): GeoLibreLayer {
  return {
    id: "layer-1",
    name: "Layer 1",
    type: "geojson",
    source: {},
    visible: true,
    opacity: 1,
    style: {},
    metadata: {},
    ...overrides,
  } as GeoLibreLayer;
}

/**
 * Records every request so a test can assert what was (and was not) asked for,
 * and answers from a target → status/throw table.
 */
function fakeFetch(routes: Record<string, number | Error>) {
  const calls: { url: string; method: string; credentials?: string }[] = [];
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({
      url,
      method: init?.method ?? "GET",
      credentials: init?.credentials,
    });
    const route = routes[url];
    if (route === undefined) throw new TypeError("Failed to fetch");
    if (route instanceof Error) throw route;
    return new Response(null, { status: route });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

describe("isPrivateHostname", () => {
  it("recognizes loopback, private ranges, and reserved suffixes", () => {
    for (const host of [
      "localhost",
      "app.localhost",
      "127.0.0.1",
      "10.1.2.3",
      "172.16.0.9",
      "172.31.255.1",
      "192.168.1.10",
      "169.254.10.1",
      // RFC 6598 carrier-grade NAT.
      "100.64.0.1",
      "100.127.255.254",
      "::1",
      "fd00::1",
      "fe80::1",
      "gis-server",
      "tiles.local",
      "maps.internal",
    ]) {
      assert.equal(isPrivateHostname(host), true, host);
    }
  });

  it("leaves public hosts alone, including ones that merely look private", () => {
    for (const host of [
      "tiles.openfreemap.org",
      "172.32.0.1",
      "172.15.0.1",
      "11.0.0.1",
      "192.169.1.1",
      // Just outside 100.64.0.0/10 on either side.
      "100.63.255.255",
      "100.128.0.1",
      // A registered domain may start with the IPv6 unique-local prefix.
      "fd-services.com",
      "fe80.example.com",
    ]) {
      assert.equal(isPrivateHostname(host), false, host);
    }
  });
});

describe("probeTargetFor", () => {
  it("collapses a tile template to its origin", () => {
    assert.equal(
      probeTargetFor("https://tile.example.com/data/{z}/{x}/{y}.png"),
      "https://tile.example.com",
    );
  });

  it("keeps a concrete URL intact so an expired link is still caught", () => {
    assert.equal(
      probeTargetFor("https://data.example.com/dem.tif"),
      "https://data.example.com/dem.tif",
    );
  });

  it("returns null for a non-HTTP reference", () => {
    assert.equal(probeTargetFor("/home/me/dem.tif"), null);
    assert.equal(probeTargetFor("ftp://example.com/dem.tif"), null);
  });
});

describe("collectShareSources", () => {
  it("skips a layer whose data travels inside the project", () => {
    const refs = collectShareSources({
      layers: [
        layer({ geojson: { type: "FeatureCollection", features: [] } }),
        layer({ id: "b", name: "B", metadata: { embeddedGeoJSON: { type: "FeatureCollection" } } }),
        layer({ id: "c", name: "C", source: { url: "https://x.example.com/a.fgb" } }),
      ],
      embeddedLayerIds: new Set(["c"]),
    });
    assert.deepEqual(refs, []);
  });

  it("flags a local path and a private host without probing them", () => {
    const refs = collectShareSources({
      layers: [
        layer({ id: "a", name: "DEM", type: "cog", source: { url: "/home/me/dem.tif" } }),
        layer({
          id: "b",
          name: "Intranet tiles",
          type: "xyz",
          source: { tiles: ["http://192.168.1.20:8080/{z}/{x}/{y}.png"] },
        }),
      ],
    });
    assert.deepEqual(
      refs.map((ref) => [ref.layerId, ref.status, ref.reason, ref.probeUrl]),
      [
        ["a", "local", "local-file", null],
        ["b", "local", "private-host", null],
      ],
    );
  });

  it("flags a URL whose credential the upload strips", () => {
    const refs = collectShareSources({
      layers: [
        layer({
          id: "a",
          name: "Keyed tiles",
          type: "xyz",
          source: { url: "https://api.example.com/{z}/{x}/{y}.png?apiKey=secret" },
        }),
      ],
    });
    assert.equal(refs.length, 1);
    assert.equal(refs[0].status, "credentialed");
    assert.equal(refs[0].reason, "credential-stripped");
    assert.equal(refs[0].probeUrl, null);
  });

  it("flags a layer whose configuration carries a credential field", () => {
    const refs = collectShareSources({
      layers: [
        layer({
          id: "a",
          name: "Private tileset",
          type: "3d-tiles",
          source: {
            url: "https://tiles.example.com/tileset.json",
            requestHeaders: { "X-Token": "abc" },
          },
        }),
      ],
    });
    assert.equal(refs[0].status, "credentialed");
    assert.equal(refs[0].probeUrl, null);
  });

  it("ignores an empty credential field, which unlocks nothing", () => {
    const refs = collectShareSources({
      layers: [
        layer({
          id: "a",
          name: "Public tileset",
          type: "3d-tiles",
          source: { url: "https://tiles.example.com/tileset.json", requestHeaders: {} },
        }),
      ],
    });
    assert.equal(refs[0].status, "unchecked");
    assert.equal(refs[0].probeUrl, "https://tiles.example.com/tileset.json");
  });

  it("reports a query-backed layer that names no reference at all", () => {
    const refs = collectShareSources({
      layers: [
        layer({
          id: "a",
          name: "PostGIS parcels",
          type: "duckdb-query",
          source: { sql: "select * from parcels" },
          metadata: { sourceKind: "sql-query" },
        }),
      ],
    });
    assert.equal(refs[0].status, "local");
    assert.equal(refs[0].reason, "no-source");
  });

  it("de-duplicates one template repeated across source and metadata", () => {
    const template = "https://tile.example.com/{z}/{x}/{y}.png";
    const refs = collectShareSources({
      layers: [
        layer({
          id: "a",
          name: "XYZ",
          type: "xyz",
          source: { url: template, tiles: [template] },
          metadata: { originalUrl: template },
        }),
      ],
    });
    assert.equal(refs.length, 1);
  });

  it("includes the basemap and absolute plugin manifests, not bundled ones", () => {
    const refs = collectShareSources({
      layers: [],
      basemapStyleUrl: "https://tiles.openfreemap.org/styles/liberty",
      pluginManifestUrls: [
        "https://plugins.example.com/p/plugin.json",
        "/plugins/local/plugin.json",
      ],
    });
    assert.deepEqual(
      refs.map((ref) => ref.field),
      ["basemapStyleUrl", "plugins.manifestUrls[0]"],
    );
    // Project-level rows carry no label: the dialog translates one from `field`,
    // so the check never needs the translation function.
    assert.deepEqual(
      refs.map((ref) => ref.label),
      ["", ""],
    );
  });

  it("says nothing about an inline data: payload", () => {
    const refs = collectShareSources({
      layers: [layer({ id: "a", type: "image", source: { url: "data:image/png;base64,AAA" } })],
    });
    assert.deepEqual(refs, []);
  });
});

describe("probeShareSources", () => {
  it("probes each distinct target once, anonymously, with HEAD", async () => {
    const template = "https://tile.example.com/{z}/{x}/{y}.png";
    const refs = collectShareSources({
      layers: [
        layer({ id: "a", name: "A", type: "xyz", source: { url: template } }),
        layer({
          id: "b",
          name: "B",
          type: "xyz",
          source: { url: "https://tile.example.com/other/{z}/{x}/{y}.png" },
        }),
      ],
    });
    const { fn, calls } = fakeFetch({ "https://tile.example.com": 200 });
    const result = await probeShareSources(refs, { fetchImpl: fn });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, "HEAD");
    assert.equal(calls[0].credentials, "omit");
    assert.equal(result.probeCount, 1);
    assert.deepEqual(
      result.refs.map((ref) => ref.status),
      ["reachable", "reachable"],
    );
  });

  it("maps 401 to credentialed and 404 to missing", async () => {
    const refs = collectShareSources({
      layers: [
        layer({ id: "a", name: "A", type: "cog", source: { url: "https://a.example.com/a.tif" } }),
        layer({ id: "b", name: "B", type: "cog", source: { url: "https://b.example.com/b.tif" } }),
      ],
    });
    const { fn } = fakeFetch({
      "https://a.example.com/a.tif": 401,
      "https://b.example.com/b.tif": 404,
    });
    const { refs: probed } = await probeShareSources(refs, { fetchImpl: fn });
    assert.deepEqual(
      probed.map((ref) => [ref.status, ref.reason]),
      [
        ["credentialed", "auth-required"],
        ["missing", "not-found"],
      ],
    );
  });

  it("retries a HEAD-refusing host with a ranged GET before calling it gated", async () => {
    const refs = collectShareSources({
      layers: [
        layer({ id: "a", name: "A", type: "cog", source: { url: "https://s3.example.com/a.tif" } }),
      ],
    });
    let first = true;
    const attempts: { method?: string; range?: string }[] = [];
    const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
      void input;
      attempts.push({
        method: init?.method,
        range: (init?.headers as Record<string, string> | undefined)?.Range,
      });
      if (first && init?.method === "HEAD") {
        first = false;
        return new Response(null, { status: 403 });
      }
      return new Response(null, { status: 206 });
    }) as unknown as typeof fetch;
    const { refs: probed } = await probeShareSources(refs, { fetchImpl: fn });
    assert.equal(probed[0].status, "reachable");
    // The range matters as much as the method: without it, every HEAD-refusing
    // host would have its whole object downloaded by the readiness check.
    assert.deepEqual(attempts, [
      { method: "HEAD", range: undefined },
      { method: "GET", range: "bytes=0-0" },
    ]);
  });

  it("reads an opaque browser rejection as browser-blocked", async () => {
    const refs = collectShareSources({
      layers: [
        layer({
          id: "a",
          name: "A",
          type: "cog",
          source: { url: "https://nocors.example.com/a.tif" },
        }),
      ],
    });
    const { fn } = fakeFetch({});
    const { refs: probed } = await probeShareSources(refs, { fetchImpl: fn });
    assert.equal(probed[0].status, "blocked");
    assert.equal(probed[0].reason, "cors");
  });

  it("does not blame the project for a 5xx", async () => {
    const refs = collectShareSources({
      layers: [
        layer({
          id: "a",
          name: "A",
          type: "cog",
          source: { url: "https://down.example.com/a.tif" },
        }),
      ],
    });
    const { fn } = fakeFetch({ "https://down.example.com/a.tif": 503 });
    const { refs: probed } = await probeShareSources(refs, { fetchImpl: fn });
    assert.equal(probed[0].status, "unchecked");
  });

  it("caps the probe count and reports the remainder as unchecked", async () => {
    const layers = Array.from({ length: 4 }, (_unused, index) =>
      layer({
        id: `l${index}`,
        name: `L${index}`,
        type: "cog",
        source: { url: `https://host${index}.example.com/a.tif` },
      }),
    );
    const { fn, calls } = fakeFetch({
      "https://host0.example.com/a.tif": 200,
      "https://host1.example.com/a.tif": 200,
      "https://host2.example.com/a.tif": 200,
      "https://host3.example.com/a.tif": 200,
    });
    const result = await probeShareSources(collectShareSources({ layers }), {
      fetchImpl: fn,
      maxProbes: 2,
    });
    assert.equal(calls.length, 2);
    assert.equal(result.truncated, true);
    assert.deepEqual(
      result.refs.map((ref) => ref.status),
      ["reachable", "reachable", "unchecked", "unchecked"],
    );
    assert.equal(result.refs[3].reason, "probe-budget");
  });
});

describe("summarizeShareSources", () => {
  it("keeps the worst verdict per layer", () => {
    const items = summarizeShareSources([
      {
        layerId: "a",
        label: "A",
        field: "source.tiles[0]",
        url: "https://ok.example.com/a",
        probeUrl: null,
        status: "reachable",
        reason: "ok",
      },
      {
        layerId: "a",
        label: "A",
        field: "source.tiles[1]",
        url: "https://bad.example.com/a",
        probeUrl: null,
        status: "blocked",
        reason: "cors",
      },
    ]);
    assert.equal(items.length, 1);
    assert.equal(items[0].status, "blocked");
  });
});

describe("checkShareReadiness", () => {
  it("orders problems worst first and leaves reachable sources out of them", async () => {
    const { fn } = fakeFetch({ "https://ok.example.com/a.tif": 200 });
    const report = await checkShareReadiness(
      {
        layers: [
          layer({
            id: "ok",
            name: "Good",
            type: "cog",
            source: { url: "https://ok.example.com/a.tif" },
          }),
          layer({
            id: "local",
            name: "Local DEM",
            type: "cog",
            source: { url: "/home/me/dem.tif" },
          }),
          layer({
            id: "keyed",
            name: "Keyed",
            type: "xyz",
            source: { url: "https://k.example.com/{z}/{x}/{y}.png?apiKey=s" },
          }),
        ],
      },
      { fetchImpl: fn },
    );
    assert.equal(report.items.length, 3);
    assert.deepEqual(
      report.problems.map((item) => item.layerId),
      ["local", "keyed"],
    );
  });

  it("reports everything as unchecked rather than throwing when fetch is unavailable", async () => {
    const original = globalThis.fetch;
    // @ts-expect-error deliberately emulating a runtime with no fetch
    delete globalThis.fetch;
    try {
      const report = await checkShareReadiness({
        layers: [layer({ id: "a", type: "cog", source: { url: "https://a.example.com/a.tif" } })],
      });
      assert.equal(report.probeCount, 0);
      assert.equal(report.items[0].status, "unchecked");
    } finally {
      globalThis.fetch = original;
    }
  });
});
