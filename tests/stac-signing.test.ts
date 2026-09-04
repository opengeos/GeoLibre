import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_LAYER_STYLE, type GeoLibreLayer } from "@geolibre/core";
import {
  createStacAssetAccess,
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
        token: "sp=rl&sig=fresh-token",
        "msft:expiry": "2099-01-01T00:00:00Z",
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch;
  try {
    const href = await readableStacLayerHref(layerWithAccess(access), `${ASSET}?sig=expired`);
    assert.equal(
      tokenUrl,
      "https://planetarycomputer.microsoft.com/api/sas/v1/token/io-lulc-annual-v02",
    );
    assert.equal(href, `${ASSET}?sp=rl&sig=fresh-token`);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
