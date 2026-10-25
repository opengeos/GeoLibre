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
    const methods = [
      "clearRect",
      "fill",
      "fillRect",
      "drawImage",
      "stroke",
      "putImageData",
    ] as const;
    const originals = methods.map((name) => [name, prototype[name]] as const);
    let writes = 0;
    for (const [name, original] of originals) {
      Reflect.set(prototype, name, function (this: CanvasRenderingContext2D, ...args: unknown[]) {
        if (staticCanvases.has(this.canvas)) writes++;
        return Reflect.apply(original, this, args);
      });
    }
    try {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      return writes;
    } finally {
      for (const [name, original] of originals) Reflect.set(prototype, name, original);
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
    // A slow frame may land in the first window. Continuous idle repainting
    // never produces a zero-write window, so polling still catches the bug.
    await expect.poll(() => staticDraws(page), { timeout: 15_000 }).toBe(0);
    const before = await page
      .locator('[data-effects-layer="stars"], [data-effects-layer="halo"]')
      .evaluateAll((canvases) =>
        canvases.map((canvas) => (canvas as HTMLCanvasElement).toDataURL()),
      );

    // Camera changes must still repaint the stars and halo, then become idle again.
    await page.evaluate(() => window.__geolibreTestMap?.jumpTo({ center: [130, -25], zoom: 3.7 }));
    await expect.poll(() => staticDraws(page), { timeout: 15_000 }).toBe(0);
    const after = await page
      .locator('[data-effects-layer="stars"], [data-effects-layer="halo"]')
      .evaluateAll((canvases) =>
        canvases.map((canvas) => (canvas as HTMLCanvasElement).toDataURL()),
      );
    expect(after[0] !== before[0], "stars follow the camera").toBe(true);
    expect(after[1] !== before[1], "halo follows the globe's projected edge").toBe(true);

    // Direct API changes do not emit a camera move. The toolbar also updates
    // preferences, whose camera clamp would otherwise hide this regression.
    await page.evaluate(() => {
      const map = window.__geolibreTestMap;
      if (!map || !("setProjection" in map) || typeof map.setProjection !== "function") {
        throw new Error("MapLibre projection API is unavailable");
      }
      map.setProjection({ type: "mercator" });
    });
    await expect
      .poll(
        () =>
          page.locator(".geolibre-effects-canvas").evaluateAll((canvases) =>
            canvases.every((canvas) => {
              const element = canvas as HTMLCanvasElement;
              const pixels = element
                .getContext("2d")!
                .getImageData(0, 0, element.width, element.height).data;
              return pixels.every((value) => value === 0);
            }),
          ),
        { message: "Mercator clears every effects canvas" },
      )
      .toBe(true);
    await page.evaluate(() => {
      const map = window.__geolibreTestMap;
      if (!map || !("setProjection" in map) || typeof map.setProjection !== "function") {
        throw new Error("MapLibre projection API is unavailable");
      }
      map.setProjection({ type: "globe" });
    });
    await expect
      .poll(
        () =>
          page
            .locator(
              '[data-effects-layer="space"], [data-effects-layer="stars"], [data-effects-layer="halo"]',
            )
            .evaluateAll(
              (canvases) =>
                canvases.length === 3 &&
                canvases.every((canvas) => {
                  const element = canvas as HTMLCanvasElement;
                  return element
                    .getContext("2d")!
                    .getImageData(0, 0, element.width, element.height)
                    .data.some((value) => value !== 0);
                }),
            ),
        { message: "globe effects return after a direct projection change" },
      )
      .toBe(true);
    await expect.poll(() => staticDraws(page), { timeout: 15_000 }).toBe(0);
  });
}
