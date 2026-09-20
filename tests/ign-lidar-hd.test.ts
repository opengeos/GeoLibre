import turfBbox from "@turf/bbox";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildIgnLidarHdWfsUrl,
  fetchIgnLidarHdTiles,
  IGN_LIDAR_HD_MAX_QUERY_AREA_SQUARE_DEGREES,
  IGN_LIDAR_HD_MAX_RESULT_COUNT,
  IGN_LIDAR_HD_TYPENAME,
  IGN_LIDAR_HD_WFS_ENDPOINT,
  parseIgnLidarHdFeatureCollection,
  type IgnLidarHdFetch,
} from "../packages/plugins/src/plugins/ign-lidar-hd-api";
import { IGN_LIDAR_HD_PLUGIN_ID } from "../packages/plugins/src/plugins/maplibre-ign-lidar-hd";
import { WEB_SERVICE_PLUGIN_IDS } from "../packages/plugins/src/plugins/web-service-sync";

describe("buildIgnLidarHdWfsUrl", () => {
  it("targets the Géoplateforme WFS with a CRS84 lon,lat BBOX", () => {
    const url = new URL(buildIgnLidarHdWfsUrl([2.25, 48.83, 2.35, 48.87]));
    assert.equal(url.origin + url.pathname, IGN_LIDAR_HD_WFS_ENDPOINT);
    assert.equal(url.searchParams.get("SERVICE"), "WFS");
    assert.equal(url.searchParams.get("VERSION"), "2.0.0");
    assert.equal(url.searchParams.get("REQUEST"), "GetFeature");
    assert.equal(url.searchParams.get("TYPENAMES"), IGN_LIDAR_HD_TYPENAME);
    assert.equal(url.searchParams.get("OUTPUTFORMAT"), "application/json");
    assert.equal(
      url.searchParams.get("BBOX"),
      "2.25,48.83,2.35,48.87,urn:ogc:def:crs:OGC:1.3:CRS84",
    );
  });

  it("caps COUNT at the maximum result count", () => {
    const url = new URL(buildIgnLidarHdWfsUrl([0, 0, 1, 1], { count: 10_000 }));
    assert.equal(url.searchParams.get("COUNT"), String(IGN_LIDAR_HD_MAX_RESULT_COUNT));
  });

  it("defaults COUNT to the maximum result count", () => {
    const url = new URL(buildIgnLidarHdWfsUrl([0, 0, 1, 1]));
    assert.equal(url.searchParams.get("COUNT"), String(IGN_LIDAR_HD_MAX_RESULT_COUNT));
  });

  it("rejects invalid bounds", () => {
    assert.throws(() => buildIgnLidarHdWfsUrl([2, 1, 0, 3]));
    assert.throws(() => buildIgnLidarHdWfsUrl([Number.NaN, 0, 1, 1]));
  });

  it("rejects queries above the area cap", () => {
    const side = Math.sqrt(IGN_LIDAR_HD_MAX_QUERY_AREA_SQUARE_DEGREES) + 1;
    assert.throws(() => buildIgnLidarHdWfsUrl([0, 0, side, side]), /limited to 2 square degrees/);
  });
});

describe("parseIgnLidarHdFeatureCollection", () => {
  it("maps WFS properties onto tiles and builds footprints", () => {
    const result = parseIgnLidarHdFeatureCollection({
      numberMatched: 1,
      features: [
        {
          id: "metadata.1",
          geometry: { type: "Point", coordinates: [2.3, 48.85] },
          properties: {
            coordonnees_nw: "0644-6860",
            code_mission: "22LHDKE",
            date_debut_acquisition: "2023-02-01Z",
            date_fin_acquisition: "2023-02-01Z",
            nombre_points: 123456,
            url_npl:
              "https://data.geopf.fr/telechargement/download/x/y/LHD_FXX_0644_6860_PTS_LAMB93_IGN69.copc.laz",
          },
        },
      ],
    });
    assert.equal(result.tiles.length, 1);
    const [tile] = result.tiles;
    assert.equal(tile.tileCoord, "0644-6860");
    assert.equal(tile.missionCode, "22LHDKE");
    assert.equal(tile.acquisitionStart, "2023-02-01");
    assert.equal(tile.acquisitionEnd, "2023-02-01");
    assert.equal(tile.pointCount, 123456);
    assert.equal(tile.filename, "LHD_FXX_0644_6860_PTS_LAMB93_IGN69.copc.laz");
    assert.equal(
      tile.downloadUrl,
      "https://data.geopf.fr/telechargement/download/x/y/LHD_FXX_0644_6860_PTS_LAMB93_IGN69.copc.laz",
    );
    assert.equal(result.footprints.features.length, 1);
    assert.equal(result.footprints.features[0].properties?.tileCoord, "0644-6860");
    assert.equal(result.matched, 1);
    assert.equal(result.truncated, false);
  });

  it("drops features without a geometry", () => {
    const result = parseIgnLidarHdFeatureCollection({
      features: [{ id: "metadata.2", geometry: null, properties: {} }],
    });
    assert.equal(result.tiles.length, 0);
    assert.equal(result.footprints.features.length, 0);
  });

  it("rejects a non-HTTPS download URL", () => {
    const result = parseIgnLidarHdFeatureCollection({
      features: [
        {
          id: "metadata.3",
          geometry: { type: "Point", coordinates: [0, 0] },
          properties: { url_npl: "javascript:alert(1)" },
        },
      ],
    });
    assert.equal(result.tiles[0].downloadUrl, null);
    assert.equal(result.tiles[0].filename, null);
  });

  it("flags truncated results when the match count exceeds the page", () => {
    const result = parseIgnLidarHdFeatureCollection({
      numberMatched: 5,
      features: [{ id: "metadata.4", geometry: { type: "Point", coordinates: [0, 0] } }],
    });
    assert.equal(result.matched, 5);
    assert.equal(result.truncated, true);
  });
});

describe("fetchIgnLidarHdTiles", () => {
  it("queries the WFS and parses the response", async () => {
    const calls: string[] = [];
    const fetchImpl: IgnLidarHdFetch = async (url) => {
      calls.push(url);
      return {
        ok: true,
        status: 200,
        json: async () => ({ numberMatched: 0, features: [] }),
        text: async () => "",
      };
    };
    const result = await fetchIgnLidarHdTiles([0, 0, 1, 1], { fetchImpl });
    assert.equal(calls.length, 1);
    assert.ok(calls[0].startsWith(IGN_LIDAR_HD_WFS_ENDPOINT));
    assert.equal(result.tiles.length, 0);
  });

  it("surfaces WFS HTTP errors", async () => {
    const fetchImpl: IgnLidarHdFetch = async () => ({
      ok: false,
      status: 503,
      json: async () => ({}),
      text: async () => "Service unavailable",
    });
    await assert.rejects(
      () => fetchIgnLidarHdTiles([0, 0, 1, 1], { fetchImpl }),
      /503.*Service unavailable/,
    );
  });

  it("aborts a stalled request after the client timeout", async () => {
    const fetchImpl: IgnLidarHdFetch = async (_url, init) =>
      await new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      });
    await assert.rejects(
      () => fetchIgnLidarHdTiles([0, 0, 1, 1], { fetchImpl, timeoutMs: 5 }),
      /timed out/,
    );
  });
});

function bboxesIntersect(
  a: [number, number, number, number],
  b: [number, number, number, number],
): boolean {
  const [aWest, aSouth, aEast, aNorth] = a;
  const [bWest, bSouth, bEast, bNorth] = b;
  return aWest <= bEast && aEast >= bWest && aSouth <= bNorth && aNorth >= bSouth;
}

describe("fetchIgnLidarHdTiles (live)", () => {
  it("returns real LiDAR HD tile coverage for central Paris", async (t) => {
    const bbox: [number, number, number, number] = [2.25, 48.83, 2.42, 48.9];
    let result: Awaited<ReturnType<typeof fetchIgnLidarHdTiles>>;
    try {
      result = await fetchIgnLidarHdTiles(bbox);
    } catch (error) {
      if (error instanceof TypeError) {
        t.skip(`network unavailable: ${error.message}`);
        return;
      }
      throw error;
    }

    assert.ok(result.tiles.length > 0, "expected at least one LiDAR HD tile over central Paris");
    assert.ok(result.matched == result.tiles.length);

    for (const tile of result.tiles) {
      assert.equal(typeof tile.id, "string");
      assert.ok(tile.id.length > 0);
      assert.ok(tile.geometry, `tile ${tile.id} is missing a geometry`);
      const tileBbox = turfBbox(tile.geometry) as [number, number, number, number];
      assert.ok(
        bboxesIntersect(tileBbox, bbox),
        `tile ${tile.id} bbox [${tileBbox}] does not intersect the requested bbox [${bbox}]`,
      );
      if (tile.tileCoord !== null) assert.match(tile.tileCoord, /^\d{4}-\d{4}$/);
      if (tile.downloadUrl !== null) assert.match(tile.downloadUrl, /^https:\/\//);
      if (tile.pointCount !== null) assert.ok(tile.pointCount > 0);
    }
  });
});

describe("IGN LiDAR HD downloader registration", () => {
  it("appears in the Web Services plugin group", () => {
    assert.ok(WEB_SERVICE_PLUGIN_IDS.includes(IGN_LIDAR_HD_PLUGIN_ID));
  });
});
