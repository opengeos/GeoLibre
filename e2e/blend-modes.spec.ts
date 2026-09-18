import { expect, test, type Page } from "@playwright/test";
import { dropGeoJson, layerRow, readFixture, waitForMap } from "./helpers";

const POLYGON = readFixture("blend-polygon.geojson");

/**
 * Per-layer blend modes are the one GeoLibre feature with no assertable
 * signal short of the rendered pixels: the mode never reaches a paint
 * property, it is applied inside MapLibre's render loop by the wrappers in
 * `packages/map/src/layer-blend-modes.ts`. A unit test can only check the GL
 * factor table, so this drives the real canvas.
 *
 * It also pins the invariant that bounded the mode list. `darken` (a MIN
 * equation) and `subtract` (a reverse subtract) were both dropped because
 * MapLibre composites a blended layer as one viewport-filling quad and its
 * blend state covers alpha too, so they erased the map outside the layer and
 * left the canvas translucent inside it. Every shipped mode has to leave the
 * canvas opaque and leave the map alone where the layer does not cover.
 */

/** Reads back one pixel of the live WebGL canvas as `[r, g, b, a]`. */
async function samplePixel(page: Page, fx: number, fy: number): Promise<number[]> {
  return page.evaluate(
    ([x, y]) => {
      const canvas = document.querySelector(".maplibregl-canvas") as HTMLCanvasElement;
      // The app keeps `preserveDrawingBuffer` on for the Print Layout composer,
      // which is also what makes the drawing buffer readable here.
      const scratch = document.createElement("canvas");
      scratch.width = canvas.width;
      scratch.height = canvas.height;
      const ctx = scratch.getContext("2d")!;
      ctx.drawImage(canvas, 0, 0);
      const rect = canvas.getBoundingClientRect();
      const dpr = canvas.width / rect.width;
      const data = ctx.getImageData(
        Math.floor(rect.width * x * dpr),
        Math.floor(rect.height * y * dpr),
        1,
        1,
      ).data;
      return [data[0], data[1], data[2], data[3]];
    },
    [fx, fy],
  );
}

const luminance = ([r, g, b]: number[]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/**
 * The layer's Blend menu, opening the Style panel first if it is not showing.
 *
 * Re-checked before every use rather than held as a locator, because the Style
 * panel shares the right sidebar with the plugin panels: one of those (the
 * NASA OPERA panel, which auto-opens once its plugin finishes loading) can
 * take the sidebar over part-way through a test and evict Style. Clicking the
 * layer card's palette button again reclaims it.
 *
 * The menu is located page-wide rather than scoped to the panel: the Style
 * panel's `<aside>` is nested inside the sidebar's own `<aside>`, so its
 * implicit role is `generic`, not `complementary`. The per-layer aria-label is
 * unique, and only present while the panel is open.
 */
async function blendMenu(page: Page, layerName: string) {
  const select = page.getByLabel(`Blend mode for ${layerName}`);
  if (!(await select.isVisible().catch(() => false))) {
    await layerRow(page, layerName).getByRole("button", { name: "Open Style panel" }).click();
    await expect(select).toBeVisible();
  }
  return select;
}

/** Sets a blend mode, reopening the Style panel if something displaced it. */
async function setBlendMode(page: Page, layerName: string, mode: string) {
  await (await blendMenu(page, layerName)).selectOption(mode);
}

/**
 * The centre pixel once the map has stopped changing.
 *
 * A blend mode never reaches a paint property, so there is no style event to
 * await: the only signal that the new mode has reached the GPU is the pixel
 * itself settling. Polling until two consecutive reads agree is what keeps a
 * sample from being taken mid-transition (or from the previous mode's frame),
 * without a fixed timeout that is both slower and less reliable on CI.
 */
async function settledPixel(page: Page): Promise<number[]> {
  let previous = await samplePixel(page, 0.5, 0.5);
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await page.waitForTimeout(250);
    const current = await samplePixel(page, 0.5, 0.5);
    if (current.every((channel, index) => channel === previous[index])) return current;
    previous = current;
  }
  return previous;
}

test("blends a vector layer against the map beneath it", async ({ page }) => {
  await waitForMap(page);
  await dropGeoJson(page, "blendtest", POLYGON);
  await expect(layerRow(page, "blendtest")).toBeVisible();

  // Let the basemap tiles settle so the backdrop being blended into is stable.
  const normal = await settledPixel(page);
  expect(normal[3]).toBe(255);

  await setBlendMode(page, "blendtest", "multiply");
  await expect
    .poll(async () => luminance(await settledPixel(page)), { timeout: 15_000 })
    .toBeLessThan(luminance(normal));

  await setBlendMode(page, "blendtest", "screen");
  await expect
    .poll(async () => luminance(await settledPixel(page)), { timeout: 15_000 })
    .toBeGreaterThan(luminance(normal));

  // Clearing the mode has to restore the layer exactly: `fill-layer-opacity` is
  // set to elect MapLibre's composite path and must be written back to 1.
  await setBlendMode(page, "blendtest", "normal");
  await expect.poll(async () => settledPixel(page), { timeout: 15_000 }).toEqual(normal);
});

test("keeps the canvas opaque and the uncovered map intact in every mode", async ({ page }) => {
  await waitForMap(page);
  await dropGeoJson(page, "blendtest", POLYGON);
  await expect(layerRow(page, "blendtest")).toBeVisible();

  const modes = await (
    await blendMenu(page, "blendtest")
  )
    .locator("option")
    .evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value));
  expect(modes).toContain("multiply");
  // The two modes whose GL equations broke this invariant must stay unlisted.
  expect(modes).not.toContain("darken");
  expect(modes).not.toContain("subtract");

  const baseline = await settledPixel(page);
  expect(baseline[3]).toBe(255);

  const rendered = new Map<string, number[]>();
  for (const mode of modes) {
    await setBlendMode(page, "blendtest", mode);
    const centre = await settledPixel(page);
    // Alpha alone would prove nothing: the canvas is already opaque before a
    // mode is applied, so this assertion would pass on a frame the mode had not
    // reached yet. The colour assertions below are what pin that it took.
    expect(centre[3], `${mode} left the canvas translucent`).toBe(255);
    rendered.set(mode, centre);
  }

  expect(rendered.get("normal"), "normal did not restore the unblended pixel").toEqual(baseline);

  // Every mode has to render a pixel no other mode produced. Comparing each
  // mode against `baseline` alone would not catch a mode being dropped: a
  // stale frame left over from the previous mode also differs from the
  // unblended pixel, so the weaker check passes while nothing was applied.
  const byColour = new Map<string, string>();
  for (const [mode, pixel] of rendered) {
    const colour = pixel.slice(0, 3).join(",");
    const clash = byColour.get(colour);
    expect(clash, `${mode} rendered rgb(${colour}), the same pixel as ${clash}`).toBeUndefined();
    byColour.set(colour, mode);
  }

  // ...and in the direction the mode is named for, against the same backdrop.
  expect(luminance(rendered.get("multiply")!), "multiply did not darken").toBeLessThan(
    luminance(baseline),
  );
  for (const lightening of ["screen", "lighten", "add"]) {
    expect(luminance(rendered.get(lightening)!), `${lightening} did not lighten`).toBeGreaterThan(
      luminance(baseline),
    );
  }
});
