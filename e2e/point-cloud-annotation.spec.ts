import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

async function loadCopc(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Add Data", exact: true }).click();
  await page.getByRole("menuitem", { name: "LiDAR Layer", exact: true }).click();
  await page
    .getByRole("textbox", { name: "https://example.com/pointcloud.laz", exact: true })
    .fill(COPC_URL);
  await page.getByRole("button", { name: "Load", exact: true }).click();
  await expect(page.getByText("1,065 points", { exact: true })).toBeVisible({ timeout: 60_000 });
  await page.getByRole("button", { name: "Close panel", exact: true }).click();
}

/** Opens the plugin and starts a session; returns the start/finish button. */
async function startSession(page: Page, options: { restored?: boolean } = {}) {
  if (options.restored) {
    // A restored project re-activates the plugin with its panel collapsed to
    // the right rail; the Plugins menu entry would toggle it off instead.
    const rail = page.getByRole("button", { name: "Expand Point Cloud Annotation" });
    await expect(rail).toBeVisible({ timeout: 30_000 });
    await rail.click();
  } else {
    await page.getByRole("button", { name: "Plugins", exact: true }).click();
    await page.getByRole("menuitem", { name: "Point Cloud Annotation", exact: true }).click();
  }
  const start = page.getByTestId("pc-annotation-start");
  await expect(start).toBeEnabled({ timeout: 30_000 });
  await start.click();
  await expect(start).toHaveText("Finish session");
  return start;
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

  test("brushes, locks a class, exports LAZ, and keeps labels across save and reopen", async ({
    page,
  }) => {
    test.setTimeout(180_000);
    await captureSavedFiles(page);
    await page.addInitScript(() => {
      // Force the <input type=file> open path, which Playwright can drive.
      delete (window as unknown as Record<string, unknown>).showOpenFilePicker;
    });
    await waitForMap(page);
    await loadCopc(page);
    const start = await startSession(page);
    const canvas = (await page.locator(".maplibregl-canvas").boundingBox())!;
    const classes = page.getByTestId("pc-annotation-classes");
    const countOf = async (code: number) => {
      const row = classes.locator(`[data-code="${code}"]`);
      if ((await row.count()) === 0) return 0;
      return Number(((await row.textContent()) ?? "").split("·")[1].replace(/\D/g, ""));
    };

    // Brush a wide stroke across the middle of the cloud, then assign Building.
    await page.getByRole("button", { name: "Brush (P)" }).click();
    await page.getByRole("spinbutton", { name: /Brush size/ }).fill("120");
    await page.getByRole("spinbutton", { name: /Brush size/ }).press("Enter");
    await page.mouse.move(canvas.x + canvas.width * 0.2, canvas.y + canvas.height * 0.5);
    await page.mouse.down();
    await page.mouse.move(canvas.x + canvas.width * 0.8, canvas.y + canvas.height * 0.5, {
      steps: 12,
    });
    await page.mouse.up();
    const brushed = Number(
      ((await page.getByTestId("pc-annotation-selected").textContent()) ?? "").replace(/\D/g, ""),
    );
    expect(brushed).toBeGreaterThan(0);
    await page.getByTestId("pc-annotation-target").selectOption("6");
    await page.getByTestId("pc-annotation-apply").click();
    const buildings = await countOf(6);
    expect(buildings).toBe(brushed);

    // Lock Building, then relabel everything else as Water: Building survives.
    await classes.locator('[data-lock="6"]').click();
    await page.getByRole("button", { name: "Box (B)" }).click();
    await page.mouse.move(canvas.x + 5, canvas.y + 5);
    await page.mouse.down();
    await page.mouse.move(canvas.x + canvas.width - 5, canvas.y + canvas.height - 5, { steps: 8 });
    await page.mouse.up();
    await page.getByTestId("pc-annotation-target").selectOption("9");
    await page.getByTestId("pc-annotation-apply").click();
    await expect(page.getByTestId("pc-annotation-status")).toContainText("to Water");
    expect(await countOf(6)).toBe(buildings);
    const water = await countOf(9);
    expect(water).toBeGreaterThan(0);

    // LAZ export: a LASzip-compressed LAS 1.4 file (format bit 0x80 set).
    await page.getByTestId("pc-annotation-export-laz").click();
    await expect(page.getByTestId("pc-annotation-status")).toContainText("Exported");
    const laz = await savedFile(page, "1.2-with-color-annotated.laz");
    expect(laz).not.toBeNull();
    expect(laz!.readUInt8(104)).toBe(7 | 0x80);
    const exportedText = await page.getByTestId("pc-annotation-status").textContent();
    const exported = Number(
      /Exported ([\d,]+) points/.exec(exportedText ?? "")?.[1].replace(/,/g, ""),
    );
    expect(Number(laz!.readBigUInt64LE(247))).toBe(exported);
    await start.click();

    // Save the project: the labels travel in the plugin's project state.
    await page.getByRole("button", { name: "Project" }).click();
    await page.getByRole("menuitem", { name: "Save", exact: true }).click();
    // Other plugins' settings may prompt to strip credentials. Stripping must
    // keep the labels, which are publishable plugin state.
    const strip = page.getByRole("button", { name: "Strip credentials", exact: true });
    if (await strip.isVisible({ timeout: 3_000 }).catch(() => false)) await strip.click();
    const findProject = () =>
      page.evaluate(() =>
        Object.keys(
          (window as unknown as { __savedFiles: Record<string, number[]> }).__savedFiles,
        ).find((name) => /\.geolibre(\.json)?$/.test(name)),
      );
    await expect.poll(findProject).toBeTruthy();
    const projectName = await findProject();
    const projectBytes = (await savedFile(page, projectName!))!;
    const project = JSON.parse(projectBytes.toString("utf8")) as {
      plugins?: { settings?: Record<string, { sources?: { url: string }[] }> };
    };
    const labels = project.plugins?.settings?.["geolibre-point-cloud-annotation"];
    expect(labels?.sources?.map((source) => source.url)).toEqual([COPC_URL]);

    // Reopen it in a fresh page: the cloud re-streams and the labels come back.
    const dir = await mkdtemp(join(tmpdir(), "geolibre-pc-annotation-"));
    const projectPath = join(dir, "labels.geolibre.json");
    await writeFile(projectPath, projectBytes);
    await waitForMap(page);
    const chooserPromise = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "Project" }).click();
    await page.getByRole("menuitem", { name: "Open From" }).click();
    await page.getByRole("menuitem", { name: "File..." }).click();
    await (await chooserPromise).setFiles(projectPath);
    await expect(
      page.locator('[data-testid="layer-row"][data-layer-name="1.2-with-color.copc.laz"]'),
    ).toBeVisible({
      timeout: 60_000,
    });
    await startSession(page, { restored: true });
    await expect.poll(() => countOf(6), { timeout: 30_000 }).toBe(buildings);
    expect(await countOf(9)).toBe(water);

    // The exported LAZ opens in GeoLibre again (LAS 1.4, LASzip-compressed).
    const lazPath = join(dir, "annotated.laz");
    await writeFile(lazPath, laz!);
    await page.getByRole("button", { name: "Add Data", exact: true }).click();
    await page.getByRole("menuitem", { name: "LiDAR Layer", exact: true }).click();
    await page.locator('input[type="file"][accept*=".laz"]').first().setInputFiles(lazPath);
    await expect(
      page.getByText(`${exported.toLocaleString("en-US")} points`, { exact: true }).first(),
    ).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/Failed to load/)).toHaveCount(0);
  });

  test("fits a 3D box to a selection, shows its side views, exports and restores it", async ({
    page,
  }) => {
    test.setTimeout(180_000);
    await captureSavedFiles(page);
    await page.addInitScript(() => {
      delete (window as unknown as Record<string, unknown>).showOpenFilePicker;
    });
    await waitForMap(page);
    await loadCopc(page);
    await startSession(page);
    const canvas = (await page.locator(".maplibregl-canvas").boundingBox())!;

    // Select part of the cloud and fit a box to it.
    await page.mouse.move(canvas.x + canvas.width * 0.3, canvas.y + canvas.height * 0.3);
    await page.mouse.down();
    await page.mouse.move(canvas.x + canvas.width * 0.7, canvas.y + canvas.height * 0.7, {
      steps: 8,
    });
    await page.mouse.up();
    await page.getByTestId("pc-annotation-target").selectOption("6");
    await page.getByTestId("pc-annotation-box-from-selection").click();
    const boxes = page.getByTestId("pc-annotation-cuboids");
    await expect(boxes.locator('[data-box="1"]')).toBeVisible();
    await expect(page.getByTestId("pc-annotation-status")).toContainText("Added box 1");

    // The three orthographic views open, each with its own deck.gl canvas.
    const views = page.getByTestId("pc-annotation-box-views");
    await expect(views).toBeVisible();
    await expect(views.locator("canvas")).toHaveCount(3);

    // Keyboard nudge: "+" twice raises the box top by 20 cm.
    const heightOf = async () =>
      Number(/× ([\d.]+) m/.exec((await boxes.locator('[data-box="1"]').textContent()) ?? "")?.[1]);
    const before = await heightOf();
    await page.keyboard.press("+");
    await page.keyboard.press("+");
    await expect.poll(heightOf).toBeCloseTo(before + 0.2, 1);

    // Export the box as GeoJSON: one closed footprint with class and extent.
    await page.getByTestId("pc-annotation-export-cuboids-geojson").click();
    await expect.poll(() => savedFile(page, "1.2-with-color-boxes.geojson")).not.toBeNull();
    const geojson = JSON.parse(
      (await savedFile(page, "1.2-with-color-boxes.geojson"))!.toString("utf8"),
    ) as GeoJSON.FeatureCollection<GeoJSON.Polygon>;
    expect(geojson.features).toHaveLength(1);
    expect(geojson.features[0].properties?.classification).toBe(6);
    expect(geojson.features[0].geometry.coordinates[0]).toHaveLength(5);
    const saved = geojson.features[0].properties!;

    // Save and reopen: the box comes back with the same size.
    await page.getByTestId("pc-annotation-start").click();
    await page.getByRole("button", { name: "Project" }).click();
    await page.getByRole("menuitem", { name: "Save", exact: true }).click();
    const strip = page.getByRole("button", { name: "Strip credentials", exact: true });
    if (await strip.isVisible({ timeout: 3_000 }).catch(() => false)) await strip.click();
    const findProject = () =>
      page.evaluate(() =>
        Object.keys(
          (window as unknown as { __savedFiles: Record<string, number[]> }).__savedFiles,
        ).find((name) => /\.geolibre(\.json)?$/.test(name)),
      );
    await expect.poll(findProject).toBeTruthy();
    const projectBytes = (await savedFile(page, (await findProject())!))!;
    const dir = await mkdtemp(join(tmpdir(), "geolibre-pc-boxes-"));
    const projectPath = join(dir, "boxes.geolibre.json");
    await writeFile(projectPath, projectBytes);
    await waitForMap(page);
    const chooserPromise = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "Project" }).click();
    await page.getByRole("menuitem", { name: "Open From" }).click();
    await page.getByRole("menuitem", { name: "File..." }).click();
    await (await chooserPromise).setFiles(projectPath);
    await startSession(page, { restored: true });
    await expect(page.getByTestId("pc-annotation-cuboids").locator('[data-box="1"]')).toContainText(
      `${Number(saved.length_m).toFixed(1)} × ${Number(saved.width_m).toFixed(1)}`,
    );
  });

  test("pre-labels with a Whitebox classifier as one undoable edit", async ({ page }) => {
    test.setTimeout(180_000);
    await waitForMap(page);
    await loadCopc(page);
    await startSession(page);
    const classes = page.getByTestId("pc-annotation-classes");
    const before = await classes.innerText();

    // Relabel every class (not just 0/1) so the tool's result is visible.
    await page.getByTestId("pc-annotation-prelabel-tool").selectOption("ground-vegetation");
    await page.getByTestId("pc-annotation-prelabel-only-unclassified").uncheck();
    await page.getByTestId("pc-annotation-prelabel-run").click();
    const status = page.getByTestId("pc-annotation-status");
    await expect(status).toContainText(/Pre-labelled|Pre-label failed/, { timeout: 120_000 });
    await expect(status).toContainText("Pre-labelled");
    const changed = Number(
      /Pre-labelled ([\d,]+) points/
        .exec((await status.textContent()) ?? "")?.[1]
        .replace(/,/g, ""),
    );
    if (changed > 0) {
      expect(await classes.innerText()).not.toBe(before);
      // One undo restores the classes from before the run.
      await page.getByTestId("pc-annotation-undo").click();
      await expect.poll(() => classes.innerText()).toBe(before);
    }
  });

  test("selects with a click-by-click polygon and assigns a class by digit key", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await waitForMap(page);
    await loadCopc(page);
    await startSession(page);
    const canvas = (await page.locator(".maplibregl-canvas").boundingBox())!;
    const at = (fx: number, fy: number) =>
      [canvas.x + canvas.width * fx, canvas.y + canvas.height * fy] as const;

    await page.keyboard.press("g");
    await expect(page.getByRole("button", { name: "Polygon (G)" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    for (const [fx, fy] of [
      [0.1, 0.1],
      [0.9, 0.1],
      [0.9, 0.9],
      [0.1, 0.9],
    ]) {
      await page.mouse.click(...at(fx, fy));
    }
    // The camera is locked while the ring is open: vertices are screen
    // positions, so a wheel zoom between clicks must not move the map.
    const zoomText = async () =>
      /Zoom: ([\d.]+)/.exec((await page.locator("footer").textContent()) ?? "")?.[1];
    // Let the post-load fly-to finish first.
    await expect
      .poll(async () => Number(await zoomText()), { timeout: 30_000 })
      .toBeGreaterThan(10);
    await page.waitForTimeout(1_000);
    const zoomBefore = await zoomText();
    await page.mouse.move(...at(0.5, 0.5));
    await page.mouse.wheel(0, -400);
    await page.waitForTimeout(500);
    expect(await zoomText()).toBe(zoomBefore);
    // Nothing is selected until the ring is closed.
    await expect(page.getByTestId("pc-annotation-selected")).toHaveText("0 points selected");
    await page.keyboard.press("Enter");
    const selected = Number(
      ((await page.getByTestId("pc-annotation-selected").textContent()) ?? "").replace(/\D/g, ""),
    );
    expect(selected).toBeGreaterThan(0);
    // Once the ring closes the camera is unlocked again: the same wheel zooms.
    await page.mouse.wheel(0, -400);
    await expect.poll(zoomText).not.toBe(zoomBefore);

    // Digit 9 picks Water as the class to assign, then Enter applies it.
    const classes = page.getByTestId("pc-annotation-classes");
    // The count is the last span of a class row's pick button.
    const countOf = async (code: number) => {
      const row = classes.locator(`[data-code="${code}"] button`).first();
      if ((await row.count()) === 0) return 0;
      return Number(((await row.locator("span").last().textContent()) ?? "").replace(/\D/g, ""));
    };
    const waterBefore = await countOf(9);
    await page.keyboard.press("9");
    await expect(page.getByTestId("pc-annotation-target")).toHaveValue("9");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("pc-annotation-status")).toContainText("to Water");
    const assigned = Number(
      /Assigned ([\d,]+) points/
        .exec((await page.getByTestId("pc-annotation-status").textContent()) ?? "")?.[1]
        .replace(/,/g, ""),
    );
    await expect.poll(() => countOf(9)).toBe(waterBefore + assigned);
    expect(assigned).toBeLessThanOrEqual(selected);
  });
  test("adds a custom class, assigns it, exports its code and saves it", async ({ page }) => {
    test.setTimeout(120_000);
    await captureSavedFiles(page);
    await waitForMap(page);
    await loadCopc(page);
    const start = await startSession(page);

    await page.getByTestId("pc-annotation-custom-classes").locator("summary").click();
    await page.getByTestId("pc-annotation-custom-code").fill("64");
    await page.getByTestId("pc-annotation-custom-name").fill("Car");
    await page.getByTestId("pc-annotation-custom-color").fill("#e11d48");
    await page.getByTestId("pc-annotation-custom-add").click();
    await expect(page.getByTestId("pc-annotation-status")).toContainText("Added class 64");
    await expect(page.getByTestId("pc-annotation-target")).toHaveValue("64");

    const canvas = (await page.locator(".maplibregl-canvas").boundingBox())!;
    await page.getByRole("button", { name: "Box (B)" }).click();
    await page.mouse.move(canvas.x + 5, canvas.y + 5);
    await page.mouse.down();
    await page.mouse.move(canvas.x + canvas.width - 5, canvas.y + canvas.height - 5, { steps: 8 });
    await page.mouse.up();
    const selected = Number(
      ((await page.getByTestId("pc-annotation-selected").textContent()) ?? "").replace(/\D/g, ""),
    );
    expect(selected).toBeGreaterThan(0);
    await page.getByTestId("pc-annotation-apply").click();
    await expect(page.getByTestId("pc-annotation-status")).toContainText("to Car");
    const row = page.getByTestId("pc-annotation-classes").locator('[data-code="64"]');
    await expect(row).toContainText("Car");
    await expect(row).toContainText(selected.toLocaleString("en-US"));

    // The LAS classification byte carries the custom code.
    await page.getByTestId("pc-annotation-export-las").click();
    await expect(page.getByTestId("pc-annotation-status")).toContainText("Exported");
    const las = await savedFile(page, "1.2-with-color-annotated.las");
    expect(readLas(las!).classes.get(64)).toBe(selected);
    await start.click();

    // The class definition travels with the project.
    await page.getByRole("button", { name: "Project" }).click();
    await page.getByRole("menuitem", { name: "Save", exact: true }).click();
    const strip = page.getByRole("button", { name: "Strip credentials", exact: true });
    if (await strip.isVisible({ timeout: 3_000 }).catch(() => false)) await strip.click();
    const findProject = () =>
      page.evaluate(() =>
        Object.keys(
          (window as unknown as { __savedFiles: Record<string, number[]> }).__savedFiles,
        ).find((name) => /\.geolibre(\.json)?$/.test(name)),
      );
    await expect.poll(findProject).toBeTruthy();
    const project = JSON.parse((await savedFile(page, (await findProject())!))!.toString("utf8"));
    expect(project.plugins.settings["geolibre-point-cloud-annotation"].customClasses).toEqual([
      { code: 64, name: "Car", color: "#e11d48" },
    ]);
  });
});
