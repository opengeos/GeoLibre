import { expect, test, type Page } from "@playwright/test";
import { waitForMap } from "./helpers";

// A 1,065-point COPC from PDAL's test data: small enough to stream in seconds.
const COPC =
  "https://raw.githubusercontent.com/PDAL/PDAL/master/test/data/copc/1.2-with-color.copc.laz";

/**
 * maplibre-gl-lidar draws point clouds into its own overlaid deck.gl canvas,
 * above MapLibre's, so the Measure tool's line — drawn by MapLibre — was hidden
 * wherever the cloud had points (opengeos/GeoLibre#2533). GeoLibre redraws the
 * measured geometry into that same deck overlay with the depth test off, which
 * is the only place it can win.
 *
 * Nothing in the wiring is visible to the compiler: the control's source id and
 * the geojson source's data are both private fields, and deck's layer order
 * decides whether the line or the points end up on top. So assert the thing
 * that actually matters — blue line pixels inside the *point cloud's* canvas.
 */
async function measureLinePixels(page: Page): Promise<{ blue: number; drawn: number }> {
  return page.evaluate(() => {
    const canvas = document.querySelector(
      ".maplibre-gl-lidar-canvas canvas",
    ) as HTMLCanvasElement | null;
    if (!canvas) return { blue: 0, drawn: 0 };
    // Copying the live WebGL canvas into a 2D one is how e2e/blend-modes.spec.ts
    // reads the map canvas back; deck's canvas is readable the same way.
    const scratch = document.createElement("canvas");
    scratch.width = canvas.width;
    scratch.height = canvas.height;
    const ctx = scratch.getContext("2d")!;
    ctx.drawImage(canvas, 0, 0);
    const { data } = ctx.getImageData(0, 0, scratch.width, scratch.height);
    let blue = 0;
    let drawn = 0;
    for (let at = 0; at < data.length; at += 4) {
      const [r, g, b, a] = [data[at], data[at + 1], data[at + 2], data[at + 3]];
      if (a > 0) drawn++;
      // The measure line's #3b82f6, allowing for antialiasing at the edges.
      if (a > 200 && b > 200 && r > 30 && r < 100 && g > 100 && g < 170) blue++;
    }
    return { blue, drawn };
  });
}

test.describe("measured geometry over a LiDAR point cloud", () => {
  test("redraws the measure line inside the point cloud's own canvas", async ({ page }) => {
    await waitForMap(page);

    await page.getByRole("button", { name: "Add Data", exact: true }).click();
    await page.getByRole("menuitem", { name: "LiDAR Layer", exact: true }).click();
    await page
      .getByRole("textbox", { name: "https://example.com/pointcloud.laz", exact: true })
      .fill(COPC);
    await page.getByRole("button", { name: "Load", exact: true }).click();
    // The panel lists the loaded cloud once the points are in the overlay.
    await expect(page.getByText("1,065 points", { exact: true })).toBeVisible({ timeout: 60_000 });
    await expect
      .poll(async () => (await measureLinePixels(page)).drawn, { timeout: 30_000 })
      .toBeGreaterThan(0);
    await page.getByRole("button", { name: "Close panel", exact: true }).click();

    // Nothing blue is in that canvas before a measurement exists.
    expect((await measureLinePixels(page)).blue).toBe(0);

    await page.getByRole("button", { name: "Controls", exact: true }).click();
    await page.getByRole("menuitem", { name: "Measure", exact: true }).click();
    await page.getByRole("button", { name: "Distance", exact: true }).click();

    // Draw across the middle of the map, right through the point cloud, which the
    // load auto-zoomed to.
    const box = (await page.locator(".maplibregl-canvas").boundingBox())!;
    const start = { x: box.x + box.width * 0.55, y: box.y + box.height * 0.35 };
    const end = { x: box.x + box.width * 0.85, y: box.y + box.height * 0.7 };
    await page.mouse.click(start.x, start.y);
    await page.mouse.click(end.x, end.y);
    await page.mouse.dblclick(end.x, end.y);
    await expect(page.getByText("Total Distance", { exact: true })).toBeVisible();

    await expect.poll(async () => (await measureLinePixels(page)).blue).toBeGreaterThan(50);
  });
});
