import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseHTML } from "linkedom";
import {
  maplibreVantorPlugin,
  VANTOR_PLUGIN_ID,
} from "../packages/plugins/src/plugins/maplibre-vantor";
import { CogLayer } from "../packages/plugins/src/plugins/vantor/cog-layer";
import { VantorControl } from "../packages/plugins/src/plugins/vantor/control";
import { Downloader } from "../packages/plugins/src/plugins/vantor/download";
import { DrawBBox } from "../packages/plugins/src/plugins/vantor/draw-bbox";
import { FootprintLayer } from "../packages/plugins/src/plugins/vantor/footprint-layer";
import { PanelUI } from "../packages/plugins/src/plugins/vantor/panel";
import { StacClient } from "../packages/plugins/src/plugins/vantor/stac-client";
import { WEB_SERVICE_PLUGIN_IDS } from "../packages/plugins/src/plugins/web-service-sync";
import { pluginTier } from "../apps/geolibre-desktop/src/lib/ui-profile";

describe("Vantor Open Data built-in plugin", () => {
  const item = (id: string, href = "https://example.com/vantor.tif") =>
    ({
      type: "Feature",
      stac_version: "1.0.0",
      id,
      geometry: null,
      bbox: [0, 0, 1, 1],
      properties: {},
      assets: {
        visual: {
          href,
          type: "image/tiff; application=geotiff; profile=cloud-optimized",
        },
      },
      links: [],
    }) as const;

  const installDom = () => {
    const { document, window } = parseHTML("<html><body></body></html>");
    class TestCustomEvent<T = unknown> extends Event {
      detail: T;

      constructor(type: string, init?: CustomEventInit<T>) {
        super(type);
        this.detail = init?.detail as T;
      }
    }
    Object.assign(globalThis, {
      document,
      window,
      CustomEvent: TestCustomEvent,
      CSS: { escape: (value: string) => value },
    });
    return { document, window };
  };

  it("is registered as an advanced Web Services plugin", () => {
    assert.equal(VANTOR_PLUGIN_ID, "maplibre-gl-vantor");
    assert.equal(maplibreVantorPlugin.id, VANTOR_PLUGIN_ID);
    assert.equal(maplibreVantorPlugin.name, "Vantor Open Data");
    assert.equal(maplibreVantorPlugin.version, "0.2.1");
    assert.ok(WEB_SERVICE_PLUGIN_IDS.includes(VANTOR_PLUGIN_ID));
    assert.equal(
      WEB_SERVICE_PLUGIN_IDS.indexOf(VANTOR_PLUGIN_ID),
      WEB_SERVICE_PLUGIN_IDS.indexOf("maplibre-gl-national-map") + 1,
    );
    assert.equal(pluginTier(VANTOR_PLUGIN_ID), "advanced");
  });

  it("defaults to the top-left map-control position", () => {
    assert.equal(maplibreVantorPlugin.getMapControlPosition?.(), "top-left");
  });

  it("uses the GPU renderer by default and allows selecting WASM", async () => {
    let receivedOptions: Parameters<NonNullable<ConstructorParameters<typeof CogLayer>[2]>>[2];
    const layer = new CogLayer({} as never, undefined, async (_name, _url, options) => {
      receivedOptions = options;
      return "vantor-layer";
    });

    const scene = item("test-vantor-scene");

    await layer.addCogLayer(scene);

    assert.deepEqual(receivedOptions!, {
      nodata: 0,
      engine: "maplibre-gl-raster",
    });

    const wasmLayer = new CogLayer({} as never, undefined, async (_name, _url, options) => {
      receivedOptions = options;
      return "vantor-wasm-layer";
    });
    await wasmLayer.setRenderEngine("cog-tiler-wasm");
    assert.equal(wasmLayer.getRenderEngine(), "cog-tiler-wasm");
    await wasmLayer.addCogLayer(scene);
    assert.deepEqual(receivedOptions!, { nodata: 0, engine: "cog-tiler-wasm" });
  });

  it("propagates renderer changes after adding a host-managed COG", async () => {
    const switched: string[] = [];
    const layer = new CogLayer(
      {} as never,
      undefined,
      async () => "vantor-host-layer",
      "maplibre-gl-raster",
      async (engine) => switched.push(engine),
    );

    await layer.addCogLayer(item("host-scene"));
    assert.deepEqual(switched, []);
    await layer.setRenderEngine("cog-tiler-wasm");
    assert.deepEqual(switched, ["cog-tiler-wasm"]);
  });

  it("rejects unsafe asset URLs before visualization or download", async () => {
    installDom();
    const client = new StacClient();
    const unsafe = item("unsafe", "javascript:alert(1)");
    assert.equal(client.getCogUrl(unsafe), null);

    const result = await new Downloader().downloadItems([unsafe], () => "javascript:alert(1)");
    assert.deepEqual(result, { started: 0, failed: 1 });
    assert.equal(document.querySelectorAll("a").length, 0);

    let hostAdds = 0;
    const layer = new CogLayer({} as never, undefined, async () => {
      hostAdds++;
      return "unsafe-layer";
    });
    await assert.rejects(layer.addCogLayer(unsafe), /No COG URL found/);
    assert.equal(hostAdds, 0);
  });

  it("settles an active bounding-box draw when deactivated", async () => {
    const source = { setData() {} };
    const canvas = { style: { cursor: "" } };
    const map = {
      getSource: () => source,
      addSource() {},
      addLayer() {},
      getCanvas: () => canvas,
      dragPan: { disable() {}, enable() {} },
      on() {},
      off() {},
    };
    const draw = new DrawBBox(map as never);
    const pending = draw.activate();
    draw.deactivate();
    await assert.rejects(pending, { name: "AbortError" });
  });

  it("removes footprint hover listeners with their original callbacks", () => {
    const source = { setData() {} };
    const listeners = new Map<string, unknown>();
    const removed = new Map<string, unknown>();
    let hasSource = false;
    const layers = new Set<string>();
    const map = {
      getSource: () => (hasSource ? source : undefined),
      addSource() {
        hasSource = true;
      },
      addLayer(layer: { id: string }) {
        layers.add(layer.id);
      },
      getLayer: (id: string) => layers.has(id),
      removeLayer: (id: string) => layers.delete(id),
      removeSource() {
        hasSource = false;
      },
      getCanvas: () => ({ style: { cursor: "" } }),
      on(event: string, _layer: string, handler: unknown) {
        listeners.set(event, handler);
      },
      off(event: string, _layer: string, handler: unknown) {
        removed.set(event, handler);
      },
    };
    const footprints = new FootprintLayer(map as never);
    footprints.setItems([item("footprint")]);
    footprints.remove();
    assert.equal(removed.get("mouseenter"), listeners.get("mouseenter"));
    assert.equal(removed.get("mouseleave"), listeners.get("mouseleave"));
  });

  it("cancels deferred layer initialization when removed before map load", () => {
    installDom();
    let loadHandler: (() => void) | undefined;
    let addSourceCalls = 0;
    const map = {
      isStyleLoaded: () => false,
      once(event: string, handler: () => void) {
        if (event === "load") loadHandler = handler;
      },
      off(event: string, handler: () => void) {
        if (event === "load" && loadHandler === handler) loadHandler = undefined;
      },
      addSource() {
        addSourceCalls++;
      },
    };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (() => new Promise(() => {})) as typeof fetch;
    try {
      const control = new VantorControl();
      control.onAdd(map as never);
      const deferred = loadHandler;
      assert.ok(deferred);
      control.onRemove();
      deferred();
      assert.equal(addSourceCalls, 0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("keeps selection through sorting and updates localized panel labels", () => {
    const { document } = installDom();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const panel = new PanelUI(container);
    panel.setItems([item("z-scene"), item("a-scene")]);

    let selectionChanges = 0;
    panel.addEventListener("panel-action", (event) => {
      if ((event as CustomEvent).detail.type === "selection-change") selectionChanges++;
    });
    const checkbox = container.querySelector<HTMLInputElement>('input[data-item-id="z-scene"]');
    assert.ok(checkbox);
    checkbox.checked = true;
    checkbox.click();
    assert.equal(selectionChanges, 1);

    const idHeader = container.querySelectorAll("th")[1];
    (idHeader as HTMLElement).click();
    assert.deepEqual(
      panel.getCheckedItems().map(({ id }) => id),
      ["z-scene"],
    );
    assert.ok(container.querySelector('label[for="vantor-event-select"]'));
    assert.ok(container.querySelector('label[for="vantor-phase-select"]'));

    panel.setTranslator((_key, fallback) => `Translated: ${fallback}`);
    assert.equal(container.querySelector("h3")?.textContent, "Translated: Vantor STAC Explorer");
  });
});
