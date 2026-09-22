import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MAPLIBRE_CAPABILITIES } from "../packages/map/src/map-engine";
import { MAPBOX_CAPABILITIES } from "../packages/map/src/mapbox-engine";
import { CESIUM_CAPABILITIES, CESIUM_PANE_CAPABILITIES } from "../packages/map/src/cesium-engine";
import { ARCGIS_CAPABILITIES, ARCGIS_DECK_CAPABILITIES } from "../packages/map/src/arcgis-engine";
import { projectExtentCorners } from "../apps/geolibre-desktop/src/hooks/useExtentScreenOverlay";
import type { MapExtent } from "../packages/map/src/map-engine";

/**
 * A stand-in for a Web Mercator `project`: 1 degree = 1 pixel, y flipped, so
 * corner ordering is readable in the assertions.
 */
function flatProject([lng, lat]: [number, number]) {
  return { x: lng, y: -lat };
}

describe("projectExtentCorners (#2475)", () => {
  const bbox: MapExtent = [-10, -5, 10, 5];

  it("emits the corners in NW, NE, SE, SW order", () => {
    const points = projectExtentCorners(flatProject, bbox);
    assert.deepEqual(points, [
      { x: -10, y: -5 },
      { x: 10, y: -5 },
      { x: 10, y: 5 },
      { x: -10, y: 5 },
    ]);
  });

  it("projects all four corners so a rotated camera still gets a true outline", () => {
    // A 90° screen rotation: a two-corner box would still draw axis-aligned.
    const rotated = projectExtentCorners(([lng, lat]) => ({ x: lat, y: lng }), bbox);
    assert.deepEqual(rotated, [
      { x: 5, y: -10 },
      { x: 5, y: 10 },
      { x: -5, y: 10 },
      { x: -5, y: -10 },
    ]);
  });

  it("has nothing to draw without a box", () => {
    assert.equal(projectExtentCorners(flatProject, null), null);
  });

  it("drops a box wider than the span guard, and keeps one inside it", () => {
    // The Basemap Extract panel's guard: a near-global box degenerates into a
    // stray diagonal, so it opts out rather than drawing a wrong rectangle.
    assert.equal(projectExtentCorners(flatProject, [-180, -85, 180, 85], 170), null);
    assert.equal(projectExtentCorners(flatProject, [-10, -86, 10, 86], 170), null);
    assert.ok(projectExtentCorners(flatProject, [-80, -80, 80, 80], 170));
    // No guard given (the Raster Subset panel): every box is drawn.
    assert.ok(projectExtentCorners(flatProject, [-180, -85, 180, 85]));
  });
});

describe("screenOverlays capability (#2475)", () => {
  it("is true for the 2D engines, whose panels draw their own SVG outline", () => {
    // The extract panels project through `MapRenderSurface.project` and render
    // an SVG, so the outline sits above the interleaved deck.gl raster overlay
    // a style layer would end up beneath — which is the very raster a subset is
    // drawn over. Mapbox used to fall through to the native `showExtent` box
    // and the outline came out partly hidden, or missing entirely when the
    // style was still loading.
    assert.equal(MAPLIBRE_CAPABILITIES.screenOverlays, true);
    assert.equal(MAPBOX_CAPABILITIES.screenOverlays, true);
  });
  it("is false for the globe engines, which draw the extent natively", () => {
    assert.equal(CESIUM_CAPABILITIES.screenOverlays, false);
    assert.equal(CESIUM_PANE_CAPABILITIES.screenOverlays, false);
    assert.equal(ARCGIS_CAPABILITIES.screenOverlays, false);
    assert.equal(ARCGIS_DECK_CAPABILITIES.screenOverlays, false);
  });
});

describe("flatProjection capability (#2475)", () => {
  it("is true wherever the project's mercator projection is honored", () => {
    // Atmospheric effects idle in a flat projection, so the Controls menu reads
    // this plus `preferences.map.projection` instead of "has no MapLibre map",
    // which left the submenu enabled on Mapbox in Mercator.
    assert.equal(MAPLIBRE_CAPABILITIES.flatProjection, true);
    assert.equal(MAPBOX_CAPABILITIES.flatProjection, true);
    assert.equal(ARCGIS_CAPABILITIES.flatProjection, true);
  });
  it("is false for Cesium, a globe whatever the projection preference says", () => {
    assert.equal(CESIUM_CAPABILITIES.flatProjection, false);
    assert.equal(CESIUM_PANE_CAPABILITIES.flatProjection, false);
  });
});

describe("terrainSource capability (#2475)", () => {
  it("is false only on Mapbox, which has no raster-dem source a COG can back", () => {
    // `MapboxEngine.setTerrainCogSource` returns false for any real source, so
    // the Terrain settings dialog hides the whole section there rather than
    // accepting a URL, a file or a raster layer and doing nothing at all.
    assert.equal(MAPBOX_CAPABILITIES.terrainSource, false);
    assert.equal(MAPLIBRE_CAPABILITIES.terrainSource, true);
    assert.equal(CESIUM_CAPABILITIES.terrainSource, true);
    assert.equal(ARCGIS_CAPABILITIES.terrainSource, true);
  });
  it("still leaves Mapbox its own terrain and exaggeration", () => {
    assert.equal(MAPBOX_CAPABILITIES.terrain, true);
  });
});
