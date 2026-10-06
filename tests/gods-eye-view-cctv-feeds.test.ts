import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CCTV_CATALOG_FAILURE_CACHE_MS,
  cctvCamerasToCzml,
  cctvPreviewsVisibleAtZoom,
  cctvShowPreviews,
  fetchCctvCzml,
  normalizeAustinCameras,
  normalizeCalgaryCameras,
  normalizeCaltransCameras,
  normalizeDriveBcCameras,
  normalizeFintrafficCameras,
  normalizeOntarioCameras,
  normalizeNswCameras,
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

const austin = [
  {
    camera_id: "86",
    location_name: "Congress Ave / 6th St",
    camera_status: "TURNED_ON",
    location: { type: "Point", coordinates: [-97.7431, 30.2672] },
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

const ontario = [
  {
    Id: 1,
    Roadway: "QEW",
    Location: "QEW West of Thompson Road",
    Latitude: 42.9143,
    Longitude: -78.958,
    Views: [
      {
        Url: "https://511on.ca/map/Cctv/2",
        Status: "Enabled",
        Description: "Looking Down",
      },
      {
        Url: "https://511on.ca/map/Cctv/1",
        Status: "Enabled",
        Description: "Toronto Bound",
      },
    ],
  },
];

const driveBc = [
  {
    id: 888,
    name: "Braden Road - W",
    location: { coordinates: [-120.76256, 55.7815] },
    is_on: true,
    should_appear: true,
  },
];

const nsw = {
  features: [
    {
      type: "Feature",
      id: "023651ee-389c-4677-978e-d39b6c24c1e7",
      geometry: { type: "Point", coordinates: [151.10533, -34.02977] },
      properties: {
        title: "5 Ways (Miranda)",
        view: "5 Ways at The Boulevarde looking west towards Sutherland.",
        href: "https://webcams.transport.nsw.gov.au/livetraffic-webcams/cameras/5_ways_&_miranda.jpeg",
      },
    },
  ],
};

const caltrans = {
  data: [
    {
      cctv: {
        inService: "true",
        location: {
          district: "4",
          locationName: "TV102 -- I-580 : West of SR-24",
          longitude: "-122.27291",
          latitude: "37.82539",
        },
        imageData: {
          static: {
            currentImageUpdateFrequency: "5",
            currentImageURL:
              "https://cwwp2.dot.ca.gov/data/d4/cctv/image/TV102i580WestOfSR24/TV102i580WestOfSR24.jpg",
          },
        },
      },
    },
  ],
};

describe("God's Eye View CCTV feeds", () => {
  it("shows ambient previews only above zoom 13", () => {
    assert.equal(cctvPreviewsVisibleAtZoom(null), false);
    assert.equal(cctvPreviewsVisibleAtZoom(13), false);
    assert.equal(cctvPreviewsVisibleAtZoom(13.0001), true);
  });

  it("lets the preview mode override the zoom rule", () => {
    assert.equal(cctvShowPreviews("auto", 10), false);
    assert.equal(cctvShowPreviews("auto", 15), true);
    assert.equal(cctvShowPreviews("always", null), true);
    assert.equal(cctvShowPreviews("always", 3), true);
    assert.equal(cctvShowPreviews("off", 18), false);
  });

  it("normalizes pinned TfL, Austin, Calgary, and Fintraffic frame sources", () => {
    assert.equal(normalizeTflCameras(tfl)[0].id, "tfl-00001.00001");
    assert.equal(
      normalizeAustinCameras(austin, false)[0].snapshotUrl,
      "https://tiles.geolibre.app/cctv/austin/86.jpg",
    );
    assert.equal(
      normalizeAustinCameras(austin, true)[0].snapshotUrl,
      "http://localhost/cctv/austin/86.jpg",
    );
    assert.equal(
      normalizeCalgaryCameras(calgary, true)[0].snapshotUrl,
      "http://localhost/cctv/calgary/86.jpg",
    );
    assert.equal(
      normalizeCalgaryCameras(calgary, false)[0].snapshotUrl,
      "https://tiles.geolibre.app/cctv/calgary/86.jpg",
    );
    assert.equal(
      normalizeFintrafficCameras(fintraffic)[0].snapshotUrl,
      "https://weathercam.digitraffic.fi/C0150301.jpg",
    );
  });

  it("normalizes pinned Ontario 511 and DriveBC frame sources", () => {
    const ontarioCamera = normalizeOntarioCameras(ontario, false)[0];
    assert.equal(ontarioCamera.id, "ontario-1");
    assert.match(ontarioCamera.name, /Toronto Bound/);
    assert.equal(ontarioCamera.snapshotUrl, "https://tiles.geolibre.app/cctv/ontario/1");
    assert.equal(
      normalizeOntarioCameras(ontario, true)[0].snapshotUrl,
      "http://localhost/cctv/ontario/1",
    );
    const driveBcCamera = normalizeDriveBcCameras(driveBc)[0];
    assert.equal(driveBcCamera.id, "drivebc-888");
    assert.equal(driveBcCamera.snapshotUrl, "https://www.drivebc.ca/images/888.jpg");
  });

  it("normalizes pinned Live Traffic NSW frame sources", () => {
    const camera = normalizeNswCameras(nsw, false)[0];
    assert.equal(camera.provider, "Live Traffic NSW");
    assert.equal(camera.snapshotUrl, "https://tiles.geolibre.app/cctv/nsw/5_ways_%26_miranda.jpeg");
    assert.equal(
      normalizeNswCameras(nsw, true)[0].snapshotUrl,
      "http://localhost/cctv/nsw/5_ways_%26_miranda.jpeg",
    );
    const fallback = normalizeNswCameras({
      features: [
        {
          ...nsw.features[0],
          properties: {
            ...nsw.features[0].properties,
            view: "x".repeat(141),
            title: "malformed\ntitle",
          },
        },
      ],
    })[0];
    assert.match(fallback.name, /^Live Traffic NSW Camera /);
  });

  it("normalizes pinned Caltrans frame sources", () => {
    const edge = normalizeCaltransCameras(caltrans, false)[0];
    assert.equal(edge.provider, "Caltrans District 4");
    assert.equal(
      edge.snapshotUrl,
      "https://tiles.geolibre.app/cctv/caltrans/4/TV102i580WestOfSR24.jpg",
    );
    assert.equal(edge.refreshMs, 10_000, "very fast upstream cadences are bounded");
    assert.equal(
      normalizeCaltransCameras(caltrans, true)[0].snapshotUrl,
      "http://localhost/cctv/caltrans/4/TV102i580WestOfSR24.jpg",
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
      normalizeAustinCameras([
        { ...austin[0], camera_status: "REMOVED" },
        {
          ...austin[0],
          camera_id: "87",
          location: { type: "Point", coordinates: [-80, 25] },
        },
        {
          ...austin[0],
          camera_id: "88",
          location: { type: "LineString", coordinates: [] },
        },
      ]),
      [],
    );
    assert.deepEqual(
      normalizeCalgaryCameras([
        { ...calgary[0], camera_url: { url: "https://example.com/loc86.jpg" } },
        {
          ...calgary[0],
          camera_url: { url: "https://trafficcam.calgary.ca/loc12345.jpg" },
        },
      ]),
      [],
    );
    assert.deepEqual(
      normalizeFintrafficCameras({
        features: [
          {
            ...fintraffic.features[0],
            properties: {
              ...fintraffic.features[0].properties,
              collectionStatus: "REMOVED",
            },
          },
        ],
      }),
      [],
    );
    assert.deepEqual(
      normalizeOntarioCameras([
        {
          ...ontario[0],
          Views: [{ Url: "https://mirror.traveliq.co/map/Cctv/1", Status: "Enabled" }],
        },
      ]),
      [],
    );
    assert.deepEqual(normalizeDriveBcCameras([{ ...driveBc[0], is_on: false }]), []);
    assert.deepEqual(
      normalizeNswCameras({
        features: [
          {
            ...nsw.features[0],
            properties: {
              ...nsw.features[0].properties,
              href: "https://example.com/camera.jpg",
            },
          },
        ],
      }),
      [],
    );
  });

  it("rejects null and otherwise non-numeric camera coordinates", () => {
    assert.deepEqual(normalizeTflCameras([{ ...tfl[0], lon: null }]), []);
    assert.deepEqual(
      normalizeCalgaryCameras([{ ...calgary[0], point: { coordinates: [[], 51.05] } }]),
      [],
    );
    assert.deepEqual(
      normalizeFintrafficCameras({
        features: [
          {
            ...fintraffic.features[0],
            geometry: { coordinates: [24.94, false] },
          },
        ],
      }),
      [],
    );
  });

  it("creates camera previews with a high-contrast badge and refreshable popup", () => {
    const camera = normalizeTflCameras(tfl)[0];
    const result = cctvCamerasToCzml([camera], 120_000);
    const packet = result.packets[1] as {
      billboard: { image: string; width: number; pixelOffset: { cartesian2: number[] } };
      label: { text: string; backgroundColor: { rgba: number[] } };
      point?: unknown;
      properties: { snapshot: string };
    };
    assert.match(packet.billboard.image, /geolibre_frame=2$/);
    assert.equal(packet.billboard.width, 96);
    assert.deepEqual(packet.billboard.pixelOffset.cartesian2, [0, -24]);
    assert.equal(packet.label.text, "CAM");
    assert.deepEqual(packet.label.backgroundColor.rgba, [34, 211, 238, 255]);
    assert.equal(packet.point, undefined);
    assert.equal(packet.properties.snapshot, packet.billboard.image);
    assert.equal(result.attributes.features[0].properties?.provider, "Transport for London");
  });

  it("keeps camera anchors but hides preview billboards at overview zooms", () => {
    const camera = normalizeTflCameras(tfl)[0];
    const result = cctvCamerasToCzml([camera], 120_000, false);
    const packet = result.packets[1] as {
      billboard?: unknown;
      label?: unknown;
      point: { pixelSize: number };
      properties: { snapshot: string };
    };
    assert.equal(packet.billboard, undefined);
    assert.equal(packet.label, undefined);
    assert.equal(packet.point.pixelSize, 18);
    assert.match(packet.properties.snapshot, /geolibre_frame=2$/);
  });

  it("stops reading a chunked catalog once it crosses the byte ceiling", async () => {
    const fetcher = (async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(8 * 1024 * 1024));
            controller.enqueue(new Uint8Array([1]));
            controller.close();
          },
        }),
        { status: 200 },
      )) as typeof fetch;
    await assert.rejects(
      fetchCctvCzml([-0.2, 51.45, 0, 51.65], { fetch: fetcher }),
      /Every CCTV provider failed/,
    );
  });

  it("fetches providers independently and keeps cameras inside the viewport", async () => {
    const requested: string[] = [];
    const realDateNow = Date.now;
    let currentTime = 1_000_000;
    Date.now = () => currentTime;
    const fetcher = (async (input: RequestInfo | URL) => {
      const url = String(input);
      requested.push(url);
      if (url.includes("tfl.gov.uk")) return new Response(JSON.stringify(tfl), { status: 200 });
      if (url.includes("calgary.ca")) return new Response("upstream down", { status: 503 });
      return new Response(JSON.stringify(fintraffic), { status: 200 });
    }) as typeof fetch;
    try {
      const result = await fetchCctvCzml([-0.2, 51.45, 0, 51.65], {
        fetch: fetcher,
        nowMs: 0,
      });
      const refreshed = await fetchCctvCzml([-0.2, 51.45, 0, 51.65], {
        fetch: fetcher,
        nowMs: 60_000,
      });
      assert.equal(requested.length, 11, "immediate repeats use every catalog cache");
      currentTime += CCTV_CATALOG_FAILURE_CACHE_MS + 1;
      await fetchCctvCzml([-0.2, 51.45, 0, 51.65], {
        fetch: fetcher,
        nowMs: 120_000,
      });
      assert.equal(requested.length, 12, "failed catalogs retry after the shorter failure TTL");
      assert.equal(result.attributes.features.length, 1);
      assert.equal(result.attributes.features[0].properties?.provider, "Transport for London");
      assert.notEqual(
        refreshed.attributes.features[0].properties?.snapshot,
        result.attributes.features[0].properties?.snapshot,
      );
    } finally {
      Date.now = realDateNow;
    }
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
