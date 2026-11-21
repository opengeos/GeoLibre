import { expect, test, type Page, type Route } from "./test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { aprx, groupLayer, hostedFeatureLayer } from "../tests/helpers/arcgis-aprx-fixtures";
import { waitForRenderedFeature } from "./helpers";

/**
 * An ArcGIS Pro project whose feature layers read numbered sublayers of a
 * FeatureServer opens with those layers live, keeps their place, group,
 * visibility and opacity through a save and reopen, and a service that cannot
 * be reached is reported without taking the rest of the project with it.
 *
 * The FeatureServer is a fixture served through `page.route`, so the run needs
 * no network and checks exactly which URLs the loader asked for.
 */

const SERVICE = "https://gis.fixture.test/arcgis/rest/services/Water/FeatureServer";
const DOWN_SERVICE = "https://down.fixture.test/arcgis/rest/services/Hydrants/FeatureServer";
const SECRET = "fixture-secret-token";

const POINTS: Record<string, [number, number]> = {
  "3": [-75, 35],
  "5": [-74, 36],
};

/** Top first, as ArcGIS Pro lists them. A token in a connection string must never be sent or saved. */
function buildAprx(): Uint8Array {
  const hosted = (name: string, root: string, dataset: string, extra = {}) =>
    hostedFeatureLayer(name, `${root}?token=${SECRET}`, dataset, extra);
  return aprx(["Utilities", "Hydrants"], {
    Utilities: groupLayer("Utilities", ["Network"]),
    Network: groupLayer("Network", ["Mains", "Valves"]),
    Mains: hosted("Mains", SERVICE, "3"),
    Valves: hosted("Valves", SERVICE, "5", { visibility: false, transparency: 40 }),
    Hydrants: hosted("Hydrants", DOWN_SERVICE, "1"),
  });
}

/** Serves sublayers 3 and 5 of the fixture FeatureServer; anything else is a 404. */
async function serveFeatureServer(page: Page, requested: string[]): Promise<void> {
  await page.route("https://gis.fixture.test/**", async (route: Route) => {
    const url = new URL(route.request().url());
    requested.push(url.href);
    const match = url.pathname.match(/\/FeatureServer\/(\d+)(\/query)?$/);
    const point = match ? POINTS[match[1]] : undefined;
    if (!match || !point) return route.fulfill({ status: 404, body: "not found" });
    const json = (body: unknown) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(body),
      });
    if (!match[2]) {
      return json({
        name: `Sublayer ${match[1]}`,
        geometryType: "esriGeometryPoint",
        objectIdField: "OBJECTID",
        maxRecordCount: 1000,
        advancedQueryCapabilities: { supportsPagination: true },
        fields: [
          { name: "OBJECTID", type: "esriFieldTypeOID" },
          { name: "name", type: "esriFieldTypeString" },
        ],
        extent: {
          xmin: point[0] - 1,
          ymin: point[1] - 1,
          xmax: point[0] + 1,
          ymax: point[1] + 1,
          spatialReference: { wkid: 4326 },
        },
      });
    }
    if (url.searchParams.get("returnCountOnly") === "true") return json({ count: 1 });
    if (url.searchParams.get("returnIdsOnly") === "true") {
      return json({ objectIdFieldName: "OBJECTID", objectIds: [1] });
    }
    return json({
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          id: 1,
          properties: { OBJECTID: 1, name: `feature ${match[1]}` },
          geometry: { type: "Point", coordinates: point },
        },
      ],
    });
  });
  // The second service is down: the import must report it and carry on.
  await page.route("https://down.fixture.test/**", (route) =>
    route.fulfill({ status: 503, body: "unavailable" }),
  );
}

async function waitForMap(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.getByTestId("map-canvas")).toBeVisible();
  await expect(page.locator(".maplibregl-canvas")).toBeVisible({
    timeout: 30_000,
  });
}

function layerRow(page: Page, name: string) {
  return page.locator(`[data-testid="layer-row"][data-layer-name="${name}"]`);
}

async function saveProject(page: Page): Promise<Buffer> {
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Project" }).click();
  await page.getByRole("menuitem", { name: "Save", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Save", exact: true }).click();
  const download = await downloadPromise;
  const chunks: Buffer[] = [];
  for await (const chunk of await download.createReadStream()) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

interface SavedLayer {
  name: string;
  visible: boolean;
  opacity: number;
  groupId?: string;
  sourcePath?: string;
  source: { arcgisQueryUrl?: string };
  metadata: Record<string, unknown>;
}

test("opens FeatureServer sublayers from an ArcGIS Pro project and keeps them across save and reopen", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.addInitScript(() => {
    delete (window as unknown as Record<string, unknown>).showSaveFilePicker;
    delete (window as unknown as Record<string, unknown>).showOpenFilePicker;
  });
  const logs: string[] = [];
  page.on("console", (message) => logs.push(message.text()));
  const requested: string[] = [];
  await serveFeatureServer(page, requested);

  const dir = await mkdtemp(join(tmpdir(), "geolibre-aprx-"));
  try {
    const aprxPath = join(dir, "water.aprx");
    await writeFile(aprxPath, buildAprx());

    // 1. Import through Project -> Import, the path a user takes.
    await waitForMap(page);
    const chooserPromise = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "Project" }).click();
    await page.getByRole("menuitem", { name: "Import", exact: true }).click();
    await page.getByRole("menuitem", { name: "Import ArcGIS Pro project…" }).click();
    await (await chooserPromise).setFiles(aprxPath);

    // The unreachable service is reported by name; the rest still loads.
    const warnings = page.getByRole("dialog", {
      name: "ArcGIS Pro project imported",
    });
    await expect(warnings).toBeVisible({ timeout: 30_000 });
    await expect(warnings).toContainText("1 layer could not be loaded");
    await expect(warnings).toContainText("Hydrants");
    await expect(warnings).toContainText("The ArcGIS feature service could not be loaded");
    await page.screenshot({
      path: test.info().outputPath("import-warnings.png"),
    });
    await warnings.getByRole("button", { name: "OK" }).click();

    await expect(layerRow(page, "Mains")).toBeVisible();
    await expect(layerRow(page, "Valves")).toBeVisible();
    await expect(layerRow(page, "Hydrants")).toHaveCount(0);
    await expect(page.getByTestId("layer-group-header")).toHaveCount(2);
    // Each sublayer's features were queried from its own explicit URL.
    await expect
      .poll(() => requested.some((url) => url.startsWith(`${SERVICE}/3/query`)))
      .toBe(true);
    await expect
      .poll(() => requested.some((url) => url.startsWith(`${SERVICE}/5/query`)))
      .toBe(true);
    expect(requested.some((url) => /\/FeatureServer\/0\b/.test(url))).toBe(false);
    // The feature is drawn on the map, not only listed: the project's extent
    // centres on Mains' one point.
    await waitForRenderedFeature(page, "feature 3");
    await page.screenshot({ path: test.info().outputPath("imported.png") });

    // 2. Save, and check what reached the project file.
    const savedBytes = await saveProject(page);
    const savedText = savedBytes.toString("utf8");
    expect(savedText).not.toContain(SECRET);
    const saved = JSON.parse(savedText) as {
      layers: SavedLayer[];
      layerGroups: { id: string; name: string; parentId?: string }[];
      mapView: { center: [number, number] };
    };
    const groups = new Map(saved.layerGroups.map((group) => [group.name, group]));
    expect(groups.get("Network")?.parentId).toBe(groups.get("Utilities")?.id);
    const byName = new Map(saved.layers.map((layer) => [layer.name, layer]));
    const mains = byName.get("Mains")!;
    const valves = byName.get("Valves")!;
    // ArcGIS Pro lists Mains on top; the store and the file keep bottom first.
    expect(saved.layers.map((layer) => layer.name)).toEqual(["Valves", "Mains"]);
    expect(mains).toMatchObject({
      visible: true,
      opacity: 1,
      groupId: groups.get("Network")?.id,
    });
    expect(valves).toMatchObject({
      visible: false,
      opacity: 0.6,
      groupId: groups.get("Network")?.id,
    });
    expect(mains.source.arcgisQueryUrl).toBe(`${SERVICE}/3/query`);
    expect(valves.source.arcgisQueryUrl).toBe(`${SERVICE}/5/query`);
    expect(mains.metadata).toMatchObject({
      importedFrom: "arcgis-pro",
      arcgisLayerUri: "CIMPATH=map/mains.json",
    });
    expect(saved.mapView.center[0]).toBeCloseTo(-75, 3);
    expect(saved.mapView.center[1]).toBeCloseTo(35, 3);

    // 3. Reopen in a fresh page: the layers query their sublayers again.
    const savedPath = join(dir, "water.geolibre.json");
    await writeFile(savedPath, savedBytes);
    await waitForMap(page);
    // The import's own requests are checked before the history is cleared.
    expect(requested.join("\n")).not.toContain(SECRET);
    requested.length = 0;
    const reopenChooser = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "Project" }).click();
    await page.getByRole("menuitem", { name: "Open from" }).click();
    await page.getByRole("menuitem", { name: "File…" }).click();
    await (await reopenChooser).setFiles(savedPath);

    await expect(layerRow(page, "Mains")).toBeVisible();
    await expect(layerRow(page, "Valves")).toBeVisible();
    await expect(page.getByTestId("layer-group-header")).toHaveCount(2);
    await expect
      .poll(() => requested.some((url) => url.startsWith(`${SERVICE}/3/query`)))
      .toBe(true);
    // The saved extent is restored, and Mains' feature draws at its centre.
    await waitForRenderedFeature(page, "feature 3");
    const center = await page.evaluate(() => window.__geolibreTestMap!.getCenter().toArray());
    expect(center[0]).toBeCloseTo(-75, 1);
    expect(center[1]).toBeCloseTo(35, 1);
    await page.screenshot({ path: test.info().outputPath("reopened.png") });

    // No request and no log line ever carried the project's token.
    expect(requested.join("\n")).not.toContain(SECRET);
    expect(logs.join("\n")).not.toContain(SECRET);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
