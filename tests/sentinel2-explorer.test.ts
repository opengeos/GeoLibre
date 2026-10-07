import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  S2_CATALOG_URL,
  S2_COLLECTIONS,
  aggregateMonths,
  bandRescale,
  filterScenes,
  l2aArchivePart,
  monthsIn,
  onRamp,
  partUrls,
  sceneDirectory,
  tilePasses,
  timeSeriesIndex,
  timeSeriesScenes,
  toScenes,
  windowMonths,
  type S2Scene,
} from "../packages/plugins/src/plugins/sentinel2-explorer-data";
import {
  S2_COMPOSITES,
  compositeTileUrl,
  paintComposite,
  parseCompositeTileUrl,
  pickOverview,
  utmProj4,
} from "../packages/plugins/src/plugins/sentinel2-composite";

const C1 = S2_COLLECTIONS["sentinel-2-c1-l2a"];
const L2A = S2_COLLECTIONS["sentinel-2-l2a"];

describe("Sentinel-2 explorer part selection", () => {
  it("picks the zone part of the original collection by year tier", () => {
    assert.equal(l2aArchivePart("31UFU", 2018), "items");
    assert.equal(l2aArchivePart("31UFU", 2019), "z21-35");
    assert.equal(l2aArchivePart("1VCJ", 2020), "z01-20");
    assert.equal(l2aArchivePart("31UFU", 2021), "z21-31");
    assert.equal(l2aArchivePart("60XWF", 2025), "z53-60");
    assert.equal(l2aArchivePart("XXX", 2025), null);
  });

  it("lists the months of a year a window touches", () => {
    assert.deepEqual(windowMonths(2025, "2025-03-10", "2025-05-02"), [3, 4, 5]);
    assert.deepEqual(windowMonths(2024, "2024-12-01", "2025-01-31"), [12]);
    assert.deepEqual(windowMonths(2025, "2024-12-01", "2025-01-31"), [1]);
    assert.deepEqual(windowMonths(2023, "2024-12-01", "2025-01-31"), []);
  });

  it("reads Collection 1's yearly part plus the monthly tails of the window", () => {
    assert.deepEqual(partUrls(C1, "31UFU", "2025-06-01", "2025-07-15", 2026), [
      `${S2_CATALOG_URL}/sentinel-2-c1-l2a/year=2025/items.parquet`,
      `${S2_CATALOG_URL}/sentinel-2-c1-l2a/year=2025/live.parquet`,
      `${S2_CATALOG_URL}/sentinel-2-c1-l2a/year=2025/live-06.parquet`,
      `${S2_CATALOG_URL}/sentinel-2-c1-l2a/year=2025/live-07.parquet`,
    ]);
  });

  it("reads one zone part of the original collection, plus live for the current year", () => {
    assert.deepEqual(partUrls(L2A, "31UFU", "2025-12-20", "2026-01-10", 2026), [
      `${S2_CATALOG_URL}/sentinel-2-l2a/year=2025/z21-31.parquet`,
      `${S2_CATALOG_URL}/sentinel-2-l2a/year=2026/z21-31.parquet`,
      `${S2_CATALOG_URL}/sentinel-2-l2a/year=2026/live.parquet`,
    ]);
  });
});

describe("Sentinel-2 explorer scenes", () => {
  const raw = [
    {
      id: "B",
      datetime: new Date("2025-06-12T10:36:56Z"),
      "eo:cloud_cover": 0.1,
      "s2:nodata_pixel_percentage": 33,
      thumbnail_url:
        "https://e84-earth-search-sentinel-data.s3.us-west-2.amazonaws.com/x/B/L2A_PVI.jpg",
      bbox: [4.8, 52.2, 6.1, 53.2],
      "s2:processing_baseline": "05.11",
    },
    {
      id: "A",
      datetime: "2025-06-30T10:42:34Z",
      "eo:cloud_cover": 40,
      "s2:nodata_pixel_percentage": null,
      thumbnail_url: "https://sentinel-cogs.s3.us-west-2.amazonaws.com/y/A/preview.jpg",
      bbox: { xmin: 1, ymin: 2, xmax: 3, ymax: 4 },
      "s2:processing_baseline": "03.00",
    },
    // A duplicate across the live tail and the archive, and an unparseable time.
    {
      id: "B",
      datetime: new Date("2025-06-12T10:36:56Z"),
      "eo:cloud_cover": 0.1,
    },
    { id: "C", datetime: null, "eo:cloud_cover": 5 },
  ];

  it("projects, dedupes and time-sorts decoded rows", () => {
    const scenes = toScenes(raw);
    assert.deepEqual(
      scenes.map((s) => s.id),
      ["B", "A"],
    );
    assert.equal(scenes[0].day, "2025-06-12");
    assert.equal(scenes[0].cover, 67);
    assert.equal(scenes[1].cover, null);
    assert.deepEqual(scenes[1].bbox, [1, 2, 3, 4]);
    assert.equal(scenes[1].baseline, "03.00");
  });

  it("filters by window, cloud and coverage, and sorts", () => {
    const scenes = toScenes(raw);
    const window = {
      from: "2025-06-01",
      to: "2025-06-30",
      maxCloud: 100,
      minCoverage: 0,
    };
    assert.deepEqual(
      filterScenes(scenes, window, "date").map((s) => s.id),
      ["A", "B"],
    );
    assert.deepEqual(
      filterScenes(scenes, { ...window, maxCloud: 10 }, "cloud").map((s) => s.id),
      ["B"],
    );
    // Unknown coverage is never excluded by the floor.
    assert.deepEqual(
      filterScenes(scenes, { ...window, minCoverage: 80 }, "coverage").map((s) => s.id),
      ["A"],
    );
    assert.deepEqual(
      filterScenes(scenes, { ...window, to: "2025-06-29" }, "cloud").map((s) => s.id),
      ["B"],
    );
  });

  it("orders the time slider frames oldest first, after the filters", () => {
    const scenes = toScenes(raw);
    const window = {
      from: "2025-06-01",
      to: "2025-06-30",
      maxCloud: 100,
      minCoverage: 0,
    };
    assert.deepEqual(
      timeSeriesScenes(scenes, window).map((s) => s.id),
      ["B", "A"],
    );
    assert.deepEqual(
      timeSeriesScenes(scenes, { ...window, maxCloud: 10 }).map((s) => s.id),
      ["B"],
    );
  });

  it("keeps the time slider near its scene when the frames change", () => {
    const frame = (id: string, t: number) => ({ id, t }) as S2Scene;
    const series = [frame("a", 10), frame("b", 20), frame("c", 30)];
    assert.equal(timeSeriesIndex([], "a", 10), -1);
    assert.equal(timeSeriesIndex(series, "b", 20), 1);
    // Filtered out: the nearest earlier frame, else the first.
    assert.equal(timeSeriesIndex(series, "gone", 25), 1);
    assert.equal(timeSeriesIndex(series, "gone", 99), 2);
    assert.equal(timeSeriesIndex(series, "gone", 5), 0);
    assert.equal(timeSeriesIndex(series, null, null), 0);
  });

  it("derives a scene's COG directory from its thumbnail", () => {
    assert.equal(
      sceneDirectory(
        "https://e84-earth-search-sentinel-data.s3.us-west-2.amazonaws.com/sentinel-2-c1-l2a/31/U/FU/2025/6/S2A_T31UFU_20250612T103656_L2A/L2A_PVI.jpg",
      ),
      "https://e84-earth-search-sentinel-data.s3.us-west-2.amazonaws.com/sentinel-2-c1-l2a/31/U/FU/2025/6/S2A_T31UFU_20250612T103656_L2A",
    );
    assert.throws(() => sceneDirectory("http://sentinel-cogs.s3.amazonaws.com/a/b.jpg"));
    assert.throws(() => sceneDirectory("https://evil.example.com/a/b.jpg"));
    assert.throws(() => sceneDirectory("not a url"));
    // Only Earth Search's two Sentinel-2 buckets, not any S3 bucket.
    assert.throws(() => sceneDirectory("https://other-bucket.s3.amazonaws.com/a/b.jpg"));
  });

  it("offsets reflectance stretches from processing baseline 04.00", () => {
    assert.deepEqual(bandRescale("B04", "05.11"), [1000, 4000]);
    assert.deepEqual(bandRescale("B04", "03.00"), [0, 3000]);
    assert.deepEqual(bandRescale("B12", null), [0, 4000]);
    assert.deepEqual(bandRescale("B08", "05.11"), [1000, 7000]);
    assert.deepEqual(bandRescale("B8A", null), [0, 6000]);
    assert.deepEqual(bandRescale("B11", null), [0, 5000]);
    assert.deepEqual(bandRescale("CLD_20m", "05.11"), [0, 100]);
    assert.deepEqual(bandRescale("SCL", "05.11"), [0, 19]);
  });
});

describe("Sentinel-2 explorer tile stats", () => {
  it("lists the months a window overlaps across a year boundary", () => {
    assert.deepEqual(monthsIn("2024-11-15", "2025-02-01"), [
      "2024-11",
      "2024-12",
      "2025-01",
      "2025-02",
    ]);
  });

  it("maps each metric onto the 0 (good) to 100 (poor) ramp", () => {
    assert.equal(onRamp("min_cloud_cover", 30), 30);
    assert.equal(onRamp("max_cover", 90), 10);
    assert.equal(onRamp("scene_count", 12), 4);
    assert.equal(onRamp("scene_count", 40), 0);
  });

  it("aggregates months per tile: min cloud, summed scenes, max coverage", () => {
    const stats = aggregateMonths(
      [
        [
          { tile: "31UFU", cc: 20, sc: 5, cover: 60, med: 50 },
          { tile: "31UFT", cc: null, sc: 2, cover: null, med: null },
        ],
        [{ tile: "31UFU", cc: 4, sc: 7, cover: 100, med: 70 }],
      ],
      "min_cloud_cover",
    );
    assert.deepEqual(stats.get("31UFU"), { v: 4, cc: 4, sc: 12, cover: 100 });
    // No cloud value for the metric: left out of the map.
    assert.equal(stats.has("31UFT"), false);
    const counts = aggregateMonths(
      [[{ tile: "31UFT", cc: null, sc: 2, cover: null, med: null }]],
      "scene_count",
    );
    assert.equal(counts.get("31UFT")?.v, 84);
  });

  it("dims tiles failing a filter, treating unknown values as passing", () => {
    const filters = { maxCloud: 10, minCoverage: 50, minScenes: 3 };
    assert.equal(tilePasses({ v: 0, cc: 5, sc: 4, cover: 60 }, filters), true);
    assert.equal(tilePasses({ v: 0, cc: 15, sc: 4, cover: 60 }, filters), false);
    assert.equal(tilePasses({ v: 0, cc: 5, sc: 2, cover: 60 }, filters), false);
    assert.equal(tilePasses({ v: 0, cc: 5, sc: 4, cover: 40 }, filters), false);
    assert.equal(tilePasses({ v: 0, cc: null, sc: null, cover: null }, filters), true);
  });
});

describe("Sentinel-2 explorer composites", () => {
  const dir =
    "https://e84-earth-search-sentinel-data.s3.us-west-2.amazonaws.com/sentinel-2-c1-l2a/31/U/FU/2025/6/S2A_T31UFU_20250612T103656_L2A";

  it("round-trips a composite tile URL and rejects foreign hosts", () => {
    const url = compositeTileUrl(dir, "ndvi", 1000)
      .replace("{z}", "12")
      .replace("{x}", "2100")
      .replace("{y}", "1340");
    assert.deepEqual(parseCompositeTileUrl(url), {
      z: 12,
      x: 2100,
      y: 1340,
      dir,
      key: "ndvi",
      offset: 1000,
    });
    const foreign = url.replace(
      encodeURIComponent(dir),
      encodeURIComponent("https://evil.example.com/x"),
    );
    assert.equal(parseCompositeTileUrl(foreign), null);
    const otherBucket = url.replace(
      encodeURIComponent(dir),
      encodeURIComponent("https://other-bucket.s3.us-west-2.amazonaws.com/x"),
    );
    assert.equal(parseCompositeTileUrl(otherBucket), null);
    assert.equal(parseCompositeTileUrl(url.replace("c=ndvi", "c=toString")), null);
    assert.equal(parseCompositeTileUrl(url.replace("o=1000", "o=7")), null);
  });

  it("stretches RGB composites per band and keys out nodata", () => {
    const out = new Uint8ClampedArray(8);
    // Baseline >= 04.00: DN carry the 1000 offset. B08 spans 1000..7000,
    // B04 and B03 1000..4000.
    paintComposite(
      S2_COMPOSITES.fcir,
      [
        [4000, 0],
        [2500, 3000],
        [1000, 3000],
      ],
      1000,
      out,
    );
    assert.deepEqual([...out.slice(0, 4)], [128, 128, 0, 255]);
    assert.equal(out[7], 0);
  });

  it("draws an index on its ramp over -1..1", () => {
    const out = new Uint8ClampedArray(12);
    // NDVI = (B08 - B04) / (B08 + B04) on offset-corrected DN: 1, 0, -1.
    paintComposite(
      S2_COMPOSITES.ndvi,
      [
        [1500, 1300, 1000],
        [1000, 1300, 1500],
      ],
      1000,
      out,
    );
    assert.deepEqual([...out.slice(0, 3)], [1, 102, 94]);
    assert.deepEqual([...out.slice(4, 7)], [245, 245, 245]);
    assert.deepEqual([...out.slice(8, 11)], [140, 81, 10]);
  });

  it("picks the coarsest overview still as fine as the tile", () => {
    assert.equal(pickOverview([10, 20, 40, 80], 5), 0);
    assert.equal(pickOverview([10, 20, 40, 80], 45), 2);
    assert.equal(pickOverview([10, 20, 40, 80], 1000), 3);
  });

  it("names WGS 84 UTM zones for proj4", () => {
    assert.equal(utmProj4(32631), "+proj=utm +zone=31 +datum=WGS84 +units=m +no_defs");
    assert.equal(utmProj4(32755), "+proj=utm +zone=55 +south +datum=WGS84 +units=m +no_defs");
    assert.throws(() => utmProj4(3857));
  });
});
