import { expect, test, type Page } from "./test";
import { bindMapLibreMap, waitForMap } from "./helpers";

/** Count writes to the static effects, excluding the intentionally animated comet canvas. */
async function staticDraws(page: Page): Promise<number> {
  return page.evaluate(async () => {
    const staticCanvases = new Set(
      document.querySelectorAll<HTMLCanvasElement>(
        '.geolibre-effects-canvas:not([data-effects-layer="comets"])',
      ),
    );
    const prototype = CanvasRenderingContext2D.prototype;
    const clear = prototype.clearRect;
    const fill = prototype.fill;
    const fillRect = prototype.fillRect;
    const drawImage = prototype.drawImage;
    const stroke = prototype.stroke;
    const putImageData = prototype.putImageData;
    let writes = 0;
    prototype.clearRect = function (...args) {
      if (staticCanvases.has(this.canvas)) writes++;
      return clear.apply(this, args);
    };
    prototype.fill = function (...args: Parameters<typeof fill>) {
      if (staticCanvases.has(this.canvas)) writes++;
      return fill.apply(this, args);
    };
    prototype.fillRect = function (...args) {
      if (staticCanvases.has(this.canvas)) writes++;
      return fillRect.apply(this, args);
    };
    prototype.drawImage = function (...args: Parameters<typeof drawImage>) {
      if (staticCanvases.has(this.canvas)) writes++;
      return drawImage.apply(this, args);
    };
    prototype.stroke = function (...args: Parameters<typeof stroke>) {
      if (staticCanvases.has(this.canvas)) writes++;
      return stroke.apply(this, args);
    };
    prototype.putImageData = function (...args: Parameters<typeof putImageData>) {
      if (staticCanvases.has(this.canvas)) writes++;
      return putImageData.apply(this, args);
    };
    try {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      return writes;
    } finally {
      prototype.clearRect = clear;
      prototype.fill = fill;
      prototype.fillRect = fillRect;
      prototype.drawImage = drawImage;
      prototype.stroke = stroke;
      prototype.putImageData = putImageData;
    }
  });
}

for (const theme of ["light", "dark"] as const) {
  test(`globe effects stop repainting static canvases when idle (${theme})`, async ({ page }) => {
    await waitForMap(page);
    const toggle = page.getByRole("button", {
      name: `Switch to ${theme === "dark" ? "Dark" : "Light"} Mode`,
    });
    if (await toggle.isVisible()) await toggle.click();
    const enableGlobe = page.getByRole("button", { name: "Enable globe", exact: true });
    if (await enableGlobe.isVisible()) await enableGlobe.click();
    await expect(page.locator(".geolibre-effects-canvas")).toHaveCount(4);
    await bindMapLibreMap(page);
    await page.waitForFunction(() => !window.__geolibreTestMap?.isMoving());
    // Allow the effects' camera invalidation to be drawn before measuring idle work.
    await page.waitForTimeout(200);
    expect(await staticDraws(page)).toBe(0);
    const before = await page
      .locator('[data-effects-layer="stars"], [data-effects-layer="halo"]')
      .evaluateAll((canvases) =>
        canvases.map((canvas) => (canvas as HTMLCanvasElement).toDataURL()),
      );

    // Camera changes must still repaint the stars and halo, then become idle again.
    await page.evaluate(() => window.__geolibreTestMap?.jumpTo({ center: [130, -25], zoom: 3.7 }));
    await page.waitForTimeout(200);
    const after = await page
      .locator('[data-effects-layer="stars"], [data-effects-layer="halo"]')
      .evaluateAll((canvases) =>
        canvases.map((canvas) => (canvas as HTMLCanvasElement).toDataURL()),
      );
    expect(after[0] !== before[0], "stars follow the camera").toBe(true);
    expect(after[1] !== before[1], "halo follows the globe's projected edge").toBe(true);
    expect(await staticDraws(page)).toBe(0);

    await page.getByRole("button", { name: "Disable globe", exact: true }).click();
    await page.waitForTimeout(200);
    expect(
      await page.locator(".geolibre-effects-canvas").evaluateAll((canvases) =>
        canvases.every((canvas) => {
          const element = canvas as HTMLCanvasElement;
          const pixels = element
            .getContext("2d")!
            .getImageData(0, 0, element.width, element.height).data;
          return pixels.every((value) => value === 0);
        }),
      ),
      "Mercator clears every effects canvas",
    ).toBe(true);
    await page.getByRole("button", { name: "Enable globe", exact: true }).click();
    await page.waitForTimeout(500);
    expect(await staticDraws(page)).toBe(0);
  });
}
