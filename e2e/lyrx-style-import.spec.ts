import { expect, test } from "./test";
import { bindMapLibreMap, dropGeoJson, layerRow, readFixture, waitForMap } from "./helpers";

const FIXTURE_TEXT = readFixture("smoke.geojson");

function lyrx(renderer: unknown): string {
  return JSON.stringify({
    type: "CIMLayerDocument",
    layerDefinitions: [{ type: "CIMFeatureLayer", name: "Places", renderer }],
  });
}

/** A green vector marker, 12 pt across, with no outline. */
const SIMPLE_MARKER = lyrx({
  type: "CIMSimpleRenderer",
  symbol: {
    type: "CIMSymbolReference",
    symbol: {
      type: "CIMPointSymbol",
      symbolLayers: [
        {
          type: "CIMVectorMarker",
          enable: true,
          size: 12,
          markerGraphics: [
            {
              type: "CIMMarkerGraphic",
              symbol: {
                type: "CIMPolygonSymbol",
                symbolLayers: [
                  {
                    type: "CIMSolidFill",
                    enable: true,
                    color: { type: "CIMRGBColor", values: [0, 128, 0, 100] },
                  },
                ],
              },
            },
          ],
        },
      ],
    },
  },
});

/**
 * An ArcGIS Pro layer file through the normal style import doors.
 *
 * The CIM reading is unit-tested (`tests/lyrx-import.test.ts`); what needs a browser is that the
 * file picker offers and accepts a `.lyrx`, that the style reaches the map, and that a renderer
 * GeoLibre cannot draw is refused in words the user can act on.
 */
test("a .lyrx file styles the layer, and an unsupported renderer is refused by name", async ({
  page,
}) => {
  await waitForMap(page);
  await bindMapLibreMap(page);
  await dropGeoJson(page, "smoke", FIXTURE_TEXT);

  const row = layerRow(page, "smoke");
  await expect(row).toBeVisible();
  await row.locator('button[aria-label="Layer actions"]').click();
  await page.getByRole("menuitem", { name: "Styles", exact: true }).click();

  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("menuitem", { name: /Import style from file .*LYRX/ }).click();
  const fileChooser = await chooser;
  await fileChooser.setFiles({
    name: "places.lyrx",
    mimeType: "application/octet-stream",
    buffer: Buffer.from(SIMPLE_MARKER),
  });
  await expect(row).toContainText("Style imported.");

  // The marker's colour and size reach the rendered circle layer.
  await expect
    .poll(() =>
      page.evaluate(() => {
        const map = (
          window as unknown as {
            __geolibreTestMap?: {
              getStyle(): { layers: Array<{ type: string; paint?: Record<string, unknown> }> };
            };
          }
        ).__geolibreTestMap;
        const circle = map
          ?.getStyle()
          .layers.find(
            (layer) => layer.type === "circle" && layer.paint?.["circle-color"] === "#008000",
          );
        return circle ? circle.paint?.["circle-radius"] : null;
      }),
    )
    .toBe(8);

  // A heat map has no GeoLibre equivalent: refused in the dialog, by name, text kept.
  await row.locator('button[aria-label="Layer actions"]').click();
  await page.getByRole("menuitem", { name: "Styles", exact: true }).click();
  await page.getByRole("menuitem", { name: "Import style from text…" }).click();
  const box = page.getByRole("textbox", { name: "Import style from text…" });
  const heatMap = lyrx({ type: "CIMHeatMapRenderer" });
  await box.fill(heatMap);
  await page.getByRole("button", { name: "Import", exact: true }).click();
  await expect(page.getByText(/uses the heat map renderer/)).toBeVisible();
  await expect(box).toHaveValue(heatMap);
});
