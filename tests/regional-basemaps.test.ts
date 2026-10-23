import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  PLANETARY_BASEMAP_SENTINEL_PREFIX,
  PLANETARY_BASEMAPS,
} from "../packages/core/src/ellipsoids";
import {
  CHINA_BASEMAPS,
  getRegionalBasemapById,
  getRegionalBasemapByStyleUrl,
  isRegionalBasemapSentinel,
  REGIONAL_BASEMAP_GROUPS,
  REGIONAL_BASEMAP_SENTINEL_PREFIX,
  REGIONAL_BASEMAPS,
} from "../packages/core/src/regional-basemaps";

describe("regional basemap catalog invariants", () => {
  it("basemap ids are unique", () => {
    const ids = REGIONAL_BASEMAPS.map((basemap) => basemap.id);
    assert.equal(new Set(ids).size, ids.length);
  });

  it("every basemap's styleUrl is its id under the regional sentinel prefix", () => {
    for (const basemap of REGIONAL_BASEMAPS) {
      assert.equal(basemap.styleUrl, `${REGIONAL_BASEMAP_SENTINEL_PREFIX}${basemap.id}`);
      assert.ok(isRegionalBasemapSentinel(basemap.styleUrl));
    }
  });

  it("every tile template carries the {z}/{x}/{y} placeholders MapLibre substitutes", () => {
    for (const basemap of REGIONAL_BASEMAPS) {
      for (const template of [basemap.tileUrl, basemap.overlayTileUrl].filter(Boolean)) {
        for (const placeholder of ["{z}", "{x}", "{y}"]) {
          assert.ok(
            template?.includes(placeholder),
            `${basemap.id} tile template is missing ${placeholder}`,
          );
        }
      }
    }
  });

  it("serves every basemap over https, so the desktop CSP and the web build accept it", () => {
    for (const basemap of REGIONAL_BASEMAPS) {
      assert.ok(basemap.tileUrl.startsWith("https://"), `${basemap.id} is not https`);
    }
  });

  // A regional basemap must never collide with the planetary sentinel: the
  // planetary path also switches the project's celestial body, which would
  // reproject measurements onto the wrong radius for an Earth basemap.
  it("uses a sentinel prefix distinct from the planetary one", () => {
    assert.notEqual(REGIONAL_BASEMAP_SENTINEL_PREFIX, PLANETARY_BASEMAP_SENTINEL_PREFIX);
    for (const basemap of REGIONAL_BASEMAPS) {
      assert.ok(!basemap.styleUrl.startsWith(PLANETARY_BASEMAP_SENTINEL_PREFIX));
    }
    const planetaryIds = new Set(PLANETARY_BASEMAPS.map((basemap) => basemap.id));
    for (const basemap of REGIONAL_BASEMAPS) {
      assert.ok(
        !planetaryIds.has(basemap.id),
        `${basemap.id} collides with a planetary basemap id`,
      );
    }
  });

  it("resolves a basemap by style URL and by id, and rejects an unknown one", () => {
    const street = getRegionalBasemapById("amap-street");
    assert.equal(street?.name, "高德地图");
    assert.equal(getRegionalBasemapByStyleUrl(street?.styleUrl)?.id, "amap-street");

    // An unresolvable sentinel (e.g. a project saved with an id since renamed)
    // still reads as a sentinel, so the map controller falls back to the
    // default basemap rather than fetching `geolibre://` as a URL.
    const stale = `${REGIONAL_BASEMAP_SENTINEL_PREFIX}gone`;
    assert.equal(getRegionalBasemapByStyleUrl(stale), undefined);
    assert.ok(isRegionalBasemapSentinel(stale));
    assert.ok(!isRegionalBasemapSentinel("https://tiles.openfreemap.org/styles/liberty"));
    assert.equal(getRegionalBasemapByStyleUrl(undefined), undefined);
    assert.equal(getRegionalBasemapById(undefined), undefined);
  });
});

describe("China basemaps", () => {
  it("groups every China basemap under the china region", () => {
    assert.ok(CHINA_BASEMAPS.length > 0);
    for (const basemap of CHINA_BASEMAPS) {
      assert.equal(basemap.region, "china");
    }
  });

  // Tencent numbers tile rows from the bottom; Amap uses standard xyz. Getting
  // this backwards renders the world vertically mirrored.
  it("marks the Tencent basemaps as TMS and leaves Amap on xyz", () => {
    for (const basemap of CHINA_BASEMAPS) {
      const expected = basemap.id.startsWith("tencent-") ? "tms" : undefined;
      assert.equal(basemap.scheme, expected, `${basemap.id} has the wrong tile scheme`);
    }
  });

  it("gives Amap Hybrid a label overlay and no other basemap one", () => {
    for (const basemap of CHINA_BASEMAPS) {
      if (basemap.id === "amap-hybrid") {
        assert.ok(basemap.overlayTileUrl, "amap-hybrid should stack the roads-and-labels tiles");
        // The hybrid is the satellite imagery plus labels, so its base tiles
        // must be the same source the plain satellite basemap uses.
        assert.equal(
          basemap.tileUrl,
          CHINA_BASEMAPS.find((b) => b.id === "amap-satellite")?.tileUrl,
        );
      } else {
        assert.equal(basemap.overlayTileUrl, undefined);
      }
    }
  });

  // Probed against the live endpoints: Amap's imagery serves a "no imagery"
  // placeholder rather than a 404 past 18, and Tencent 400s past 19 with 19
  // already blank. Capping here makes MapLibre overzoom (blur) instead.
  it("caps each source at its probed native zoom", () => {
    const expected: Record<string, number> = {
      "amap-street": 19,
      "amap-satellite": 18,
      "amap-hybrid": 18,
      "tencent-street": 18,
      "tencent-dark": 18,
    };
    for (const basemap of CHINA_BASEMAPS) {
      assert.equal(
        basemap.maxZoom,
        expected[basemap.id],
        `${basemap.id} has an unexpected maxZoom`,
      );
    }
  });

  // Not every regional basemap is offset (Tianditu publishes in CGCS2000), so
  // the flag records which are rather than being implied by the region.
  it("flags every China basemap as GCJ-02", () => {
    for (const basemap of CHINA_BASEMAPS) {
      assert.equal(basemap.gcj02, true, `${basemap.id} is missing the GCJ-02 flag`);
    }
  });

  it("credits the provider on every basemap", () => {
    for (const basemap of CHINA_BASEMAPS) {
      const expected = basemap.id.startsWith("amap-") ? "Amap" : "Tencent Maps";
      assert.ok(basemap.attribution.includes(expected), `${basemap.id} is missing its credit`);
    }
  });
});

describe("REGIONAL_BASEMAP_GROUPS (picker section)", () => {
  it("covers every regional basemap exactly once", () => {
    const grouped = REGIONAL_BASEMAP_GROUPS.flatMap((group) => group.basemaps.map((b) => b.id));
    assert.deepEqual([...grouped].sort(), [...REGIONAL_BASEMAPS.map((b) => b.id)].sort());
    assert.equal(new Set(grouped).size, grouped.length);
  });

  it("puts every basemap in the group matching its own region", () => {
    for (const group of REGIONAL_BASEMAP_GROUPS) {
      for (const basemap of group.basemaps) {
        assert.equal(basemap.region, group.id);
      }
    }
  });
});
