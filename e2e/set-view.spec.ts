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
test("submits a fractional zoom the native validator would reject", async ({
  page,
}) => {
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

  // Confirm the value genuinely trips native validation, so the assertion below
  // proves the dialog submits despite it (rather than the value being benign).
  expect(await zoom.evaluate((z: HTMLInputElement) => z.validity.stepMismatch)).toBe(
    true,
  );

  await dialog.getByRole("button", { name: "Go" }).click();

  // The fix lets submission through, so the dialog closes. Before the fix the
  // native tooltip blocked submit and the dialog stayed open.
  await expect(dialog).toBeHidden();
});
