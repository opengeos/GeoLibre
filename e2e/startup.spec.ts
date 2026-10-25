import { expect, test } from "./test";

for (const colorScheme of ["light", "dark"] as const) {
  test(`offers recovery when startup scripts fail in ${colorScheme} mode`, async ({ page }) => {
    await page.emulateMedia({ colorScheme });
    // Block scripts rather than the HTML: the recovery UI must survive even
    // when the entry module (and therefore React and i18next) never executes.
    await page.route("**/*", (route) =>
      route.request().resourceType() === "script" ? route.abort() : route.continue(),
    );
    const url = `/?theme=${colorScheme}&lng=en`;
    await page.goto(url);
    await expect(page.getByRole("heading", { name: "Loading GeoLibre" })).toBeVisible();
    await expect(page.getByText(/hard refresh/)).toBeVisible();

    // Once scripts are available again, the ordinary link must perform a
    // fresh navigation, preserve the deep link, and let React replace the UI.
    await page.unroute("**/*");
    await page.getByRole("link", { name: "Refresh page" }).click();
    await expect(page.locator(".maplibregl-canvas")).toBeVisible({ timeout: 30_000 });
    await expect(page).toHaveURL(new RegExp(`theme=${colorScheme}&lng=en`));
    await expect(page.locator("#startup-placeholder")).toHaveCount(0);
  });
}

test.describe("without JavaScript", () => {
  test.use({ javaScriptEnabled: false });

  test("keeps refresh guidance readable", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Loading GeoLibre" })).toBeVisible();
    // Playwright's generic text matching skips noscript; target its paragraph.
    const scriptDisabledMessage = page.locator("#startup-placeholder noscript p");
    await expect(scriptDisabledMessage).toHaveText("JavaScript must be enabled to use GeoLibre.");
    await expect(scriptDisabledMessage).toBeVisible();
    await expect(page.getByText(/hard refresh/)).toBeVisible();
    await expect(page.getByRole("link", { name: "Refresh page" })).toBeVisible();
  });
});
