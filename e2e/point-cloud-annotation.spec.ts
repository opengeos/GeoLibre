import { expect, test, type Page } from "@playwright/test";
import { COPC_URL, waitForMap } from "./helpers";

/**
 * Point Cloud Annotation (opengeos/GeoLibre#2749): select LiDAR points with a
 * box drawn on the map, assign an ASPRS class, undo/redo it, and export the
 * edited cloud as LAS 1.4. Selection projects every point through the LiDAR
 * overlay's own deck.gl viewport and the edits write into the control's
 * private buffers, none of which a unit test can reach, so drive the real app.
 */

/**
 * Replaces the File System Access save picker with one that keeps the written
 * bytes on `window.__savedFiles`, so the export can be asserted byte for byte
 * (a real picker would hang the test; see saveBinaryFileBrowser).
 */
async function captureSavedFiles(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const saved: Record<string, number[]> = {};
    (window as unknown as { __savedFiles: Record<string, number[]> }).__savedFiles = saved;
    (window as unknown as { showSaveFilePicker: unknown }).showSaveFilePicker = async (options: {
      suggestedName: string;
    }) => ({
      name: options.suggestedName,
      createWritable: async () => {
        const parts: Blob[] = [];
        return {
          write: async (data: Blob | string) => {
            parts.push(typeof data === "string" ? new Blob([data]) : data);
          },
          close: async () => {
            const bytes = new Uint8Array(await new Blob(parts).arrayBuffer());
            saved[options.suggestedName] = Array.from(bytes);
          },
        };
      },
    });
  });
}

async function savedFile(page: Page, name: string): Promise<Buffer | null> {
  const bytes = await page.evaluate(
    (fileName) =>
      (window as unknown as { __savedFiles: Record<string, number[]> }).__savedFiles[fileName] ??
      null,
    name,
  );
  return bytes ? Buffer.from(bytes) : null;
}

/** Reads the point count and per-class histogram out of a LAS 1.4 file. */
function readLas(buffer: Buffer): { count: number; format: number; classes: Map<number, number> } {
  const pointOffset = buffer.readUInt32LE(96);
  const format = buffer.readUInt8(104);
  const recordLength = buffer.readUInt16LE(105);
  const count = Number(buffer.readBigUInt64LE(247));
  const classes = new Map<number, number>();
  for (let i = 0; i < count; i++) {
    const code = buffer.readUInt8(pointOffset + i * recordLength + 16);
    classes.set(code, (classes.get(code) ?? 0) + 1);
  }
  return { count, format, classes };
}

test.describe("point cloud annotation", () => {
  test("labels points drawn with a box and exports them as LAS", async ({ page }) => {
    test.setTimeout(120_000);
    await captureSavedFiles(page);
    await waitForMap(page);

    await page.getByRole("button", { name: "Add Data", exact: true }).click();
    await page.getByRole("menuitem", { name: "LiDAR Layer", exact: true }).click();
    await page
      .getByRole("textbox", { name: "https://example.com/pointcloud.laz", exact: true })
      .fill(COPC_URL);
    await page.getByRole("button", { name: "Load", exact: true }).click();
    await expect(page.getByText("1,065 points", { exact: true })).toBeVisible({ timeout: 60_000 });
    await page.getByRole("button", { name: "Close panel", exact: true }).click();

    await page.getByRole("button", { name: "Plugins", exact: true }).click();
    await page.getByRole("menuitem", { name: "Point Cloud Annotation", exact: true }).click();
    const start = page.getByTestId("pc-annotation-start");
    await expect(start).toBeEnabled({ timeout: 15_000 });
    await start.click();
    await expect(start).toHaveText("Finish session");
    await expect(page.getByTestId("pc-annotation-selected")).toHaveText("0 points selected");
    // A COPC streams by level of detail, so the session holds the points resident
    // at this zoom, not necessarily all 1,065.
    const hint = await page.getByTestId("pc-annotation-hint").textContent();
    const loaded = Number(/: ([\d,]+) points loaded/.exec(hint ?? "")?.[1].replace(/,/g, ""));
    expect(loaded).toBeGreaterThan(0);

    // Box-select the middle of the view, where the auto-zoomed cloud sits.
    const canvas = page.locator(".maplibregl-canvas");
    const box = (await canvas.boundingBox())!;
    await page.mouse.move(box.x + box.width * 0.05, box.y + box.height * 0.05);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.6, { steps: 8 });
    await page.mouse.move(box.x + box.width * 0.95, box.y + box.height * 0.95, { steps: 8 });
    await page.mouse.up();

    const selectedText = await page.getByTestId("pc-annotation-selected").textContent();
    const selected = Number((selectedText ?? "").replace(/\D/g, ""));
    expect(selected).toBeGreaterThan(0);
    expect(selected).toBeLessThanOrEqual(loaded);

    // Selection highlight lands in the LiDAR overlay's canvas.
    await expect
      .poll(() =>
        page.evaluate(() => {
          const canvasEl = document.querySelector(
            ".maplibre-gl-lidar-canvas canvas",
          ) as HTMLCanvasElement | null;
          if (!canvasEl) return 0;
          const scratch = document.createElement("canvas");
          scratch.width = canvasEl.width;
          scratch.height = canvasEl.height;
          const ctx = scratch.getContext("2d")!;
          ctx.drawImage(canvasEl, 0, 0);
          const { data } = ctx.getImageData(0, 0, scratch.width, scratch.height);
          let yellow = 0;
          for (let at = 0; at < data.length; at += 4) {
            // Yellow, allowing for the overlay canvas's partial alpha on readback;
            // no ASPRS class colour has both red and green this high and no blue.
            const [r, g, b] = [data[at], data[at + 1], data[at + 2]];
            if (data[at + 3] > 150 && r > 150 && g > 150 && b < 60 && Math.abs(r - g) < 30)
              yellow++;
          }
          return yellow;
        }),
      )
      .toBeGreaterThan(0);

    await page.getByTestId("pc-annotation-target").selectOption("6");
    await page.getByTestId("pc-annotation-apply").click();
    await expect(page.getByTestId("pc-annotation-status")).toContainText("to Building");
    const classes = page.getByTestId("pc-annotation-classes");
    await expect(classes.locator('[data-code="6"]')).toContainText(
      selected.toLocaleString("en-US"),
    );
    await expect(page.getByTestId("pc-annotation-selected")).toHaveText("0 points selected");

    // Undo removes the Building points; redo restores them.
    await page.getByTestId("pc-annotation-undo").click();
    await expect(classes.locator('[data-code="6"]')).toHaveCount(0);
    await page.getByTestId("pc-annotation-redo").click();
    await expect(classes.locator('[data-code="6"]')).toContainText(
      selected.toLocaleString("en-US"),
    );

    await page.getByTestId("pc-annotation-export-las").click();
    await expect(page.getByTestId("pc-annotation-status")).toContainText("Exported");
    const exportedText = await page.getByTestId("pc-annotation-status").textContent();
    const exported = Number(
      /Exported ([\d,]+) points/.exec(exportedText ?? "")?.[1].replace(/,/g, ""),
    );
    // Nodes already in flight when streaming paused may still have arrived.
    expect(exported).toBeGreaterThanOrEqual(loaded);
    const las = await savedFile(page, "1.2-with-color-annotated.las");
    expect(las).not.toBeNull();
    const parsed = readLas(las!);
    expect(parsed.count).toBe(exported);
    expect(parsed.format).toBe(7);
    expect(parsed.classes.get(6)).toBe(selected);

    // Finishing restores map panning and removes the drawing overlay.
    await start.click();
    await expect(start).toHaveText("Start annotating");
    await expect(page.locator(".geolibre-pc-annotation-overlay")).toHaveCount(0);
  });
});
