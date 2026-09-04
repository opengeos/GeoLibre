import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_LAYER_STYLE, type GeoLibreLayer } from "@geolibre/core";
import {
  createStacAssetAccess,
  readableStacAssetHref,
  readableStacLayerHref,
  STAC_ASSET_ACCESS_METADATA_KEY,
  stacAssetAccessFromLayer,
} from "../packages/plugins/src/plugins/stac-signing";

const CATALOG = "https://planetarycomputer.microsoft.com/api/stac/v1/";
const ASSET = "https://ai4edataeuwest.blob.core.windows.net/io-lulc/example.tif";

function layerWithAccess(access: unknown): GeoLibreLayer {
  return {
    id: "raster-1",
    name: "Private raster",
    type: "cog",
    source: { type: "raster", url: `${ASSET}?sig=expired` },
    visible: true,
    opacity: 1,
    style: { ...DEFAULT_LAYER_STYLE },
    metadata: { [STAC_ASSET_ACCESS_METADATA_KEY]: access },
  };
}

test("Planetary Computer Azure assets retain the information needed for re-signing", () => {
  const access = createStacAssetAccess(CATALOG, "io-lulc-annual-v02", ASSET);
  assert.deepEqual(access, {
    catalogUrl: CATALOG,
    collectionId: "io-lulc-annual-v02",
    href: ASSET,
  });
  assert.deepEqual(stacAssetAccessFromLayer(layerWithAccess(access)), access);
});

test("third-party catalogs cannot send Azure asset details to the MPC signer", () => {
  assert.equal(createStacAssetAccess("https://third-party.example/stac/", "private", ASSET), null);
  assert.equal(createStacAssetAccess(CATALOG, "private", "https://example.com/data.tif"), null);
  assert.equal(
    createStacAssetAccess(
      CATALOG,
      "private",
      "http://ai4edataeuwest.blob.core.windows.net/io-lulc/data.tif",
    ),
    null,
  );
  assert.equal(stacAssetAccessFromLayer(layerWithAccess({ collectionId: "private" })), null);
});

test("access metadata is rejected when a layer points at a different asset", () => {
  const access = createStacAssetAccess(CATALOG, "io-lulc-annual-v02", ASSET);
  assert.ok(access);
  assert.equal(
    stacAssetAccessFromLayer(
      layerWithAccess(access),
      "https://ai4edataeuwest.blob.core.windows.net/io-lulc/different.tif?sig=old",
    ),
    null,
  );
  assert.deepEqual(stacAssetAccessFromLayer(layerWithAccess(access), `${ASSET}?sig=old`), access);
});

test("a saved STAC layer receives a fresh token when it is restored", async () => {
  const access = createStacAssetAccess(CATALOG, "io-lulc-annual-v02", ASSET);
  assert.ok(access);
  const originalFetch = globalThis.fetch;
  let tokenUrl = "";
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    tokenUrl = String(input);
    return new Response(
      JSON.stringify({
        href: `${ASSET}?sp=rl&sig=fresh-token`,
        "msft:expiry": "2099-01-01T00:00:00Z",
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch;
  try {
    const href = await readableStacLayerHref(layerWithAccess(access), `${ASSET}?sig=expired`);
    assert.equal(
      tokenUrl,
      `https://planetarycomputer.microsoft.com/api/sas/v1/sign?href=${encodeURIComponent(ASSET)}`,
    );
    assert.equal(href, `${ASSET}?sp=rl&sig=fresh-token`);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("layers pointing at one asset share a single signing request", async () => {
  const asset = "https://ai4edataeuwest.blob.core.windows.net/io-lulc/shared.tif";
  const access = createStacAssetAccess(CATALOG, "io-lulc-annual-v02", asset);
  assert.ok(access);
  const originalFetch = globalThis.fetch;
  let requests = 0;
  let release = (): void => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  globalThis.fetch = (async () => {
    requests += 1;
    await gate;
    return new Response(
      JSON.stringify({
        href: `${asset}?sp=rl&sig=fresh-token`,
        "msft:expiry": "2099-01-01T00:00:00Z",
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch;
  try {
    // Project restore signs every STAC-backed layer at once, before any of
    // them can populate the settled cache.
    const hrefs = Promise.all([
      readableStacLayerHref(layerWithAccess(access), `${asset}?sig=expired`),
      readableStacLayerHref(layerWithAccess(access), `${asset}?sig=expired`),
      readableStacLayerHref(layerWithAccess(access), `${asset}?sig=expired`),
    ]);
    release();
    assert.deepEqual(await hrefs, Array(3).fill(`${asset}?sp=rl&sig=fresh-token`));
    assert.equal(requests, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a cancelled add stops waiting for its signing request", async () => {
  const asset = "https://ai4edataeuwest.blob.core.windows.net/io-lulc/cancelled.tif";
  const access = createStacAssetAccess(CATALOG, "io-lulc-annual-v02", asset);
  assert.ok(access);
  const originalFetch = globalThis.fetch;
  let release = (): void => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  globalThis.fetch = (async () => {
    await gate;
    return new Response(
      JSON.stringify({
        href: `${asset}?sp=rl&sig=fresh-token`,
        "msft:expiry": "2099-01-01T00:00:00Z",
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch;
  const controller = new AbortController();
  try {
    // Closing the panel must not leave the add handler pending on a stalled
    // signer, and it must not fall back to the unreadable unsigned URL either.
    const pending = readableStacAssetHref(access, `${asset}?sig=expired`, controller.signal);
    controller.abort();
    await assert.rejects(pending, (error: Error) => error.name === "AbortError");
    // The request itself lives on for whoever is still waiting on it.
    release();
    assert.equal(
      await readableStacAssetHref(access, `${asset}?sig=expired`),
      `${asset}?sp=rl&sig=fresh-token`,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a failed signing request does not block a later retry of the same asset", async () => {
  const asset = "https://ai4edataeuwest.blob.core.windows.net/io-lulc/retried.tif";
  const access = createStacAssetAccess(CATALOG, "io-lulc-annual-v02", asset);
  assert.ok(access);
  const originalFetch = globalThis.fetch;
  let attempts = 0;
  globalThis.fetch = (async () => {
    attempts += 1;
    if (attempts === 1) throw new Error("network down");
    return new Response(
      JSON.stringify({
        href: `${asset}?sp=rl&sig=fresh-token`,
        "msft:expiry": "2099-01-01T00:00:00Z",
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch;
  try {
    // The first attempt falls back to the unsigned URL; the shared request it
    // registered has to be gone by then, or the asset stays unsignable.
    assert.equal(await readableStacAssetHref(access, `${asset}?sig=expired`), asset);
    assert.equal(
      await readableStacAssetHref(access, `${asset}?sig=expired`),
      `${asset}?sp=rl&sig=fresh-token`,
    );
    assert.equal(attempts, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
