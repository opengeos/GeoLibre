import { expect, test, type Page } from "@playwright/test";

/** Waits for MapLibre to mount its WebGL canvas — the app's "map ready" signal. */
async function waitForMap(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.getByTestId("map-canvas")).toBeVisible();
  await expect(page.locator(".maplibregl-canvas")).toBeVisible({
    timeout: 30_000,
  });
}

/**
 * Regression guard for issue #669: the Set View dialog prefills its inputs from
 * the live camera, so the zoom is a fractional value that violates the input's
 * `step="0.1"` constraint. Native HTML5 validation must not block submitting it.
 * The dialog disables native validation (`noValidate`) and validates in its own
 * `handleSubmit`, so a fractional zoom should fly and close the dialog — if a
 * future change drops `noValidate`, the browser would reject the value here and
 * this test would fail with the dialog still open.
 */
test("submits a fractional zoom the native validator would reject", async ({ page }) => {
  await waitForMap(page);

  await page.getByRole("button", { name: "View", exact: true }).click();
  await page.getByRole("menuitem", { name: /Set View/ }).click();

  const dialog = page.getByRole("dialog", { name: "Set View" });
  await expect(dialog).toBeVisible();

  // A zoom that is not a multiple of step="0.1" — exactly the kind of value the
  // live camera produces and the native validator rejects.
  const zoom = dialog.locator("#set-view-zoom");
  await zoom.fill("6.963");
  await dialog.locator("#set-view-longitude").fill("-97.5");
  await dialog.locator("#set-view-latitude").fill("35.4");

  // Pitch has step="1", so a fractional value trips the same stepMismatch as
  // zoom — noValidate covers the whole form, so guard both axes.
  const pitch = dialog.locator("#set-view-pitch");
  await pitch.fill("45.3");

  // Confirm both fields genuinely trip native validation, so the assertion
  // below proves the dialog submits despite it (not that the values are benign).
  expect(await zoom.evaluate((z: HTMLInputElement) => z.validity.stepMismatch)).toBe(true);
  expect(await pitch.evaluate((p: HTMLInputElement) => p.validity.stepMismatch)).toBe(true);

  await dialog.getByRole("button", { name: "Go", exact: true }).click();

  // The fix lets submission through, so the dialog closes. Before the fix the
  // native tooltip blocked submit and the dialog stayed open.
  await expect(dialog).toBeHidden();
});

/**
 * The other half of the contract: disabling native validation must not lose
 * validation. With `noValidate`, `handleSubmit` is the only thing standing
 * between bad input and `flyTo`, so out-of-range input must still be rejected
 * with the dialog's own message and the dialog kept open.
 */
test("rejects out-of-range input via the dialog's own validation", async ({ page }) => {
  await waitForMap(page);

  await page.getByRole("button", { name: "View", exact: true }).click();
  await page.getByRole("menuitem", { name: /Set View/ }).click();

  const dialog = page.getByRole("dialog", { name: "Set View" });
  await expect(dialog).toBeVisible();

  // Longitude 999 is outside -180..180 — the browser would have caught this
  // natively; with noValidate, handleSubmit must catch it instead.
  await dialog.locator("#set-view-longitude").fill("999");
  await dialog.locator("#set-view-latitude").fill("35.4");
  await dialog.locator("#set-view-zoom").fill("5");

  await dialog.getByRole("button", { name: "Go", exact: true }).click();

  // The dialog stays open and surfaces its own error rather than flying.
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText(/Enter a valid longitude/)).toBeVisible();
});

/**
 * Issue #669 part 2: the center can be entered in degrees/minutes/seconds.
 * Switching DMS -> DD converts the entry in place (deterministic, no map
 * animation), and the converted value submits like any other DD coordinate.
 */
test("accepts a center entered in degrees/minutes/seconds", async ({ page }) => {
  await waitForMap(page);

  await page.getByRole("button", { name: "View", exact: true }).click();
  await page.getByRole("menuitem", { name: /Set View/ }).click();

  const dialog = page.getByRole("dialog", { name: "Set View" });
  await expect(dialog).toBeVisible();

  await dialog.getByRole("radio", { name: "DMS", exact: true }).click();

  // 98°28'8.3"W, 42°8'45"N — the issue's own worked example (≈ -98.468972,
  // 42.145833).
  await dialog.locator("#set-view-lon-deg").fill("98");
  await dialog.locator("#set-view-lon-min").fill("28");
  await dialog.locator("#set-view-lon-sec").fill("8.3");
  await dialog.locator("#set-view-lon-dir").selectOption("W");
  await dialog.locator("#set-view-lat-deg").fill("42");
  await dialog.locator("#set-view-lat-min").fill("8");
  await dialog.locator("#set-view-lat-sec").fill("45");
  await dialog.locator("#set-view-lat-dir").selectOption("N");
  await dialog.locator("#set-view-zoom").fill("5");

  // Toggling to DD converts the DMS entry synchronously, so we can assert the
  // decimal without waiting on the map. Exact match so "DD" does not also pick
  // up the "DDM" radio.
  await dialog.getByRole("radio", { name: "DD", exact: true }).click();
  expect(Number(await dialog.locator("#set-view-longitude").inputValue())).toBeCloseTo(
    -98.468972,
    4,
  );
  expect(Number(await dialog.locator("#set-view-latitude").inputValue())).toBeCloseTo(42.145833, 4);

  // The converted coordinate submits like any other DD value.
  await dialog.getByRole("button", { name: "Go", exact: true }).click();
  await expect(dialog).toBeHidden();
});

/**
 * Issue #828: the center can also be entered in degrees and decimal minutes
 * (DDM). Like the DMS toggle, switching DDM -> DD converts the entry in place,
 * and the converted value submits like any other DD coordinate.
 */
test("accepts a center entered in degrees and decimal minutes", async ({ page }) => {
  await waitForMap(page);

  await page.getByRole("button", { name: "View", exact: true }).click();
  await page.getByRole("menuitem", { name: /Set View/ }).click();

  const dialog = page.getByRole("dialog", { name: "Set View" });
  await expect(dialog).toBeVisible();

  await dialog.getByRole("radio", { name: "DDM", exact: true }).click();

  // 98°28.14'W, 42°8.75'N ≈ -98.469, 42.145833.
  await dialog.locator("#set-view-ddm-lon-deg").fill("98");
  await dialog.locator("#set-view-ddm-lon-min").fill("28.14");
  await dialog.locator("#set-view-ddm-lon-dir").selectOption("W");
  await dialog.locator("#set-view-ddm-lat-deg").fill("42");
  await dialog.locator("#set-view-ddm-lat-min").fill("8.75");
  await dialog.locator("#set-view-ddm-lat-dir").selectOption("N");
  await dialog.locator("#set-view-zoom").fill("5");

  // Toggling to DD converts the DDM entry synchronously.
  await dialog.getByRole("radio", { name: "DD", exact: true }).click();
  expect(Number(await dialog.locator("#set-view-longitude").inputValue())).toBeCloseTo(-98.469, 3);
  expect(Number(await dialog.locator("#set-view-latitude").inputValue())).toBeCloseTo(42.145833, 4);

  await dialog.getByRole("button", { name: "Go", exact: true }).click();
  await expect(dialog).toBeHidden();
});

/**
 * Issue #828: the smart-paste box is hidden by default and revealed from the
 * paste icon next to the heading (hover or click), and it fills the precise
 * fields only on an explicit "Process input" (it does not mutate them on every
 * keystroke). After processing a valid string the longitude/latitude fields
 * reflect it and the camera submits.
 */
test("fills the fields from a pasted string only after Process input", async ({ page }) => {
  await waitForMap(page);

  await page.getByRole("button", { name: "View", exact: true }).click();
  await page.getByRole("menuitem", { name: /Set View/ }).click();

  const dialog = page.getByRole("dialog", { name: "Set View" });
  await expect(dialog).toBeVisible();

  const longitude = dialog.locator("#set-view-longitude");
  const before = await longitude.inputValue();

  // The paste field is hidden until the paste icon next to the heading is used.
  const pasteInput = dialog.locator("#set-view-paste");
  await expect(pasteInput).toBeHidden();
  await dialog.getByRole("button", { name: "Paste coordinates" }).click();
  await expect(pasteInput).toBeVisible();

  // Typing alone must not change the manual fields — processing is on demand.
  await pasteInput.fill("35.4, -97.5");
  expect(await longitude.inputValue()).toBe(before);

  // Running Process input parses the string and fills the fields (the parser
  // reads a bare pair as lat, lon, so this resolves to lon -97.5, lat 35.4).
  await dialog.getByRole("button", { name: "Process input" }).click();
  expect(Number(await longitude.inputValue())).toBeCloseTo(-97.5, 4);
  expect(Number(await dialog.locator("#set-view-latitude").inputValue())).toBeCloseTo(35.4, 4);

  await dialog.locator("#set-view-zoom").fill("5");
  await dialog.getByRole("button", { name: "Go", exact: true }).click();
  await expect(dialog).toBeHidden();
});
