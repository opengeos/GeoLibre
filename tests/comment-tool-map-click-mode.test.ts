import { act, render, resetStores } from "./helpers/dom";
import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import { createElement } from "react";

// Loaded after the harness so its CSS imports and Vite globals are handled.
const { useCommentTool } =
  await import("../apps/geolibre-desktop/src/components/comments/useCommentTool");

type ClickHandler = (event: unknown) => void;

/**
 * A MapLibre stand-in with just what the comment tool touches: click
 * listeners, the canvas cursor and feature picking under the click.
 */
function fakeMapEngine() {
  const handlers = new Set<ClickHandler>();
  const canvas = { style: { cursor: "" } };
  const map = {
    on: (type: string, handler: ClickHandler) => {
      if (type === "click") handlers.add(handler);
    },
    off: (type: string, handler: ClickHandler) => {
      if (type === "click") handlers.delete(handler);
    },
    getCanvas: () => canvas,
    queryRenderedFeatures: () => [],
  };
  const engine = {
    capabilities: { nativeMapInstance: true },
    getMap: () => map,
    getRenderSurface: () => null,
  };
  const click = () => {
    const event = {
      point: { x: 120, y: 80 },
      lngLat: { lng: -76.2869, lat: 36.8535 },
      originalEvent: { stopPropagation: () => {} },
    };
    for (const handler of [...handlers]) handler(event);
  };
  return { engine, click, canvas };
}

type CommentTool = ReturnType<typeof useCommentTool>;

/**
 * Render the comment tool against a fake map and hand back its latest state.
 *
 * @param isMapClickModeActive - Whether Directions / Reverse Geocode owns clicks.
 * @returns The fake map's click trigger and a getter for the hook's state.
 */
function renderCommentTool(isMapClickModeActive: () => boolean) {
  const { engine, click } = fakeMapEngine();
  let tool: CommentTool | null = null;
  function Harness() {
    tool = useCommentTool({
      mapControllerRef: { current: engine as never },
      mapReadyGeneration: 1,
      isMapClickModeActive,
    });
    return null;
  }
  render(createElement(Harness));
  return { click, current: () => tool! };
}

afterEach(() => resetStores());

it("leaves a Directions-mode map click to Directions instead of opening the comment dialog (#3256)", () => {
  let directionsActive = true;
  const { click, current } = renderCommentTool(() => directionsActive);
  act(() => current().activateTool());
  assert.equal(current().isActive, true);

  // A click on the search pin reaches the map's click listeners like any map
  // click; Directions turns it into a waypoint, so no comment card opens.
  act(() => click());
  assert.equal(current().pendingComment, null);
  // The ignored click leaves the tool armed for after Directions ends.
  assert.equal(current().isActive, true);

  // Leaving Directions hands clicks back to the armed comment tool.
  directionsActive = false;
  act(() => click());
  assert.deepEqual(current().pendingComment?.anchor, {
    type: "point",
    lngLat: [-76.2869, 36.8535],
  });
});

it("still anchors a comment on a map click when no map-click mode is on", () => {
  const { click, current } = renderCommentTool(() => false);
  act(() => current().activateTool());
  act(() => click());
  assert.equal(current().pendingComment?.anchor.type, "point");
});

it("leaves a Reverse Geocode click alone on a non-MapLibre renderer too", () => {
  // Another renderer reports clicks through `onMapClick` instead of MapLibre's
  // own events, so the gate has to hold on that path as well.
  const clicks = new Set<(lngLat: [number, number]) => void>();
  const canvas = { style: { cursor: "" } };
  const engine = {
    capabilities: { nativeMapInstance: false },
    getMap: () => null,
    getRenderSurface: () => ({ getCanvas: () => canvas, project: () => ({ x: 40, y: 30 }) }),
    onMapClick: (handler: (lngLat: [number, number]) => void) => {
      clicks.add(handler);
      return () => clicks.delete(handler);
    },
    identifyFeatures: () => [],
  };
  let reverseGeocodeActive = true;
  let tool: CommentTool | null = null;
  function Harness() {
    tool = useCommentTool({
      mapControllerRef: { current: engine as never },
      mapReadyGeneration: 1,
      isMapClickModeActive: () => reverseGeocodeActive,
    });
    return null;
  }
  render(createElement(Harness));
  const click = () => {
    for (const handler of [...clicks]) handler([10, 20]);
  };
  const current = (): CommentTool => tool!;

  act(() => current().activateTool());
  act(() => click());
  assert.equal(current().pendingComment, null);

  reverseGeocodeActive = false;
  act(() => click());
  assert.deepEqual(current().pendingComment?.anchor, { type: "point", lngLat: [10, 20] });
});

it("counts Directions and Reverse Geocode as the map-click modes", async () => {
  const { isMapClickModeActive } = await import("../apps/geolibre-desktop/src/lib/map-click-modes");
  const { DIRECTIONS_PLUGIN_ID, REVERSE_GEOCODE_PLUGIN_ID } = await import("@geolibre/plugins");
  const managerWith = (...active: string[]) => ({ isActive: (id: string) => active.includes(id) });
  assert.equal(isMapClickModeActive(managerWith()), false);
  assert.equal(isMapClickModeActive(managerWith("maplibre-gl-measures")), false);
  assert.equal(isMapClickModeActive(managerWith(DIRECTIONS_PLUGIN_ID)), true);
  assert.equal(isMapClickModeActive(managerWith(REVERSE_GEOCODE_PLUGIN_ID)), true);
});
