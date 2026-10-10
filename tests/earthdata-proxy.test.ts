import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  clearEarthdataPresignedCache,
  handleEarthdataDownload,
  isEarthdataDataUrl,
  isEarthdataRedirectUrl,
} from "../workers/tiles/src/earthdata";
import { tilesWorker } from "../workers/tiles/src/index";

const FILE =
  "https://data.nsidc.earthdatacloud.nasa.gov/nsidc-cumulus-prod-protected/ATLAS/ATL08/007/2026/07/18/ATL08_20260718174253_05303206_007_01.h5";
const PRESIGNED = "https://d3h5e2j7riftk6.cloudfront.net/s3-abc/ATL08.h5?A-userid=x&Signature=y";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearEarthdataPresignedCache();
});

function request(target: string, headers: Record<string, string> = {}): Request {
  const url = `https://tiles.geolibre.app/earthdata/download?url=${encodeURIComponent(target)}`;
  return new Request(url, { headers: { origin: "http://localhost:5173", ...headers } });
}

interface Hop {
  url: string;
  authorization: string | null;
  range: string | null;
}

/** A fake upstream that redirects the DAAC URL to a presigned URL, then serves bytes. */
function fakeUpstream(hops: Hop[], location = PRESIGNED) {
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const url = String(input);
    hops.push({ url, authorization: headers.get("authorization"), range: headers.get("range") });
    assert.equal(init?.redirect, "manual");
    if (url === FILE) return new Response(null, { status: 303, headers: { location } });
    return new Response("HDF", {
      status: headers.get("range") ? 206 : 200,
      headers: {
        "content-type": "application/x-hdf5",
        "content-length": "3",
        "set-cookie": "secret=1",
        ...(headers.get("range") ? { "content-range": "bytes 0-2/3" } : {}),
      },
    });
  };
}

describe("Earthdata download proxy", () => {
  it("sends the token to the DAAC only and streams the presigned file with CORS", async () => {
    const hops: Hop[] = [];
    const response = await handleEarthdataDownload(
      request(FILE, { authorization: "Bearer abc.def-ghi", range: "bytes=0-2" }),
      fakeUpstream(hops),
    );
    assert.equal(response.status, 206);
    assert.equal(await response.text(), "HDF");
    assert.deepEqual(hops, [
      { url: FILE, authorization: "Bearer abc.def-ghi", range: "bytes=0-2" },
      { url: PRESIGNED, authorization: null, range: "bytes=0-2" },
    ]);
    assert.equal(response.headers.get("access-control-allow-origin"), "*");
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.equal(response.headers.get("content-range"), "bytes 0-2/3");
    assert.equal(response.headers.get("set-cookie"), null);
    assert.match(response.headers.get("content-disposition") ?? "", /ATL08_2026/);
  });

  it("reuses the presigned URL for later range requests with the same token", async () => {
    const hops: Hop[] = [];
    const upstream = fakeUpstream(hops);
    const auth = { authorization: "Bearer cache-me", range: "bytes=0-2" };
    assert.equal((await handleEarthdataDownload(request(FILE, auth), upstream)).status, 206);
    assert.equal((await handleEarthdataDownload(request(FILE, auth), upstream)).status, 206);
    assert.deepEqual(
      hops.map((hop) => hop.url),
      [FILE, PRESIGNED, PRESIGNED],
    );
    assert.equal(hops[2].authorization, null);
    // Another token does not see that entry.
    await handleEarthdataDownload(
      request(FILE, { authorization: "Bearer other", range: "bytes=0-2" }),
      upstream,
    );
    assert.equal(hops[3].url, FILE);
  });

  it("does not cache a first hop to another Earthdata host", async () => {
    const MIDDLE = "https://data.ornldaac.earthdata.nasa.gov/protected/next.h5";
    const hops: string[] = [];
    const upstream = async (input: RequestInfo | URL) => {
      const url = String(input);
      hops.push(url);
      if (url === FILE) return new Response(null, { status: 303, headers: { location: MIDDLE } });
      if (url === MIDDLE)
        return new Response(null, { status: 303, headers: { location: PRESIGNED } });
      return new Response("HDF", { status: 200 });
    };
    const auth = { authorization: "Bearer hop" };
    await handleEarthdataDownload(request(FILE, auth), upstream);
    await handleEarthdataDownload(request(FILE, auth), upstream);
    assert.deepEqual(hops, [FILE, MIDDLE, PRESIGNED, FILE, MIDDLE, PRESIGNED]);
  });

  it("falls back to the DAAC when a cached presigned URL stops working", async () => {
    const hops: Hop[] = [];
    let expired = false;
    const base = fakeUpstream(hops);
    const upstream = async (input: RequestInfo | URL, init?: RequestInit) =>
      expired && String(input) === PRESIGNED
        ? (hops.push({ url: PRESIGNED, authorization: null, range: null }),
          new Response("expired", { status: 403 }))
        : base(input, init);
    const auth = { authorization: "Bearer t2" };
    await handleEarthdataDownload(request(FILE, auth), upstream);
    expired = true;
    const response = await handleEarthdataDownload(request(FILE, auth), upstream);
    assert.equal(response.status, 403);
    assert.deepEqual(
      hops.map((hop) => hop.url),
      [FILE, PRESIGNED, PRESIGNED, FILE, PRESIGNED],
    );
  });

  it("answers 401 when the DAAC sends the browser to the login page", async () => {
    const hops: Hop[] = [];
    const response = await handleEarthdataDownload(
      request(FILE),
      fakeUpstream(hops, "https://urs.earthdata.nasa.gov/oauth/authorize?client_id=x"),
    );
    assert.equal(response.status, 401);
    assert.equal(hops.length, 1);
  });

  it("refuses redirects off NASA, CloudFront and S3", async () => {
    const hops: Hop[] = [];
    const response = await handleEarthdataDownload(
      request(FILE, { authorization: "Bearer t" }),
      fakeUpstream(hops, "https://evil.example/steal"),
    );
    assert.equal(response.status, 502);
    assert.equal(hops.length, 1);
  });

  it("asks for identity encoding and sends a header-safe file name", async () => {
    const encodings: (string | null)[] = [];
    const odd =
      "https://data.lpdaac.earthdatacloud.nasa.gov/lp-prod-protected/x/a%0D%0Ab%C3%A9%22.tif";
    const upstream = async (_input: RequestInfo | URL, init?: RequestInit) => {
      encodings.push(new Headers(init?.headers).get("accept-encoding"));
      return new Response("TIF", { status: 200 });
    };
    const response = await handleEarthdataDownload(
      request(odd, { authorization: "Bearer e" }),
      upstream,
    );
    assert.equal(response.status, 200);
    assert.deepEqual(encodings, ["identity"]);
    assert.equal(
      response.headers.get("content-disposition"),
      'attachment; filename="a_0D_0Ab_C3_A9_22.tif"',
    );
  });

  it("answers 502 to a malformed redirect Location", async () => {
    const hops: Hop[] = [];
    const response = await handleEarthdataDownload(
      request(FILE, { authorization: "Bearer t" }),
      fakeUpstream(hops, "https://[bad"),
    );
    assert.equal(response.status, 502);
    assert.equal(response.headers.get("access-control-allow-origin"), "*");
  });

  it("refuses non-Earthdata targets and malformed tokens before fetching", async () => {
    const hops: Hop[] = [];
    const upstream = fakeUpstream(hops);
    for (const target of [
      "https://example.com/file.h5",
      "http://data.nsidc.earthdatacloud.nasa.gov/x.h5",
      "https://urs.earthdata.nasa.gov/api/users/tokens",
      "https://data.nsidc.earthdatacloud.nasa.gov.evil.com/x.h5",
      "not a url",
    ]) {
      assert.equal((await handleEarthdataDownload(request(target), upstream)).status, 400);
    }
    const badToken = await handleEarthdataDownload(
      request(FILE, { authorization: "Basic dXNlcjpwYXNz" }),
      upstream,
    );
    assert.equal(badToken.status, 400);
    assert.equal(hops.length, 0);
  });

  it("is origin-gated and preflights the Authorization header", async () => {
    let fetched = false;
    globalThis.fetch = (async () => {
      fetched = true;
      return new Response("HDF");
    }) as typeof fetch;
    const forbidden = await tilesWorker.fetch(
      new Request(`https://tiles.geolibre.app/earthdata/download?url=${encodeURIComponent(FILE)}`, {
        headers: { origin: "https://example.com" },
      }),
      {},
      {} as ExecutionContext,
    );
    assert.equal(forbidden.status, 403);
    assert.equal(fetched, false);
    const preflight = await tilesWorker.fetch(
      new Request("https://tiles.geolibre.app/earthdata/download", { method: "OPTIONS" }),
      {},
      {} as ExecutionContext,
    );
    assert.equal(preflight.status, 204);
    assert.match(preflight.headers.get("access-control-allow-headers") ?? "", /authorization/);
  });

  it("classifies hosts", () => {
    assert.equal(
      isEarthdataDataUrl("https://data.ornldaac.earthdata.nasa.gov/protected/x.h5"),
      true,
    );
    assert.equal(isEarthdataDataUrl("https://data.lpdaac.earthdatacloud.nasa.gov/x.h5"), true);
    assert.equal(
      isEarthdataDataUrl("https://data.lpdaac.earthdatacloud.nasa.gov:8443/x.h5"),
      false,
    );
    assert.equal(isEarthdataRedirectUrl(PRESIGNED), true);
    assert.equal(isEarthdataRedirectUrl("https://bucket.s3.us-west-2.amazonaws.com/x"), true);
    assert.equal(isEarthdataRedirectUrl("https://s3.us-west-2.amazonaws.com/bucket/x"), true);
    assert.equal(isEarthdataRedirectUrl("https://lambda-url.us-east-1.on.aws/x"), false);
    assert.equal(
      isEarthdataRedirectUrl("https://abc.execute-api.us-east-1.amazonaws.com/x"),
      false,
    );
    assert.equal(isEarthdataDataUrl(PRESIGNED), false);
  });
});
