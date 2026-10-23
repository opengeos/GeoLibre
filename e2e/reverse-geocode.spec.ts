import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "./test";
import { waitForMap } from "./helpers";

test("Reverse Geocode results remain readable in both themes", async ({ page }) => {
  let reverseRequests = 0;
  await page.route(
    (url) => url.hostname === "nominatim.openstreetmap.org" && url.pathname === "/reverse",
    (route) => {
      const displayName =
        reverseRequests++ === 0
          ? "First result, Testville, Exampleland"
          : "Second result, Testville, Exampleland";
      return route.fulfill({
        headers: { "access-control-allow-origin": "*" },
        json: { display_name: displayName },
      });
    },
  );

  await waitForMap(page, "/?theme=dark");
  await page.getByRole("button", { name: "Controls", exact: true }).click();
  await page.getByRole("menuitem", { name: "Reverse Geocode", exact: true }).click();
  await page.getByRole("button", { name: "Continue", exact: true }).click();

  const canvas = page.locator(".maplibregl-canvas");
  const size = await canvas.evaluate((element) => ({
    width: element.clientWidth,
    height: element.clientHeight,
  }));
  const popup = page.locator(".geolibre-reverse-geocode-popup");
  const content = popup.locator(".maplibregl-popup-content");
  const firstAddress = "First result, Testville, Exampleland";
  const secondAddress = "Second result, Testville, Exampleland";

  await canvas.click({ position: { x: size.width * 0.72, y: size.height * 0.35 } });
  await expect.poll(() => reverseRequests).toBe(1);
  await expect(content).toContainText(firstAddress);
  await expectPopupContrast(page);

  await page.getByRole("button", { name: "Switch to Light Mode", exact: true }).click();
  await expect(page.locator("html")).not.toHaveClass(/(^|\s)dark(\s|$)/);
  await expectPopupContrast(page);

  // A second lookup replaces the first popup without losing contrast in light mode.
  await canvas.click({ position: { x: size.width * 0.24, y: size.height * 0.75 } });
  await expect.poll(() => reverseRequests).toBe(2);
  await expect(popup).toHaveCount(1);
  await expect(content).toContainText(secondAddress);
  await expectPopupContrast(page);
});

async function expectPopupContrast(page: Page): Promise<void> {
  const { violations } = await new AxeBuilder({ page })
    .include(".geolibre-reverse-geocode-popup")
    .withRules(["color-contrast"])
    .analyze();
  expect(violations, "Reverse-geocode text and controls must have readable contrast").toEqual([]);
}
