import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  maplibreVantorPlugin,
  VANTOR_PLUGIN_ID,
} from "../packages/plugins/src/plugins/maplibre-vantor";
import { CogLayer } from "../packages/plugins/src/plugins/vantor/cog-layer";
import { WEB_SERVICE_PLUGIN_IDS } from "../packages/plugins/src/plugins/web-service-sync";
import { pluginTier } from "../apps/geolibre-desktop/src/lib/ui-profile";

describe("Vantor Open Data built-in plugin", () => {
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

  it("requests the WASM renderer for Vantor COGs", async () => {
    let receivedOptions: Parameters<NonNullable<ConstructorParameters<typeof CogLayer>[2]>>[2];
    const layer = new CogLayer({} as never, undefined, async (_name, _url, options) => {
      receivedOptions = options;
      return "vantor-layer";
    });

    await layer.addCogLayer({
      type: "Feature",
      stac_version: "1.0.0",
      id: "test-vantor-scene",
      geometry: null,
      bbox: [0, 0, 1, 1],
      properties: {},
      assets: {
        visual: {
          href: "https://example.com/vantor.tif",
          type: "image/tiff; application=geotiff; profile=cloud-optimized",
        },
      },
      links: [],
    });

    assert.deepEqual(receivedOptions!, {
      nodata: 0,
      engine: "cog-tiler-wasm",
    });
  });
});
