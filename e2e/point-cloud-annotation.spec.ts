import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type Page } from "./test";
import { COPC_URL, dropGeoJson, layerRow, waitForMap } from "./helpers";

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

    // Review status and a free-form attribute.
    await boxes.locator('[data-status="1"]').selectOption("reviewed");
    await boxes.locator('[data-attributes="1"] summary').click();
    await boxes.locator('[data-attribute-key="1"]').fill("make");
    await boxes.locator('[data-attribute-value="1"]').fill("Ford");
    await boxes.locator('[data-attribute-add="1"]').click();
    await expect(boxes.locator('[data-attributes="1"] summary')).toHaveText("Attributes (1)");

    // Export the box as GeoJSON: one closed footprint with class and extent.
    await page.getByTestId("pc-annotation-export-cuboids-geojson").click();
    await expect.poll(() => savedFile(page, "1.2-with-color-boxes.geojson")).not.toBeNull();
    const geojson = JSON.parse(
      (await savedFile(page, "1.2-with-color-boxes.geojson"))!.toString("utf8"),
    ) as GeoJSON.FeatureCollection<GeoJSON.Polygon>;
    expect(geojson.features).toHaveLength(1);
    expect(geojson.features[0].properties?.classification).toBe(6);
    expect(geojson.features[0].geometry.coordinates[0]).toHaveLength(5);
    expect(geojson.features[0].properties?.status).toBe("reviewed");
    expect(geojson.features[0].properties?.make).toBe("Ford");
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
    const restored = page.getByTestId("pc-annotation-cuboids");
    await expect(restored.locator('[data-status="1"]')).toHaveValue("reviewed");
    await expect(restored.locator('[data-attributes="1"] summary')).toHaveText("Attributes (1)");
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
  test("groups a selection as an object, exports its ids and saves them", async ({ page }) => {
    test.setTimeout(120_000);
    await captureSavedFiles(page);
    await waitForMap(page);
    await loadCopc(page);
    const start = await startSession(page);
    const canvas = (await page.locator(".maplibregl-canvas").boundingBox())!;
    const selected = async () =>
      Number(
        ((await page.getByTestId("pc-annotation-selected").textContent()) ?? "").replace(/\D/g, ""),
      );

    // Box the left half and make it an object with the N key.
    await page.getByRole("button", { name: "Box (B)" }).click();
    await page.mouse.move(canvas.x + 5, canvas.y + 5);
    await page.mouse.down();
    await page.mouse.move(canvas.x + canvas.width / 2, canvas.y + canvas.height - 5, { steps: 8 });
    await page.mouse.up();
    const count = await selected();
    expect(count).toBeGreaterThan(0);
    await page.getByTestId("pc-annotation-target").selectOption("6");
    await page.keyboard.press("n");
    await expect(page.getByTestId("pc-annotation-status")).toContainText("Created instance #1");
    const objects = page.getByTestId("pc-annotation-objects");
    await expect(objects.locator('[data-instance="1"]')).toContainText(
      `${count.toLocaleString("en-US")} pts`,
    );

    // Select brings its points back; dissolve and undo round-trip.
    await objects.locator('[data-object-select="1"]').click();
    expect(await selected()).toBe(count);
    await page.getByTestId("pc-annotation-clear").click();
    await objects.locator('[data-object-dissolve="1"]').click();
    await expect(objects.locator("[data-instance]")).toHaveCount(0);
    await page.getByTestId("pc-annotation-undo").click();
    await expect(objects.locator('[data-instance="1"]')).toBeVisible();

    // LAS export: a 4-byte instance extra dimension after each format 7 record.
    await page.getByTestId("pc-annotation-export-las").click();
    await expect(page.getByTestId("pc-annotation-status")).toContainText("Exported");
    const las = (await savedFile(page, "1.2-with-color-annotated.las"))!;
    const recordLength = las.readUInt16LE(105);
    expect(recordLength).toBe(40);
    const pointOffset = las.readUInt32LE(96);
    const points = Number(las.readBigUInt64LE(247));
    let inObject = 0;
    for (let i = 0; i < points; i++) {
      if (las.readUInt32LE(pointOffset + i * recordLength + 36) === 1) inObject++;
    }
    expect(inObject).toBe(count);
    await start.click();

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
    const state = project.plugins.settings["geolibre-point-cloud-annotation"];
    expect(state.instances.map((entry: { url: string }) => entry.url)).toEqual([COPC_URL]);
  });
  test("draws 3D vectors snapped to points, exports GeoJSON and saves them", async ({ page }) => {
    test.setTimeout(120_000);
    await captureSavedFiles(page);
    await waitForMap(page);
    await loadCopc(page);
    const start = await startSession(page);
    const vectors = page.getByTestId("pc-annotation-vectors");
    // Click where points are actually drawn: opaque pixels of the LiDAR
    // overlay canvas, in page coordinates, at least 30 px apart.
    await expect(page.locator(".maplibre-gl-lidar-canvas canvas")).toHaveCount(1);
    const scan = () =>
      page.evaluate(() => {
        const source = document.querySelector(
          ".maplibre-gl-lidar-canvas canvas",
        ) as HTMLCanvasElement;
        const rect = source.getBoundingClientRect();
        const scratch = document.createElement("canvas");
        scratch.width = source.width;
        scratch.height = source.height;
        const ctx = scratch.getContext("2d")!;
        ctx.drawImage(source, 0, 0);
        const { data } = ctx.getImageData(0, 0, scratch.width, scratch.height);
        const found: [number, number][] = [];
        for (let y = 0; y < scratch.height; y += 3) {
          for (let x = 0; x < scratch.width; x += 3) {
            if (data[(y * scratch.width + x) * 4 + 3] > 200) {
              const px = rect.left + (x * rect.width) / scratch.width;
              const py = rect.top + (y * rect.height) / scratch.height;
              if (found.every(([fx, fy]) => Math.hypot(fx - px, fy - py) > 30))
                found.push([px, py]);
            }
          }
        }
        return found;
      });
    // The camera may still be settling after the session starts: wait until
    // two scans a moment apart agree.
    let points: [number, number][] = [];
    await expect
      .poll(async () => {
        const first = await scan();
        await page.waitForTimeout(300);
        points = await scan();
        return points.length >= 7 && JSON.stringify(first) === JSON.stringify(points);
      })
      .toBe(true);
    expect(points.length).toBeGreaterThanOrEqual(7);

    // Keypoint (K): one click.
    await page.keyboard.press("k");
    await page.mouse.click(...points[0]);
    await expect(vectors.locator('[data-vector="1"]')).toContainText("Keypoint");

    // Polyline (V): three clicks, Enter finishes.
    await page.keyboard.press("v");
    for (const point of points.slice(1, 4)) await page.mouse.click(...point);
    await page.keyboard.press("Enter");
    await expect(vectors.locator('[data-vector="2"]')).toContainText("Polyline");

    // Polygon: three clicks and a double-click on the last one.
    await page.locator('[data-vector-kind="polygon"]').click();
    await page.mouse.click(...points[4]);
    await page.mouse.click(...points[5]);
    await page.mouse.dblclick(...points[6]);
    await expect(vectors.locator('[data-vector="3"]')).toContainText("3D polygon");

    await page.getByTestId("pc-annotation-export-vectors-geojson").click();
    await expect.poll(() => savedFile(page, "1.2-with-color-vectors.geojson")).not.toBeNull();
    const geojson = JSON.parse(
      (await savedFile(page, "1.2-with-color-vectors.geojson"))!.toString("utf8"),
    ) as GeoJSON.FeatureCollection;
    expect(geojson.features.map((feature) => feature.geometry.type)).toEqual([
      "Point",
      "LineString",
      "Polygon",
    ]);
    // Every vertex carries the elevation of the point it snapped to.
    const line = geojson.features[1].geometry as GeoJSON.LineString;
    expect(line.coordinates).toHaveLength(3);
    for (const coordinate of line.coordinates) expect(Number.isFinite(coordinate[2])).toBe(true);
    const ring = (geojson.features[2].geometry as GeoJSON.Polygon).coordinates[0];
    expect(ring.length).toBeGreaterThanOrEqual(4);

    // A double-click also closes a selection polygon (pointer events carry no
    // click count, so this goes through the dblclick event).
    await page.keyboard.press("g");
    const map = (await page.locator(".maplibregl-canvas").boundingBox())!;
    await page.mouse.click(map.x + 5, map.y + 5);
    await page.mouse.click(map.x + map.width - 5, map.y + 5);
    await page.mouse.click(map.x + map.width - 5, map.y + map.height - 5);
    await page.mouse.dblclick(map.x + 5, map.y + map.height - 5);
    await expect(page.getByTestId("pc-annotation-selected")).not.toHaveText("0 points selected");
    await start.click();

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
    const saved = project.plugins.settings["geolibre-point-cloud-annotation"].vectors;
    expect(saved[0].url).toBe(COPC_URL);
    expect(saved[0].items.map((item: { kind: string }) => item.kind)).toEqual([
      "keypoint",
      "polyline",
      "polygon",
    ]);
  });
  test("lifts polygon layer footprints onto points, one instance per polygon", async ({ page }) => {
    test.setTimeout(120_000);
    await waitForMap(page);
    await loadCopc(page);
    // Split the fitted view (which holds the whole cloud) into west and east
    // halves, as a stand-in for SAM masks or building footprints.
    await page.waitForTimeout(1_500);
    const bbox = /BBox: ([-\d.]+), ([-\d.]+), ([-\d.]+), ([-\d.]+)/
      .exec((await page.locator("footer").textContent()) ?? "")!
      .slice(1)
      .map(Number);
    const [west, south, east, north] = bbox;
    const mid = (west + east) / 2;
    const ring = (x0: number, x1: number) => [
      [x0, south],
      [x1, south],
      [x1, north],
      [x0, north],
      [x0, south],
    ];
    await dropGeoJson(
      page,
      "halves",
      JSON.stringify({
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            properties: { side: "west" },
            geometry: { type: "Polygon", coordinates: [ring(west, mid)] },
          },
          {
            type: "Feature",
            properties: { side: "east" },
            geometry: { type: "Polygon", coordinates: [ring(mid, east)] },
          },
        ],
      }),
    );
    await expect(layerRow(page, "halves")).toBeVisible({ timeout: 15_000 });
    await startSession(page);
    const hint = await page.getByTestId("pc-annotation-hint").textContent();
    const loaded = Number(/: ([\d,]+) points loaded/.exec(hint ?? "")?.[1].replace(/,/g, ""));

    const layerSelect = page.getByTestId("pc-annotation-lift-layer");
    await layerSelect.focus();
    await expect(layerSelect.locator("option")).toHaveText(["halves"]);
    await page.getByTestId("pc-annotation-lift-select").click();
    await expect(page.getByTestId("pc-annotation-status")).toContainText(
      "inside 2 polygons of halves",
    );
    const selected = Number(
      ((await page.getByTestId("pc-annotation-selected").textContent()) ?? "").replace(/\D/g, ""),
    );
    expect(selected).toBe(loaded);

    await page.getByTestId("pc-annotation-target").selectOption("6");
    await page.getByTestId("pc-annotation-lift-instances").click();
    await expect(page.getByTestId("pc-annotation-status")).toContainText("Created 2 instances");
    const rows = page.getByTestId("pc-annotation-objects").locator("[data-instance]");
    await expect(rows).toHaveCount(2);
    const counts = await rows.evaluateAll((nodes) =>
      nodes.map((node) =>
        Number(/([\d,]+) pts/.exec(node.textContent ?? "")?.[1].replace(/,/g, "")),
      ),
    );
    expect(counts[0] + counts[1]).toBe(loaded);
    expect(counts.every((count) => count > 0)).toBe(true);
    // One undo removes both instances.
    await page.getByTestId("pc-annotation-undo").click();
    await expect(rows).toHaveCount(0);
  });
  test("loads the view at full detail so a session labels every point", async ({ page }) => {
    test.setTimeout(120_000);
    await waitForMap(page);
    await loadCopc(page);
    await page.getByRole("button", { name: "Plugins", exact: true }).click();
    await page.getByRole("menuitem", { name: "Point Cloud Annotation", exact: true }).click();
    // The fitted view streams a coarse level of detail; full detail loads
    // every node in view (here, the whole 1,065-point test cloud) and pins it.
    await page.getByTestId("pc-annotation-full-detail").click();
    await expect(page.getByTestId("pc-annotation-status")).toContainText(
      "Loaded 1,065 points at full detail",
      { timeout: 60_000 },
    );
    await expect(page.getByTestId("pc-annotation-release-detail")).toBeVisible();
    const start = page.getByTestId("pc-annotation-start");
    await start.click();
    await expect(page.getByTestId("pc-annotation-hint")).toContainText("1,065 points loaded");
    await start.click();
    await page.getByTestId("pc-annotation-release-detail").click();
    await expect(page.getByTestId("pc-annotation-release-detail")).toBeHidden();
  });
});
