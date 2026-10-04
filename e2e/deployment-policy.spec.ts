import { expect, test, type Page } from "./test";
import { waitForMap } from "./helpers";

/** Serves `body` as this test's deployment.json. */
async function serveDeployment(page: Page, body: unknown): Promise<void> {
  await page.route("**/deployment.json", (route) => route.fulfill({ json: body }));
}

const toolbarButton = (page: Page, name: string) => page.getByRole("button", { name, exact: true });

test("capabilities restrict the toolbar before first paint", async ({ page }) => {
  // Record any frame in which the gated menu ever existed: a full-grant first
  // paint that later retracts would pass a plain end-state assertion.
  await page.addInitScript(() => {
    const w = window as unknown as { __sawProcessing?: boolean };
    const isProcessing = (node: Node): boolean => {
      if (!(node instanceof Element)) return false;
      const buttons = node.tagName === "BUTTON" ? [node] : [...node.querySelectorAll("button")];
      return buttons.some((button) => button.textContent?.trim() === "Processing");
    };
    new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) if (isProcessing(node)) w.__sawProcessing = true;
      }
    }).observe(document, { childList: true, subtree: true });
  });
  await serveDeployment(page, { version: 1, capabilities: ["data:add"] });
  await waitForMap(page);

  await expect(toolbarButton(page, "Add Data")).toBeVisible();
  await expect(toolbarButton(page, "Processing")).toHaveCount(0);
  await expect(toolbarButton(page, "Plugins")).toHaveCount(0);
  expect(
    await page.evaluate(() => (window as { __sawProcessing?: boolean }).__sawProcessing),
  ).not.toBe(true);
});

test("an empty capabilities list grants nothing", async ({ page }) => {
  await serveDeployment(page, { version: 1, capabilities: [] });
  await waitForMap(page);

  for (const name of ["Add Data", "Processing", "Plugins"]) {
    await expect(toolbarButton(page, name)).toHaveCount(0);
  }
});

test("a missing deployment.json leaves the app unchanged and quiet", async ({ page }) => {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" && message.text().includes("deployment.json")) {
      errors.push(message.text());
    }
  });
  await page.route("**/deployment.json", (route) => route.fulfill({ status: 404, body: "" }));
  await waitForMap(page);

  for (const name of ["Add Data", "Processing", "Plugins"]) {
    await expect(toolbarButton(page, name)).toBeVisible();
  }
  expect(errors).toEqual([]);
});

test("branding.appName titles the tab", async ({ page }) => {
  await serveDeployment(page, {
    version: 1,
    branding: { appName: "Acme Maps" },
  });
  await waitForMap(page);
  await expect(page).toHaveTitle("Acme Maps");
});

test("a hung deployment.json does not block rendering", async ({ page }) => {
  await page.route("**/deployment.json", async () => {
    await new Promise(() => {});
  });
  await waitForMap(page);
  await expect(toolbarButton(page, "Processing")).toBeVisible();
});
