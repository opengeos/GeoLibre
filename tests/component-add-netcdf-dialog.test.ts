import { fireEvent, mockFetch, render, screen, useAppStore, waitFor } from "./helpers/dom";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import type { GeoLibreAppAPI } from "@geolibre/plugins";

const { AddNetcdfDialog } =
  await import("../apps/geolibre-desktop/src/components/layout/AddNetcdfDialog");
type Services =
  import("../apps/geolibre-desktop/src/components/layout/AddNetcdfDialog").AddNetcdfServices;
type CloudOptions = Parameters<Services["addCloudNetcdfLayer"]>[1];

const KERCHUNK_URL = "https://data.example.com/air.kerchunk.json";

/** A kerchunk reference with one 3-D variable and a 1-D coordinate array. */
const KERCHUNK = {
  version: 1,
  refs: {
    ".zgroup": '{"zarr_format":2}',
    "air/.zarray": JSON.stringify({
      shape: [4, 73, 144],
      chunks: [1, 73, 144],
      dtype: "<f4",
      zarr_format: 2,
    }),
    "air/.zattrs": JSON.stringify({ _ARRAY_DIMENSIONS: ["time", "lat", "lon"] }),
    "lat/.zarray": JSON.stringify({ shape: [73], chunks: [73], dtype: "<f4", zarr_format: 2 }),
  },
};

/** Fake readers and layer helper that record what the dialog asked for. */
function fakeServices(overrides: Partial<Services> = {}) {
  const added: CloudOptions[] = [];
  const services: Services = {
    addCloudNetcdfLayer: async (_app, options) => {
      added.push(options);
    },
    openRemoteNetcdfFile: async () => {
      throw new Error("not used");
    },
    openLocalNetcdf: async () => {
      throw new Error("not used");
    },
    openLocalDataFile: async () => null,
    ...overrides,
  };
  return { services, added };
}

const fitted: unknown[] = [];
const appApi = { fitBounds: (bounds: unknown) => fitted.push(bounds) } as unknown as GeoLibreAppAPI;

function renderDialog(services: Services) {
  let open = true;
  render(
    createElement(AddNetcdfDialog, {
      open: true,
      appApi,
      onOpenChange: (next: boolean) => (open = next),
      services,
    }),
  );
  return () => open;
}

const text = () => document.body.textContent ?? "";

function useCloudSource(url: string) {
  fireEvent.change(screen.getByLabelText("Source"), { target: { value: "url" } });
  fireEvent.change(screen.getByLabelText("Kerchunk reference or NetCDF/HDF file URL"), {
    target: { value: url },
  });
  fireEvent.click(screen.getByRole("button", { name: "Load variables" }));
}

describe("AddNetcdfDialog", () => {
  it("lists a kerchunk reference's variables and adds one slice with the chosen limits", async () => {
    mockFetch(async () => new Response(JSON.stringify(KERCHUNK), { status: 200 }));
    const { services, added } = fakeServices();
    const isOpen = renderDialog(services);
    useCloudSource(KERCHUNK_URL);
    await waitFor(() => assert.ok(text().includes("Found 1 variable.")));
    assert.equal((screen.getByLabelText("Variable") as HTMLSelectElement).value, "air");

    fireEvent.change(screen.getByLabelText("time index"), { target: { value: "2" } });
    fireEvent.change(screen.getByLabelText("Color min (optional)"), { target: { value: "230" } });
    fireEvent.change(screen.getByLabelText("Color max (optional)"), { target: { value: "310" } });
    fireEvent.click(screen.getByRole("button", { name: "Add layer" }));
    await waitFor(() => assert.equal(added.length, 1));
    const options = added[0]!;
    assert.equal(options.url, KERCHUNK_URL);
    assert.equal(options.variable, "air");
    assert.deepEqual(options.selector, { time: 2 });
    assert.deepEqual(options.clim, [230, 310]);
    assert.equal(options.colormap, "viridis");
    // The reference fetched for listing is reused rather than fetched again.
    assert.ok(options.refs);
    await waitFor(() => assert.equal(isOpen(), false));
  });

  it("ignores color limits that do not form a range", async () => {
    mockFetch(async () => new Response(JSON.stringify(KERCHUNK), { status: 200 }));
    const { services, added } = fakeServices();
    renderDialog(services);
    useCloudSource(KERCHUNK_URL);
    await waitFor(() => assert.ok(text().includes("Found 1 variable.")));
    fireEvent.change(screen.getByLabelText("Color min (optional)"), { target: { value: "300" } });
    fireEvent.change(screen.getByLabelText("Color max (optional)"), { target: { value: "200" } });
    fireEvent.click(screen.getByRole("button", { name: "Add layer" }));
    await waitFor(() => assert.equal(added.length, 1));
    assert.equal(added[0]!.clim, undefined);
  });

  it("reports a reference that cannot be fetched or has nothing to render", async () => {
    mockFetch(async () => new Response("missing", { status: 404 }));
    renderDialog(fakeServices().services);
    useCloudSource(KERCHUNK_URL);
    await waitFor(() => assert.ok(text().includes("Failed to fetch kerchunk reference: HTTP 404")));

    mockFetch(
      async () =>
        new Response(
          JSON.stringify({ version: 1, refs: { "lat/.zarray": KERCHUNK.refs["lat/.zarray"] } }),
          {
            status: 200,
          },
        ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Load variables" }));
    await waitFor(() =>
      assert.ok(text().includes("No renderable (2-D or higher) variables found")),
    );
    assert.equal(screen.getByRole("button", { name: "Add layer" }).hasAttribute("disabled"), true);
  });

  it("adds a local file's time series as a Zarr layer that keeps the time axis", async () => {
    let closed = 0;
    const builds: unknown[] = [];
    const localFile = {
      listVariables: () => [
        { name: "t2m", dims: ["time", "lat", "lon"], shape: [3, 10, 20], units: "K" },
      ],
      listAxes: () => [{ name: "time", size: 3, values: [0, 6, 12] }],
      buildLayerRefs: (variable: string, selector: unknown, options: unknown) => {
        builds.push({ variable, selector, options });
        return {
          refs: { "t2m/.zarray": "{}" },
          variable,
          bounds: [-10, 40, 10, 50] as [number, number, number, number],
          clim: [260, 300] as [number, number],
          selector: { time: 0 },
        };
      },
      close: () => {
        closed += 1;
      },
    };
    const { services, added } = fakeServices({
      openLocalDataFile: (async () => ({
        data: new ArrayBuffer(8),
        path: "/data/era5.nc",
      })) as Services["openLocalDataFile"],
      openLocalNetcdf: (async () => localFile) as unknown as Services["openLocalNetcdf"],
    });
    renderDialog(services);
    fireEvent.click(screen.getByRole("button", { name: "Choose file" }));
    await waitFor(() => assert.ok(text().includes("Found 1 variable.")));
    fireEvent.click(screen.getByRole("button", { name: "Add layer" }));
    await waitFor(() => assert.equal(added.length, 1));
    assert.deepEqual(builds[0], {
      variable: "t2m",
      selector: { time: 0 },
      options: { keepAxis: "time" },
    });
    assert.equal(added[0]!.url, "local:era5.nc");
    assert.deepEqual(added[0]!.clim, [260, 300]);
    assert.deepEqual(added[0]!.bounds, [-10, 40, 10, 50]);
    assert.deepEqual(fitted.at(-1), [-10, 40, 10, 50]);
    // The refs are self-contained, so the file is released once the layer is added.
    assert.equal(closed, 1);
    // The form resets for the next file.
    assert.ok(!text().includes("/data/era5.nc"));
  });

  it("reports a local file without renderable variables", async () => {
    const { services } = fakeServices({
      openLocalDataFile: (async () => ({
        data: new ArrayBuffer(8),
        path: "/data/empty.nc",
      })) as Services["openLocalDataFile"],
      openLocalNetcdf: (async () => ({
        listVariables: () => [],
        close: () => {},
      })) as unknown as Services["openLocalNetcdf"],
    });
    renderDialog(services);
    fireEvent.click(screen.getByRole("button", { name: "Choose file" }));
    await waitFor(() =>
      assert.ok(text().includes("No renderable (2-D or higher) variables found in the file.")),
    );
    assert.equal(useAppStore.getState().layers.length, 0);
  });
});
