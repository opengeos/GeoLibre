import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  dedupeVectorUrlFetch,
  isBlockedUrlError,
  resetVectorUrlFetchDedupe,
  vectorDownloadFileName,
} from "../apps/geolibre-desktop/src/lib/vector-url-fetch";

const KMZ_URL =
  "https://firms.modaps.eosdis.nasa.gov/api/kml_fire_footprints/russia_asia/24h/" +
  "suomi-npp-viirs-c2/FirespotArea_russia_asia_suomi-npp-viirs-c2_24h.kmz";

/** A deferred promise, so a test can hold a download open across assertions. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, reject, resolve };
}

describe("dedupeVectorUrlFetch", () => {
  afterEach(() => {
    resetVectorUrlFetchDedupe();
  });

  // The whole point: the six layers of one KMZ must not pull the archive six
  // times over on every project open (opengeos/GeoLibre discussion #1757).
  it("shares one in-flight download across concurrent callers", async () => {
    const gate = deferred<File | null>();
    let downloads = 0;
    const download = () => {
      downloads += 1;
      return gate.promise;
    };

    const callers = Array.from({ length: 6 }, () => dedupeVectorUrlFetch(KMZ_URL, download));
    assert.equal(downloads, 1);

    const file = new File([new Uint8Array([1, 2, 3])], "fires.kmz");
    gate.resolve(file);
    const results = await Promise.all(callers);

    assert.equal(downloads, 1);
    // Identity, not just equality: the vector control keys its unzip and DuckDB
    // registration caches on the source object, so one object means one unzip.
    for (const result of results) assert.equal(result, file);
  });

  it("keeps distinct URLs on their own downloads", async () => {
    const seen: string[] = [];
    const download = (url: string) => async () => {
      seen.push(url);
      return new File([], "data.geojson");
    };

    await Promise.all([
      dedupeVectorUrlFetch("https://example.com/a.geojson", download("a")),
      dedupeVectorUrlFetch("https://example.com/b.geojson", download("b")),
    ]);

    assert.deepEqual(seen.sort(), ["a", "b"]);
  });

  // A collapser, never a cache: auto-refresh exists to pick up new data, so a
  // later tick has to hit the network again.
  it("re-downloads once the previous request has settled", async () => {
    let downloads = 0;
    const download = async () => {
      downloads += 1;
      return new File([], "fires.kmz");
    };

    await dedupeVectorUrlFetch(KMZ_URL, download);
    await dedupeVectorUrlFetch(KMZ_URL, download);

    assert.equal(downloads, 2);
  });

  it("shares a rejection with every caller and does not cache it", async () => {
    const gate = deferred<File | null>();
    let downloads = 0;
    const failing = () => {
      downloads += 1;
      return gate.promise;
    };

    const first = dedupeVectorUrlFetch(KMZ_URL, failing);
    const second = dedupeVectorUrlFetch(KMZ_URL, failing);
    gate.reject(new Error("Failed to fetch KMZ (503 Service Unavailable)."));

    await assert.rejects(first, /503/);
    await assert.rejects(second, /503/);
    assert.equal(downloads, 1);

    // The failure must not stick: the next attempt gets a fresh download.
    const recovered = await dedupeVectorUrlFetch(KMZ_URL, async () => new File([], "fires.kmz"));
    assert.ok(recovered);
    assert.equal(downloads, 1);
  });

  it("passes a null loader result through unchanged", async () => {
    const result = await dedupeVectorUrlFetch(KMZ_URL, async () => null);
    assert.equal(result, null);
  });
});

describe("vectorDownloadFileName", () => {
  it("uses the URL's file name so format detection still works", () => {
    assert.equal(
      vectorDownloadFileName(KMZ_URL),
      "FirespotArea_russia_asia_suomi-npp-viirs-c2_24h.kmz",
    );
  });

  it("ignores the query string", () => {
    assert.equal(
      vectorDownloadFileName("https://example.com/data/roads.gpkg?token=abc"),
      "roads.gpkg",
    );
  });

  it("decodes a percent-encoded name", () => {
    assert.equal(
      vectorDownloadFileName("https://example.com/my%20data.geojson"),
      "my data.geojson",
    );
  });

  it("falls back when the URL carries no extension", () => {
    // An OGC API / ArcGIS endpoint: the control sniffs the content type instead.
    assert.equal(vectorDownloadFileName("https://example.com/collections/items"), "data");
  });

  it("falls back on an unparseable URL", () => {
    assert.equal(vectorDownloadFileName("not a url"), "data");
  });
});

describe("isBlockedUrlError", () => {
  // The webview is not subject to the backend SSRF guard, so these must never
  // fall through to a plain browser fetch of the same URL.
  it("recognizes the backend's URL-policy rejections", () => {
    for (const message of [
      "Refusing to fetch a link-local, unspecified, or multicast address",
      "Unsupported URL scheme: file",
      "Invalid URL: relative URL without a base",
      "URL has no host",
    ]) {
      assert.equal(isBlockedUrlError(new Error(message)), true, message);
    }
  });

  it("reads a bare string rejection too (Tauri rejects with the raw message)", () => {
    assert.equal(
      isBlockedUrlError("Refusing to fetch a link-local, unspecified, or multicast address"),
      true,
    );
  });

  // Transport failures are exactly what the browser fallback is for.
  it("lets ordinary request failures fall back", () => {
    for (const message of [
      "Request failed: error sending request",
      "Could not read response body: error decoding response body",
      "Request failed with status 503 Service Unavailable",
      "Could not resolve host example.com",
    ]) {
      assert.equal(isBlockedUrlError(new Error(message)), false, message);
    }
  });
});
