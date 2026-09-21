import { expect, test } from "@playwright/test";
import { waitForMap } from "./helpers";

// maplibre-gl-lidar draws point clouds into an overlaid deck.gl canvas. That
// overlay is a MapLibre IControl, so MapLibre used to park its absolutely
// positioned, map-sized wrapper in a corner of the control container, where it
// painted over every control panel and marker it overlapped — a loaded point
// cloud hid the Measure, Colorbar, Legend, HTML and Bookmark panels
// (opengeos/GeoLibre#2530).
//
// maplibre-gl-lidar >= 0.17.1 moves the wrapper into the canvas container,
// right after the base map canvas, and the space-effects stylesheet gives it
// the canvas's z-index so raising the canvas cannot bury the point cloud. Both
// halves have to hold for the fix to work, and neither fails the build if it
// drifts, so assert the resulting stack directly. No point cloud is loaded:
// opening the panel is enough to mount the control and create the overlay, and
// the stacking is a property of the DOM, not of the points.
// Spelled out rather than imported from the package's `DECK_CANVAS_CLASS`:
// Playwright transpiles specs to CJS, and this package's CJS entry pulls in
// `@deck.gl/maplibre`, which publishes no CJS export. A rename upstream fails
// `npm run typecheck` at the import in `maplibre-effects.ts` anyway, and this
// spec's first assertion would fail loudly rather than pass vacuously.
const WRAPPER = ".maplibre-gl-lidar-canvas";

test.describe("LiDAR point-cloud canvas stacking", () => {
  test("parks the deck canvas above the basemap but below markers and controls", async ({
    page,
  }) => {
    await waitForMap(page);

    await page.getByRole("button", { name: "Add Data", exact: true }).click();
    await page.getByRole("menuitem", { name: "LiDAR Layer", exact: true }).click();
    await expect(page.locator(WRAPPER)).toHaveCount(1);

    const stack = await page.evaluate((wrapper) => {
      const root = document.querySelector(".maplibregl-map")!;
      const canvasContainer = root.querySelector(".maplibregl-canvas-container")!;
      const controlContainer = root.querySelector(".maplibregl-control-container")!;
      const canvas = canvasContainer.querySelector(".maplibregl-canvas")!;
      const deck = root.querySelector(wrapper)!;
      const zIndexOf = (element: Element) => getComputedStyle(element).zIndex;
      const children = Array.from(canvasContainer.children);
      return {
        inCanvasContainer: deck.parentElement === canvasContainer,
        afterCanvas: children.indexOf(deck) > children.indexOf(canvas),
        deckZ: zIndexOf(deck),
        canvasZ: zIndexOf(canvas),
        controlsZ: zIndexOf(controlContainer),
      };
    }, WRAPPER);

    // Out of the control container and beside the base map canvas.
    expect(stack.inCanvasContainer).toBe(true);
    // Later in DOM order, so an equal z-index still paints it over the basemap.
    expect(stack.afterCanvas).toBe(true);
    // Equal, whether that is the default `auto` or the space-effects stack's
    // raised value: the DOM order above is what puts the points on top.
    expect(stack.deckZ).toBe(stack.canvasZ);
    // Controls (and markers, which the effects stylesheet pins to the control
    // container's value) sit higher, so panels over the points stay readable.
    const paintOrder = (zIndex: string) => (zIndex === "auto" ? 0 : Number(zIndex));
    expect(paintOrder(stack.controlsZ)).toBeGreaterThan(paintOrder(stack.deckZ));
  });
});
