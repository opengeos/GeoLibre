import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Feature, FeatureCollection } from "geojson";
import { DOMParser } from "linkedom";
import { KML_ICON_URL_PROPERTY as MAP_KML_ICON_URL_PROPERTY } from "../packages/map/src/markers";
import { parseKmlText } from "../apps/geolibre-desktop/src/lib/kml";
import {
  createRemoteIconFetcher,
  fetchRemoteIconDataUrl,
  KML_ICON_HREF_PROPERTY,
  KML_ICON_URL_PROPERTY,
  remoteIconCandidates,
  resolveKmlFeatureIcons,
} from "../apps/geolibre-desktop/src/lib/kml-icons";

globalThis.DOMParser = DOMParser as unknown as typeof globalThis.DOMParser;

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
const PNG_DATA_URL = `data:image/png;base64,${Buffer.from(PNG_BYTES).toString("base64")}`;

function pointWithIcon(href: unknown): Feature {
  return {
    type: "Feature",
    geometry: { type: "Point", coordinates: [0, 0] },
    properties: { name: "pin", [KML_ICON_HREF_PROPERTY]: href },
  };
}

function collection(...features: Feature[]): FeatureCollection {
  return { type: "FeatureCollection", features };
}

/** A fake fetch serving `routes` (URL -> response), recording every request. */
function fakeFetch(routes: Record<string, () => Response>): typeof fetch & { calls: string[] } {
  const calls: string[] = [];
  const impl = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    const route = routes[url];
    if (!route) throw new TypeError("Failed to fetch");
    return route();
  }) as typeof fetch & { calls: string[] };
  impl.calls = calls;
  return impl;
}

const png = () => new Response(PNG_BYTES, { headers: { "content-type": "image/png" } });

describe("remoteIconCandidates", () => {
  it("tries an http icon over https first, keeping http as the fallback", () => {
    assert.deepEqual(
      remoteIconCandidates("http://maps.google.com/mapfiles/kml/paddle/red-circle.png"),
      [
        "https://maps.google.com/mapfiles/kml/paddle/red-circle.png",
        "http://maps.google.com/mapfiles/kml/paddle/red-circle.png",
      ],
    );
  });

  it("keeps an https icon as is and treats a protocol-relative one as https", () => {
    assert.deepEqual(remoteIconCandidates(" https://example.com/a.png "), [
      "https://example.com/a.png",
    ]);
    assert.deepEqual(remoteIconCandidates("//example.com/a.png"), ["https://example.com/a.png"]);
  });

  it("returns null for archive-relative and non-http hrefs", () => {
    assert.equal(remoteIconCandidates("files/icon.png"), null);
    assert.equal(remoteIconCandidates("../icons/icon.png"), null);
    assert.equal(remoteIconCandidates("root://icons/palette-3.png"), null);
    assert.equal(remoteIconCandidates("data:image/png;base64,AAAA"), null);
  });
});

describe("fetchRemoteIconDataUrl", () => {
  it("inlines a fetched raster icon as a data URL", async () => {
    const fetchImpl = fakeFetch({ "https://example.com/a.png": png });
    assert.equal(await fetchRemoteIconDataUrl("http://example.com/a.png", fetchImpl), PNG_DATA_URL);
    assert.deepEqual(fetchImpl.calls, ["https://example.com/a.png"]);
  });

  it("falls back to the original http URL when https fails", async () => {
    const fetchImpl = fakeFetch({ "http://example.com/a.png": png });
    assert.equal(await fetchRemoteIconDataUrl("http://example.com/a.png", fetchImpl), PNG_DATA_URL);
    assert.deepEqual(fetchImpl.calls, ["https://example.com/a.png", "http://example.com/a.png"]);
  });

  it("uses the file extension when the server sends no image content type", async () => {
    const fetchImpl = fakeFetch({
      "https://example.com/a.png": () =>
        new Response(PNG_BYTES, { headers: { "content-type": "application/octet-stream" } }),
    });
    assert.equal(
      await fetchRemoteIconDataUrl("https://example.com/a.png", fetchImpl),
      PNG_DATA_URL,
    );
  });

  it("rejects SVG, error responses, and oversized icons", async () => {
    const fetchImpl = fakeFetch({
      "https://example.com/a.svg": () =>
        new Response("<svg/>", { headers: { "content-type": "image/svg+xml" } }),
      "https://example.com/missing.png": () => new Response("", { status: 404 }),
      "https://example.com/huge.png": () =>
        new Response(new Uint8Array(2 * 1024 * 1024), { headers: { "content-type": "image/png" } }),
    });
    assert.equal(await fetchRemoteIconDataUrl("https://example.com/a.svg", fetchImpl), null);
    assert.equal(await fetchRemoteIconDataUrl("https://example.com/missing.png", fetchImpl), null);
    assert.equal(await fetchRemoteIconDataUrl("https://example.com/huge.png", fetchImpl), null);
  });
});

describe("fetchRemoteIconDataUrl body checks", () => {
  it("rejects a non-image content type even when the URL ends in .png", async () => {
    const fetchImpl = fakeFetch({
      "https://example.com/a.png": () =>
        new Response("<html>not found</html>", { headers: { "content-type": "text/html" } }),
    });
    assert.equal(await fetchRemoteIconDataUrl("https://example.com/a.png", fetchImpl), null);
  });

  it("stops reading a body with no Content-Length once it passes the cap", async () => {
    let pulled = 0;
    const chunk = new Uint8Array(256 * 1024);
    const fetchImpl = fakeFetch({
      "https://example.com/stream.png": () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              pulled += 1;
              controller.enqueue(chunk);
            },
          }),
          { headers: { "content-type": "image/png" } },
        ),
    });
    assert.equal(await fetchRemoteIconDataUrl("https://example.com/stream.png", fetchImpl), null);
    // 1 MB cap / 256 KB chunks: the fifth chunk crosses it, and reading stops.
    assert.ok(pulled <= 6, `pulled ${pulled} chunks from an endless stream`);
  });
});

describe("resolveKmlFeatureIcons", () => {
  it("resolves remote icons, fetching each distinct href once", async () => {
    const href = "http://maps.google.com/mapfiles/kml/shapes/star.png";
    const fetchImpl = fakeFetch({ "https://maps.google.com/mapfiles/kml/shapes/star.png": png });
    const data = collection(pointWithIcon(href), pointWithIcon(href));

    await resolveKmlFeatureIcons(data, undefined, createRemoteIconFetcher(fetchImpl));

    for (const feature of data.features) {
      assert.equal(feature.properties?.[KML_ICON_URL_PROPERTY], PNG_DATA_URL);
      assert.equal(KML_ICON_HREF_PROPERTY in (feature.properties ?? {}), false);
      assert.equal(feature.properties?.name, "pin");
    }
    assert.equal(fetchImpl.calls.length, 1);
  });

  it("hands archive-relative hrefs to the local resolver", async () => {
    const seen: string[] = [];
    const data = collection(pointWithIcon("files/icon.png"));
    await resolveKmlFeatureIcons(
      data,
      async (href) => {
        seen.push(href);
        return PNG_DATA_URL;
      },
      createRemoteIconFetcher(fakeFetch({})),
    );
    assert.deepEqual(seen, ["files/icon.png"]);
    assert.equal(data.features[0].properties?.[KML_ICON_URL_PROPERTY], PNG_DATA_URL);
  });

  it("strips unresolvable hrefs so they never reach the attribute table", async () => {
    const data = collection(
      pointWithIcon("files/icon.png"),
      pointWithIcon("https://example.com/down.png"),
      pointWithIcon(42),
    );
    await resolveKmlFeatureIcons(
      data,
      async () => {
        throw new Error("boom");
      },
      createRemoteIconFetcher(fakeFetch({})),
    );
    for (const feature of data.features) {
      assert.deepEqual(feature.properties, { name: "pin" });
    }
  });

  it("caps the number of distinct remote icons it fetches", async () => {
    const routes: Record<string, () => Response> = {};
    const features: Feature[] = [];
    for (let index = 0; index < 70; index += 1) {
      routes[`https://example.com/${index}.png`] = png;
      features.push(pointWithIcon(`https://example.com/${index}.png`));
    }
    const fetchImpl = fakeFetch(routes);
    const warn = console.warn;
    console.warn = () => {};
    try {
      await resolveKmlFeatureIcons(
        collection(...features),
        undefined,
        createRemoteIconFetcher(fetchImpl),
      );
    } finally {
      console.warn = warn;
    }
    assert.equal(fetchImpl.calls.length, 64);
    assert.equal(features.filter((f) => f.properties?.[KML_ICON_URL_PROPERTY]).length, 64);
  });

  it("shares one fetcher's cache and budget across collections", async () => {
    const fetchImpl = fakeFetch({ "https://example.com/shared.png": png });
    const fetchRemote = createRemoteIconFetcher(fetchImpl);
    const first = collection(pointWithIcon("https://example.com/shared.png"));
    const second = collection(pointWithIcon("https://example.com/shared.png"));
    await resolveKmlFeatureIcons(first, undefined, fetchRemote);
    await resolveKmlFeatureIcons(second, undefined, fetchRemote);
    assert.equal(fetchImpl.calls.length, 1);
    assert.equal(second.features[0].properties?.[KML_ICON_URL_PROPERTY], PNG_DATA_URL);
  });

  it("keeps its property names in sync with the KML parser and the map package", () => {
    const parsed = parseKmlText(`<kml xmlns="http://www.opengis.net/kml/2.2"><Placemark>
      <Style><IconStyle><Icon><href>files/a.png</href></Icon></IconStyle></Style>
      <Point><coordinates>0,0</coordinates></Point></Placemark></kml>`);
    assert.equal(parsed.features[0].properties?.[KML_ICON_HREF_PROPERTY], "files/a.png");
    assert.equal(KML_ICON_URL_PROPERTY, MAP_KML_ICON_URL_PROPERTY);
  });
});
