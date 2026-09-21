import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  cctvCamerasToCzml,
  fetchCctvCzml,
  normalizeCalgaryCameras,
  normalizeFintrafficCameras,
  normalizeTflCameras,
} from "../packages/plugins/src/plugins/gods-eye-view-cctv-feeds";

const tfl = [
  {
    id: "JamCams_00001.00001",
    commonName: "London Camera",
    lat: 51.51,
    lon: -0.12,
    additionalProperties: [
      { key: "available", value: "true" },
      {
        key: "imageUrl",
        value: "https://s3-eu-west-1.amazonaws.com/jamcams.tfl.gov.uk/00001.00001.jpg",
      },
    ],
  },
];

const calgary = [
  {
    camera_location: "1 Street / 2 Avenue SW",
    camera_url: { url: "http://trafficcam.calgary.ca/loc86.jpg" },
    point: { coordinates: [-114.07, 51.05] },
  },
];

const fintraffic = {
  features: [
    {
      geometry: { coordinates: [24.94, 60.17, 10] },
      properties: {
        id: "C01503",
        name: "Helsinki",
        collectionStatus: "GATHERING",
        presets: [
          { id: "C0150301", inCollection: true },
          { id: "C0150399", inCollection: false },
        ],
      },
    },
  ],
};

describe("God's Eye View CCTV feeds", () => {
  it("normalizes pinned TfL, Calgary, and Fintraffic frame sources", () => {
    assert.equal(normalizeTflCameras(tfl)[0].id, "tfl-00001.00001");
    assert.equal(normalizeCalgaryCameras(calgary, true)[0].snapshotUrl, "/cctv/calgary/86.jpg");
    assert.equal(
      normalizeCalgaryCameras(calgary, false)[0].snapshotUrl,
      "https://tiles.geolibre.app/cctv/calgary/86.jpg",
    );
    assert.equal(
      normalizeFintrafficCameras(fintraffic)[0].snapshotUrl,
      "https://weathercam.digitraffic.fi/C0150301.jpg",
    );
  });

  it("rejects off-host and inactive camera records", () => {
    assert.deepEqual(
      normalizeTflCameras([
        {
          ...tfl[0],
          additionalProperties: [
            { key: "available", value: "true" },
            { key: "imageUrl", value: "https://example.com/frame.jpg" },
          ],
        },
      ]),
      [],
    );
    assert.deepEqual(
      normalizeCalgaryCameras([
        { ...calgary[0], camera_url: { url: "https://example.com/loc86.jpg" } },
      ]),
      [],
    );
    assert.deepEqual(
      normalizeFintrafficCameras({
        features: [
          {
            ...fintraffic.features[0],
            properties: { ...fintraffic.features[0].properties, collectionStatus: "REMOVED" },
          },
        ],
      }),
      [],
    );
  });

  it("creates refreshable image billboards and an image popup property", () => {
    const camera = normalizeTflCameras(tfl)[0];
    const result = cctvCamerasToCzml([camera], 120_000);
    const packet = result.packets[1] as {
      billboard: { image: string; width: number };
      properties: { snapshot: string };
    };
    assert.match(packet.billboard.image, /geolibre_frame=2$/);
    assert.equal(packet.billboard.width, 80);
    assert.equal(packet.properties.snapshot, packet.billboard.image);
    assert.equal(result.attributes.features[0].properties?.provider, "Transport for London");
  });

  it("fetches providers independently and keeps cameras inside the viewport", async () => {
    const requested: string[] = [];
    const fetcher = (async (input: RequestInfo | URL) => {
      const url = String(input);
      requested.push(url);
      if (url.includes("tfl.gov.uk")) return new Response(JSON.stringify(tfl), { status: 200 });
      if (url.includes("calgary.ca")) return new Response("upstream down", { status: 503 });
      return new Response(JSON.stringify(fintraffic), { status: 200 });
    }) as typeof fetch;
    const result = await fetchCctvCzml([-0.2, 51.45, 0, 51.65], {
      fetch: fetcher,
      nowMs: 0,
    });
    assert.equal(requested.length, 3);
    assert.equal(result.attributes.features.length, 1);
    assert.equal(result.attributes.features[0].properties?.provider, "Transport for London");
  });

  it("does not download global catalogs while the globe is zoomed out", async () => {
    let fetched = false;
    const result = await fetchCctvCzml([-180, -80, 180, 80], {
      fetch: (async () => {
        fetched = true;
        return new Response();
      }) as typeof fetch,
    });
    assert.equal(fetched, false);
    assert.equal(result.attributes.features.length, 0);
  });
});
