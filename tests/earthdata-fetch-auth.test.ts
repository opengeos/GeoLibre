import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { withEarthdataAuth } from "../apps/geolibre-desktop/src/lib/earthdata-fetch-auth";
import {
  EARTHDATA_PROXY_ENDPOINT,
  earthdataProxyUrl,
  isEarthdataProxyUrl,
} from "../packages/plugins/src/plugins/earthdata-relay";

const COG =
  "https://data.lpdaac.earthdatacloud.nasa.gov/lp-prod-protected/HLSL30.020/HLS.L30.T16SGD.2026280T160613.v2.0/HLS.L30.T16SGD.2026280T160613.v2.0.B04.tif";

/** A fetch that records the Authorization header of each request. */
function recorder() {
  const seen: { url: string; authorization: string | null; range: string | null }[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : {}));
    seen.push({
      url: typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
      authorization: headers.get("authorization"),
      range: headers.get("range"),
    });
    return new Response("ok");
  }) as typeof fetch;
  return { seen, fetchImpl };
}

describe("Earthdata relay URLs", () => {
  it("round-trips a DAAC URL and matches only the exact route", () => {
    const relay = earthdataProxyUrl(COG);
    assert.ok(relay.startsWith(`${EARTHDATA_PROXY_ENDPOINT}?url=`));
    assert.equal(new URL(relay).searchParams.get("url"), COG);
    assert.equal(isEarthdataProxyUrl(relay), true);
    assert.equal(isEarthdataProxyUrl("https://tiles.geolibre.app/earthdata/download/x"), false);
    assert.equal(
      isEarthdataProxyUrl("https://tiles.geolibre.app.evil.com/earthdata/download"),
      false,
    );
    assert.equal(isEarthdataProxyUrl("http://tiles.geolibre.app/earthdata/download?url=x"), false);
    assert.equal(isEarthdataProxyUrl(COG), false);
    assert.equal(isEarthdataProxyUrl("not a url"), false);
  });
});

describe("Earthdata fetch auth", () => {
  it("adds the token to relay requests and keeps their other headers", async () => {
    const { seen, fetchImpl } = recorder();
    const wrapped = withEarthdataAuth(fetchImpl, () => "tok");
    await wrapped(earthdataProxyUrl(COG), { headers: { Range: "bytes=0-99" } });
    await wrapped(new Request(earthdataProxyUrl(COG), { headers: { Range: "bytes=5-9" } }));
    assert.deepEqual(
      seen.map(({ authorization, range }) => [authorization, range]),
      [
        ["Bearer tok", "bytes=0-99"],
        ["Bearer tok", "bytes=5-9"],
      ],
    );
  });

  it("never sends the token anywhere else, or without one saved", async () => {
    const { seen, fetchImpl } = recorder();
    await withEarthdataAuth(fetchImpl, () => "tok")(COG);
    await withEarthdataAuth(fetchImpl, () => "tok")("https://example.com/earthdata/download?url=x");
    await withEarthdataAuth(fetchImpl, () => "")(earthdataProxyUrl(COG));
    assert.deepEqual(
      seen.map((entry) => entry.authorization),
      [null, null, null],
    );
  });

  it("leaves a caller's own Authorization alone", async () => {
    const { seen, fetchImpl } = recorder();
    await withEarthdataAuth(fetchImpl, () => "saved")(earthdataProxyUrl(COG), {
      headers: { Authorization: "Bearer mine" },
    });
    assert.equal(seen[0].authorization, "Bearer mine");
  });
});
