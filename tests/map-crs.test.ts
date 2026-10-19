import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import proj4 from "proj4";
import {
  adaptBboxTemplateToCrs,
  createEmptyProject,
  deriveTileMatrixSet,
  ELLIPSOIDS,
  getMapCrsPreset,
  MAP_CRS_PRESETS,
  normalizeMapCrs,
  parseMapCrsEpsgCode,
  parseProject,
  serializeProject,
} from "@geolibre/core";
import {
  setActiveMapCrs,
  tileTemplatesForMapCrs,
  type ResolvedMapCrs,
} from "../packages/map/src/active-map-crs";
import { createMapCrsStyle, MAP_CRS_BASEMAP_ID, resolveMapCrs } from "../packages/map/src/map-crs";
import { proxyWmsTileUrl } from "../packages/map/src/wms-proxy";
import type * as maplibregl from "maplibre-gl";

// A MapLibre map drawn flat in another CRS (issue #1128): presets, the stored
// preference, and the WMS templates that ask for tiles in that CRS.

const en = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../apps/geolibre-desktop/src/i18n/locales/en.json", import.meta.url)),
    "utf8",
  ),
);

const WMS_3857 =
  "https://example.com/wms?SERVICE=WMS&REQUEST=GetMap&VERSION=1.3.0&LAYERS=a&STYLES=" +
  "&FORMAT=image/png&CRS=EPSG:3857&WIDTH=256&HEIGHT=256&BBOX={bbox-epsg-3857}";

describe("MAP_CRS_PRESETS", () => {
  it("have unique ids, MapLibre-registrable codes and {bbox} basemaps", () => {
    const ids = MAP_CRS_PRESETS.map((preset) => preset.id);
    assert.equal(new Set(ids).size, ids.length);
    const bodies = new Set<string>(ELLIPSOIDS.map((ellipsoid) => ellipsoid.id));
    for (const preset of MAP_CRS_PRESETS) {
      // addProjection rejects a name without a colon (reserved for built-ins).
      assert.match(preset.code, /^[A-Z_0-9]+:\d+$/, preset.id);
      assert.ok(preset.basemap.tiles.includes("BBOX={bbox}"), preset.id);
      assert.ok(!preset.basemap.tiles.includes("bbox-epsg-3857"), preset.id);
      assert.ok(bodies.has(preset.ellipsoidId), preset.id);
      assert.ok(preset.tileMatrixSet.extentAtZoom0 > 0, preset.id);
      // proj4 must build the converter MapLibre is given.
      assert.doesNotThrow(() => proj4(preset.definition), preset.id);
    }
  });

  it("center each grid on the pole or the world it maps", () => {
    for (const preset of MAP_CRS_PRESETS) {
      const { origin, extentAtZoom0 } = preset.tileMatrixSet;
      const center = [origin[0] + extentAtZoom0 / 2, origin[1] - extentAtZoom0 / 2];
      const [lng, lat] = proj4(preset.definition).inverse(center);
      const polar =
        /polar/.test(preset.id) || preset.code === "EPSG:3413" || preset.code === "EPSG:3031";
      if (polar) assert.equal(Math.abs(Math.round(lat)), 90, preset.id);
      else assert.deepEqual([Math.round(lng), Math.round(lat)], [0, 0], preset.id);
    }
  });

  it("have an English name in en.json", () => {
    for (const preset of MAP_CRS_PRESETS) {
      assert.equal(en.settings.map.mapCrsPresets[preset.id], preset.name, preset.id);
    }
  });
});

describe("normalizeMapCrs", () => {
  it("keeps presets and EPSG codes and drops the default map", () => {
    assert.equal(normalizeMapCrs("mars-north-polar"), "mars-north-polar");
    assert.equal(normalizeMapCrs("EPSG:3995"), "EPSG:3995");
    assert.equal(normalizeMapCrs(" epsg:5070 "), "EPSG:5070");
    // Codes a preset uses resolve to it: one grid per registered code.
    assert.equal(normalizeMapCrs("EPSG:4326"), "earth-cylindrical");
    assert.equal(normalizeMapCrs("EPSG:3413"), "earth-arctic");
    assert.equal(normalizeMapCrs("epsg:3031"), "earth-antarctic");
    for (const value of [
      undefined,
      null,
      3031,
      "",
      "EPSG:3857",
      "EPSG:900913",
      "EPSG:0",
      "mars",
      "x:1",
    ]) {
      assert.equal(normalizeMapCrs(value), undefined, String(value));
    }
  });

  it("reads EPSG codes", () => {
    assert.equal(parseMapCrsEpsgCode("EPSG:3413"), 3413);
    assert.equal(parseMapCrsEpsgCode("moon-north-polar"), null);
    assert.equal(parseMapCrsEpsgCode(undefined), null);
    assert.equal(getMapCrsPreset("EPSG:3413"), undefined);
  });

  it("round-trips through the project file", () => {
    const project = createEmptyProject();
    project.preferences.map.mapCrs = "moon-south-polar";
    assert.equal(
      parseProject(serializeProject(project)).preferences.map.mapCrs,
      "moon-south-polar",
    );
    for (const value of ["EPSG:3857", "nope", 7]) {
      (project.preferences.map as { mapCrs?: unknown }).mapCrs = value;
      assert.equal(parseProject(serializeProject(project)).preferences.map.mapCrs, undefined);
    }
    delete project.preferences.map.mapCrs;
    assert.equal(parseProject(serializeProject(project)).preferences.map.mapCrs, undefined);
  });
});

describe("adaptBboxTemplateToCrs", () => {
  it("asks a Web Mercator WMS for {bbox} in the CRS over WMS 1.1.1", () => {
    assert.equal(
      adaptBboxTemplateToCrs(WMS_3857, "EPSG:3031"),
      "https://example.com/wms?SERVICE=WMS&REQUEST=GetMap&VERSION=1.1.1&LAYERS=a&STYLES=" +
        "&FORMAT=image/png&WIDTH=256&HEIGHT=256&BBOX={bbox}&SRS=EPSG:3031",
    );
  });

  it("replaces an existing SRS whatever its case", () => {
    const template =
      "https://example.com/wms?service=WMS&request=GetMap&version=1.1.1&srs=EPSG:3857&bbox={bbox-epsg-3857}";
    assert.equal(
      adaptBboxTemplateToCrs(template, "IAU_2015:49918"),
      "https://example.com/wms?service=WMS&request=GetMap&VERSION=1.1.1&SRS=IAU_2015:49918&bbox={bbox}",
    );
  });

  it("drops a CRS parameter that comes first", () => {
    assert.equal(
      adaptBboxTemplateToCrs("https://x.org/wms?CRS=EPSG:3857&BBOX={bbox-epsg-3857}", "EPSG:5070"),
      "https://x.org/wms?BBOX={bbox}&SRS=EPSG:5070&VERSION=1.1.1",
    );
  });

  it("points an ArcGIS export at the EPSG WKID, and gives up on other codes", () => {
    const template =
      "https://x.org/MapServer/export?bbox={bbox-epsg-3857}&bboxSR=3857&imageSR=3857&f=image";
    assert.equal(
      adaptBboxTemplateToCrs(template, "EPSG:3031"),
      "https://x.org/MapServer/export?bbox={bbox}&bboxSR=3031&imageSR=3031&f=image",
    );
    assert.equal(adaptBboxTemplateToCrs(template, "IAU_2015:49900"), null);
  });

  it("keeps a {bbox} template and rejects XYZ tiles", () => {
    const native = "https://x.org/wms?SRS=EPSG:3413&BBOX={bbox}";
    assert.equal(adaptBboxTemplateToCrs(native, "EPSG:3413"), native);
    assert.equal(adaptBboxTemplateToCrs("https://tile.osm.org/{z}/{x}/{y}.png", "EPSG:3413"), null);
  });
});

describe("deriveTileMatrixSet", () => {
  it("fits a polar CRS around the pole", () => {
    const grid = deriveTileMatrixSet(
      proj4("+proj=stere +lat_0=-90 +lat_ts=-71 +lon_0=0 +datum=WGS84 +units=m +no_defs"),
      false,
    );
    assert.ok(grid);
    const centerX = grid.origin[0] + grid.extentAtZoom0 / 2;
    const centerY = grid.origin[1] - grid.extentAtZoom0 / 2;
    // Centered on the pole, which sits at the CRS origin.
    assert.ok(Math.abs(centerX) < 1e-6 * grid.extentAtZoom0, String(centerX));
    assert.ok(Math.abs(centerY) < 1e-6 * grid.extentAtZoom0, String(centerY));
  });

  it("gives a geographic CRS the whole-world degree grid", () => {
    assert.deepEqual(deriveTileMatrixSet(proj4("EPSG:4326"), true), {
      origin: [-180, 180],
      extentAtZoom0: 360,
    });
  });

  it("returns null when nothing round-trips", () => {
    const broken = { forward: () => [Number.NaN, 0], inverse: () => null };
    assert.equal(deriveTileMatrixSet(broken, false), null);
  });
});

describe("map-crs (MapLibre side)", () => {
  const crs: ResolvedMapCrs = {
    id: "earth-arctic",
    code: "EPSG:3413",
    definition: getMapCrsPreset("earth-arctic")!.definition,
    tileMatrixSet: getMapCrsPreset("earth-arctic")!.tileMatrixSet,
    basemap: getMapCrsPreset("earth-arctic")!.basemap,
  };

  it("builds a style that carries the projection and the native basemap", () => {
    const style = createMapCrsStyle(crs);
    assert.deepEqual(style.projection, { type: "EPSG:3413" });
    assert.ok(style.sources[MAP_CRS_BASEMAP_ID]);
    assert.deepEqual(
      style.layers.map((layer) => layer.id),
      ["geolibre-blank-background", MAP_CRS_BASEMAP_ID],
    );
    // A fresh object per call: MapLibre mutates the style it is handed.
    assert.notEqual(createMapCrsStyle(crs), style);
  });

  it("adapts tile templates only on a map in a custom CRS", () => {
    const map = {} as maplibregl.Map;
    const xyz = "https://tile.osm.org/{z}/{x}/{y}.png";
    assert.deepEqual(tileTemplatesForMapCrs(map, [WMS_3857, xyz]), [WMS_3857, xyz]);
    setActiveMapCrs(map, crs);
    const [adapted, ...rest] = tileTemplatesForMapCrs(map, [WMS_3857, xyz]);
    assert.equal(rest.length, 0);
    assert.match(adapted, /BBOX=\{bbox\}/);
    assert.match(adapted, /SRS=EPSG:3413/);
    setActiveMapCrs(map, null);
    assert.deepEqual(tileTemplatesForMapCrs(map, [xyz]), [xyz]);
  });

  it("asks WMS layers on a planetary map for the label servers read", async () => {
    const map = {} as maplibregl.Map;
    const mars = await resolveMapCrs("mars-cylindrical");
    assert.equal(mars?.code, "IAU_2015:49900");
    setActiveMapCrs(map, mars);
    const [adapted] = tileTemplatesForMapCrs(map, [WMS_3857]);
    assert.match(adapted, /SRS=EPSG:4326/);
    setActiveMapCrs(map, await resolveMapCrs("moon-south-polar"));
    assert.match(tileTemplatesForMapCrs(map, [WMS_3857])[0], /SRS=EPSG:32761/);
    setActiveMapCrs(map, null);
  });

  it("resolves presets, EPSG codes and the default map", async () => {
    assert.equal(await resolveMapCrs(undefined), null);
    assert.equal(await resolveMapCrs("EPSG:3857"), null);
    const preset = await resolveMapCrs("mars-south-polar");
    assert.equal(preset?.code, "IAU_2015:49920");
    assert.ok(preset?.basemap);
    // A preset's code resolves to the preset, with its grid and basemap.
    assert.equal((await resolveMapCrs("EPSG:3031"))?.id, "earth-antarctic");
    const epsg = await resolveMapCrs("EPSG:5070");
    assert.equal(epsg?.code, "EPSG:5070");
    assert.equal(epsg?.basemap, undefined);
    assert.ok((epsg?.tileMatrixSet.extentAtZoom0 ?? 0) > 1e6);
    assert.equal(await resolveMapCrs("EPSG:999999"), null);
  });

  it("keeps {bbox} literal through the dev WMS proxy", () => {
    const proxied = proxyWmsTileUrl("https://x.org/wms?SRS=EPSG:3413&BBOX={bbox}");
    assert.ok(proxied.endsWith("BBOX%3D{bbox}"), proxied);
  });
});
