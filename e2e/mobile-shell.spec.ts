import { expect, test } from "./test";
import { collectPageProblems, waitForMap } from "./helpers";

test.use({
  viewport: { width: 390, height: 844 },
  hasTouch: true,
  isMobile: true,
});

test("renders the touch mobile shell with bottom navigation and draggable sheets on phones", async ({
  page,
}) => {
  const { problems } = collectPageProblems(page);
  await waitForMap(page);

  await expect(page.locator("html")).toHaveAttribute("data-touch-ui", "true");
  await expect(page.getByTestId("desktop-shell")).toHaveAttribute("data-mobile-shell", "true");
  await expect(page.getByTestId("mobile-top-bar")).toBeVisible();
  await expect(page.getByTestId("mobile-bottom-nav")).toBeVisible();
  await expect(page.getByTestId("mobile-status-pill")).toBeVisible();

  // Status strip sits cleanly beneath the map canvas rather than covering top-left map controls.
  const mapRect = await page.locator("main").boundingBox();
  const statusRect = await page.getByTestId("mobile-status-pill").boundingBox();
  expect(mapRect).not.toBeNull();
  expect(statusRect).not.toBeNull();
  expect(statusRect!.y).toBeGreaterThanOrEqual(mapRect!.y + mapRect!.height - 1);

  // No horizontal overflow at phone width.
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth,
  );
  expect(overflow).toBe(false);

  // Primary mobile chrome controls meet the 44x44px touch target floor.
  for (const selector of [
    '[data-testid="mobile-top-bar"] button',
    '[data-testid="mobile-bottom-nav"] button',
  ]) {
    const boxes = await page.locator(selector).evaluateAll((els) =>
      els.map((el) => {
        const rect = el.getBoundingClientRect();
        return { width: rect.width, height: rect.height };
      }),
    );
    expect(boxes.length).toBeGreaterThan(0);
    for (const box of boxes) {
      expect(box.width).toBeGreaterThanOrEqual(44);
      expect(box.height).toBeGreaterThanOrEqual(44);
    }
  }

  // Tapping Layers opens the BottomSheet at half detent.
  await page.getByTestId("mobile-nav-layers").tap();
  const layersSheet = page.getByTestId("mobile-sheet-layers");
  await expect(layersSheet).toBeVisible();
  await expect(layersSheet).toHaveAttribute("data-detent", "half");

  // Tapping the drag handle cycles the sheet detent (half -> full -> peek).
  const handle = layersSheet.locator("[data-sheet-handle]");
  await handle.tap();
  await expect(layersSheet).toHaveAttribute("data-detent", "full");
  await handle.tap();
  await expect(layersSheet).toHaveAttribute("data-detent", "peek");

  // Switching to Add replaces the Layers sheet cleanly.
  await page.getByTestId("mobile-nav-add").tap();
  await expect(layersSheet).toBeHidden();
  await expect(page.getByTestId("mobile-sheet-add")).toBeVisible();

  // Switching to Field replaces Add cleanly.
  await page.getByTestId("mobile-nav-field").tap();
  await expect(page.getByTestId("mobile-sheet-add")).toBeHidden();
  await expect(page.getByTestId("mobile-sheet-field")).toBeVisible();

  // Switching to More opens the searchable TouchMenuSheet drill-down navigator.
  await page.getByTestId("mobile-nav-more").tap();
  const moreSheet = page.getByTestId("mobile-sheet-more");
  await expect(moreSheet).toBeVisible();
  await moreSheet.getByRole("button", { name: "View" }).tap();
  await expect(moreSheet.getByTestId("touch-menu-back")).toBeVisible();
  await moreSheet.getByTestId("touch-menu-back").tap();
  await moreSheet.getByTestId("touch-menu-search").fill("MapLibre");
  await expect(moreSheet.getByRole("button", { name: /MapLibre/i })).toBeVisible();
  await moreSheet.getByTestId("touch-menu-search").fill("");
  await moreSheet.getByRole("button", { name: "Switch to desktop layout" }).tap();

  await expect(page.getByTestId("mobile-bottom-nav")).toBeHidden();
  await expect(page.locator("html")).not.toHaveAttribute("data-touch-ui", "true");
  await expect(page.getByRole("button", { name: "Project", exact: true })).toBeVisible();

  // Desktop status bar offers a 1-tap button to return to the touch layout.
  const backToTouch = page.getByTestId("status-bar-switch-to-touch");
  await expect(backToTouch).toBeVisible();
  await backToTouch.tap();
  await expect(page.locator("html")).toHaveAttribute("data-touch-ui", "true");
  await expect(page.getByTestId("mobile-bottom-nav")).toBeVisible();

  // Field sheet launches map-center crosshair capture and adds a Field captures layer.
  await page.getByTestId("mobile-nav-field").tap();
  await page
    .getByTestId("mobile-sheet-field")
    .getByRole("button", { name: "Map-center crosshair capture" })
    .tap();
  await expect(page.getByTestId("field-crosshair-reticle")).toBeVisible();
  await page.getByTestId("field-crosshair-drop").tap();
  await page.getByTestId("field-crosshair-done").tap();
  await expect(page.getByTestId("field-crosshair-reticle")).toBeHidden();
  await page.getByTestId("mobile-nav-layers").tap();
  await expect(page.getByTestId("mobile-sheet-layers")).toContainText("Field captures");

  expect(problems, "console errors or failed same-origin requests").toEqual([]);
});

test.describe("tablet touch ergonomics", () => {
  test.use({
    viewport: { width: 1024, height: 768 },
    hasTouch: true,
    isMobile: false,
  });

  test("enables touch targets on tablets while keeping split-screen desktop chrome", async ({
    page,
  }) => {
    const { problems } = collectPageProblems(page);
    await waitForMap(page);
    await expect(page.locator("html")).toHaveAttribute("data-touch-ui", "true");
    await expect(page.getByTestId("desktop-shell")).not.toHaveAttribute(
      "data-mobile-shell",
      "true",
    );
    await expect(page.getByTestId("mobile-bottom-nav")).toBeHidden();
    await expect(page.getByRole("button", { name: "Project", exact: true })).toBeVisible();
    expect(problems, "console errors or failed same-origin requests").toEqual([]);
  });
});
