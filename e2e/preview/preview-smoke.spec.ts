import { expect, test } from "@playwright/test";
import { collectPageProblems, waitForMapLoaded } from "../helpers";

test("the deployed app renders the map with a clean console", async ({ page }, testInfo) => {
  const { problems } = collectPageProblems(page);
  try {
    // Relative to baseURL, so a subpath deployment (the previews' /demo/) is
    // loaded from its own path, where its base-relative requests resolve.
    await page.goto("./");
    await expect(page.getByTestId("map-canvas")).toBeVisible();
    await expect(page.locator(".maplibregl-canvas")).toBeVisible({ timeout: 30_000 });
    await waitForMapLoaded(page);
    // Requests that start after the first idle (deployment-policy follow-ups,
    // lazy panels) get a moment to fail too.
    await page.waitForTimeout(3_000);
    await testInfo.attach("map", { body: await page.screenshot(), contentType: "image/png" });
  } finally {
    // Keep the diagnostics when an earlier step fails first: a 404'd app never
    // mounts its map, and the HTTP status is what explains why.
    if (problems.length > 0) {
      await testInfo.attach("problems", { body: problems.join("\n"), contentType: "text/plain" });
      console.log(`Page problems:\n  ${problems.join("\n  ")}`);
    }
  }

  expect(problems, "console errors or failed same-origin requests").toEqual([]);
});
