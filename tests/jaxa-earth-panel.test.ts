import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { DEFAULT_LAYER_STYLE, useAppStore } from "@geolibre/core";
import { parseHTML } from "linkedom";
import {
  JAXA_EARTH_CATALOG_URL,
  type JaxaEarthModule,
  parseJaxaTileUrl,
  setJaxaEarthModuleLoader,
} from "../packages/plugins/src/plugins/jaxa-earth-api";
import { maplibreJaxaEarthPlugin } from "../packages/plugins/src/plugins/maplibre-jaxa-earth";
import type { GeoLibreAppAPI } from "../packages/plugins/src/types";

const LST = "JAXA.G-Portal_GCOM-C.SGLI_standard.L3-LST.daytime.v3_global_monthly";
const ICE = "JAXA.JASMES_GCOM-W.AMSR2_ic0.v201_north_daily";

const CATALOG = `
# Main Recommended Data

## Land Surface Temperature

- ${LST}

## Duplicate group

- ${LST}

# Dataset List

## Land Surface Temperature (Daytime/Monthly)
* id: ${LST}
* title: Land Surface Temperature (Daytime/Monthly)
* bands: LST
* bbox: [-180,-90,180,90]
* epsg: 4326
* spatialResolution: 2.783
* startDate: 2018-01-01T00:00:00Z
* endDate: present
* temporalResolution: monthly
* normal: false

## Sea Ice Concentration (North)
* id: ${ICE}
* title: Sea Ice Concentration (North)
* bands: IC0
* epsg: 3995
* temporalResolution: daily
`;

/** Months the fake collection has data for. */
const MONTHS = ["2026-01", "2026-02", "2026-03"].map((m) => new Date(`${m}-01T00:00:00Z`));
const label = (date: Date) => date.toISOString().slice(0, 7).replace("-", "/");

/** A fake JAXA module whose sample read can be made to fail. */
function fakeModule(options: { sampleFails?: boolean } = {}): JaxaEarthModule {
  const floor = (date: Date) =>
    [...MONTHS].reverse().find((month) => month <= date) ?? new Date(Number.NaN);
  return {
    Resampling: { NEAREST: "nearest", BILINEAR: "bilinear" },
    TileGenerator: class {},
    ImageCollection: class {
      async init() {}
      first() {
        return MONTHS[0];
      }
      last() {
        return MONTHS[MONTHS.length - 1];
      }
      async prev(date: Date) {
        return MONTHS[MONTHS.findIndex((m) => m.getTime() === date.getTime()) - 1] ?? new Date(NaN);
      }
      async next(date: Date) {
        return MONTHS[MONTHS.findIndex((m) => m.getTime() === date.getTime()) + 1] ?? new Date(NaN);
      }
      formatDate(date: Date) {
        return label(date);
      }
      getBandIdAll() {
        return ["LST"];
      }
      async getImage({ date }: { date?: Date }) {
        const snapped = floor(date ?? new Date());
        return {
          getDate: () => snapped,
          getFormattedDate: () => label(snapped),
          getBand: () => "LST",
          getDataObject: async () => {
            if (options.sampleFails) throw new Error("network down");
            const data = new Float32Array(101).map((_, i) => 250 + i * 0.7);
            return {
              width: 101,
              height: 1,
              data,
              unit: "Kelvin",
              date: snapped,
              formattedDate: label(snapped),
              photometricInterpretation: 1,
            };
          },
        };
      }
    },
    image: {
      ColorMap: class {
        createColorBarCanvas() {
          return document.createElement("canvas");
        }
      },
    },
  } as unknown as JaxaEarthModule;
}

/** Waits until `check` holds, failing after a second. */
async function until(check: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 100; i += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`timed out waiting for ${what}`);
}

/** Opens the panel against a fake app whose tile layers go into the real store. */
function openPanel(options: { sampleFails?: boolean } = {}) {
  const { document, window } = parseHTML("<html><body></body></html>");
  Object.assign(globalThis, { document, window, HTMLElement: window.HTMLElement });
  // linkedom's <select> has a value getter only; browsers also let it be set.
  const selectProto = Object.getPrototypeOf(document.createElement("select"));
  const getter = Object.getOwnPropertyDescriptor(selectProto, "value")?.get;
  if (getter) {
    Object.defineProperty(selectProto, "value", {
      configurable: true,
      get: getter,
      set(this: HTMLSelectElement, value: string) {
        for (const option of Array.from(this.options)) option.selected = option.value === value;
      },
    });
  }
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    assert.equal(String(input), JAXA_EARTH_CATALOG_URL);
    return new Response(CATALOG);
  }) as typeof fetch;
  setJaxaEarthModuleLoader(async () => fakeModule(options));
  useAppStore.setState({ layers: [] });

  const container = document.createElement("div");
  document.body.append(container);
  const added: Array<{ name: string; url: string; options: Record<string, unknown> }> = [];
  const app = {
    registerRightPanel: (panel: { render: (el: HTMLElement) => void }) => {
      panel.render(container);
      return () => {};
    },
    openRightPanel: () => true,
    closeRightPanel: () => {},
    addTileLayer: (name: string, url: string, layerOptions: Record<string, unknown> = {}) => {
      const id = `jaxa-${added.length + 1}`;
      added.push({ name, url, options: layerOptions });
      useAppStore.getState().addLayer({
        id,
        name,
        type: "xyz",
        source: { type: "raster", tiles: [url], tileSize: 256 },
        visible: true,
        opacity: 1,
        style: { ...DEFAULT_LAYER_STYLE },
        metadata: { ...(layerOptions.metadata as Record<string, unknown>) },
      });
      return id;
    },
  } as unknown as GeoLibreAppAPI;
  maplibreJaxaEarthPlugin.activate(app);

  const select = (name: string) =>
    container.querySelector(`select[aria-label="${name}"]`) as HTMLSelectElement;
  const button = (text: string) =>
    Array.from(container.querySelectorAll("button")).find(
      (node) => node.textContent === text || node.getAttribute("aria-label") === text,
    ) as HTMLButtonElement;
  const change = (node: HTMLElement) => node.dispatchEvent(new window.Event("change"));
  const choose = (id: string) => {
    const datasets = select("Dataset");
    for (const option of Array.from(datasets.options)) option.selected = option.value === id;
    change(datasets);
  };
  const numbers = () =>
    Array.from(container.querySelectorAll('input[type="number"]')) as HTMLInputElement[];
  return {
    container,
    added,
    select,
    button,
    change,
    choose,
    numbers,
    text: () => container.textContent ?? "",
    close: () => {
      maplibreJaxaEarthPlugin.deactivate(app);
      globalThis.fetch = realFetch;
    },
  };
}

describe("JAXA Earth panel", () => {
  let panel: ReturnType<typeof openPanel> | null = null;
  afterEach(() => {
    panel?.close();
    panel = null;
    setJaxaEarthModuleLoader(null);
  });

  it("lists recommended datasets once and disables unsupported projections", async () => {
    panel = openPanel();
    const p = panel;
    await until(() => p.select("Dataset").options.length > 1, "the catalog");
    const options = Array.from(p.select("Dataset").options).filter((o) => o.value);
    assert.deepEqual(
      options.map((o) => o.value),
      [LST, ICE],
      "the dataset in two recommended groups is listed once",
    );
    const ice = options.find((o) => o.value === ICE)!;
    assert.equal(ice.disabled, true);
    assert.match(ice.textContent ?? "", /projection not supported/);
  });

  it("samples a range, adds a layer, and re-draws it as the date steps", async () => {
    panel = openPanel();
    const p = panel;
    await until(() => p.select("Dataset").options.length > 1, "the catalog");
    p.choose(LST);
    await until(() => p.button("Add to map")?.disabled === false, "the sample");
    const [min, max] = p.numbers();
    assert.ok(Number(min.value) >= 250 && Number(min.value) < 252, `min ${min.value}`);
    assert.ok(Number(max.value) > 318 && Number(max.value) <= 320, `max ${max.value}`);
    assert.match(p.text(), /2026\/03/, "opens on the latest date");

    p.button("Add to map").click();
    assert.equal(p.added.length, 1);
    const spec = parseJaxaTileUrl(p.added[0].url);
    assert.equal(spec?.datasetId, LST);
    assert.equal(spec?.date, "2026-03-01T00:00:00.000Z");
    assert.equal(spec?.colormap, "turbo");
    assert.equal(p.added[0].name, "Land Surface Temperature (Daytime/Monthly) (2026/03)");

    const layer = () => useAppStore.getState().layers[0];
    p.button("Previous date").click();
    await until(() => /2026-02/.test(String(layer().source.tiles)), "the re-drawn layer");
    assert.equal(layer().name, "Land Surface Temperature (Daytime/Monthly) (2026/02)");

    // A name the user typed survives the next step.
    useAppStore.getState().updateLayer(layer().id, { name: "My LST" });
    await until(() => p.button("Previous date")?.disabled === false, "the stepper");
    p.button("Previous date").click();
    await until(() => /2026-01/.test(String(layer().source.tiles)), "the second step");
    assert.equal(layer().name, "My LST");

    // Stepping past the first date reports it instead of doing nothing.
    await until(() => p.button("Previous date")?.disabled === false, "the stepper");
    p.button("Previous date").click();
    await until(() => /no other date/.test(p.text()), "the error");
    assert.match(String(layer().source.tiles), /2026-01/);
  });

  it("keeps Add disabled after a failed sample until a range is typed", async () => {
    panel = openPanel({ sampleFails: true });
    const p = panel;
    await until(() => p.select("Dataset").options.length > 1, "the catalog");
    p.choose(LST);
    await until(() => /Could not read a sample/.test(p.text()), "the failure");
    const [min, max] = p.numbers();
    assert.equal(min.value, "");
    assert.equal(p.button("Add to map").disabled, true);
    min.value = "250";
    p.change(min);
    assert.equal(p.button("Add to map").disabled, true, "one bound is not a range");
    max.value = "320";
    p.change(max);
    assert.equal(p.button("Add to map").disabled, false);
  });
});
