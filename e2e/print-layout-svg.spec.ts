import { expect, test, type Page } from "@playwright/test";
import { dropGeoJson, layerRow, readFixture, waitForMap } from "./helpers";

async function downloadSvg(page: Page): Promise<string> {
  const pending = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export SVG", exact: true }).click();
  const download = await pending;
  expect(download.suggestedFilename()).toMatch(/\.svg$/);
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

for (const theme of ["light", "dark"]) {
  test(`exports editable print furniture and an embedded map in ${theme} theme`, async ({
    page,
  }) => {
    await page.addInitScript(() => {
      // Exercise the real browser download fallback, avoiding a native picker.
      Reflect.deleteProperty(window, "showSaveFilePicker");
    });
    await waitForMap(page, `/?theme=${theme}`);
    await dropGeoJson(page, "smoke", readFixture("smoke.geojson"));
    await expect(layerRow(page, "smoke")).toBeVisible();
    await page.getByRole("button", { name: "Project", exact: true }).click();
    await page.getByRole("menuitem", { name: "Print Layout...", exact: true }).click();

    const title = "Map <SVG> & café 地図";
    const subtitle = "A long editable subtitle & <text> ".repeat(20);
    await page.getByRole("textbox", { name: "Title", exact: true }).fill(title);
    await page.getByRole("textbox", { name: "Subtitle", exact: true }).fill(subtitle);
    await page.getByRole("checkbox", { name: "Colorbar", exact: true }).check();
    await page.getByRole("textbox", { name: "Label", exact: true }).fill("Elevation (m)");
    await expect(page.getByRole("button", { name: "Export SVG", exact: true })).toBeEnabled();

    const source = await downloadSvg(page);
    const result = await page.evaluate(
      async ({ source, title, subtitle }) => {
        const doc = new DOMParser().parseFromString(source, "image/svg+xml");
        const svg = doc.documentElement;
        const texts = Array.from(doc.querySelectorAll("text"));
        const fitted = texts.find((node) => node.textContent === subtitle.trim());
        const image = new Image();
        const url = URL.createObjectURL(new Blob([source], { type: "image/svg+xml" }));
        try {
          image.src = url;
          await image.decode();
          return {
            valid: !doc.querySelector("parsererror"),
            width: svg.getAttribute("width"),
            height: svg.getAttribute("height"),
            viewBox: svg.getAttribute("viewBox"),
            hasTitle: texts.some((node) => node.textContent === title),
            labels: texts.map((node) => node.textContent),
            fitted:
              Number(fitted?.getAttribute("textLength")) > 0 &&
              fitted?.getAttribute("lengthAdjust") === "spacingAndGlyphs",
            gradients: doc.querySelectorAll("linearGradient stop").length,
            paths: doc.querySelectorAll("path").length,
            clips: doc.querySelectorAll("clipPath").length,
            images: Array.from(doc.querySelectorAll("image"), (node) =>
              node.getAttributeNS("http://www.w3.org/1999/xlink", "href"),
            ),
            unsafe: !!doc.querySelector("script, foreignObject"),
            decoded: image.naturalWidth > 0 && image.naturalHeight > 0,
          };
        } finally {
          URL.revokeObjectURL(url);
        }
      },
      { source, title, subtitle },
    );

    expect(result.valid).toBe(true);
    expect(result.width).toBe("297mm");
    expect(result.height).toBe("210mm");
    expect(result.viewBox).toBe("0 0 1754 1240");
    expect(result.hasTitle).toBe(true);
    expect(result.labels).toEqual(
      expect.arrayContaining(["Legend", "smoke", "Elevation (m)", "N"]),
    );
    expect(result.fitted).toBe(true);
    expect(result.gradients).toBeGreaterThanOrEqual(2);
    expect(result.paths).toBeGreaterThan(0);
    expect(result.clips).toBeGreaterThan(0);
    expect(result.images).toHaveLength(1);
    expect(result.images[0]).toMatch(/^data:image\/png;base64,/);
    expect(result.unsafe).toBe(false);
    expect(result.decoded).toBe(true);

    // Digital pages retain exact pixel dimensions, independent of print DPI.
    await page.getByRole("combobox", { name: "Size", exact: true }).selectOption("hd");
    const digital = await downloadSvg(page);
    expect(digital).toContain('width="1280px"');
    expect(digital).toContain('height="720px"');
    expect(digital).toContain('viewBox="0 0 1280 720"');

    // The shared drawing entry point must keep the existing exports working.
    for (const format of ["PNG", "PDF"]) {
      const pending = page.waitForEvent("download");
      await page.getByRole("button", { name: `Export ${format}`, exact: true }).click();
      const download = await pending;
      expect(download.suggestedFilename()).toMatch(new RegExp(`\\.${format.toLowerCase()}$`));
      const stream = await download.createReadStream();
      const chunks: Buffer[] = [];
      for await (const chunk of stream) chunks.push(Buffer.from(chunk));
      const bytes = Buffer.concat(chunks);
      expect(bytes.length).toBeGreaterThan(1000);
      if (format === "PNG") expect(bytes.subarray(1, 4).toString()).toBe("PNG");
      else expect(bytes.subarray(0, 5).toString()).toBe("%PDF-");
    }

    // A single SVG has one page; atlas mode keeps its existing ZIP/PDF exports.
    await page.getByRole("checkbox", { name: "Generate a multi-page map series" }).check();
    await expect(page.getByRole("button", { name: "Export SVG", exact: true })).toHaveCount(0);
  });
}
