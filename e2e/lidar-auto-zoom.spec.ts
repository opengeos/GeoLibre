import { expect, test } from "@playwright/test";
import { waitForMap } from "./helpers";

// A 1,065-point COPC from PDAL's test data, near -117.24, 46.28.
const COPC =
  "https://raw.githubusercontent.com/PDAL/PDAL/master/test/data/copc/1.2-with-color.copc.laz";

/**
 * Loading a point cloud flies the camera to its extent (maplibre-gl-lidar's
 * `autoZoom`, on by default). It stopped doing so on the *first* load of a
 * session: the plugin flips the projection preference to mercator from the
 * `load` event it fires right after starting that fly-to, and
 * `MapController.applyMapPreferences` re-applied the current camera to clamp it
 * to the new constraints — a jump, which cancels an animation in flight and
 * pinned the camera at the world view it started from. Only the first load was
 * affected, because the second one finds the preference already mercator and
 * changes nothing, which is what made it look like a LiDAR bug rather than a
 * camera one.
 */
test("flies to the point cloud on the first load of a session", async ({ page }) => {
  await waitForMap(page);

  const status = page.locator("footer");
  await expect(status).toContainText("Zoom: 2.00");

  await page.getByRole("button", { name: "Add Data", exact: true }).click();
  await page.getByRole("menuitem", { name: "LiDAR Layer", exact: true }).click();
  await page
    .getByRole("textbox", { name: "https://example.com/pointcloud.laz", exact: true })
    .fill(COPC);
  await page.getByRole("button", { name: "Load", exact: true }).click();
  await expect(page.getByText("1,065 points", { exact: true })).toBeVisible({ timeout: 60_000 });

  // The cloud covers a few hundred metres, so fitting it lands deep in the
  // zoom range — nowhere near the world view the app opens at.
  await expect
    .poll(async () => Number(/Zoom: ([\d.]+)/.exec((await status.textContent()) ?? "")?.[1] ?? 0), {
      timeout: 30_000,
    })
    .toBeGreaterThan(10);
  await expect(status).toContainText("-117.2");
});
